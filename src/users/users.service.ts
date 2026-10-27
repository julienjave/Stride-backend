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
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { eq, and, asc, inArray, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  users,
  userRoles,
  practitionerProfiles,
  patientProfiles,
  adminProfiles,
  userClinics,
  clinics,
} from '../database/schema'
import { CreateUserDto, UserRole } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { GrantRoleDto } from './dto/grant-role.dto'
import { StorageService } from '../storage/storage.service'
import { extensionForMimeType } from '../common/config/image-upload.config'
import { withRlsContext } from '../database/rls-context'
import {
  isUniqueViolation,
  PRACTITIONER_LICENSE_NUMBER_UNIQUE,
  USER_ROLES_USER_ROLE_UNIQUE,
} from '../database/pg-errors'
import { AuditService } from '../audit/audit.service'
import { changedFields } from '../common/changed-fields'
import { InvitationsService } from '../invitations/invitations.service'
import type { InvitationStatus } from '../invitations/invitation-status'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { translateDuplicateEmail } from '../common/email-address'
import {
  CareTeamService,
  ENDED_PRACTITIONER_DEACTIVATED_REASON,
} from '../care-team/care-team.service'
import {
  needsAttention,
  type AttentionKind,
} from '../admin-metrics/attention-rules'

// --- HELPER ------------------------------------------------------------------------------------------------

// Runs a write that may store a practitioner's licenseNumber, and turns a
// duplicate-license failure into a proper 409 Conflict.
//
// Why this is needed at all: licenseNumber is UNIQUE in the database, and
// until now nothing checked for a collision first. A duplicate reached
// Postgres, failed with SQLSTATE 23505, and the catch-all exception filter
// reported it as a 500 — "the server broke" — when the truth is "that value
// is taken", a client-side problem with a specific, fixable cause.
//
// Why catch the database error instead of checking first (a findFirst on
// licenseNumber before writing, as create() once did for the email): a
// check-then-write has a race window — two requests can both pass the
// check before either writes (see deferred-improvements.md, "TOCTOU").
// The UNIQUE constraint is the only thing that decides atomically, so
// translating ITS verdict is correct under concurrency, with no extra
// query.
//
// Anything that is NOT this specific violation is rethrown untouched: the
// helper must never turn an unrelated failure into a misleading 409.
async function translateDuplicateLicense<T>(write: () => Promise<T>) {
  try {
    return await write()
  } catch (error) {
    if (isUniqueViolation(error, PRACTITIONER_LICENSE_NUMBER_UNIQUE)) {
      throw new ConflictException(
        'This license number is already registered to another practitioner',
      )
    }
    throw error
  }
}

// Granting a role the account already has: the UNIQUE (user_id, role) on
// user_roles refuses the INSERT, and this turns that refusal into the 409 —
// for the promise's .catch(), so grantRole's long callback stays where it is.
// grantRole used to read user_roles first and insert after: two grants of the
// same role at once both read "not yet", and the second hit the constraint
// as a 500 (deferred-improvements.md). The constraint alone decides
// atomically, so its verdict is the answer, with no read. Always throws: the
// 409, otherwise the error it was given.
function rethrowDuplicateRole(role: UserRole): (error: unknown) => never {
  return (error: unknown) => {
    if (isUniqueViolation(error, USER_ROLES_USER_ROLE_UNIQUE)) {
      throw new ConflictException(`User already has the "${role}" role`)
    }
    throw error
  }
}

// Every session of an account, deleted — the ids answered (RETURNING sid) so
// their messaging sockets can be closed. Raw SQL: the "session" table belongs
// to connect-pg-simple, outside Drizzle's schema (AuthService's
// destroyAllSessionsForUser explains the JSON path). In the caller's
// transaction.
async function endSessions(tx: DrizzleDb, userId: number): Promise<string[]> {
  const ended = await tx.execute<{ sid: string }>(
    sql`DELETE FROM session WHERE (sess::jsonb)->'passport'->'user'->>'id' = ${String(userId)} RETURNING sid`,
  )
  return ended.rows.map((row) => row.sid)
}

// Creating an account can collide on two values: the email (any role) and a
// practitioner's license number. Each refusal becomes its own 409 — the
// email's from common/email-address.ts (shared with registerClinic, which
// creates the founding admin), the license's above. Composed here so
// create() reads as one call.
function translateDuplicateAccount<T>(write: () => Promise<T>) {
  return translateDuplicateEmail(() => translateDuplicateLicense(write))
}

// --- SERVICE ------------------------------------------------------------------------------------------------
// --- TYPES -------------------------------------------------------------------------------------------------

// Who is creating an account (and so sending its first invitation).
type InvitingUser = { id: number; activeRole: UserRole }

// What POST /users adds to the created user: its first invitation, and
// whether the email went out (false → the screen offers to send it again).
export interface CreatedUserInvitation {
  id: number
  status: InvitationStatus
  expiresAt: Date
  emailSent: boolean
}

// --- SERVICE ------------------------------------------------------------------------------------------------

// softDelete(): who may deactivate an account holding the practitioner role.
export const DEACTIVATE_PRACTITIONER_MESSAGE =
  "Only an admin, or the practitioner themselves, can deactivate a practitioner's account"

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
    private readonly careTeamService: CareTeamService,
    private readonly invitationsService: InvitationsService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // requestingUser is checked against ACTIVE role, not just "has this role somewhere"
  //
  // Accounts are created by invitation only (design decisions §3): no
  // password here. The account is created with none (password_hash NULL),
  // its first invitation is created in the SAME transaction, and the email
  // goes out after the commit. The person chooses their own password by
  // accepting it (POST /invitations/accept) — nobody ever sets someone
  // else's password.
  //
  // requestingUser is required: since public self-registration was removed
  // (it used to call this with no one signed in), every account is created
  // by a signed-in admin or practitioner — who is also the inviter.
  async create(dto: CreateUserDto, requestingUser: InvitingUser) {
    if (
      requestingUser.activeRole === UserRole.PRACTITIONER &&
      dto.role !== UserRole.PATIENT
    ) {
      throw new ForbiddenException(
        'Practitioners can only create patient accounts',
      )
    }

    // Since the care team (2026-09-27), a practitioner creating a patient
    // must say which clinic the patient belongs to: the practitioner joins
    // the new patient's care team (below), and a care-team link only grants
    // access while both people share a clinic. A patient created without
    // one would be unreachable — for their creator and for everyone else.
    if (requestingUser.activeRole === UserRole.PRACTITIONER && !dto.clinicId) {
      throw new BadRequestException('Choose the clinic this patient belongs to')
    }

    // The one place in this app that actually CREATES a practitioner-patient
    // relationship — every other path that trusts one already going through
    // it (findOne/update/remove on users, AssignedPrograms, Sessions,
    // MedicalFiles, Messaging) does so via isPatientManagedBy, which now
    // checks the care team. This clinic check was missing here entirely:
    // dto.clinicId was only ever verified to exist as a real clinic, never
    // verified as one the REQUESTING practitioner actually belongs to —
    // meaning a practitioner in Clinic A could plant a patient record
    // directly into Clinic B's roster purely by knowing Clinic B's id.
    // Admin is exempt — admins have legitimate oversight across every
    // clinic, consistent with every other admin-bypass check in this app.
    if (requestingUser.activeRole === UserRole.PRACTITIONER && dto.clinicId) {
      const ownClinicIds = await this.getClinicIdsForUser(requestingUser.id)
      if (!ownClinicIds.includes(dto.clinicId)) {
        throw new ForbiddenException(
          'You can only add patients to a clinic you belong to',
        )
      }
    }

    // Set inside the transaction when a practitioner creates a patient (see
    // below), read after it has committed to write the audit entry.
    let creatorLink: { id: number } | undefined
    // The first invitation, with its raw token — set inside the transaction,
    // emailed after it has committed.
    let issued:
      Awaited<ReturnType<InvitationsService['insertInvitation']>> | undefined

    // Wrapped: the email may be taken — the UNIQUE constraint is the one
    // judge (no read beforehand: two requests could both read "free"); and
    // creating a practitioner inserts their licenseNumber. dto.email arrives
    // normalised (@NormalizeEmail() on the DTO), so "taken" ignores case.
    // A refusal aborts the transaction: no account, no invitation, no entry.
    const created = await translateDuplicateAccount(() =>
      withRlsContext(this.db, requestingUser, async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: dto.email,
            // No passwordHash: NULL until the invitation is accepted.
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

        await tx.insert(userRoles).values({ userId: user.id, role: dto.role })

        if (dto.role === UserRole.PRACTITIONER) {
          await tx.insert(practitionerProfiles).values({
            userId: user.id,
            licenseNumber: dto.licenseNumber!,
            specialties: dto.specialties ?? [],
            bio: dto.bio,
          })
        } else if (dto.role === UserRole.PATIENT) {
          await tx.insert(patientProfiles).values({
            userId: user.id,
            dateOfBirth: dto.dateOfBirth!,
          })
        } else if (dto.role === UserRole.ADMIN) {
          await tx.insert(adminProfiles).values({
            userId: user.id,
            position: dto.position,
          })
        }

        // Validated as a plain query against the clinics table — not by
        // injecting ClinicsService, which would create a circular dependency
        // between UsersModule and ClinicsModule. Both services independently
        // query whatever tables they need via the shared, global DRIZZLE
        // token; neither needs the other's NestJS module imported.
        if (dto.clinicId) {
          const clinic = await tx.query.clinics.findFirst({
            where: eq(clinics.id, dto.clinicId),
          })
          if (!clinic) {
            throw new NotFoundException(`Clinic ${dto.clinicId} not found`)
          }
          await tx.insert(userClinics).values({
            userId: user.id,
            clinicId: dto.clinicId,
          })
        }

        // A practitioner who creates a patient joins their care team, in
        // this same transaction — the patient, their clinic membership and
        // this link are all created, or none of them. (The earlier check
        // guarantees a clinic here, and the RLS insert policy on
        // care_team_members requires one: it can see the membership just
        // inserted above, because it's the same transaction.)
        if (requestingUser.activeRole === UserRole.PRACTITIONER) {
          creatorLink = await this.careTeamService.linkCreator(
            tx,
            user.id,
            requestingUser.id,
          )
        }

        // AFTER the care-team link, on purpose: the invitations insert
        // policy (migration 0021) lets a practitioner invite only a patient
        // whose care team they're on — which, inside this transaction,
        // they've just joined.
        issued = await this.invitationsService.insertInvitation(
          tx,
          user.id,
          requestingUser.id,
        )

        // ONE entry for the whole creation, in this transaction (the audit
        // convention): the account as created, plus what came with it — the
        // creator's care-team link and the first invitation. They are parts
        // of one act ("Alex added a patient"), so they are one entry; three
        // entries for one request would read as three separate decisions.
        // The record is the request as validated: every field a
        // CreateUserDto can carry is account data, none of it a secret (no
        // password exists yet). Fields the request didn't send are
        // `undefined` on the DTO instance, and the jsonb column stores
        // JSON.stringify's output, which leaves them out — the stored record
        // is exactly what was sent. Whether the invitation EMAIL went out is
        // not here — it happens after the commit, and the invitation row
        // itself records it (email_sent_at).
        await this.auditService.logInTransaction(tx, {
          performedBy: requestingUser.id,
          action: 'USER_CREATED',
          targetUserId: user.id,
          entityType: 'users',
          entityId: user.id,
          details: {
            record: dto,
            ...(creatorLink ? { careTeamLinkId: creatorLink.id } : {}),
            invitationId: issued.invitation.id,
          },
        })

        const roles = [dto.role]
        return this.attachProfile(
          { ...(await this.toPublic(user)), roles },
          roles,
          tx,
        )
      }),
    )

    // Unreachable — the transaction always sets it — but it tells
    // TypeScript (and a reader) that the code below has an invitation.
    if (!issued) {
      throw new Error('The account was created without an invitation')
    }

    // The email, after the commit (same order as InvitationsService.send):
    // a failure doesn't undo the account — it's reported, and the person
    // who created it can send the invitation again.
    const emailSent = await this.invitationsService.deliver(
      issued.invitation.id,
      created,
      issued.token,
      requestingUser,
    )

    const invitation: CreatedUserInvitation = {
      id: issued.invitation.id,
      status: 'pending',
      expiresAt: issued.invitation.expiresAt,
      emailSent,
    }
    return { ...created, invitation }
  }

  // Grants an ADDITIONAL role to an already-existing user
  async grantRole(
    userId: number,
    dto: GrantRoleDto,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findOne(userId)

    // Wrapped: granting the practitioner role inserts a licenseNumber; and a
    // role the account already has is refused by user_roles' UNIQUE — the
    // .catch() at the end (rethrowDuplicateRole), not a read beforehand.
    return translateDuplicateLicense(() =>
      withRlsContext(this.db, currentUser, async (tx) => {
        await tx.insert(userRoles).values({ userId, role: dto.role })

        // Only creates the profile row if this user doesn't already have one
        // for this role (relevant if a role was previously granted, then
        // somehow re-granted after removal — defensive, not expected in
        // normal use, but cheap to guard against). `profile` keeps what WAS
        // inserted, for the audit entry: null when an existing profile was
        // kept (the request's profile fields were then not used).
        let profile: Record<string, unknown> | null = null
        if (dto.role === UserRole.PRACTITIONER) {
          const hasProfile = await tx.query.practitionerProfiles.findFirst({
            where: eq(practitionerProfiles.userId, userId),
          })
          if (!hasProfile) {
            profile = {
              licenseNumber: dto.licenseNumber!,
              specialties: dto.specialties ?? [],
              bio: dto.bio ?? null,
            }
            await tx.insert(practitionerProfiles).values({
              userId,
              licenseNumber: dto.licenseNumber!,
              specialties: dto.specialties ?? [],
              bio: dto.bio,
            })
          }
        } else if (dto.role === UserRole.PATIENT) {
          const hasProfile = await tx.query.patientProfiles.findFirst({
            where: eq(patientProfiles.userId, userId),
          })
          if (!hasProfile) {
            profile = { dateOfBirth: dto.dateOfBirth! }
            await tx
              .insert(patientProfiles)
              .values({ userId, dateOfBirth: dto.dateOfBirth! })
          }
        } else if (dto.role === UserRole.ADMIN) {
          const hasProfile = await tx.query.adminProfiles.findFirst({
            where: eq(adminProfiles.userId, userId),
          })
          if (!hasProfile) {
            profile = { position: dto.position ?? null }
            await tx
              .insert(adminProfiles)
              .values({ userId, position: dto.position })
          }
        }

        // Granting a role widens what an account can do (a patient who
        // becomes a practitioner can read clinical data): exactly the kind
        // of change an access review looks for. One entry, in this
        // transaction, with the profile the role came with.
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'USER_ROLE_GRANTED',
          targetUserId: userId,
          entityType: 'users',
          entityId: userId,
          details: { role: dto.role, profile },
        })

        return this.getRolesForUser(userId, tx)
      }),
    ).catch(rethrowDuplicateRole(dto.role))
  }

  // Uploads a new avatar, points the user's row at it, then deletes the
  // previous file (if any). Mirrors ClinicsService.updateLogo().
  //
  // Authorization happens in the controller: the user themselves or an
  // admin. Deliberately narrower than update(), which also lets a
  // managing practitioner in — a photo is personal, and there's no
  // clinical reason for a practitioner to change a patient's.
  //
  // Every upload gets a NEW object key (the timestamp), rather than
  // overwriting one fixed key per user. That's what makes it safe for a
  // browser to cache an avatar image: a given URL's content never changes,
  // a new photo simply lives at a new URL.
  async updateAvatar(
    id: number,
    file: Express.Multer.File,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findRawOrThrow(id)
    const objectKey = `avatars/${id}/${Date.now()}.${extensionForMimeType(file.mimetype)}`
    await this.storageService.upload(objectKey, file.buffer, file.mimetype)
    // The previous key is read INSIDE the transaction, under the row's lock
    // (lockUser): the photo it replaces is then certainly the one the audit
    // entry names — and the one deleted below. The transaction returns both
    // the updated row and that key.
    const { updated, previousPath } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const before = await this.lockUser(tx, id)
        const [row] = await tx
          .update(users)
          .set({ avatarPath: objectKey })
          .where(eq(users.id, id))
          .returning()
        // Storage keys, not URLs: a signed URL expires in minutes, the key
        // says for good which file was shown before and after.
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'USER_AVATAR_CHANGED',
          targetUserId: id,
          entityType: 'users',
          entityId: id,
          details: {
            changes: { avatarPath: { from: before.avatarPath, to: objectKey } },
          },
        })
        return { updated: row, previousPath: before.avatarPath }
      },
    )
    // Order matters: upload the new file, point the row at it, and only
    // THEN delete the old one. If anything before this line fails, the
    // user still points at a file that exists. Deleting first would open a
    // window where the row points at a file that's already gone.
    //
    // deleteUnreferenced, not delete: the new photo is saved at this point,
    // so a storage hiccup while cleaning up the OLD file must not turn this
    // successful upload into an error — it just leaves an orphaned file
    // (logged). See StorageService.deleteUnreferenced().
    if (previousPath) {
      await this.storageService.deleteUnreferenced(previousPath)
    }
    const roles = await this.getRolesForUser(id)
    return this.attachProfile(
      { ...(await this.toPublic(updated)), roles },
      roles,
    )
  }

  // --- GET ROUTES ---

  // includeInactive defaults to false — every existing caller (and the
  // controller's own default) keeps seeing only active users, unchanged.
  // Admin-only enforcement of WHO can pass true happens at the controller
  // (see findAll's @Query handling there); this method just does what
  // it's told, the same division of responsibility as reactivate() above.
  // Without this option, a deactivated user could never be found again
  // through this list to be reactivated at all — the list is the only
  // way an admin browses users today.
  async findAll(includeInactive = false) {
    const rows = await this.db.query.users.findMany({
      where: includeInactive ? undefined : eq(users.isActive, true),
    })
    // Promise.all: toPublic() is async (see its comment), so mapping over
    // the rows gives an array of Promises; Promise.all waits for all of
    // them at once rather than one after another.
    return this.attachProfilesToMany(
      await Promise.all(rows.map((u) => this.toPublic(u))),
    )
  }

  // The users list filtered to one "needs attention" group (decisions §17,
  // GET /users?attention=…; admins — checked by the controller). The SAME
  // condition the admin home counts with (attention-rules.ts), so the home's
  // number and this list always agree; and the same order as the home's
  // first five (last name, first name, then id — two people can share a
  // name, and the id keeps the order the same on every load), so the list
  // continues where the home's names stop.
  //
  // Under the admin's row-security context, unlike findAll(): the rule reads
  // care_team_members, which shows no row to a query without one — every
  // patient would then look unattended. (users itself is readable by
  // anyone, which is why findAll() needs no context.) The condition already
  // means "active" accounts, so there is no includeInactive here.
  async findNeedingAttention(
    attention: AttentionKind,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    //
    // The core builder (select().from()), not db.query.users.findMany as in
    // findAll(): the relational builder renders EVERY column in its `where`
    // against its own table's alias — care_team_members.practitioner_id came
    // out as "users"."practitioner_id" (found by the e2e test, a 500). The
    // core builder writes the SQL as given. Same rows either way: every
    // column of users.
    const rows = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .select()
        .from(users)
        .where(
          needsAttention(attention, {
            id: sql`${users.id}`,
            isActive: sql`${users.isActive}`,
          }),
        )
        .orderBy(asc(users.lastName), asc(users.firstName), asc(users.id)),
    )
    return this.attachProfilesToMany(
      await Promise.all(rows.map((u) => this.toPublic(u))),
    )
  }

  // dbOrTx defaults to this.db (a fresh connection, always seeing the
  // latest COMMITTED state) — correct for every caller that runs this
  // after its own writing transaction has already resolved
  // (findOne/update/softDelete/updateAvatar/removeAvatar all call this once
  // withRlsContext's promise has settled). grantRole() is the one
  // exception: it calls this from INSIDE its own still-open transaction,
  // so it passes `tx` explicitly — without that, this would query via a
  // SEPARATE connection that can't see the role that same transaction
  // just inserted but hasn't committed yet, under normal READ COMMITTED
  // visibility. Caught for real, not by inspection: an e2e test asserting
  // the actual returned roles array (grantRole had none before this pass)
  // failed with the newly-granted role silently missing from the response
  // until this was threaded through.
  async getRolesForUser(
    userId: number,
    dbOrTx: DrizzleDb = this.db,
  ): Promise<string[]> {
    const rows = await dbOrTx
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId))
    return rows.map((r) => r.role)
  }

  // Used by create()'s clinic-ownership check: "which clinics does this
  // user actually belong to".
  private async getClinicIdsForUser(userId: number): Promise<number[]> {
    const rows = await this.db
      .select({ clinicId: userClinics.clinicId })
      .from(userClinics)
      .where(eq(userClinics.userId, userId))
    return rows.map((r) => r.clinicId)
  }

  // "My patients," for a practitioner: every active patient whose care team
  // they are on (design decisions §3) — no longer every patient of their
  // clinics. GET /users (for a practitioner), and the assigned-programs and
  // sessions lists, are all built from this.
  //
  // WHICH patients is CareTeamService's decision (the care-team rule lives
  // there, once); this method only turns those ids into full user objects.
  //
  // includeInactive (2026-10-27, decisions §22): a deactivated patient keeps
  // their care team (§18), but this list left them out — so their team
  // could reach them only by address. GET /users?includeInactive=true (My
  // patients' "Show deactivated patients") adds them, each with its
  // `isActive: false`. Off by default: the other callers (the programs and
  // sessions lists) keep listing only active patients, unchanged.
  async findPatientsForPractitioner(
    practitionerId: number,
    includeInactive = false,
  ) {
    const patientIds =
      await this.careTeamService.findPatientIdsForPractitioner(practitionerId)
    if (patientIds.length === 0) {
      return []
    }

    const rows = await this.db
      .selectDistinct({ user: users })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(
        and(
          eq(userRoles.role, UserRole.PATIENT),
          includeInactive ? undefined : eq(users.isActive, true),
          inArray(users.id, patientIds),
        ),
      )

    return this.attachProfilesToMany(
      await Promise.all(rows.map((r) => this.toPublic(r.user))),
    )
  }

  // "May this practitioner act on this patient's clinical data?" — the check
  // behind every clinical endpoint: profile (GET/PATCH/DELETE /users/:id),
  // assigned programs, sessions, medical files, starting a conversation.
  //
  // Since 2026-09-27 it means "is on the patient's care team" (an active
  // link AND a clinic they still share), no longer "shares a clinic". It
  // keeps its name and signature so its ~15 callers — and their unit-test
  // mocks — didn't have to change; the rule itself lives in
  // CareTeamService.isOnCareTeam().
  //
  // The SQL twin, rls_care_team_member() (migration 0019), is kept in step
  // by test/care-team.e2e-spec.ts, which runs the same scenarios through
  // both and requires identical answers. A drift would otherwise fail
  // silently: RLS can only narrow what a query returns, so rows would just
  // go quietly missing for a practitioner, never throw an error.
  async isPatientManagedBy(
    patientId: number,
    practitionerId: number,
  ): Promise<boolean> {
    return this.careTeamService.isOnCareTeam(practitionerId, patientId)
  }

  // "Can this account sign in?" — false for a deactivated account, and for
  // an id that holds no account. The question behind a deactivated
  // patient's frozen programs and read-only conversations (decisions §22).
  // It answers about the ACCOUNT only: whether the caller may act on this
  // patient at all is isPatientManagedBy's question, asked first by every
  // caller.
  async isAccountActive(userId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return row?.isActive === true
  }

  async findOne(id: number) {
    const user = await this.findRawOrThrow(id)
    const roles = await this.getRolesForUser(id)
    return this.attachProfile({ ...(await this.toPublic(user)), roles }, roles)
  }

  // INTERNAL USE ONLY — the one method in this service that does NOT strip
  // passwordHash. Never call this from a controller; it exists purely for
  // AuthService to compare a login attempt's password against the real hash.
  //
  // `email` must already be normalised (common/email-address.ts): stored
  // emails are, so a plain equality is the case-insensitive match. Its two
  // callers (sign-in, forgot password) receive it from a DTO with
  // @NormalizeEmail().
  async findByEmailWithHash(email: string) {
    return this.db.query.users.findFirst({ where: eq(users.email, email) })
  }

  // --- PATCH ROUTES ---

  // dto mixes plain `users` columns (firstName/lastName) with fields that
  // actually belong to one of the three role-profile tables
  // (licenseNumber/specialties -> practitioner_profiles, dateOfBirth ->
  // patient_profiles, position -> admin_profiles). Split up-front so each
  // piece can be routed at the table it actually belongs to.
  //
  // Field applicability is checked against the TARGET's real held roles,
  // not the caller's — deliberately independent of the
  // isSelf/isAdmin/isManagingPractitioner check in the controller. An
  // admin (or a managing practitioner) editing a patient can still only
  // ever touch patientProfile fields; sending licenseNumber for a target
  // with no practitioner role is a 400, not silently ignored or silently
  // scoped away, the same way an invalid field value would be.
  //
  // Two field-level rules sit on top of that: licenseNumber can only be
  // changed by a caller whose ACTIVE role is admin (decisions §4), and
  // preferredWeightUnit only by the user themselves — see the checks
  // below.
  async update(
    id: number,
    dto: UpdateUserDto,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    const existing = await this.findOne(id)
    const { licenseNumber, specialties, bio, dateOfBirth, position, ...rest } =
      dto
    // TS class fields (target ES2023, useDefineForClassFields) make every
    // declared UpdateUserDto property — including ones the caller never
    // sent — a real own key on the instance, set to `undefined`. Spreading
    // `rest` above already carries firstName/lastName even when absent from
    // the request body, so Object.keys(rest).length alone can't tell "sent"
    // from "not sent"; filtering out undefined values is what actually
    // distinguishes them (and is what keeps an all-profile-fields request
    // from reaching `tx.update(users).set({})`, which Drizzle rejects
    // outright with "No values to set").
    const userFields = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    )

    // The weight-unit preference is personal: it only changes how weights
    // are shown to, and pre-filled for, this one person. Nobody else has a
    // reason to change it — not even an admin — so it's self-only, the
    // mirror image of the license rule below (which is admin-only). It
    // compares ids, not roles: whichever role you're acting as, it's still
    // your own preference. Same 403-before-any-write reasoning as below.
    if (dto.preferredWeightUnit !== undefined && currentUser.id !== id) {
      throw new ForbiddenException(
        'Only the user themselves can change their weight unit preference',
      )
    }

    // licenseNumber is a professional credential: set or verified by an
    // admin, never self-edited (decided in design decisions §4). This is a
    // FIELD-level rule, a different question from the controller's
    // "may this caller edit this profile at all?": a practitioner editing
    // their own profile passes that check, and may still change their
    // specialties or bio — just not this one field.
    //
    // It checks the caller's ACTIVE role, like every other role check in
    // this app: an account holding both roles can change its own license
    // while switched to admin, not while acting as a practitioner.
    //
    // 403, not 400: the request is well-formed and the field does apply to
    // the target — the caller simply isn't allowed to do it. Checked
    // before any write, so a refused request changes nothing, not even the
    // other fields sent alongside it.
    if (
      licenseNumber !== undefined &&
      currentUser.activeRole !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('Only an admin can change a license number')
    }

    if (
      (licenseNumber !== undefined ||
        specialties !== undefined ||
        bio !== undefined) &&
      !existing.roles.includes(UserRole.PRACTITIONER)
    ) {
      throw new BadRequestException(
        'This user does not have a practitioner profile',
      )
    }
    if (
      dateOfBirth !== undefined &&
      !existing.roles.includes(UserRole.PATIENT)
    ) {
      throw new BadRequestException('This user does not have a patient profile')
    }
    if (position !== undefined && !existing.roles.includes(UserRole.ADMIN)) {
      throw new BadRequestException('This user does not have an admin profile')
    }

    // Wrapped: an admin may set a license number that another practitioner
    // already holds — a 409, not a 500 (see translateDuplicateLicense).
    return translateDuplicateLicense(() =>
      withRlsContext(this.db, currentUser, async (tx) => {
        // Every value this PATCH may change, as it is NOW: the user's row
        // (locked until the commit — two simultaneous edits of one profile
        // take turns, so each entry's "from" is what that edit really
        // replaced) and the profile rows. Then only what really differs.
        const before = {
          ...(await this.lockUser(tx, id)),
          ...(await this.profileValues(tx, id)),
        }
        const changes = changedFields(before, {
          ...userFields,
          licenseNumber,
          specialties,
          bio,
          dateOfBirth,
          position,
        })

        // The convention's "a request that changes nothing writes nothing":
        // no UPDATE, no entry. (Saving a form unchanged is common — the
        // profile page's fields each save on their own.)
        if (Object.keys(changes).length > 0) {
          if (Object.keys(userFields).length > 0) {
            await tx.update(users).set(userFields).where(eq(users.id, id))
          }
          if (
            licenseNumber !== undefined ||
            specialties !== undefined ||
            bio !== undefined
          ) {
            await tx
              .update(practitionerProfiles)
              .set({
                ...(licenseNumber !== undefined && { licenseNumber }),
                ...(specialties !== undefined && { specialties }),
                ...(bio !== undefined && { bio }),
              })
              .where(eq(practitionerProfiles.userId, id))
          }
          if (dateOfBirth !== undefined) {
            await tx
              .update(patientProfiles)
              .set({ dateOfBirth })
              .where(eq(patientProfiles.userId, id))
          }
          if (position !== undefined) {
            await tx
              .update(adminProfiles)
              .set({ position })
              .where(eq(adminProfiles.userId, id))
          }
          // Before → after for each changed field. A patient's date of
          // birth and address are personal health information under HIPAA;
          // they belong in the trail of WHO changed them — the audit log is
          // readable by admins only (audit_logs_select).
          await this.auditService.logInTransaction(tx, {
            performedBy: currentUser.id,
            action: 'USER_UPDATED',
            targetUserId: id,
            entityType: 'users',
            entityId: id,
            details: { changes },
          })
        }

        const updated = await tx.query.users.findFirst({
          where: eq(users.id, id),
        })
        const roles = await this.getRolesForUser(id, tx)
        return this.attachProfile(
          { ...(await this.toPublic(updated!)), roles },
          roles,
          tx,
        )
      }),
    )
  }

  // --- DELETE ROUTES ---

  // Soft delete only — matches the is_active pattern from the schema. There is
  // deliberately no method here that issues a real DELETE against users.
  //
  // Answers the account AND the ids of the sessions the deactivation ended:
  // the controller closes their messaging sockets (see setActive).
  //
  // WHO MAY DEACTIVATE A PRACTITIONER'S ACCOUNT: an admin, or the
  // practitioner themselves acting as one (2026-10-25). The deactivation
  // ends their care-team links (setActive), and the links' UPDATE policy
  // lets exactly those two end them — anyone else's UPDATE would match no
  // row and SILENTLY leave the links open, so they're refused here instead.
  // The route lets two other people through: a managing practitioner (for a
  // patient — but that patient may hold the practitioner role too), and the
  // account itself acting as a patient (a practitioner + patient account).
  async softDelete(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    const { roles: targetRoles } = await this.findOne(id)
    const mayEndPractitionerLinks =
      currentUser.activeRole === UserRole.ADMIN ||
      (currentUser.id === id &&
        currentUser.activeRole === UserRole.PRACTITIONER)
    if (
      targetRoles.includes(UserRole.PRACTITIONER) &&
      !mayEndPractitionerLinks
    ) {
      throw new ForbiddenException(DEACTIVATE_PRACTITIONER_MESSAGE)
    }
    const { row, endedSessionIds } = await withRlsContext(
      this.db,
      currentUser,
      (tx) => this.setActive(tx, id, false, currentUser.id),
    )
    const roles = await this.getRolesForUser(id)
    const user = await this.attachProfile(
      { ...(await this.toPublic(row)), roles },
      roles,
    )
    return { user, endedSessionIds }
  }

  // Clears the avatar: the row goes back to avatarPath = null (so every
  // response carries avatarUrl: null and the frontend shows initials),
  // and the file itself is deleted from storage. Mirrors
  // ClinicsService.removeLogo(); self-or-admin, checked in the controller
  // like updateAvatar().
  //
  // Idempotent: removing an avatar that isn't there succeeds and changes
  // nothing — the storage delete is skipped, and setting null on a null
  // column is a harmless no-op. "Make sure there's no photo" is satisfied
  // either way, so a double click or a retry after a network error isn't
  // an error.
  async removeAvatar(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findRawOrThrow(id)
    const { updated, previousPath } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const before = await this.lockUser(tx, id)
        // No photo to remove: nothing changes, so nothing is written — no
        // UPDATE and no audit entry (the idempotent case above).
        if (before.avatarPath === null) {
          return { updated: before, previousPath: null }
        }
        const [row] = await tx
          .update(users)
          .set({ avatarPath: null })
          .where(eq(users.id, id))
          .returning()
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'USER_AVATAR_REMOVED',
          targetUserId: id,
          entityType: 'users',
          entityId: id,
          details: {
            changes: { avatarPath: { from: before.avatarPath, to: null } },
          },
        })
        return { updated: row, previousPath: before.avatarPath }
      },
    )
    // Same order as updateAvatar(), same reason: the row stops pointing at
    // the file BEFORE the file is deleted, so a failed delete leaves an
    // orphaned file, never a user pointing at a missing one. Best-effort
    // for the same reason too: the removal is already saved.
    if (previousPath) {
      await this.storageService.deleteUnreferenced(previousPath)
    }
    const roles = await this.getRolesForUser(id)
    return this.attachProfile(
      { ...(await this.toPublic(updated)), roles },
      roles,
    )
  }

  // Admin-only — enforced by @Roles(UserRole.ADMIN) on the controller
  // route, not re-checked here (same division of responsibility as every
  // other role-gated route in this service). Deliberately NOT a new
  // user: this flips isActive back to true on the SAME row, so a
  // returning patient's or practitioner's entire history (medical files,
  // assigned programs, past messages) stays correctly attached to the
  // account they already had, rather than starting over under a second,
  // disconnected id. This is exactly why softDelete() above only ever
  // sets isActive: false instead of issuing a real DELETE — reactivation
  // like this is the payoff of that choice.
  //
  // Deliberately admin-only rather than a self-service flow (e.g. an
  // emailed reactivation link, mirroring forgotPassword/resetPassword) —
  // an account may have been deactivated for a reason a returning person
  // shouldn't be able to silently undo just by proving they still control
  // the original email address. A human admin verifying identity through
  // the clinic's own real-world process before restoring access to a
  // potentially PHI-adjacent account is the more conservative default.
  async reactivate(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findOne(id)
    // "Who restored access to which account, and when" is exactly the kind
    // of event HIPAA's audit controls exist to capture — written in the
    // same transaction as the change (setActive), so the two can't part.
    const { row: reactivated } = await withRlsContext(
      this.db,
      currentUser,
      (tx) => this.setActive(tx, id, true, currentUser.id),
    )
    const roles = await this.getRolesForUser(id)
    return this.attachProfile(
      { ...(await this.toPublic(reactivated)), roles },
      roles,
    )
  }

  // === HELPER FUNCTIONS =====================================================

  // The user's raw row, LOCKED until the end of the caller's transaction
  // (SELECT … FOR UPDATE). Every write to an account reads its "before"
  // values through this, inside its own transaction: a second request for
  // the same account then waits at this line until the first has committed,
  // and reads what the first one wrote. Without the lock, two edits could
  // both read the same old value, and the second entry would claim to have
  // replaced a value that was in fact already gone.
  //
  // Under row-level security, FOR UPDATE also asks the table's UPDATE policy
  // (users_update: self, an admin, or a managing practitioner) — the very
  // people the controller lets through. A row that policy hides is answered
  // like a missing one.
  private async lockUser(tx: DrizzleDb, id: number) {
    const [row] = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .for('update')
    if (!row) {
      throw new NotFoundException(`User ${id} not found`)
    }
    return row
  }

  // The profile fields a PATCH may change, as stored now, flattened to the
  // names UpdateUserDto uses — so changedFields() can compare them with the
  // request. Only the profiles the account HAS: a field of a missing profile
  // is refused before this (update()'s role checks).
  private async profileValues(tx: DrizzleDb, id: number) {
    const [practitioner, patient, admin] = await Promise.all([
      tx.query.practitionerProfiles.findFirst({
        where: eq(practitionerProfiles.userId, id),
      }),
      tx.query.patientProfiles.findFirst({
        where: eq(patientProfiles.userId, id),
      }),
      tx.query.adminProfiles.findFirst({
        where: eq(adminProfiles.userId, id),
      }),
    ])
    return {
      ...(practitioner && {
        licenseNumber: practitioner.licenseNumber,
        specialties: practitioner.specialties,
        bio: practitioner.bio,
      }),
      ...(patient && { dateOfBirth: patient.dateOfBirth }),
      ...(admin && { position: admin.position }),
    }
  }

  // Deactivates (false) or reactivates (true) an account, inside the
  // caller's transaction, with its ONE audit entry — or, when the account is
  // already in that state, changes and writes nothing (the convention).
  // Returns the row as it now is, and the sessions a deactivation ended.
  //
  // DEACTIVATING ENDS THE ACCOUNT'S SESSIONS (found 2026-10-22, with "Change
  // email"). HTTP was already safe — every request re-reads the account and
  // SessionSerializer refuses an inactive one — but a messaging socket is
  // checked once, at its handshake: a deactivated person's open tab kept
  // receiving messages. The sessions are deleted in THIS transaction (an
  // account is never deactivated with its sessions left, nor the other way
  // round), their ids answered so the caller closes the sockets after the
  // commit, and the entry says how many (as an email change's does).
  //
  // DEACTIVATING A PRACTITIONER ENDS THEIR CARE-TEAM LINKS (2026-10-25,
  // decided with the person): someone who can't sign in treats nobody, so
  // the links say so — CareTeamService.endLinksOfDeactivatedPractitioner,
  // in this same transaction. The account's entry names the links it ended
  // (`endedCareTeamLinkIds`, [] for an account that had none — a patient's
  // links are never ended here), and each link gets its own CARE_TEAM_ENDED
  // entry about its patient, as a clinic removal does (decisions §10's
  // exception). Reactivating restores none of them: an admin adds the
  // practitioner back where they're needed.
  private async setActive(
    tx: DrizzleDb,
    id: number,
    isActive: boolean,
    performedBy: number,
  ): Promise<{ row: typeof users.$inferSelect; endedSessionIds: string[] }> {
    const before = await this.lockUser(tx, id)
    if (before.isActive === isActive) {
      return { row: before, endedSessionIds: [] }
    }
    const [row] = await tx
      .update(users)
      .set({ isActive })
      .where(eq(users.id, id))
      .returning()
    // Only on deactivation. Reactivating could run the same DELETE and find
    // nothing: an inactive account holds no session (signing in refuses it,
    // and deactivating deleted them all) — a mutation making reactivation
    // end sessions too changed nothing a test could see. The condition just
    // spares that query, and says what deactivation means.
    const endedSessionIds = isActive ? [] : await endSessions(tx, id)
    const endedLinks = isActive
      ? []
      : await this.careTeamService.endLinksOfDeactivatedPractitioner(
          tx,
          id,
          performedBy,
        )
    await this.auditService.logInTransaction(tx, {
      performedBy,
      action: isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
      targetUserId: id,
      entityType: 'users',
      entityId: id,
      details: {
        changes: { isActive: { from: before.isActive, to: isActive } },
        ...(isActive
          ? {}
          : {
              signedOutSessions: endedSessionIds.length,
              endedCareTeamLinkIds: endedLinks.map((link) => link.id),
            }),
      },
    })
    await this.careTeamService.recordEndedLinks(
      tx,
      endedLinks,
      performedBy,
      ENDED_PRACTITIONER_DEACTIVATED_REASON,
    )
    return { row, endedSessionIds }
  }

  // The raw `users` row, or a 404. RAW means unstripped — passwordHash,
  // avatarPath and all — which is exactly why it's private: its callers
  // need a raw field (updateAvatar/removeAvatar need the OLD avatarPath to
  // delete the file, which the public shape no longer carries) or pass the
  // row straight on to toPublic() (findOne). It must never be returned
  // from a route as-is. Same idea as ClinicsService.findRawForLogoOp().
  private async findRawOrThrow(id: number) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, id),
    })
    if (!user) {
      throw new NotFoundException(`User ${id} not found`)
    }
    return user
  }

  // Turns a raw `users` row into the shape that is allowed to leave the
  // server. Two jobs:
  //
  // 1. Strip every server-internal field: passwordHash (obviously),
  //    mfaSecret (still an encrypted secret that should never reach a
  //    client), mfaLastUsedStep (when the account last used a two-factor
  //    code — a sign-in time, useful to no screen), stepUpFailures (how
  //    many step-ups in a row failed — a security counter, not a screen's
  //    business) and
  //    passwordResetTokenHash/passwordResetTokenExpiresAt (they reveal
  //    whether a password reset is pending, and when it expires).
  // 2. Swap avatarPath (the internal RustFS object key) for avatarUrl, a
  //    presigned URL a browser can load directly — the same conversion
  //    ClinicsService.withLogoUrl() does for logoPath. The key itself is
  //    dropped, not sent alongside: where a file lives in storage is an
  //    implementation detail, and nothing in the frontend can use it.
  //
  // This is THE one funnel for user responses. Every method in this
  // service that returns a user goes through it, and so do AuthService's
  // login and register-clinic responses — which is why it's public, not
  // private: those two build their response from a raw row (they need the
  // real passwordHash, or just inserted the row themselves), and they used
  // to keep their own copy of the strip list. Two copies of a security
  // rule drift apart; one shared function can't. findOne() is also what
  // SessionSerializer.deserializeUser() calls to build req.user on every
  // authenticated request, so this is what shapes GET /auth/me,
  // POST /auth/mfa/verify and POST /auth/switch-role too.
  //
  // async because presigning is: getSignedUrl() is a Promise-based API.
  // No network call happens, though — a presigned URL is a signature
  // computed locally from the access key, so this stays cheap even on the
  // per-request /auth/me path.
  async toPublic(user: typeof users.$inferSelect) {
    const {
      passwordHash,
      mfaSecret,
      mfaLastUsedStep,
      stepUpFailures,
      passwordResetTokenHash,
      passwordResetTokenExpiresAt,
      avatarPath,
      ...publicUser
    } = user
    const avatarUrl = await this.storageService.getPresignedUrlOrNull(
      avatarPath,
      AVATAR_URL_EXPIRY_SECONDS,
    )
    return { ...publicUser, avatarUrl }
  }

  // licenseNumber/specialties, dateOfBirth, and position are written to
  // practitioner_profiles/patient_profiles/admin_profiles at account
  // creation (create(), grantRole()) but were never attached to any
  // response — a real, separate gap from RLS, predating it entirely. Nested
  // under role-named keys (rather than flattened) so a multi-role account
  // can carry more than one without ambiguous top-level fields that only
  // sometimes exist. Public (not private) since AuthService's own
  // hand-built responses (registerClinic, login) need it too — see the
  // comment on toPublic() above for why those two don't go through
  // findOne()/create() in the first place.
  //
  // dbOrTx defaults to this.db for the same reason getRolesForUser's does:
  // create() is the one caller reading a row it just inserted inside its
  // own still-open transaction, so it passes tx explicitly; every other
  // caller reads after its own write has already committed.
  async attachProfile<T extends { id: number }>(
    user: T,
    roles: string[],
    dbOrTx: DrizzleDb = this.db,
  ): Promise<
    T & {
      practitionerProfile?: {
        licenseNumber: string
        specialties: string[]
        bio: string | null
      }
      patientProfile?: { dateOfBirth: string }
      adminProfile?: { position: string | null }
      clinics: { id: number; name: string }[]
    }
  > {
    const [practitionerProfile, patientProfile, adminProfile, clinicRows] =
      await Promise.all([
        roles.includes(UserRole.PRACTITIONER)
          ? dbOrTx.query.practitionerProfiles.findFirst({
              where: eq(practitionerProfiles.userId, user.id),
            })
          : undefined,
        roles.includes(UserRole.PATIENT)
          ? dbOrTx.query.patientProfiles.findFirst({
              where: eq(patientProfiles.userId, user.id),
            })
          : undefined,
        roles.includes(UserRole.ADMIN)
          ? dbOrTx.query.adminProfiles.findFirst({
              where: eq(adminProfiles.userId, user.id),
            })
          : undefined,
        // Not gated by role, unlike the three above — any role can belong
        // to clinics (an admin might, even though nothing else in the app
        // is clinic-scoped for admins), so this always runs.
        dbOrTx
          .select({ id: clinics.id, name: clinics.name })
          .from(userClinics)
          .innerJoin(clinics, eq(clinics.id, userClinics.clinicId))
          .where(eq(userClinics.userId, user.id)),
      ])

    return {
      ...user,
      ...(practitionerProfile && {
        practitionerProfile: {
          licenseNumber: practitionerProfile.licenseNumber,
          specialties: practitionerProfile.specialties,
          bio: practitionerProfile.bio,
        },
      }),
      ...(patientProfile && {
        patientProfile: { dateOfBirth: patientProfile.dateOfBirth },
      }),
      ...(adminProfile && {
        adminProfile: { position: adminProfile.position },
      }),
      clinics: clinicRows,
    }
  }

  // Batched sibling of attachProfile() for findAll()/
  // findPatientsForPractitioner() — one query per table across every user
  // in the list (via inArray), instead of N+1 queries per user.
  private async attachProfilesToMany<T extends { id: number }>(usersList: T[]) {
    if (usersList.length === 0) {
      return [] as Array<
        T & {
          roles: string[]
          practitionerProfile?: {
            licenseNumber: string
            specialties: string[]
            bio: string | null
          }
          patientProfile?: { dateOfBirth: string }
          adminProfile?: { position: string | null }
          clinics: { id: number; name: string }[]
        }
      >
    }

    const ids = usersList.map((u) => u.id)
    const [roleRows, practitionerRows, patientRows, adminRows, clinicRows] =
      await Promise.all([
        this.db
          .select({ userId: userRoles.userId, role: userRoles.role })
          .from(userRoles)
          .where(inArray(userRoles.userId, ids)),
        this.db.query.practitionerProfiles.findMany({
          where: inArray(practitionerProfiles.userId, ids),
        }),
        this.db.query.patientProfiles.findMany({
          where: inArray(patientProfiles.userId, ids),
        }),
        this.db.query.adminProfiles.findMany({
          where: inArray(adminProfiles.userId, ids),
        }),
        this.db
          .select({
            userId: userClinics.userId,
            id: clinics.id,
            name: clinics.name,
          })
          .from(userClinics)
          .innerJoin(clinics, eq(clinics.id, userClinics.clinicId))
          .where(inArray(userClinics.userId, ids)),
      ])

    const rolesByUserId = new Map<number, string[]>()
    for (const row of roleRows) {
      const existing = rolesByUserId.get(row.userId)
      if (existing) {
        existing.push(row.role)
      } else {
        rolesByUserId.set(row.userId, [row.role])
      }
    }
    const practitionerByUserId = new Map(
      practitionerRows.map((p) => [p.userId, p]),
    )
    const patientByUserId = new Map(patientRows.map((p) => [p.userId, p]))
    const adminByUserId = new Map(adminRows.map((p) => [p.userId, p]))
    // Same accumulate-into-an-array pattern as rolesByUserId just above —
    // a user can belong to several clinics, so this can't be a simple
    // one-row-per-user Map the way practitioner/patient/admin are.
    const clinicsByUserId = new Map<number, { id: number; name: string }[]>()
    for (const row of clinicRows) {
      const entry = { id: row.id, name: row.name }
      const existing = clinicsByUserId.get(row.userId)
      if (existing) {
        existing.push(entry)
      } else {
        clinicsByUserId.set(row.userId, [entry])
      }
    }

    return usersList.map((user) => {
      const practitionerProfile = practitionerByUserId.get(user.id)
      const patientProfile = patientByUserId.get(user.id)
      const adminProfile = adminByUserId.get(user.id)
      return {
        ...user,
        roles: rolesByUserId.get(user.id) ?? [],
        ...(practitionerProfile && {
          practitionerProfile: {
            licenseNumber: practitionerProfile.licenseNumber,
            specialties: practitionerProfile.specialties,
            bio: practitionerProfile.bio,
          },
        }),
        ...(patientProfile && {
          patientProfile: { dateOfBirth: patientProfile.dateOfBirth },
        }),
        ...(adminProfile && {
          adminProfile: { position: adminProfile.position },
        }),
        clinics: clinicsByUserId.get(user.id) ?? [],
      }
    })
  }
}
