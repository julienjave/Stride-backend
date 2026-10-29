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
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, count, eq, inArray, isNull } from 'drizzle-orm'
import * as QRCode from 'qrcode'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { mfaRecoveryCodes, users } from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { errorMessage } from '../common/error-message'
import { WRONG_PASSWORD_MESSAGE } from '../common/current-password'
import { endAllSessions, endOtherSessions } from '../common/other-sessions'
import { encryptMfaSecret } from '../auth/mfa-secret-crypto'
import type { UserRole } from '../users/dto/create-user.dto'
import { mfaKeyUri, newMfaSecret, useMfaCode } from './totp'
import { secondFactorRefusalMessage, trySecondFactor } from './second-factor'
import { hashRecoveryCode, newRecoveryCodes } from './recovery-codes'
import {
  type StepUpProof,
  StepUpService,
  STEP_UP_COLUMNS,
} from './step-up.service'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Set-up while MFA is on would REPLACE the secret the person's app uses —
// their next sign-in would fail (the bug pass 1 fixed: setup never looked
// at mfaEnabled). Changing phone = turn it off, then set up again. Also the
// answer to "enable" when it's already on: nothing to do, and nothing done.
export const MFA_ALREADY_ON_MESSAGE =
  'Two-factor sign-in is already on for this account'
export const MFA_NOT_ON_MESSAGE =
  'Two-factor sign-in is not on for this account'
// "Enable" with no set-up started: there is no secret to check a code against.
export const MFA_SETUP_FIRST_MESSAGE =
  'Start setting up two-factor sign-in first'
// The admin reset on one's own account (the person's choice): the reset
// weakens an account, so it always takes a SECOND person; one's own lost
// phone goes through one's recovery codes or another admin.
export const MFA_RESET_OWN_MESSAGE =
  "You can't reset your own two-factor sign-in — use one of your recovery codes, or ask another admin"

// --- TYPES -------------------------------------------------------------------------------------------------

type SignedInUser = { id: number; activeRole: UserRole }

// What setup answers, shown once: the QR code for the app to scan, the same
// address as text, and the secret itself for typing in by hand (an app that
// can't scan, or a person who prefers to type).
export interface MfaSetup {
  secret: string
  otpauthUrl: string
  qrCodeDataUrl: string
}

// New recovery codes, shown ONCE (only their keyed hashes are stored): when
// MFA is turned on, and when the person asks for new ones.
export interface RecoveryCodes {
  recoveryCodes: string[]
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// Two-factor sign-in with an authenticator app (TOTP) — MFA enrolment,
// Phase 6. The life of it:
//
//   setup (password) ──► a new secret stored, not yet in force; the QR shown
//   enable (an app code from that secret) ──► ON; 10 recovery codes shown
//     once; other devices signed out
//   sign-in: password, then an app code OR a recovery code (verifySignIn)
//   new recovery codes (password + a second factor) ──► 10 new, old ones gone
//   disable (password + a second factor) ──► OFF, secret and codes deleted
//   admin reset (the ADMIN's password, and their second factor if they have
//     one) ──► OFF for someone else, their sessions ended
//
// Every method LOCKS the account's row first (SELECT … FOR UPDATE) and does
// its checks against what the lock returned, in ONE transaction with its
// write and its ONE audit entry (plus MFA_RECOVERY_CODE_USED when a recovery
// code was spent — StepUpService). Two reasons: a second factor is SPENT
// (two requests with the same code must not both find it unused), and a
// set-up in another tab must not change the secret between "the code matches
// it" and "MFA is on".
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly messagingEvents: MessagingEvents,
    private readonly stepUp: StepUpService,
  ) {}

  // === SET-UP =================================================================

  // A new secret, stored ENCRYPTED and not yet in force (mfaEnabled stays
  // false until enable confirms a code from it). Asks for the password (the
  // step-up); refused while MFA is on. A set-up started earlier and never
  // confirmed is simply replaced — its QR code stops working.
  // `sessionId`: the session asking — signed out should this be its 5th
  // failed step-up in a row (decisions §16; the same for every method below
  // that asks a step-up).
  async setup(
    currentUser: SignedInUser,
    currentPassword: string,
    sessionId: string,
  ): Promise<MfaSetup> {
    const secret = newMfaSecret()

    const attempt = this.stepUp.attempt(currentUser, sessionId, 'mfa_setup')
    const email = await withRlsContext(this.db, currentUser, async (tx) => {
      const account = await lockAccount(tx, currentUser.id)
      // The password only — not the whole step-up: MFA is off here (on is
      // refused just below), so there is no second factor to ask. Password
      // FIRST: without it, the request learns nothing, not even whether MFA
      // is on. A wrong one is counted like any failed step-up.
      if (!account) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      await attempt.confirmPassword(tx, account, currentPassword)
      if (account.mfaEnabled) {
        throw new ConflictException(MFA_ALREADY_ON_MESSAGE)
      }

      // The plaintext secret goes into the QR code (the app needs the real
      // value); only the STORED copy is encrypted. (The last-used step is
      // already null here: only an account with MFA on records one, and
      // turning it off clears it.)
      await tx
        .update(users)
        .set({ mfaSecret: encryptMfaSecret(secret) })
        .where(eq(users.id, currentUser.id))
      // ONE entry, in the transaction. Never the secret, encrypted or not.
      // Whether an unconfirmed set-up was replaced: the trail then shows two
      // set-ups in a row for a reason, not by mistake.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MFA_SETUP_STARTED',
        targetUserId: currentUser.id,
        entityType: 'users',
        entityId: currentUser.id,
        ...(account.mfaSecret !== null
          ? { details: { replacedUnconfirmedSetup: true } }
          : {}),
      })
      return account.email
    }).catch(attempt.failed)

    // After the commit — the QR code is drawn from data that is now stored.
    // The label is the sign-in email, what the app shows next to the codes.
    const otpauthUrl = mfaKeyUri(email, secret)
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl)
    return { secret, otpauthUrl, qrCodeDataUrl }
  }

  // === ENABLE =================================================================

  // Turns MFA ON once a code from the set-up secret is right — the proof that
  // the person's app really holds it. Creates the 10 recovery codes and
  // answers them (shown once). Then every OTHER session ends (the sessions
  // opened with the password alone); this browser stays.
  // `keptSessionId`: the session making the request.
  async enable(
    currentUser: SignedInUser,
    code: string,
    keptSessionId: string,
  ): Promise<RecoveryCodes> {
    const recoveryCodes = newRecoveryCodes()

    const outcome = await withRlsContext(this.db, currentUser, async (tx) => {
      const account = await lockAccount(tx, currentUser.id)
      if (!account?.mfaSecret) {
        throw new BadRequestException(MFA_SETUP_FIRST_MESSAGE)
      }
      // Already on: nothing to do, and nothing written (no entry for a
      // request that changes nothing — the convention).
      if (account.mfaEnabled) {
        throw new ConflictException(MFA_ALREADY_ON_MESSAGE)
      }
      // An APP code only (EnableMfaDto): wrong or already used → 400; a good
      // code is recorded as used.
      await useMfaCode(
        tx,
        currentUser.id,
        {
          mfaSecret: account.mfaSecret,
          mfaLastUsedStep: account.mfaLastUsedStep,
        },
        code,
      )
      await tx
        .update(users)
        .set({ mfaEnabled: true })
        .where(eq(users.id, currentUser.id))
      // The account has none while MFA is off (turning off and the admin
      // reset delete them), so these are its only codes.
      await insertRecoveryCodes(tx, currentUser.id, recoveryCodes)
      const endedSessionIds = await endOtherSessions(
        tx,
        currentUser.id,
        keptSessionId,
      )
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MFA_ENABLED',
        targetUserId: currentUser.id,
        entityType: 'users',
        entityId: currentUser.id,
        details: { signedOutSessions: endedSessionIds.length },
      })
      return {
        email: account.email,
        firstName: account.firstName,
        endedSessionIds,
      }
    })

    for (const sessionId of outcome.endedSessionIds) {
      this.messagingEvents.disconnectSession(sessionId)
    }
    this.notify('enabled notice', outcome.email, () =>
      this.emailService.sendMfaEnabledNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      }),
    )
    return { recoveryCodes }
  }

  // === RECOVERY CODES =========================================================

  // How many unused codes the account has — for the profile ("7 of 10
  // left"). The codes themselves can never be shown again. 0 when MFA is off.
  async recoveryCodesLeft(
    currentUser: SignedInUser,
  ): Promise<{ remaining: number }> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [left] = await tx
        .select({ remaining: count() })
        .from(mfaRecoveryCodes)
        .where(
          and(
            eq(mfaRecoveryCodes.userId, currentUser.id),
            isNull(mfaRecoveryCodes.usedAt),
          ),
        )
      return { remaining: left.remaining }
    })
  }

  // Ten NEW codes, the old ones deleted (used or not) — for a person who used
  // some, or fears someone saw them. The step-up first (password + a second
  // factor — a recovery code counts, and is spent before the old ones go).
  async regenerateRecoveryCodes(
    currentUser: SignedInUser,
    proof: StepUpProof,
    sessionId: string,
  ): Promise<RecoveryCodes> {
    const recoveryCodes = newRecoveryCodes()

    const attempt = this.stepUp.attempt(
      currentUser,
      sessionId,
      'recovery_codes',
    )
    const stepUp = await withRlsContext(this.db, currentUser, async (tx) => {
      const account = await lockAccount(tx, currentUser.id)
      if (!account) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      const receipt = await attempt.confirm(tx, account, proof)
      // Off: the step-up checked only the password; there are no codes.
      if (!account.mfaEnabled) {
        throw new BadRequestException(MFA_NOT_ON_MESSAGE)
      }
      const replaced = await tx
        .delete(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, currentUser.id))
        .returning({ usedAt: mfaRecoveryCodes.usedAt })
      await insertRecoveryCodes(tx, currentUser.id, recoveryCodes)
      // How many unused codes stopped working — the entry says what the
      // person gave up (never a code, nor a hash).
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MFA_RECOVERY_CODES_REGENERATED',
        targetUserId: currentUser.id,
        entityType: 'users',
        entityId: currentUser.id,
        details: {
          replacedUnused: replaced.filter((row) => row.usedAt === null).length,
        },
      })
      return receipt
    }).catch(attempt.failed)

    stepUp.afterCommit()
    return { recoveryCodes }
  }

  // === DISABLE ================================================================

  // Turns MFA OFF: the password AND a second factor (the step-up, which asks
  // it because MFA is on — an app code or a recovery code). The secret and
  // the recovery codes are deleted with it: setting up again starts afresh.
  async disable(
    currentUser: SignedInUser,
    currentPassword: string,
    code: string,
    sessionId: string,
  ): Promise<void> {
    const attempt = this.stepUp.attempt(currentUser, sessionId, 'mfa_disable')
    const outcome = await withRlsContext(this.db, currentUser, async (tx) => {
      const account = await lockAccount(tx, currentUser.id)
      if (!account) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      const stepUp = await attempt.confirm(tx, account, {
        currentPassword,
        mfaCode: code,
      })
      // Off already: the step-up checked only the password; nothing to do.
      if (!account.mfaEnabled) {
        throw new BadRequestException(MFA_NOT_ON_MESSAGE)
      }
      await turnOff(tx, currentUser.id)
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MFA_DISABLED',
        targetUserId: currentUser.id,
        entityType: 'users',
        entityId: currentUser.id,
      })
      return { email: account.email, firstName: account.firstName, stepUp }
    }).catch(attempt.failed)

    outcome.stepUp.afterCommit()
    this.notify('disabled notice', outcome.email, () =>
      this.emailService.sendMfaDisabledNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      }),
    )
  }

  // === ADMIN RESET ============================================================

  // An admin turns MFA OFF for someone else — the last resort for a person
  // who lost the phone AND the codes, or whose account got someone else's
  // phone (the person's choices: the ADMIN's own step-up; never one's own
  // account). Every session of that account ends (whoever is in it should
  // sign in again); the account is told by email.
  // `sessionId`: the ADMIN's session — it was their step-up.
  async resetForUser(
    admin: SignedInUser,
    targetId: number,
    proof: StepUpProof,
    sessionId: string,
  ): Promise<void> {
    if (targetId === admin.id) {
      throw new ForbiddenException(MFA_RESET_OWN_MESSAGE)
    }

    const attempt = this.stepUp.attempt(admin, sessionId, 'mfa_reset')
    const outcome = await withRlsContext(this.db, admin, async (tx) => {
      // BOTH rows locked — the admin's (their step-up spends a code) and the
      // target's — in ONE statement, in id order. Two admins resetting each
      // other at the same moment would otherwise each hold their own row and
      // wait for the other's: a deadlock (Postgres would abort one). Taking
      // locks in one agreed order makes that circle impossible. (Postgres
      // happens to return these two rows in id order without ORDER BY too —
      // so a mutation removing it survives the tests; ORDER BY turns that
      // habit into a guarantee. A deadlock can't be produced on purpose
      // deterministically, so this one is argued, not tested.)
      const rows = await tx
        .select({ id: users.id, ...STEP_UP_COLUMNS })
        .from(users)
        .where(inArray(users.id, [admin.id, targetId]))
        .orderBy(users.id)
        .for('update')
      const own = rows.find((row) => row.id === admin.id)
      const target = rows.find((row) => row.id === targetId)
      if (!own) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      const stepUp = await attempt.confirm(tx, own, proof)
      if (!target) throw new NotFoundException(`User ${targetId} not found`)
      if (!target.mfaEnabled) {
        throw new BadRequestException(MFA_NOT_ON_MESSAGE)
      }

      await turnOff(tx, targetId)
      const endedSessionIds = await endAllSessions(tx, targetId)
      await this.auditService.logInTransaction(tx, {
        performedBy: admin.id,
        action: 'MFA_RESET_BY_ADMIN',
        targetUserId: targetId,
        entityType: 'users',
        entityId: targetId,
        details: { signedOutSessions: endedSessionIds.length },
      })
      return {
        email: target.email,
        firstName: target.firstName,
        endedSessionIds,
        stepUp,
      }
    }).catch(attempt.failed)

    for (const ended of outcome.endedSessionIds) {
      this.messagingEvents.disconnectSession(ended)
    }
    outcome.stepUp.afterCommit()
    this.notify('reset notice', outcome.email, () =>
      this.emailService.sendMfaResetNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      }),
    )
  }

  // === SIGN-IN ================================================================

  // The second step of signing in: is `code` — an app code or a recovery
  // code — good for the account whose password was just checked (the
  // session's mfaPending)? Answers ok or the refusal's words — the controller
  // decides (sign in, or 401) — and writes in both cases, in ONE transaction
  // under the row lock: a good factor is spent (and a recovery code leaves
  // its entry and notice); a refused one leaves an MFA_LOGIN_FAILURE entry
  // (the password was right, so wrong codes against one account are the
  // brute-force signal — decided in the audit review), with WHY.
  //
  // Acts AS the account (its id and the role being signed into) for row
  // security — the session isn't signed in yet, but the users and recovery
  // codes policies let an account write its own rows, which is all this does.
  async verifySignIn(
    pending: { userId: number; activeRole: UserRole },
    code: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const outcome = await withRlsContext(
      this.db,
      { id: pending.userId, activeRole: pending.activeRole },
      async (tx) => {
        const account = await lockAccount(tx, pending.userId)
        // MFA turned off from another device since the password step (or
        // never on): nothing to check against — refused, like a wrong code,
        // but not recorded (nobody guessed anything).
        if (!account?.mfaEnabled || account.mfaSecret === null) {
          return {
            ok: false as const,
            message: secondFactorRefusalMessage('wrong_code'),
          }
        }
        const check = await trySecondFactor(
          tx,
          pending.userId,
          {
            mfaSecret: account.mfaSecret,
            mfaLastUsedStep: account.mfaLastUsedStep,
          },
          code,
        )
        if (!check.ok) {
          await this.auditService.logInTransaction(tx, {
            performedBy: pending.userId,
            action: 'MFA_LOGIN_FAILURE',
            targetUserId: pending.userId,
            entityType: 'users',
            entityId: pending.userId,
            details: { reason: check.reason },
          })
          return {
            ok: false as const,
            message: secondFactorRefusalMessage(check.reason),
          }
        }
        const receipt = await this.stepUp.afterSecondFactor(
          tx,
          pending.userId,
          account,
          check,
        )
        return { ok: true as const, receipt }
      },
    )

    if (!outcome.ok) return outcome
    outcome.receipt.afterCommit()
    return { ok: true }
  }

  // === HELPERS ================================================================

  // Fire-and-forget after the commit: the change IS made whatever the mail
  // server does; a failure is logged with its reason (errorMessage — the
  // logger would drop a second argument).
  private notify(what: string, to: string, send: () => Promise<void>): void {
    send().catch((error: unknown) =>
      this.logger.error(
        `Failed to send the two-factor ${what} to ${to}: ${errorMessage(error)}`,
      ),
    )
  }
}

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

// The account's row, LOCKED until the transaction ends: everything a method
// here checks, read in one statement. Undefined if the row is gone (a
// signed-in account always has one; it keeps TypeScript honest).
async function lockAccount(tx: DrizzleDb, userId: number) {
  const [account] = await tx
    .select(STEP_UP_COLUMNS)
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
  return account
}

// Stores new codes for the account — their keyed hashes only.
async function insertRecoveryCodes(
  tx: DrizzleDb,
  userId: number,
  codes: string[],
): Promise<void> {
  await tx
    .insert(mfaRecoveryCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })))
}

// MFA OFF for the account: the flag, the secret and the last-used step (it
// belonged to this secret — a code of the same 30 seconds from the NEXT
// set-up's secret must not be refused as "already used"; cleared here, it
// stays null while MFA is off, which set-up relies on), and every recovery
// code. Shared by turning it off and the admin reset.
async function turnOff(tx: DrizzleDb, userId: number): Promise<void> {
  await tx
    .update(users)
    .set({ mfaEnabled: false, mfaSecret: null, mfaLastUsedStep: null })
    .where(eq(users.id, userId))
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId))
}
