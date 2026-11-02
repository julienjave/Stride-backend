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
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { randomBytes, createHash } from 'crypto'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  clinics,
  users,
  adminProfiles,
  userClinics,
  userRoles,
  emailChangeRequests,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { UserRole } from '../users/dto/create-user.dto'
import { RegisterClinicDto } from './dto/register-clinic.dto'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { rethrowDuplicateEmail } from '../common/email-address'
import { errorMessage } from '../common/error-message'
import { withRlsContext } from '../database/rls-context'

// --- SERVICE -----------------------------------------------------------------------------------------------

interface RegisterClinicResult {
  id: number
  email: string
  firstName: string
  lastName: string
  avatarUrl: string | null
  isActive: boolean
  createdAt: Date
  roles: UserRole[]
  activeRole: UserRole
  clinicId: number
  adminProfile?: { position: string | null }
}

// The one refusal for a dead reset link — the check and the reset say it
// alike (the frontend shows it as is).
export const INVALID_RESET_LINK_MESSAGE =
  'This password reset link is invalid or has expired'

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly usersService: UsersService,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
  ) {}

  // === REGISTRATION ============================================================

  // (register() — public self-registration — was removed with invitations;
  // see AuthController. registerClinic() is the one-time first setup.)

  // === FIRST-TIME SETUP ===========================================================

  // Has Stride been set up — does any administrator account exist? The ONE
  // definition of "set up", used both by GET /auth/setup-status (whether the
  // sign-in page offers "First time? Set up Stride") and by registerClinic()
  // below (whether it still runs), so the link can never point at a setup
  // that refuses to run, nor hide one that would.
  //
  // Any admin row counts, a deactivated admin included: setup happened.
  // (An install whose only admin was deactivated needs a database fix, not a
  // second founding admin created by whoever finds the setup page first.)
  // user_roles is readable without a session context (migration 0009), so
  // this works for a visitor who isn't signed in.
  async isSetupComplete(): Promise<boolean> {
    const admin = await this.db.query.userRoles.findFirst({
      where: eq(userRoles.role, UserRole.ADMIN),
      columns: { id: true },
    })
    return admin !== undefined
  }

  // Bootstraps a brand-new clinic AND its founding admin account together.
  // Gated to only work when NO admin exists anywhere in the system yet —
  // this is deliberately a ONE-TIME setup operation, not an ongoing public
  // signup path. Clinics in this schema are branding/display entities, not
  // isolated multi-tenant boundaries, so letting anyone spin up unlimited
  // clinics indefinitely would be a different product than the one designed.
  async registerClinic(dto: RegisterClinicDto) {
    if (await this.isSetupComplete()) {
      throw new ForbiddenException(
        'An administrator account already exists. Ask an existing admin to create additional accounts.',
      )
    }

    // The email may be taken (an account created before this setup, by a
    // seed or by hand): the UNIQUE constraint on users.email is the one judge
    // — rethrowDuplicateEmail on the transaction below turns its refusal into
    // the 409, and the whole transaction (clinic included) is undone. There
    // used to be a read first ("is this email taken?"), which two requests
    // could both pass, the loser hitting the constraint as a 500. It also
    // spared a bcrypt hash on a refused request — not worth a second judge
    // that can disagree with the first: this route runs once per deployment.
    // dto.email arrives normalised (@NormalizeEmail()), so "taken" ignores
    // case.
    const passwordHash = await bcrypt.hash(dto.password, 10)

    const result: RegisterClinicResult = await this.db
      .transaction(async (tx): Promise<RegisterClinicResult> => {
        const [clinic] = await tx
          .insert(clinics)
          .values({
            name: dto.clinicName,
            email: dto.clinicEmail,
            phone: dto.clinicPhone,
            addressLine1: dto.clinicAddressLine1,
            addressLine2: dto.clinicAddressLine2,
            addressCity: dto.clinicAddressCity,
            addressState: dto.clinicAddressState,
            addressPostalCode: dto.clinicAddressPostalCode,
            addressCountry: dto.clinicAddressCountry,
            website: dto.clinicWebsite,
          })
          .returning()

        const [user] = await tx
          .insert(users)
          .values({
            email: dto.email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            addressLine1: dto.addressLine1,
            addressLine2: dto.addressLine2,
            addressCity: dto.addressCity,
            addressState: dto.addressState,
            addressPostalCode: dto.addressPostalCode,
            addressCountry: dto.addressCountry,
          })
          .returning()

        await tx
          .insert(userRoles)
          .values({ userId: user.id, role: UserRole.ADMIN })

        await tx.insert(adminProfiles).values({
          userId: user.id,
          position: dto.position,
        })

        await tx.insert(userClinics).values({
          userId: user.id,
          clinicId: clinic.id,
        })

        // This insert's .returning() is a raw row (passwordHash and all),
        // so it goes through UsersService.toPublic() — the same funnel as
        // every other user response — rather than a hand-written strip
        // list of its own. A copy kept here would have to be remembered
        // every time a private column is added; this file used to keep
        // exactly such a copy, and it's how avatarPath would have leaked
        // raw from this route once toPublic() started converting it.
        // toSelf (toPublic + the owner's own settings): this answer is the
        // new admin's own account, signed in by the controller.
        const publicUser = await this.usersService.toSelf(user)
        const roles = [UserRole.ADMIN]
        // adminProfiles.position was inserted two statements above, inside
        // this same still-open transaction — attachProfile needs tx, not
        // this.db, to actually see it (read-committed visibility, same
        // reasoning as getRolesForUser's tx parameter elsewhere).
        const withProfile = await this.usersService.attachProfile(
          publicUser,
          roles,
          tx,
        )
        // The founding of the whole deployment: ONE entry, in this
        // transaction (audit_logs' INSERT policy is WITH CHECK (true), so no
        // session context is needed). It names the clinic and the admin —
        // never the request itself, which carries the password.
        await this.auditService.logInTransaction(tx, {
          performedBy: user.id,
          action: 'REGISTER_CLINIC',
          targetUserId: user.id,
          entityType: 'clinics',
          entityId: clinic.id,
          details: { adminUserId: user.id },
        })
        return {
          ...withProfile,
          roles,
          activeRole: UserRole.ADMIN,
          clinicId: clinic.id,
        }
      })
      .catch(rethrowDuplicateEmail)

    return result
  }

  // === VALIDATION / LOGIN =======================================================

  // Called by AuthController.login() directly (no longer via a Passport
  // strategy) and, on a successful MFA verification, indirectly again
  // through the resolved activeRole it originally returned. requestedRole is
  // optional — required only when the account holds more than one role.
  //
  // On audit coverage (the audit review, decided with the person 2026-10-21 —
  // decisions §10): signing in changes no data, so there is no transaction
  // for these entries to join. They are written on AuditService's own
  // connection and AWAITED before answering: a sign-in can't succeed (nor a
  // failure be answered) without the trail recording it. Each names the
  // account concerned (targetUserId), like every other entry.
  //
  // A failed attempt against an email that matches NO
  // real account is never logged — audit_logs.performedBy is NOT NULL, and
  // there is no valid user id to attribute an attempt against a
  // nonexistent account to. This is a real, deliberate scope limitation,
  // not an oversight — a genuinely anonymous failed attempt simply cannot
  // be represented under this schema's constraint as written.
  async validateUser(
    email: string,
    password: string,
    requestedRole?: UserRole,
  ) {
    const user = await this.usersService.findByEmailWithHash(email)
    if (!user) {
      return null
    }

    // An account created by invitation has no password until the invitation
    // is accepted (users.password_hash NULL). It fails exactly like a wrong
    // password — same null, so the same 401 "Invalid email or password" —
    // which reveals nothing about the account's state to someone who
    // doesn't hold the invitation. Checked BEFORE bcrypt.compare(), which
    // throws on a null hash (a 500, not a 401). Recorded like any failed
    // attempt against a real account (below).
    const passwordMatches =
      user.passwordHash !== null &&
      (await bcrypt.compare(password, user.passwordHash))
    if (!passwordMatches) {
      // Attributable to a REAL account — this is the security-relevant
      // case worth capturing: repeated failed attempts against one known
      // target, the same signal the login rate limiter partially defends
      // against from a different angle.
      await this.auditService.log({
        performedBy: user.id,
        action: 'LOGIN_FAILURE',
        targetUserId: user.id,
        entityType: 'users',
        entityId: user.id,
      })
      return null
    }

    // A deactivated account is rejected here, AFTER the password check —
    // deliberately not before, so a wrong password against a deactivated
    // account still reads as a generic credentials failure (the account's
    // active/deactivated status isn't confirmed to a caller who hasn't
    // proven they know the password). Once they've proven that, though,
    // there's no enumeration risk left in telling them specifically why
    // they can't log in.
    if (!user.isActive) {
      await this.auditService.log({
        performedBy: user.id,
        action: 'LOGIN_BLOCKED_DEACTIVATED',
        targetUserId: user.id,
        entityType: 'users',
        entityId: user.id,
      })
      throw new UnauthorizedException('This account has been deactivated')
    }

    const roles = await this.usersService.getRolesForUser(user.id)

    let activeRole: UserRole
    if (requestedRole) {
      if (!roles.includes(requestedRole)) {
        throw new ForbiddenException(
          `This account does not have the "${requestedRole}" role`,
        )
      }
      activeRole = requestedRole
    } else if (roles.length === 1) {
      // Boundary cast, not a workaround: roles comes from
      // UsersService.getRolesForUser(), which reads the userRoles.role
      // column — a Drizzle pgEnum. Drizzle infers that column as its own
      // string literal union ("admin" | "practitioner" | "patient"), which
      // is never unified with this app's own UserRole enum (a separate,
      // hand-maintained type — see the comment on UserRole itself). The two
      // are value-identical but nominally distinct, so TypeScript won't
      // accept the DB-sourced value here without a cast, even though it's
      // one of the exact three strings UserRole itself is built from. This
      // is the one place a raw DB role value becomes an enum-typed
      // activeRole; every other assignment in this file already starts
      // from a genuine UserRole.
      activeRole = roles[0] as UserRole
    } else {
      throw new BadRequestException({
        message: [
          'This account has multiple roles. Specify which one to log in as.',
        ],
        roles,
      })
    }

    await this.auditService.log({
      performedBy: user.id,
      action: 'LOGIN_SUCCESS',
      targetUserId: user.id,
      entityType: 'users',
      entityId: user.id,
      details: { activeRole },
    })

    // This method reads from findByEmailWithHash() — the one lookup that
    // returns the raw row, since the bcrypt.compare() above needs the real
    // passwordHash. Now that the password is verified, the row goes
    // through UsersService.toPublic() like every other user response:
    // private fields stripped, avatarPath turned into a usable avatarUrl.
    // (This used to be a hand-copied strip list, which once fell behind
    // toPublic() — passwordResetTokenHash/ExpiresAt leaked from login for
    // a while. Sharing the one function removes that whole class of bug.)
    // toSelf: the answer to a login is the person's own account — with the
    // settings only they may read (the font, applied before the first
    // screen draws).
    const publicUser = await this.usersService.toSelf(user)
    const withProfile = await this.usersService.attachProfile(publicUser, roles)
    return { ...withProfile, roles, activeRole }
  }

  // === PASSWORD RESET =============================================================

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmailWithHash(email)

    // Always the same outcome from the caller's point of view, whether the
    // email matches a real account or not — the response never reveals
    // which case actually happened. Only a real match generates a token
    // and sends an email at all.
    //
    // An account with no password yet (created by invitation, not yet
    // accepted) is treated as no match too. Its only way in is its
    // invitation: a reset link would let anyone who knows the address — or
    // the invitee, after an admin REVOKED their invitation — set a password
    // and walk in around the invitation's checks.
    if (!user || user.passwordHash === null) {
      return
    }

    // A cryptographically random 256-bit value — not a bcrypt-appropriate
    // secret. Bcrypt's deliberate slowness defends against brute-forcing a
    // LOW-ENTROPY, human-chosen value; a random token already has 2^256
    // possibilities, infeasible to guess regardless of hash speed.
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    // Overwrites any previous pending reset — only ever one active token
    // per user, which is also what makes a token single-use: it's cleared
    // entirely (not just marked "used") the moment it's successfully
    // redeemed, in resetPassword below.
    //
    // This UPDATE has no real session to run withRlsContext's usual
    // caller-identity context through — forgotPassword() is a fully public,
    // unauthenticated endpoint, like registerClinic(). But unlike an
    // INSERT, users_update has no "no session context" branch (deliberately
    // — see the migration comment on why a blanket no-context UPDATE would
    // be a materially bigger hole than a no-context INSERT). Instead, this
    // treats the request as acting AS the resolved target user: their
    // ownership was already proven out-of-band (matched by email above,
    // about to be proven for real by whoever redeems the emailed token in
    // resetPassword), so a synthetic self-context — their own id, any one
    // of their real roles — satisfies users_update's existing
    // id = rls_current_user_id() branch exactly the way a genuine session
    // would. The role value itself is inert here: that branch never
    // consults app.current_role.
    const roles = await this.usersService.getRolesForUser(user.id)
    await withRlsContext(
      this.db,
      { id: user.id, activeRole: roles[0] as UserRole },
      async (tx) => {
        await tx
          .update(users)
          .set({
            passwordResetTokenHash: tokenHash,
            passwordResetTokenExpiresAt: expiresAt,
          })
          .where(eq(users.id, user.id))
        // In the same transaction as the stored token. Never the token or
        // its hash in the entry — only when it stops working.
        await this.auditService.logInTransaction(tx, {
          performedBy: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          targetUserId: user.id,
          entityType: 'users',
          entityId: user.id,
          details: { expiresAt },
        })
      },
    )

    // The raw token — never the hash — is the only thing that ever leaves
    // this server.
    //
    // Fire-and-forget, deliberately (see docs/journal/10). Awaiting
    // this here previously meant a live Resend round-trip (hundreds of ms)
    // ran before the response, while the unknown-email early return above
    // responds in single-digit ms — a timing side-channel that let a
    // caller infer account existence without ever reading the (otherwise
    // identical) response body. EmailService rejects on ANY send failure
    // (a Resend API error or a network failure alike — it no longer
    // swallows either itself, see EmailTransport's comment), so this
    // .catch() is the one place a failed reset email gets logged, and what
    // keeps it from becoming an unhandled rejection. Logging is all that
    // can be done here: the caller gets the same 204 whether or not the
    // email went out, on purpose.
    this.emailService
      .sendPasswordResetEmail(user.email, rawToken)
      // The reason in the text, not as a second argument (which the
      // logger would drop — see errorMessage()).
      .catch((err) =>
        this.logger.error(
          `Failed to send password reset email to user ${user.id}: ${errorMessage(err)}`,
        ),
      )
  }

  // Is this reset link still usable? (POST /auth/reset-password/check —
  // Phase 6, decided with the person 2026-10-21.) The reset page asks BEFORE
  // the person chooses a new password, so a dead link is said at once instead
  // of after they typed one. A pure read: nothing changes, the token stays
  // valid, nothing is audited (it changes no data, and reveals nothing the
  // reset itself wouldn't — the same refusal, word for word).
  //
  // The answer: the account's EMAIL — for the page's read-only username
  // field, so a password manager saves the new password under the right
  // account (the invitation page does the same) — and when the link
  // expires. Only the token's holder gets them, and the token was emailed to
  // that very address: holding it already proves access to the inbox.
  async checkResetToken(
    rawToken: string,
  ): Promise<{ email: string; expiresAt: Date }> {
    const { user, expiresAt } = await this.findUserByResetToken(rawToken)
    return { email: user.email, expiresAt }
  }

  // Answers the ids of the sessions it ended: the controller closes their
  // sockets (see destroyAllSessionsForUser).
  async resetPassword(
    rawToken: string,
    newPassword: string,
  ): Promise<{ endedSessionIds: string[] }> {
    const { user } = await this.findUserByResetToken(rawToken)

    const newPasswordHash = await bcrypt.hash(newPassword, 10)

    // Same synthetic self-context reasoning as forgotPassword() above —
    // this request has no session either, but the token match just above
    // IS the proof of ownership; users_update can't see that proof
    // directly, so this stands in for it the same way.
    const roles = await this.usersService.getRolesForUser(user.id)
    await withRlsContext(
      this.db,
      { id: user.id, activeRole: roles[0] as UserRole },
      async (tx) => {
        await tx
          .update(users)
          .set({
            passwordHash: newPasswordHash,
            passwordResetTokenHash: null,
            passwordResetTokenExpiresAt: null,
          })
          .where(eq(users.id, user.id))
        // A pending change of sign-in email is cancelled too (decisions §12):
        // whoever resets may be recovering from someone who knew the password
        // — and asked to move the account to their own inbox. Its confirm
        // link dies with it. Named in the reset's ONE entry.
        const cancelledChanges = await tx
          .update(emailChangeRequests)
          .set({ cancelledAt: sql`now()`, cancelReason: 'password_reset' })
          .where(
            and(
              eq(emailChangeRequests.userId, user.id),
              isNull(emailChangeRequests.confirmedAt),
              isNull(emailChangeRequests.cancelledAt),
            ),
          )
          .returning({ id: emailChangeRequests.id })
        // In the password's own transaction; the password itself (or its
        // hash) never goes into an entry.
        await this.auditService.logInTransaction(tx, {
          performedBy: user.id,
          action: 'PASSWORD_RESET_COMPLETED',
          targetUserId: user.id,
          entityType: 'users',
          entityId: user.id,
          ...(cancelledChanges.length > 0
            ? {
                details: {
                  cancelledEmailChangeRequestId: cancelledChanges[0].id,
                },
              }
            : {}),
        })
      },
    )

    // The whole reason a password needed resetting might be that someone
    // else had access to the account — leaving their existing session
    // alive afterward would defeat the entire point of resetting it.
    return { endedSessionIds: await this.destroyAllSessionsForUser(user.id) }
  }

  // The account a reset token belongs to — or the one refusal for every way
  // a link can be dead: never issued, already used (the hash is cleared on
  // success), replaced by a newer request (one pending token per account),
  // expired, or on an account with no password. Shared by the check and the
  // reset, so the page's "this link works" and the reset's own judgement can
  // never disagree.
  //
  // The passwordHash check is defence in depth: forgotPassword() never
  // issues a reset token to an account without a password, so a match here
  // would mean a token got there some other way — and then the reset must
  // still not become a way around the invitation.
  private async findUserByResetToken(rawToken: string) {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')

    const user = await this.db.query.users.findFirst({
      where: eq(users.passwordResetTokenHash, tokenHash),
    })

    if (
      !user ||
      user.passwordHash === null ||
      !user.passwordResetTokenExpiresAt ||
      user.passwordResetTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException(INVALID_RESET_LINK_MESSAGE)
    }
    // Returned apart, already checked: TypeScript can't carry the narrowing
    // ("not null") across the return, and the caller needs it non-null.
    return { user, expiresAt: user.passwordResetTokenExpiresAt }
  }

  // === HELPER FUNCTIONS =========================================================

  // Raw SQL, deliberately — the "session" table is created and managed
  // entirely by connect-pg-simple, outside Drizzle's own schema and
  // migrations. There's no typed table definition for it to query through
  // the normal query builder; db.execute(sql`...`) is the escape hatch for
  // exactly this situation. Session data is stored as JSON in the "sess"
  // column, matching the shape SessionSerializer writes: reaching the
  // stored user id means walking that same JSON path back out.
  //
  // RETURNING the ids (found 2026-10-22, with "Change email"): deleting a
  // session ends its HTTP requests, but not a messaging socket opened with
  // it — a socket is authenticated once, at its handshake, and would keep
  // receiving messages. The caller closes them (MessagingEvents.
  // disconnectSession), as logout does for its one session.
  private async destroyAllSessionsForUser(userId: number): Promise<string[]> {
    const ended = await this.db.execute<{ sid: string }>(
      sql`DELETE FROM session WHERE (sess::jsonb)->'passport'->'user'->>'id' = ${String(userId)} RETURNING sid`,
    )
    return ended.rows.map((row) => row.sid)
  }
}
