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
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import * as QRCode from 'qrcode'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { users } from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { errorMessage } from '../common/error-message'
import {
  confirmStepUp,
  isCurrentPassword,
  STEP_UP_COLUMNS,
  WRONG_PASSWORD_MESSAGE,
} from '../common/current-password'
import { endOtherSessions } from '../common/other-sessions'
import { encryptMfaSecret } from '../auth/mfa-secret-crypto'
import type { UserRole } from '../users/dto/create-user.dto'
import {
  checkMfaCode,
  mfaCodeRefusalMessage,
  mfaKeyUri,
  newMfaSecret,
  recordMfaStep,
  useMfaCode,
} from './totp'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Set-up while MFA is on would REPLACE the secret the person's app uses —
// their next sign-in would fail (the bug this item fixed: setup never looked
// at mfaEnabled). Changing phone = turn it off, then set up again. Also the
// answer to "enable" when it's already on: nothing to do, and nothing done.
export const MFA_ALREADY_ON_MESSAGE =
  'Two-factor sign-in is already on for this account'
export const MFA_NOT_ON_MESSAGE =
  'Two-factor sign-in is not on for this account'
// "Enable" with no set-up started: there is no secret to check a code against.
export const MFA_SETUP_FIRST_MESSAGE =
  'Start setting up two-factor sign-in first'

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

// --- SERVICE -----------------------------------------------------------------------------------------------

// Two-factor sign-in with an authenticator app (TOTP) — MFA enrolment,
// Phase 6. The life of it:
//
//   setup (password) ──► a new secret stored, not yet in force; the QR shown
//   enable (a code from that secret) ──► ON; other devices signed out
//   sign-in: password, then a code (AuthController's mfa/verify → verifySignIn)
//   disable (password + a code) ──► OFF, the secret deleted
//
// Every method LOCKS the account's row first (SELECT … FOR UPDATE) and does
// its checks against what the lock returned, in ONE transaction with its
// write and its ONE audit entry. Two reasons: a code is recorded as used
// (mfa/totp.ts — two requests with the same code must not both find it
// unused), and a set-up in another tab must not change the secret between
// "the code matches it" and "MFA is on" (it could otherwise turn MFA on with
// a secret nobody scanned).
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly messagingEvents: MessagingEvents,
  ) {}

  // === SET-UP =================================================================

  // A new secret, stored ENCRYPTED and not yet in force (mfaEnabled stays
  // false until enable confirms a code from it). Asks for the password (the
  // step-up); refused while MFA is on. A set-up started earlier and never
  // confirmed is simply replaced — its QR code stops working.
  async setup(
    currentUser: SignedInUser,
    currentPassword: string,
  ): Promise<MfaSetup> {
    const secret = newMfaSecret()

    const email = await withRlsContext(this.db, currentUser, async (tx) => {
      const account = await lockAccount(tx, currentUser.id)
      // The password only — not confirmStepUp: MFA is off here (on is
      // refused just below), so there is no code to ask. Password FIRST:
      // without it, the request learns nothing, not even whether MFA is on.
      if (
        !account ||
        !(await isCurrentPassword(account.passwordHash, currentPassword))
      ) {
        throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      }
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
    })

    // After the commit — the QR code is drawn from data that is now stored.
    // The label is the sign-in email, what the app shows next to the codes.
    const otpauthUrl = mfaKeyUri(email, secret)
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl)
    return { secret, otpauthUrl, qrCodeDataUrl }
  }

  // === ENABLE =================================================================

  // Turns MFA ON once a code from the set-up secret is right — the proof that
  // the person's app really holds it. Then every OTHER session ends (the
  // sessions opened with the password alone); this browser stays.
  // `keptSessionId`: the session making the request.
  async enable(
    currentUser: SignedInUser,
    code: string,
    keptSessionId: string,
  ): Promise<void> {
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
      // Wrong or already used → 400; a good code is recorded as used.
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
  }

  // === DISABLE ================================================================

  // Turns MFA OFF: the password AND a current code (the step-up, which asks
  // the code because MFA is on). The secret is deleted with it — setting up
  // again starts from a new one.
  async disable(
    currentUser: SignedInUser,
    currentPassword: string,
    code: string,
  ): Promise<void> {
    const outcome = await withRlsContext(this.db, currentUser, async (tx) => {
      const account = await lockAccount(tx, currentUser.id)
      if (!account) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      // The password first (inside confirmStepUp); for an account with MFA
      // on, then the code — recorded as used.
      await confirmStepUp(tx, currentUser.id, account, {
        currentPassword,
        mfaCode: code,
      })
      // Off already: confirmStepUp checked only the password; nothing to do.
      if (!account.mfaEnabled) {
        throw new BadRequestException(MFA_NOT_ON_MESSAGE)
      }
      // The last-used step goes too: it belonged to this secret, and a code
      // of the same 30 seconds from the NEXT set-up's secret must not be
      // refused as "already used". (Cleared here, it stays null while MFA is
      // off — set-up relies on that.)
      await tx
        .update(users)
        .set({ mfaEnabled: false, mfaSecret: null, mfaLastUsedStep: null })
        .where(eq(users.id, currentUser.id))
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MFA_DISABLED',
        targetUserId: currentUser.id,
        entityType: 'users',
        entityId: currentUser.id,
      })
      return { email: account.email, firstName: account.firstName }
    })

    this.notify('disabled notice', outcome.email, () =>
      this.emailService.sendMfaDisabledNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      }),
    )
  }

  // === SIGN-IN ================================================================

  // The second step of signing in: is `code` good for the account whose
  // password was just checked (the session's mfaPending)? Answers a boolean —
  // the controller decides (sign in, or 401) — but writes in both cases, in
  // ONE transaction under the row lock: a good code is recorded as used; a
  // refused one leaves an MFA_LOGIN_FAILURE entry (the password was right,
  // so wrong codes against one account are the brute-force signal — decided
  // in the audit review), with WHY it was refused. A replayed code is the
  // stronger signal: someone else has seen one of this person's codes.
  //
  // Acts AS the account (its id and the role being signed into) for row
  // security — the session isn't signed in yet, but the users UPDATE policy
  // lets an account write its own row, which is all this does.
  async verifySignIn(
    pending: { userId: number; activeRole: UserRole },
    code: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return withRlsContext(
      this.db,
      { id: pending.userId, activeRole: pending.activeRole },
      async (tx) => {
        const account = await lockAccount(tx, pending.userId)
        // MFA turned off from another device since the password step (or
        // never on): no secret to check against — refused, like a wrong
        // code, but not recorded (nobody guessed anything).
        if (!account?.mfaEnabled || account.mfaSecret === null) {
          return { ok: false, message: mfaCodeRefusalMessage('wrong_code') }
        }
        const check = await checkMfaCode(
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
          return { ok: false, message: mfaCodeRefusalMessage(check.reason) }
        }
        await recordMfaStep(tx, pending.userId, check.step)
        return { ok: true }
      },
    )
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
    .select({
      email: users.email,
      firstName: users.firstName,
      ...STEP_UP_COLUMNS,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
  return account
}
