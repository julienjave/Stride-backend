/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { withRlsContext } from '../database/rls-context'
import { users } from '../database/schema'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { errorMessage } from '../common/error-message'
import { endSession } from '../common/other-sessions'
import type { UserRole } from '../users/dto/create-user.dto'
import {
  isCurrentPassword,
  WRONG_PASSWORD_MESSAGE,
} from '../common/current-password'
import { INVALID_MFA_CODE_MESSAGE } from './totp'
import {
  secondFactorRefusalMessage,
  spendAgain,
  trySecondFactor,
  type SecondFactorRefusal,
  type SecondFactorUse,
} from './second-factor'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// "Step-up authentication": a signed-in session proves someone signed in at
// some point — not that the account's owner is at the keyboard NOW. So the
// changes that could hand the account to someone else ask again:
//   - the current PASSWORD, always (common/current-password.ts);
//   - for an account with two-factor sign-in ON, a current SECOND FACTOR too
//     — a code from the app, or a recovery code (decisions §14).
// Five routes ask it: changing the email, changing the password, turning MFA
// off, asking for new recovery codes, and an admin's reset of someone's MFA
// (the ADMIN's own step-up). Starting set-up asks the password alone (MFA is
// off then).
//
// A service, not a plain function (it was one in pass 1), because using a
// RECOVERY code has consequences every caller would otherwise repeat: an
// audit entry in the transaction, and a notice email after the commit. The
// caller gets a receipt and calls `afterCommit()` once its transaction is
// committed — never before: no email about a use that was rolled back.
//
// FAILED step-ups (privacy and security pass 2, decided with the person
// 2026-10-23 — decisions §16): a wrong password or a wrong / used second
// factor is AUDITED (STEP_UP_FAILED), and counted per account; 5 in a row
// sign out the session that failed them. Why: the throttle (5 a minute per
// route and address) slows guessing, but a stolen session could keep
// guessing the password for hours, from several addresses, unseen. The
// refusal itself is thrown inside the caller's transaction, which then rolls
// back — taking any write made there with it — so the failure is recorded
// AFTERWARDS, in a transaction of its own (StepUpAttempt.failed below), like
// a failed sign-in.
//
// A PASSED step-up whose change then fails (2026-10-29, the person's choice):
// the second factor was spent in the change's transaction, so the rollback
// un-spent it — a code typed for "change my email to the address I already
// have" stayed usable for the rest of its 30 seconds, a recovery code for
// ever. RFC 6238 (5.2) asks that a code not be accepted again once it has
// been validated: what the change did next doesn't matter. So the attempt
// remembers what passed, and `failed` spends it again after the rollback —
// an app code or a recovery code alike (the person chose both).
//
// Why not spend it on another connection BEFORE the change, so no rollback
// can reach it? The account's row is locked FOR UPDATE by the change's
// transaction: a second connection writing the same row would wait for
// that transaction — which is waiting for the step-up: a wait on itself
// that never ends. After the rollback the lock is free. The cost is a
// window of a few milliseconds between the rollback and the spend, in which
// the same code (with the password) could be used once more; the refusal
// isn't answered before the spend is done.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// An account with two-factor sign-in on, and no code sent. The frontend shows
// the code field only for such accounts; this is what a request without it
// gets (an older screen, a direct API call).
export const MFA_CODE_REQUIRED_MESSAGE =
  'Enter the 6-digit code from your authenticator app'

// How many failed step-ups in a row end the session (the person's choice).
export const STEP_UP_FAILURE_LIMIT = 5

// The answer to the 5th failure: a 401 — the session that sent it no longer
// exists. The frontend's handler for a 401 takes the person to sign-in, and
// reads these words to say why (a sign-out that explains nothing would look
// like a bug).
export const STEP_UP_SIGNED_OUT_MESSAGE =
  'Too many wrong attempts: you have been signed out. Sign in again to continue.'

// The account's columns a step-up reads. Selected by the caller (with
// whatever else it needs) from the account's row LOCKED FOR UPDATE: the
// second factor is SPENT here, and two requests with the same code must not
// both find it unused. The name and email are for the notice.
export const STEP_UP_COLUMNS = {
  email: users.email,
  firstName: users.firstName,
  passwordHash: users.passwordHash,
  mfaEnabled: users.mfaEnabled,
  mfaSecret: users.mfaSecret,
  mfaLastUsedStep: users.mfaLastUsedStep,
  stepUpFailures: users.stepUpFailures,
}

// --- TYPES -------------------------------------------------------------------------------------------------

export interface StepUpAccount {
  email: string
  firstName: string
  passwordHash: string | null
  mfaEnabled: boolean
  mfaSecret: string | null
  mfaLastUsedStep: number | null
  stepUpFailures: number
}

// What the request brought: the password always; the code when it sent one.
export interface StepUpProof {
  currentPassword: string
  mfaCode?: string
}

// What a caller does after ITS commit: send the notice a recovery code's use
// calls for (nothing for an app code, or no second factor).
export interface StepUpReceipt {
  afterCommit(): void
}

const NOTHING_AFTER_COMMIT: StepUpReceipt = { afterCommit: () => undefined }

// Which change asked for the step-up — in the failure's audit entry, so the
// trail says what someone was trying to do.
export type StepUpPurpose =
  | 'email_change'
  | 'password_change'
  | 'mfa_setup'
  | 'mfa_disable'
  | 'recovery_codes'
  | 'mfa_reset'
  | 'patient_merge'

// Why a step-up failed: the password, or one of the second factor's own
// refusals (wrong, already used, a recovery code that isn't one).
export type StepUpFailureReason = 'wrong_password' | SecondFactorRefusal

// The account a step-up is asked of, as row security needs it: its id and
// the role the session is acting in (the failure is written AS it).
type StepUpActor = { id: number; activeRole: UserRole }

// One request's step-up (StepUpService.attempt): made before the change's
// transaction, used inside it, and handed to its `.catch` — the same object
// in all three places is what lets the catch know whether a second factor
// had passed (and so must be spent again).
export interface StepUpAttempt {
  // The whole step-up, inside the change's transaction, on the account's
  // LOCKED row — see StepUpService.check. Returns the receipt the caller
  // calls after ITS commit.
  confirm(
    tx: DrizzleDb,
    account: StepUpAccount,
    proof: StepUpProof,
  ): Promise<StepUpReceipt>
  // The password half alone — for starting two-factor set-up (MFA is off
  // there: no second factor to ask).
  confirmPassword(
    tx: DrizzleDb,
    account: Pick<StepUpAccount, 'passwordHash' | 'stepUpFailures'>,
    currentPassword: string,
  ): Promise<void>
  // For the caller's `withRlsContext(…).catch(attempt.failed)`: once the
  // transaction is over (rolled back, its lock released) —
  //   - a FAILED step-up (StepUpRefusedException) is counted and recorded,
  //     the 5th in a row signing the session out (a 401 instead);
  //   - any other error after a second factor PASSED: that factor is spent
  //     again, in a transaction of its own;
  //   - then the error goes on, unchanged.
  // `Promise<never>`: it always throws, so `promise.catch(attempt.failed)`
  // keeps the promise's own type — the caller reads its result unchanged.
  // A PROPERTY holding an arrow function (not a method): it uses no `this`,
  // so it can be passed as it is — and the type says so.
  readonly failed: (error: unknown) => Promise<never>
}

// --- EXCEPTION ---------------------------------------------------------------------------------------------

// A step-up's refusal: the same 400, with the same words as before — and
// WHY, for the attempt's `failed` to count and record. A class of its own so the
// recorder can tell a failed proof from every other refusal a change can
// end with (the same password again, an address already yours, MFA already
// off…), which aren't guesses and aren't counted. Nor is a missing code
// (MFA_CODE_REQUIRED_MESSAGE): nothing was guessed.
export class StepUpRefusedException extends BadRequestException {
  constructor(
    message: string,
    readonly reason: StepUpFailureReason,
  ) {
    super(message)
  }
}

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class StepUpService {
  private readonly logger = new Logger(StepUpService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly messagingEvents: MessagingEvents,
  ) {}

  // One request's step-up. `actor`: the account whose step-up it is (for an
  // admin's reset of someone's MFA, the ADMIN); `sessionId`: the session
  // that sent it — the one signed out at the failure limit; `purpose`: which
  // change it is for (in a failure's audit entry).
  attempt(
    actor: StepUpActor,
    sessionId: string,
    purpose: StepUpPurpose,
  ): StepUpAttempt {
    // What passed in THIS request's transaction, if a second factor did.
    // Set only after the check succeeded — a refused code is not "spent".
    let passed: SecondFactorUse | undefined
    return {
      confirm: async (tx, account, proof) => {
        const outcome = await this.check(tx, actor.id, account, proof)
        passed = outcome.use
        return outcome.receipt
      },
      confirmPassword: (tx, account, currentPassword) =>
        this.checkPassword(tx, actor.id, account, currentPassword),
      failed: async (error: unknown) => {
        if (error instanceof StepUpRefusedException) {
          const signedOut = await this.recordFailure(
            actor,
            sessionId,
            purpose,
            error.reason,
          )
          if (signedOut) {
            throw new UnauthorizedException(STEP_UP_SIGNED_OUT_MESSAGE)
          }
        } else if (passed !== undefined) {
          await this.spendAfterRollback(actor, passed)
        }
        throw error
      },
    }
  }

  // The whole step-up, inside the caller's transaction, on the locked row:
  //   1. the password — always; a wrong one refuses before any code is
  //      looked at (a code is not even spent on a request that fails here);
  //   2. for an account with two-factor on, a second factor: missing → its
  //      own 400; wrong or already used → its words; a good one is SPENT in
  //      this transaction (an app code's step recorded, a recovery code
  //      marked used — then its entry written, its notice in the receipt);
  //   3. passed: the account's failures in a row go back to 0 (in this
  //      transaction — they stay counted if the change then fails anyway).
  // Throws a 400 on any refusal — the transaction then rolls back, nothing
  // is changed. A wrong proof throws StepUpRefusedException (counted by the
  // attempt's `failed`). Answers the receipt, and what was spent (`use`) —
  // for `failed` to spend again if the change is rolled back.
  private async check(
    tx: DrizzleDb,
    userId: number,
    account: StepUpAccount,
    proof: StepUpProof,
  ): Promise<{ receipt: StepUpReceipt; use?: SecondFactorUse }> {
    if (
      !(await isCurrentPassword(account.passwordHash, proof.currentPassword))
    ) {
      throw new StepUpRefusedException(WRONG_PASSWORD_MESSAGE, 'wrong_password')
    }
    if (!account.mfaEnabled) {
      await this.passed(tx, userId, account)
      return { receipt: NOTHING_AFTER_COMMIT }
    }
    if (proof.mfaCode === undefined) {
      throw new BadRequestException(MFA_CODE_REQUIRED_MESSAGE)
    }
    // ON with no secret can't be stored (users_mfa_enabled_has_secret), but
    // TypeScript can't see a CHECK. If it ever happened, refuse — never skip
    // the code check because there is nothing to check it against.
    if (account.mfaSecret === null) {
      throw new BadRequestException(INVALID_MFA_CODE_MESSAGE)
    }
    const check = await trySecondFactor(
      tx,
      userId,
      {
        mfaSecret: account.mfaSecret,
        mfaLastUsedStep: account.mfaLastUsedStep,
      },
      proof.mfaCode,
    )
    if (!check.ok) {
      throw new StepUpRefusedException(
        secondFactorRefusalMessage(check.reason),
        check.reason,
      )
    }
    await this.passed(tx, userId, account)
    const receipt = await this.afterSecondFactor(tx, userId, account, check)
    return { receipt, use: check }
  }

  // The password half alone (set-up). The same refusal, counted the same
  // way, and the same reset when it passes.
  private async checkPassword(
    tx: DrizzleDb,
    userId: number,
    account: Pick<StepUpAccount, 'passwordHash' | 'stepUpFailures'>,
    currentPassword: string,
  ): Promise<void> {
    if (!(await isCurrentPassword(account.passwordHash, currentPassword))) {
      throw new StepUpRefusedException(WRONG_PASSWORD_MESSAGE, 'wrong_password')
    }
    await this.passed(tx, userId, account)
  }

  // A second factor passed, then the change failed and was rolled back —
  // taking the spend with it. Spent again here, in a transaction of its own,
  // AS the account (row security: its own row, its own codes). A recovery
  // code spent now is a use like any other: its entry (MFA_RECOVERY_CODE_USED
  // — `changeNotMade` says the change it was for didn't happen) and its
  // notice. Never throws: the change's own error is what the client must
  // get; a failure here is logged with its reason.
  private async spendAfterRollback(
    actor: StepUpActor,
    use: SecondFactorUse,
  ): Promise<void> {
    try {
      const outcome = await withRlsContext(this.db, actor, async (tx) => {
        const [account] = await tx
          .select({ email: users.email, firstName: users.firstName })
          .from(users)
          .where(eq(users.id, actor.id))
        const { recoveryCodesLeft } = await spendAgain(tx, actor.id, use)
        if (account === undefined || recoveryCodesLeft === null) return null
        await this.auditService.logInTransaction(tx, {
          performedBy: actor.id,
          action: 'MFA_RECOVERY_CODE_USED',
          targetUserId: actor.id,
          entityType: 'users',
          entityId: actor.id,
          details: { remaining: recoveryCodesLeft, changeNotMade: true },
        })
        return { account, remaining: recoveryCodesLeft }
      })
      if (outcome === null) return
      this.sendRecoveryCodeNotice(outcome.account, outcome.remaining)
    } catch (error: unknown) {
      this.logger.error(
        `Failed to spend a second factor again after a rolled-back change (user ${actor.id}): ${errorMessage(error)}`,
      )
    }
  }

  // A step-up passed: the failures in a row are over. Written only when
  // there were some — most step-ups pass the first time, and an UPDATE for
  // nothing would still be a write (and a row version) per change.
  private async passed(
    tx: DrizzleDb,
    userId: number,
    account: Pick<StepUpAccount, 'stepUpFailures'>,
  ): Promise<void> {
    if (account.stepUpFailures === 0) return
    await tx
      .update(users)
      .set({ stepUpFailures: 0 })
      .where(eq(users.id, userId))
  }

  // One failure: counted, audited, and — at the limit — the session that
  // failed signed out. ONE transaction, AS the account (row security: an
  // account may update its own row; an admin any): the count goes up by one
  // in a single UPDATE (`step_up_failures + 1`, computed by the database
  // under the row's lock — two failures at once both count, where "read,
  // add one, write" could lose one), then ONE entry, awaited — the refusal
  // isn't answered before its trace exists. At the limit, in the same
  // transaction: the count back to 0 (a fresh start after signing in again)
  // and the session's row deleted.
  // Answers whether the session was signed out. After the commit, then: its
  // sockets closed (they were authenticated at their handshake and would
  // keep receiving messages), and a notice to the account's inbox.
  private async recordFailure(
    actor: StepUpActor,
    sessionId: string,
    purpose: StepUpPurpose,
    reason: StepUpFailureReason,
  ): Promise<boolean> {
    const outcome = await withRlsContext(this.db, actor, async (tx) => {
      const [account] = await tx
        .update(users)
        .set({ stepUpFailures: sql`${users.stepUpFailures} + 1` })
        .where(eq(users.id, actor.id))
        .returning({
          failures: users.stepUpFailures,
          email: users.email,
          firstName: users.firstName,
        })
      // The account is gone (deleted between the two transactions): nothing
      // to count — the refusal still goes out.
      if (!account) return null
      const signedOut = account.failures >= STEP_UP_FAILURE_LIMIT
      if (signedOut) {
        await tx
          .update(users)
          .set({ stepUpFailures: 0 })
          .where(eq(users.id, actor.id))
        await endSession(tx, sessionId)
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: actor.id,
        action: 'STEP_UP_FAILED',
        targetUserId: actor.id,
        entityType: 'users',
        entityId: actor.id,
        details: {
          purpose,
          reason,
          consecutiveFailures: account.failures,
          ...(signedOut ? { signedOut: true } : {}),
        },
      })
      return { signedOut, email: account.email, firstName: account.firstName }
    })

    if (!outcome?.signedOut) return false
    this.messagingEvents.disconnectSession(sessionId)
    // Fire-and-forget: the sign-out IS done whatever the mail server does.
    this.emailService
      .sendStepUpSignOutNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Failed to send the step-up sign-out notice to ${outcome.email}: ${errorMessage(error)}`,
        ),
      )
    return true
  }

  // What a SPENT second factor leaves behind — shared with signing in, which
  // spends one without the password step (MfaService.verifySignIn). An app
  // code: nothing (its step is recorded; a sign-in or a change records
  // itself). A recovery code: a security event of its own — ONE more entry,
  // MFA_RECOVERY_CODE_USED with how many are left, in the transaction (the
  // stated exception to "one entry per request", like a clinic removal's
  // per-patient entries), and a notice to the account's inbox after the
  // commit: if someone else holds the codes, the owner hears of it at once.
  async afterSecondFactor(
    tx: DrizzleDb,
    userId: number,
    account: { email: string; firstName: string },
    use: SecondFactorUse,
  ): Promise<StepUpReceipt> {
    if (use.kind === 'totp') return NOTHING_AFTER_COMMIT
    await this.auditService.logInTransaction(tx, {
      performedBy: userId,
      action: 'MFA_RECOVERY_CODE_USED',
      targetUserId: userId,
      entityType: 'users',
      entityId: userId,
      details: { remaining: use.remaining },
    })
    return {
      afterCommit: () => this.sendRecoveryCodeNotice(account, use.remaining),
    }
  }

  // "A recovery code was used — N left". Fire-and-forget: the use IS done
  // whatever the mail server does; a failure is logged with its reason.
  private sendRecoveryCodeNotice(
    account: { email: string; firstName: string },
    remaining: number,
  ): void {
    this.emailService
      .sendRecoveryCodeUsedNotice({
        to: account.email,
        firstName: account.firstName,
        remaining,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Failed to send the recovery-code notice to ${account.email}: ${errorMessage(error)}`,
        ),
      )
  }
}
