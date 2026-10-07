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
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import * as bcrypt from 'bcrypt'
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  clinics,
  invitations,
  userClinics,
  userRoles,
  users,
} from '../database/schema'
import {
  applyUserContext,
  withInvitationTokenContext,
  withRlsContext,
} from '../database/rls-context'
import { INVITATIONS_ONE_OPEN, isUniqueViolation } from '../database/pg-errors'
import { AuditService } from '../audit/audit.service'
import { CareTeamService, type Actor } from '../care-team/care-team.service'
import { EmailService } from '../email/email.service'
import { UserRole } from '../users/dto/create-user.dto'
import { invitationStatus, type InvitationStatus } from './invitation-status'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// How long an invitation link works (design decisions §3). The recipient
// isn't expecting the email, so longer than a password reset's 1 hour.
export const INVITATION_VALIDITY_DAYS = 7

// --- TYPES -------------------------------------------------------------------------------------------------

export interface PersonRef {
  id: number
  firstName: string
  lastName: string
}

// One invitation as the API returns it. Never the token or its hash.
export interface InvitationSummary {
  id: number
  status: InvitationStatus
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
  invitedBy: PersonRef
  revokedBy: PersonRef | null
}

// What "send" returns: the new invitation, plus whether its email went out.
// A failed email doesn't fail the request (decisions §3): the invitation
// exists, and the screen can offer to send it again.
export interface SentInvitation extends InvitationSummary {
  emailSent: boolean
}

// What the accept page shows before the person chooses a password. Only
// returned to someone holding the token — 256 random bits, emailed to that
// person — so nothing here is revealed to anyone else.
export interface InvitationPreview {
  email: string
  firstName: string
  lastName: string
  clinicNames: string[]
  expiresAt: Date
}

// Why an invitation can no longer be used. Sent to the client in the 410's
// body as `reason`, so the accept page can show the right next step
// without parsing the English message.
export type UnusableReason =
  Exclude<InvitationStatus, 'pending'> | 'deactivated'

const UNUSABLE_MESSAGES: Record<UnusableReason, string> = {
  accepted:
    'This invitation has already been used. Sign in with the password you chose.',
  // "Revoked" covers both an invitation cancelled on purpose and one
  // replaced by a newer email ("resend" closes the old one).
  revoked:
    'This invitation was cancelled or replaced by a newer one. Use the most recent invitation email, or ask your clinic for a new one.',
  expired:
    'This invitation has expired. Ask your clinic to send you a new one.',
  deactivated: 'This account has been deactivated.',
}

type InvitationRow = typeof invitations.$inferSelect

// The invited account's fields this service needs. passwordHash is read
// only to ask "has this person chosen a password yet?" — never returned.
interface InvitedAccount {
  id: number
  email: string
  firstName: string
  lastName: string
  isActive: boolean
  passwordHash: string | null
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// SHA-256 of the raw token, as stored in invitations.token_hash. Plain
// SHA-256 rather than bcrypt, same reasoning as password reset
// (AuthService.forgotPassword): bcrypt's slowness protects LOW-entropy,
// human-chosen secrets; a 256-bit random token can't be guessed however
// fast the hash. And a deterministic hash is what makes it searchable —
// "which invitation is this token?" is an indexed equality lookup.
export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function gone(reason: UnusableReason): GoneException {
  // An object body: HttpExceptionFilter keeps `message` and passes any
  // other field (here `reason`) through to the JSON response.
  return new GoneException({ message: UNUSABLE_MESSAGES[reason], reason })
}

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly careTeamService: CareTeamService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  // === MANAGING INVITATIONS (signed in) ===================================

  // --- GET /users/:id/invitations ---

  // Every invitation ever sent to this account, newest first — the open one
  // (if any) and the history behind it.
  async listForUser(
    userId: number,
    actor: Actor,
  ): Promise<InvitationSummary[]> {
    await this.findManageableAccount(userId, actor)
    return this.findSummaries(actor, { userId })
  }

  // --- POST /users/:id/invitations ---

  // Sends an invitation — the first one, or a new one replacing the open
  // one ("resend"). Closing the old one and inserting the new one happen in
  // ONE transaction, so there's never a moment with two working links, nor
  // one with none if the insert fails.
  async send(userId: number, actor: Actor): Promise<SentInvitation> {
    const account = await this.findManageableAccount(userId, actor)
    if (!account.isActive) {
      throw new ConflictException(
        'This account is deactivated. Reactivate it before sending an invitation.',
      )
    }
    if (account.passwordHash !== null) {
      throw new ConflictException(
        'This account is already set up: its owner has chosen a password.',
      )
    }

    let issued: { invitation: InvitationRow; token: string; resent: boolean }
    try {
      issued = await withRlsContext(this.db, actor, async (tx) => {
        const closed = await tx
          .update(invitations)
          .set({ revokedAt: sql`now()`, revokedBy: actor.id })
          .where(and(eq(invitations.userId, userId), openInvitation()))
          .returning({ id: invitations.id })
        const created = await this.insertInvitation(tx, userId, actor.id)
        return { ...created, resent: closed.length > 0 }
      })
    } catch (error) {
      // Two "send" clicks at the same moment: each transaction closed what
      // it saw open and inserted a new row, and the database's partial
      // unique index refused the second open invitation. The winner's link
      // is the one that works.
      if (isUniqueViolation(error, INVITATIONS_ONE_OPEN)) {
        throw new ConflictException(
          'Another invitation for this account was sent at the same moment. Refresh to see it.',
        )
      }
      throw error
    }

    // After the transaction has committed: the invitation exists whatever
    // happens to the email. (Sent before commit, a failed commit would leave
    // someone holding a link to an invitation that never existed.)
    const emailSent = await this.deliver(account, issued.token, actor)

    await this.auditService.log({
      performedBy: actor.id,
      action: issued.resent ? 'INVITATION_RESENT' : 'INVITATION_SENT',
      targetUserId: userId,
      entityType: 'invitations',
      entityId: issued.invitation.id,
      details: { emailSent },
    })

    const summary = await this.findSummaryOrThrow(issued.invitation.id, actor)
    return { ...summary, emailSent }
  }

  // --- POST /users/:id/invitations/revoke ---

  // Closes the open invitation: its link stops working. The account stays
  // (it simply can't be entered); an admin can deactivate it, or anyone
  // allowed can send a new invitation later.
  async revoke(userId: number, actor: Actor): Promise<InvitationSummary> {
    await this.findManageableAccount(userId, actor)

    // The "still open?" condition is part of the UPDATE itself (same
    // pattern as ending a care-team link): two simultaneous revokes can't
    // both succeed, and the second one gets a clean 404.
    const [revoked] = await withRlsContext(this.db, actor, (tx) =>
      tx
        .update(invitations)
        .set({ revokedAt: sql`now()`, revokedBy: actor.id })
        .where(and(eq(invitations.userId, userId), openInvitation()))
        .returning({ id: invitations.id }),
    )
    if (!revoked) {
      throw new NotFoundException(
        'This account has no open invitation to revoke',
      )
    }

    await this.auditService.log({
      performedBy: actor.id,
      action: 'INVITATION_REVOKED',
      targetUserId: userId,
      entityType: 'invitations',
      entityId: revoked.id,
    })

    return this.findSummaryOrThrow(revoked.id, actor)
  }

  // Inserts a new open invitation inside the CALLER's transaction and
  // returns it with its raw token (the only moment the raw token exists on
  // the server — it goes into the email, never into the database).
  //
  // Public because step 3 needs it: creating an account (UsersService) will
  // insert the user AND their first invitation in one transaction, then
  // send the email after commit — the same order as send() above.
  async insertInvitation(
    tx: DrizzleDb,
    userId: number,
    invitedBy: number,
  ): Promise<{ invitation: InvitationRow; token: string }> {
    const token = randomBytes(32).toString('hex')
    const [invitation] = await tx
      .insert(invitations)
      .values({
        userId,
        tokenHash: hashInvitationToken(token),
        invitedBy,
        // The DATABASE's clock, not this server's: created_at defaults to
        // now() and accept() compares against now(), so all three readings
        // come from one clock. A server whose clock drifts from the
        // database's (Docker on Windows can drift by seconds) can't create
        // an invitation that expires early, or one that fails the
        // "expires after creation" CHECK.
        expiresAt: sql`now() + make_interval(days => ${INVITATION_VALIDITY_DAYS})`,
      })
      .returning()
    return { invitation, token }
  }

  // Emails an invitation. Never throws: a failure is logged and reported as
  // false, because the invitation itself is already saved — the caller
  // tells the person who sent it, and they can send it again.
  async deliver(
    account: Pick<InvitedAccount, 'id' | 'email' | 'firstName'>,
    rawToken: string,
    actor: Actor,
  ): Promise<boolean> {
    try {
      const [inviter] = await this.db
        .select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, actor.id))
      await this.emailService.sendInvitationEmail({
        to: account.email,
        rawToken,
        firstName: account.firstName,
        invitedByName: `${inviter.firstName} ${inviter.lastName}`,
        clinicNames: await this.findClinicNames(this.db, account.id),
        validForDays: INVITATION_VALIDITY_DAYS,
      })
      return true
    } catch (error) {
      this.logger.error(
        `Failed to send the invitation email to ${account.email}`,
        error,
      )
      return false
    }
  }

  // === USING AN INVITATION (the token holder, no session) =================

  // --- POST /invitations/lookup ---

  // What the accept page shows: whose account this is, and where. 404 for
  // a token that matches nothing; 410 Gone, with a `reason`, for one that
  // existed but can't be used anymore — "ask for a new one" is a different
  // next step from "this link is wrong".
  async lookup(rawToken: string): Promise<InvitationPreview> {
    const tokenHash = hashInvitationToken(rawToken)
    return withInvitationTokenContext(this.db, tokenHash, async (tx) => {
      const invitation = await this.findByTokenHash(tx, tokenHash)
      const account = await this.findAccount(tx, invitation.userId)
      assertUsable(invitation, account)
      return {
        email: account.email,
        firstName: account.firstName,
        lastName: account.lastName,
        clinicNames: await this.findClinicNames(tx, account.id),
        expiresAt: invitation.expiresAt,
      }
    })
  }

  // --- POST /invitations/accept ---

  // Sets the account's first password and closes the invitation, in one
  // transaction. The person then signs in normally (no automatic login —
  // decisions §3).
  async accept(rawToken: string, password: string): Promise<void> {
    const tokenHash = hashInvitationToken(rawToken)

    // Hashed BEFORE the transaction: bcrypt deliberately takes ~100 ms, and
    // a transaction that holds a lock on the invitation row (from the
    // UPDATE below) should be as short as possible. The cost is hashing for
    // requests that turn out to be invalid — bounded by the route's rate
    // limit.
    const passwordHash = await bcrypt.hash(password, 10)

    const accepted = await withInvitationTokenContext(
      this.db,
      tokenHash,
      async (tx) => {
        // THE single-use guarantee: one conditional UPDATE. Its WHERE
        // re-checks "still open and not expired" at the moment of writing,
        // and Postgres locks the row while doing it. If two tabs submit at
        // once, the second UPDATE waits for the first to commit, re-reads
        // the row, finds accepted_at set, and matches nothing — no
        // read-then-write gap for both to slip through.
        const [row] = await tx
          .update(invitations)
          .set({ acceptedAt: sql`now()` })
          .where(
            and(
              eq(invitations.tokenHash, tokenHash),
              openInvitation(),
              gt(invitations.expiresAt, sql`now()`),
            ),
          )
          .returning({ id: invitations.id, userId: invitations.userId })

        if (!row) {
          // Not accepted — work out why, for the right 404 or 410. These
          // checks run AFTER the decisive UPDATE, so they only explain the
          // outcome; they never decide it.
          const invitation = await this.findByTokenHash(tx, tokenHash)
          assertUsable(
            invitation,
            await this.findAccount(tx, invitation.userId),
          )
          // A pending, usable invitation that the UPDATE didn't match can
          // only be one that expired in the instant between the two
          // statements.
          throw gone('expired')
        }

        const account = await this.findAccount(tx, row.userId)
        // Throwing here rolls the whole transaction back, including the
        // accepted_at just written: a deactivated account's invitation
        // stays unaccepted.
        if (!account.isActive) throw gone('deactivated')

        // users_update (migration 0007) lets a session update its OWN row.
        // This transaction has no session, but the invitation just accepted
        // proves who it acts for — the same "synthetic self-context"
        // reasoning as AuthService.resetPassword(). The role value is inert
        // here (that branch never reads it), but the setting must hold a
        // real role.
        const [role] = await tx
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(eq(userRoles.userId, account.id))
          .orderBy(asc(userRoles.role))
          .limit(1)
        await applyUserContext(tx, {
          id: account.id,
          activeRole: role.role as UserRole,
        })

        // "AND password_hash IS NULL": an account that somehow already has
        // a password is never overwritten through an invitation.
        const updated = await tx
          .update(users)
          .set({ passwordHash })
          .where(and(eq(users.id, account.id), isNull(users.passwordHash)))
          .returning({ id: users.id })
        if (updated.length === 0) throw gone('accepted')

        return row
      },
    )

    // Performed by the account itself: accepting is the person's own act.
    await this.auditService.log({
      performedBy: accepted.userId,
      action: 'INVITATION_ACCEPTED',
      targetUserId: accepted.userId,
      entityType: 'invitations',
      entityId: accepted.id,
    })
  }

  // === PRIVATE ============================================================

  // The account whose invitations `actor` wants to manage — or the reason
  // they can't. Allowed: an admin (any account, staff included), or a
  // practitioner on the account's care team. Only patients HAVE a care
  // team, so a practitioner can never manage a staff account's invitation
  // — no separate role check needed. The same rule as the invitations
  // policies (migration 0021), which enforce it again in the database.
  private async findManageableAccount(
    userId: number,
    actor: Actor,
  ): Promise<InvitedAccount> {
    // users is readable without a session context (0007: login needs it).
    const account = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        passwordHash: true,
      },
    })
    if (!account) {
      throw new NotFoundException(`User ${userId} not found`)
    }
    if (actor.activeRole === UserRole.ADMIN) {
      return account
    }
    if (
      actor.activeRole === UserRole.PRACTITIONER &&
      (await this.careTeamService.isOnCareTeam(actor.id, userId))
    ) {
      return account
    }
    throw new ForbiddenException(
      "Only an admin, or a member of this patient's care team, can manage this account's invitations",
    )
  }

  private async findByTokenHash(
    tx: DrizzleDb,
    tokenHash: string,
  ): Promise<InvitationRow> {
    const invitation = await tx.query.invitations.findFirst({
      where: eq(invitations.tokenHash, tokenHash),
    })
    if (!invitation) {
      throw new NotFoundException('This invitation link is not valid')
    }
    return invitation
  }

  private async findAccount(
    tx: DrizzleDb,
    userId: number,
  ): Promise<InvitedAccount> {
    const account = await tx.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        passwordHash: true,
      },
    })
    if (!account) {
      // Unreachable while the foreign key holds (ON DELETE CASCADE removes
      // the invitation with its account).
      throw new NotFoundException('This invitation link is not valid')
    }
    return account
  }

  // clinics and user_clinics are readable without a session context
  // (migrations 0008, 0011), so this works on the accept page's
  // token-only transaction too.
  private async findClinicNames(
    db: DrizzleDb,
    userId: number,
  ): Promise<string[]> {
    const rows = await db
      .select({ name: clinics.name })
      .from(userClinics)
      .innerJoin(clinics, eq(clinics.id, userClinics.clinicId))
      .where(eq(userClinics.userId, userId))
      .orderBy(asc(clinics.name))
    return rows.map((row) => row.name)
  }

  // The one query that builds InvitationSummary objects. Two aliases of
  // `users`, because an invitation names two different people (who sent
  // it, who revoked it) and a table can only appear once per query under
  // its own name.
  private async findSummaries(
    actor: Actor,
    filter: { userId: number } | { invitationId: number },
  ): Promise<InvitationSummary[]> {
    const inviter = alias(users, 'inviter')
    const revoker = alias(users, 'revoker')
    const rows = await withRlsContext(this.db, actor, (tx) =>
      tx
        .select({
          invitation: invitations,
          inviter: {
            id: inviter.id,
            firstName: inviter.firstName,
            lastName: inviter.lastName,
          },
          revokerId: revoker.id,
          revokerFirstName: revoker.firstName,
          revokerLastName: revoker.lastName,
        })
        .from(invitations)
        .innerJoin(inviter, eq(inviter.id, invitations.invitedBy))
        .leftJoin(revoker, eq(revoker.id, invitations.revokedBy))
        .where(
          'userId' in filter
            ? eq(invitations.userId, filter.userId)
            : eq(invitations.id, filter.invitationId),
        )
        // id breaks ties: two invitations in one transaction share now().
        .orderBy(desc(invitations.createdAt), desc(invitations.id)),
    )
    const now = new Date()
    return rows.map((row) => ({
      id: row.invitation.id,
      status: invitationStatus(row.invitation, now),
      createdAt: row.invitation.createdAt,
      expiresAt: row.invitation.expiresAt,
      acceptedAt: row.invitation.acceptedAt,
      revokedAt: row.invitation.revokedAt,
      invitedBy: row.inviter,
      revokedBy:
        row.revokerId === null
          ? null
          : {
              id: row.revokerId,
              firstName: row.revokerFirstName ?? '',
              lastName: row.revokerLastName ?? '',
            },
    }))
  }

  private async findSummaryOrThrow(
    invitationId: number,
    actor: Actor,
  ): Promise<InvitationSummary> {
    const [summary] = await this.findSummaries(actor, { invitationId })
    if (!summary) {
      // Unreachable in practice (the caller has just written this row).
      throw new NotFoundException(`Invitation ${invitationId} not found`)
    }
    return summary
  }
}

// --- MODULE-LEVEL HELPERS ----------------------------------------------------------------------------------

// "Neither accepted nor revoked" — the same condition as the partial unique
// index's WHERE (migration 0020). Expiry is NOT part of it: an expired
// invitation is still open, and resending or revoking closes it like any
// other, which keeps "at most one open invitation" true.
function openInvitation() {
  return and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt))
}

// 410 unless the invitation can still be accepted: pending, for an active
// account that has no password yet.
function assertUsable(
  invitation: InvitationRow,
  account: InvitedAccount,
): void {
  const status = invitationStatus(invitation)
  if (status !== 'pending') throw gone(status)
  if (!account.isActive) throw gone('deactivated')
  // Open invitation, but the account already has a password: not reachable
  // through the API (accepting sets both at once), so treated as used.
  if (account.passwordHash !== null) throw gone('accepted')
}