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

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { emailChangeRequests, users } from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { errorMessage } from '../common/error-message'
import { WRONG_PASSWORD_MESSAGE } from '../common/current-password'
import { StepUpService, STEP_UP_COLUMNS } from '../mfa/step-up.service'
import { endOtherSessions } from '../common/other-sessions'
import type { UserRole } from '../users/dto/create-user.dto'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// "Changing" to the same password changes nothing — and a person who types
// their current one twice probably meant to choose a new one. Judged on the
// two typed values (the current one is then checked against the hash).
export const SAME_PASSWORD_MESSAGE =
  'Your new password must be different from your current one'

// --- TYPES -------------------------------------------------------------------------------------------------

type SignedInUser = { id: number; activeRole: UserRole }

export interface PasswordChange {
  currentPassword: string
  newPassword: string
  // Only for an account with two-factor sign-in on (the step-up asks it): a
  // code from the app or a recovery code.
  mfaCode?: string
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// Changing one's own password from the profile ("Change password", Phase 6 —
// decisions §13). The person's choices: every OTHER session signed out,
// always; a pending email change cancelled (reason `password_changed`); a
// wrong current password refused — and, since the privacy and security pass
// (decisions §16), recorded and counted (StepUpService.attempt — its `failed`).
//
//   check the two values ──► hash the new one ──► ONE transaction:
//     lock the account · the step-up (the current password, and a
//     two-factor code if the account has it on) · store the new hash ·
//     clear an unused reset link · cancel a pending email change ·
//     end the other sessions · ONE audit entry
//   ──► after the commit: close those sessions' sockets, email a notice.
@Injectable()
export class PasswordChangeService {
  private readonly logger = new Logger(PasswordChangeService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly messagingEvents: MessagingEvents,
    private readonly stepUp: StepUpService,
  ) {}

  // `keptSessionId`: the session making the request — the one that stays
  // signed in. Every other session of the account ends. (And the one signed
  // out, should this be its 5th failed step-up in a row.)
  async change(
    currentUser: SignedInUser,
    { currentPassword, newPassword, mfaCode }: PasswordChange,
    keptSessionId: string,
  ): Promise<void> {
    if (newPassword === currentPassword) {
      throw new BadRequestException(SAME_PASSWORD_MESSAGE)
    }

    // Hashed BEFORE the transaction: bcrypt is deliberately slow (~70 ms at
    // cost 10), and the account's row is locked for the whole transaction —
    // no reason to hold the lock while hashing. Cost 10, as every password
    // the app stores (reset, invitation, first admin).
    const newPasswordHash = await bcrypt.hash(newPassword, 10)

    // This request's step-up: confirmed inside the transaction, its `failed`
    // in the `.catch` below (StepUpService.attempt).
    const attempt = this.stepUp.attempt(
      currentUser,
      keptSessionId,
      'password_change',
    )
    const outcome = await withRlsContext(this.db, currentUser, async (tx) => {
      // The account's row, LOCKED until the commit, and the step-up checked
      // against what the lock returns. Checking first and
      // writing later — two steps with a gap between them — would let two
      // changes made at once (two tabs; an attacker racing the owner) both
      // pass against the SAME old password, the later one silently
      // replacing the earlier. With the lock, the second waits here, then
      // reads the NEW hash — and its "current password" no longer matches.
      // (A "time of check to time of use" race, closed by checking under
      // the lock.)
      const [account] = await tx
        .select({
          resetTokenHash: users.passwordResetTokenHash,
          ...STEP_UP_COLUMNS,
        })
        .from(users)
        .where(eq(users.id, currentUser.id))
        .for('update')
      // Throwing inside the transaction rolls it back: nothing is stored.
      // A wrong password or code is recorded AFTER that, on its own
      // (`.catch` below — decisions §16). `!account` keeps TypeScript on
      // the safe side — the same refusal (not counted: nothing was guessed).
      if (!account) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      const stepUp = await attempt.confirm(tx, account, {
        currentPassword,
        mfaCode,
      })

      // The new password — and an unused reset link dies with the old
      // one: it was asked for under the old password, and a link lying in
      // an inbox must not undo a change made since.
      await tx
        .update(users)
        .set({
          passwordHash: newPasswordHash,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        })
        .where(eq(users.id, currentUser.id))

      // A pending change of sign-in email is cancelled, as a reset does
      // (the person's choice): whoever changes the password may be locking
      // out someone who knew the old one — and who may have asked to move
      // the account to their own inbox. Its own reason, so the record says
      // a CHANGE happened, not a reset. (The guard trigger sets
      // cancelled_at to the database's now(); the value just has to be
      // non-null here.)
      const cancelled = await tx
        .update(emailChangeRequests)
        .set({ cancelledAt: sql`now()`, cancelReason: 'password_changed' })
        .where(
          and(
            eq(emailChangeRequests.userId, currentUser.id),
            isNull(emailChangeRequests.confirmedAt),
            isNull(emailChangeRequests.cancelledAt),
          ),
        )
        .returning({ id: emailChangeRequests.id })

      // Signed out everywhere else, always (the person's choice): if
      // someone else was signed in with the old password, they are out
      // now. This browser stays. In the transaction (common/
      // other-sessions.ts): if anything fails, the password AND the
      // sessions stay as they were; the ids, to close their sockets after
      // the commit.
      const endedSessionIds = await endOtherSessions(
        tx,
        currentUser.id,
        keptSessionId,
      )

      // ONE entry, in the transaction (the convention). Never the password
      // or its hash — what changed, and what else stopped working.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'PASSWORD_CHANGED',
        targetUserId: currentUser.id,
        entityType: 'users',
        entityId: currentUser.id,
        details: {
          signedOutSessions: endedSessionIds.length,
          ...(cancelled.length > 0
            ? { cancelledEmailChangeRequestId: cancelled[0].id }
            : {}),
          ...(account.resetTokenHash !== null
            ? { cancelledResetLink: true }
            : {}),
        },
      })

      return {
        email: account.email,
        firstName: account.firstName,
        endedSessionIds,
        stepUp,
      }
    }).catch(
      // Once the transaction above has rolled back: a failed step-up
      // recorded and counted (the 5th in a row signs this session out), or
      // — the step-up passed but the change failed — the code spent anyway.
      attempt.failed,
    )

    // A recovery code's notice, if one was used (StepUpService).
    outcome.stepUp.afterCommit()

    // After the commit. A socket was authenticated once, at its handshake:
    // without this, a signed-out device would keep receiving messages (as on
    // logout, a reset, an email change).
    for (const sessionId of outcome.endedSessionIds) {
      this.messagingEvents.disconnectSession(sessionId)
    }
    // Fire-and-forget: the password IS changed whatever the mail server does.
    // A failure is logged with its reason (errorMessage — the logger would
    // drop a second argument).
    this.emailService
      .sendPasswordChangedNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Failed to send the password-changed notice to user ${currentUser.id}: ${errorMessage(error)}`,
        ),
      )
  }
}
