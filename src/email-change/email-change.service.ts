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
import { and, eq, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes } from 'crypto'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { emailChangeRequests, users } from '../database/schema'
import {
  applyUserContext,
  withEmailChangeTokenContext,
  withRlsContext,
} from '../database/rls-context'
import { isUniqueViolation, USERS_EMAIL_UNIQUE } from '../database/pg-errors'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { UsersService } from '../users/users.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { errorMessage } from '../common/error-message'
import {
  isCurrentPassword,
  WRONG_PASSWORD_MESSAGE,
} from '../common/current-password'
import type { UserRole } from '../users/dto/create-user.dto'
import { maskEmail } from './mask-email'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// How long the confirm link works (decisions §12): long enough to switch to
// the other inbox, or to do it tomorrow morning; short enough that a link
// lying in a mailbox stops being a key. The expiry is computed IN SQL from
// this number (`now() + 24 hours`), and compared with `now()` in SQL — one
// clock.
export const EMAIL_CHANGE_VALID_HOURS = 24

// Every way a link can be dead — never sent, used, replaced, cancelled,
// expired, its account deactivated — gets this one answer: which of them it
// is tells a link-holder nothing useful, and an attacker probing tokens
// even less.
export const INVALID_EMAIL_CHANGE_LINK_MESSAGE =
  'This link is invalid or has expired'
export const SAME_EMAIL_MESSAGE = 'This is already your email address'
// The one case the confirmation can't complete although the link is good:
// someone took the address between the request and the click. Saying so
// reveals nothing — the person clicking holds that inbox.
export const ADDRESS_TAKEN_ON_CONFIRM_MESSAGE =
  'This address now belongs to another Stride account, so your email was not changed'
// The cancel link of a change already confirmed: too late to stop it. The
// old address is no longer the account's, so "reset your password" from it
// would find nothing — the clinic is the way back.
export const ALREADY_CONFIRMED_MESSAGE =
  'This change has already been confirmed. If you did not ask for it, contact your clinic.'

// --- TYPES -------------------------------------------------------------------------------------------------

// What the person sees of their own open request (GET / POST). The full new
// address: it is theirs, and it's how they spot a typo before the email
// lands nowhere. (The OLD inbox is shown it masked — that's another reader.)
export interface PendingEmailChange {
  newEmail: string
  createdAt: Date
  expiresAt: Date
}

type SignedInUser = { id: number; activeRole: UserRole }

// The confirming browser's session id: the one session to KEEP when the
// account is signed out everywhere else. No need to ask whose it is: the
// DELETE below only touches this account's sessions, so the id matches one of
// them only if this browser IS signed in as the account (a browser signed in
// as someone else, or not at all, keeps nothing of the account's). A test of
// "is it the same user?" was written first, and a mutation removing it
// survived — it could never change the outcome.
export interface ConfirmingSession {
  sessionId: string
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// Changing one's own sign-in email ("Change email", Phase 6 — decisions §12).
//
//   request ──► open row ──► confirm (link to the NEW inbox) ──► users.email
//                     │
//                     └────► cancelled: replaced by a new request · from the
//                            profile · by the link sent to the OLD inbox ·
//                            by a password reset (AuthService)
//
// Every write is ONE audit entry in its own transaction (the convention).
// Emails go out AFTER the commit, fire-and-forget: a failed email is logged,
// never a failed request — and, for the request, the answer then takes the
// same time whether the address is free or taken.
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly usersService: UsersService,
    private readonly messagingEvents: MessagingEvents,
  ) {}

  // === READ ===================================================================

  // The open request that can still be confirmed, or null. An expired one
  // isn't "pending" any more (its link is dead), though it stays open in the
  // table until the next request replaces it — harmless: nothing confirms it.
  async findPending(
    currentUser: SignedInUser,
  ): Promise<PendingEmailChange | null> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [row] = await tx
        .select({
          newEmail: emailChangeRequests.newEmail,
          createdAt: emailChangeRequests.createdAt,
          expiresAt: emailChangeRequests.expiresAt,
        })
        .from(emailChangeRequests)
        .where(
          and(
            eq(emailChangeRequests.userId, currentUser.id),
            isNull(emailChangeRequests.confirmedAt),
            isNull(emailChangeRequests.cancelledAt),
            sql`${emailChangeRequests.expiresAt} > now()`,
          ),
        )
      return row ?? null
    })
  }

  // === REQUEST ================================================================

  // Asks to move the signed-in account to `newEmail` (already normalised by
  // the DTO). The current password first: a session alone mustn't move the
  // sign-in.
  //
  // "Reveal nothing" (the person's choice): the answer is the same whether
  // the address is free or already an account's — the request is stored
  // either way, the old inbox gets its notice either way; only what the NEW
  // inbox receives differs (a link, or "this address already has an
  // account"), and only whoever reads that inbox sees it. Whether it was
  // taken is not even in the audit entry.
  async request(
    currentUser: SignedInUser,
    newEmail: string,
    currentPassword: string,
  ): Promise<PendingEmailChange> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    // The step-up rule shared with changing the password
    // (common/current-password.ts). `!user` keeps TypeScript on the safe
    // side — the same refusal as a wrong password.
    if (
      !user ||
      !(await isCurrentPassword(user.passwordHash, currentPassword))
    ) {
      throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
    }
    if (newEmail === user.email) {
      throw new BadRequestException(SAME_EMAIL_MESSAGE)
    }

    // Two tokens, 256 random bits each (as for reset and invitations): the
    // raw ones are emailed and forgotten, only their hashes are stored.
    const confirmToken = randomBytes(32).toString('hex')
    const cancelToken = randomBytes(32).toString('hex')

    const { pending, taken } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        // The account's row, locked until the commit: two requests from the
        // same person (two tabs) run one after the other, so the second one
        // sees — and replaces — the first's request instead of both finding
        // "nothing open" and the second failing on the one-open index.
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, currentUser.id))
          .for('update')

        // One open request per account: an earlier one closes (its links
        // die). cancelled_at's value is the trigger's (now()); the column
        // just has to be non-null here.
        const replaced = await tx
          .update(emailChangeRequests)
          .set({ cancelledAt: sql`now()`, cancelReason: 'replaced' })
          .where(
            and(
              eq(emailChangeRequests.userId, currentUser.id),
              isNull(emailChangeRequests.confirmedAt),
              isNull(emailChangeRequests.cancelledAt),
            ),
          )
          .returning({ id: emailChangeRequests.id })

        const [row] = await tx
          .insert(emailChangeRequests)
          .values({
            userId: currentUser.id,
            newEmail,
            tokenHash: sha256(confirmToken),
            cancelTokenHash: sha256(cancelToken),
            expiresAt: sql`now() + make_interval(hours => ${EMAIL_CHANGE_VALID_HOURS})`,
          })
          .returning()

        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'EMAIL_CHANGE_REQUESTED',
          targetUserId: currentUser.id,
          entityType: 'email_change_requests',
          entityId: row.id,
          details: {
            newEmail,
            expiresAt: row.expiresAt,
            ...(replaced.length > 0
              ? { replacedRequestId: replaced[0].id }
              : {}),
          },
        })

        // Which email the NEW address gets. A plain read, not a guard: the
        // UNIQUE on users.email is what decides, at the confirmation.
        const owner = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, newEmail))
        return {
          pending: {
            newEmail: row.newEmail,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
          },
          taken: owner.length > 0,
        }
      },
    )

    // After the commit — never a link to a request that was rolled back.
    if (taken) {
      this.sendAfterCommit('address-taken notice', newEmail, () =>
        this.emailService.sendEmailChangeAddressTaken(newEmail),
      )
    } else {
      this.sendAfterCommit('confirmation link', newEmail, () =>
        this.emailService.sendEmailChangeConfirmation({
          to: newEmail,
          firstName: user.firstName,
          rawToken: confirmToken,
          validForHours: EMAIL_CHANGE_VALID_HOURS,
        }),
      )
    }
    this.sendAfterCommit('change-requested notice', user.email, () =>
      this.emailService.sendEmailChangeRequestedNotice({
        to: user.email,
        firstName: user.firstName,
        maskedNewEmail: maskEmail(newEmail),
        rawCancelToken: cancelToken,
      }),
    )

    return pending
  }

  // === CANCEL (signed in) =====================================================

  // "Cancel" on the profile. Nothing open → nothing written (no entry for a
  // request that changes nothing — the convention); the answer is the same.
  async cancelPending(currentUser: SignedInUser): Promise<void> {
    await withRlsContext(this.db, currentUser, async (tx) => {
      const cancelled = await tx
        .update(emailChangeRequests)
        .set({ cancelledAt: sql`now()`, cancelReason: 'cancelled_in_app' })
        .where(
          and(
            eq(emailChangeRequests.userId, currentUser.id),
            isNull(emailChangeRequests.confirmedAt),
            isNull(emailChangeRequests.cancelledAt),
          ),
        )
        .returning({ id: emailChangeRequests.id })
      if (cancelled.length === 0) return

      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'EMAIL_CHANGE_CANCELLED',
        targetUserId: currentUser.id,
        entityType: 'email_change_requests',
        entityId: cancelled[0].id,
        details: { reason: 'cancelled_in_app' },
      })
    })
  }

  // === CONFIRM (the link sent to the new address) =============================

  // Makes the change. Public — the link may be opened on any device, signed
  // in or not: holding the token proves the new inbox, and the password was
  // checked when the change was asked for.
  //
  // In ONE transaction: the request (locked), the account (locked), the new
  // email, the request closed, the account's OTHER sessions ended, the
  // entry. Then, after the commit, their sockets closed and the old address
  // told.
  async confirm(
    rawToken: string,
    confirming: ConfirmingSession,
  ): Promise<{ email: string }> {
    const outcome = await withEmailChangeTokenContext(
      this.db,
      { kind: 'confirm', tokenHash: sha256(rawToken) },
      async (tx) => {
        // The row this token reaches (the policy shows no other), locked so
        // a second click — or the cancel link at the same moment — waits
        // here and then finds it closed. `expired` is computed by the
        // database's clock, like the expiry itself.
        const [request] = await tx
          .select({
            id: emailChangeRequests.id,
            userId: emailChangeRequests.userId,
            newEmail: emailChangeRequests.newEmail,
            confirmedAt: emailChangeRequests.confirmedAt,
            cancelledAt: emailChangeRequests.cancelledAt,
            expired: sql<boolean>`${emailChangeRequests.expiresAt} <= now()`,
          })
          .from(emailChangeRequests)
          .where(eq(emailChangeRequests.tokenHash, sha256(rawToken)))
          .for('update')
        if (
          !request ||
          request.confirmedAt !== null ||
          request.cancelledAt !== null ||
          request.expired
        ) {
          throw new BadRequestException(INVALID_EMAIL_CHANGE_LINK_MESSAGE)
        }

        // From here the transaction also acts AS the account — the token has
        // just proven whose it is, the same synthetic self-context as a
        // password reset — so users_update lets it change the email.
        const roles = await this.usersService.getRolesForUser(
          request.userId,
          tx,
        )
        await applyUserContext(tx, {
          id: request.userId,
          activeRole: roles[0] as UserRole,
        })
        const [account] = await tx
          .select({
            email: users.email,
            firstName: users.firstName,
            isActive: users.isActive,
          })
          .from(users)
          .where(eq(users.id, request.userId))
          .for('update')
        // A deactivated account isn't moved: an admin closed it, and a link
        // still lying in a mailbox mustn't change it behind their back.
        if (!account?.isActive) {
          throw new BadRequestException(INVALID_EMAIL_CHANGE_LINK_MESSAGE)
        }

        await tx
          .update(users)
          .set({ email: request.newEmail })
          .where(eq(users.id, request.userId))
        await tx
          .update(emailChangeRequests)
          .set({ confirmedAt: sql`now()` })
          .where(eq(emailChangeRequests.id, request.id))

        // Signed out everywhere else (the person's choice): the recovery
        // address just changed, so every other session ends — the one
        // confirming stays if it is one of this account's (see
        // ConfirmingSession). RETURNING the ids: their sockets are closed
        // after the commit.
        const ended = await tx.execute<{ sid: string }>(
          sql`DELETE FROM session
               WHERE (sess::jsonb)->'passport'->'user'->>'id' = ${String(request.userId)}
                 AND sid <> ${confirming.sessionId}
           RETURNING sid`,
        )

        await this.auditService.logInTransaction(tx, {
          performedBy: request.userId,
          action: 'EMAIL_CHANGE_CONFIRMED',
          targetUserId: request.userId,
          entityType: 'users',
          entityId: request.userId,
          details: {
            requestId: request.id,
            changes: { email: { from: account.email, to: request.newEmail } },
            signedOutSessions: ended.rows.length,
          },
        })
        return {
          oldEmail: account.email,
          newEmail: request.newEmail,
          firstName: account.firstName,
          endedSessionIds: ended.rows.map((row) => row.sid),
        }
      },
    ).catch((error: unknown) => {
      // Someone took the address since the request: the UNIQUE refuses the
      // UPDATE, the transaction is undone (the request stays open, its link
      // still the same — and still refused, until it expires).
      if (isUniqueViolation(error, USERS_EMAIL_UNIQUE)) {
        throw new ConflictException(ADDRESS_TAKEN_ON_CONFIRM_MESSAGE)
      }
      throw error
    })

    // A socket was authenticated once, at its handshake: without this, a
    // signed-out device would keep receiving messages (logout does the same).
    for (const sessionId of outcome.endedSessionIds) {
      this.messagingEvents.disconnectSession(sessionId)
    }
    this.sendAfterCommit('email-changed notice', outcome.oldEmail, () =>
      this.emailService.sendEmailChangedNotice({
        to: outcome.oldEmail,
        firstName: outcome.firstName,
        maskedNewEmail: maskEmail(outcome.newEmail),
      }),
    )
    return { email: outcome.newEmail }
  }

  // === CANCEL (the link sent to the old address) ==============================

  // Stops a change from the OLD inbox. Public, like the confirmation. A
  // request cancelled already (the person, a newer request, a reset) answers
  // the same and writes nothing; one confirmed already is too late — 409.
  async cancelByLink(rawToken: string): Promise<void> {
    await withEmailChangeTokenContext(
      this.db,
      { kind: 'cancel', tokenHash: sha256(rawToken) },
      async (tx) => {
        const [request] = await tx
          .select({
            id: emailChangeRequests.id,
            userId: emailChangeRequests.userId,
            confirmedAt: emailChangeRequests.confirmedAt,
            cancelledAt: emailChangeRequests.cancelledAt,
          })
          .from(emailChangeRequests)
          .where(eq(emailChangeRequests.cancelTokenHash, sha256(rawToken)))
          .for('update')
        if (!request) {
          throw new BadRequestException(INVALID_EMAIL_CHANGE_LINK_MESSAGE)
        }
        if (request.confirmedAt !== null) {
          throw new ConflictException(ALREADY_CONFIRMED_MESSAGE)
        }
        if (request.cancelledAt !== null) return

        await tx
          .update(emailChangeRequests)
          .set({
            cancelledAt: sql`now()`,
            cancelReason: 'cancelled_by_email_link',
          })
          .where(eq(emailChangeRequests.id, request.id))
        // Performed by the account's owner: the old inbox is theirs (it is
        // still the account's sign-in — the change wasn't confirmed).
        await this.auditService.logInTransaction(tx, {
          performedBy: request.userId,
          action: 'EMAIL_CHANGE_CANCELLED',
          targetUserId: request.userId,
          entityType: 'email_change_requests',
          entityId: request.id,
          details: { reason: 'cancelled_by_email_link' },
        })
      },
    )
  }

  // === HELPERS ================================================================

  // Fire-and-forget: the request has succeeded whatever the mail server
  // does. A failure is logged with its reason (errorMessage — the logger
  // would drop a second argument), never with a token.
  private sendAfterCommit(
    what: string,
    to: string,
    send: () => Promise<void>,
  ): void {
    send().catch((error: unknown) =>
      this.logger.error(
        `Failed to send the ${what} to ${to}: ${errorMessage(error)}`,
      ),
    )
  }
}

// SHA-256 as 64 hex characters — what the table stores, and what the token
// branches of the policies compare.
function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
