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
import { eq, and, inArray } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
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
} from '../database/pg-errors'
import { AuditService } from '../audit/audit.service'

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
// licenseNumber before writing, like the email check in create()): a
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

// --- SERVICE ------------------------------------------------------------------------------------------------
@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // requestingUser is checked against ACTIVE role, not just "has this role somewhere"
  async create(
    dto: CreateUserDto,
    requestingUser?: { id: number; activeRole: UserRole },
  ) {
    if (
      requestingUser?.activeRole === UserRole.PRACTITIONER &&
      dto.role !== UserRole.PATIENT
    ) {
      throw new ForbiddenException(
        'Practitioners can only create patient accounts',
      )
    }

    // The one place in this app that actually CREATES a practitioner-patient
    // relationship — every other path that trusts one already going through
    // it (findOne/update/remove on users, AssignedPrograms, Sessions,
    // MedicalFiles, Messaging) does so via isPatientManagedBy, which checks
    // REAL shared clinic membership. This check was missing here entirely:
    // dto.clinicId was only ever verified to exist as a real clinic, never
    // verified as one the REQUESTING practitioner actually belongs to —
    // meaning a practitioner in Clinic A could plant a patient record
    // directly into Clinic B's roster purely by knowing Clinic B's id.
    // Admin is exempt — admins have legitimate oversight across every
    // clinic, consistent with every other admin-bypass check in this app.
    if (requestingUser?.activeRole === UserRole.PRACTITIONER && dto.clinicId) {
      const ownClinicIds = await this.getClinicIdsForUser(requestingUser.id)
      if (!ownClinicIds.includes(dto.clinicId)) {
        throw new ForbiddenException(
          'You can only add patients to a clinic you belong to',
        )
      }
    }

    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, dto.email),
    })
    if (existing) {
      throw new ConflictException('A user with this email already exists')
    }

    const passwordHash = await bcrypt.hash(dto.password, 10)

    // Wrapped: creating a practitioner inserts their licenseNumber.
    return translateDuplicateLicense(() =>
      withRlsContext(this.db, requestingUser, async (tx) => {
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

        const roles = [dto.role]
        return this.attachProfile({ ...this.toPublic(user), roles }, roles, tx)
      }),
    )
  }

  // Grants an ADDITIONAL role to an already-existing user
  async grantRole(
    userId: number,
    dto: GrantRoleDto,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findOne(userId)

    const existingRole = await this.db.query.userRoles.findFirst({
      where: and(eq(userRoles.userId, userId), eq(userRoles.role, dto.role)),
    })
    if (existingRole) {
      throw new ConflictException(`User already has the "${dto.role}" role`)
    }

    // Wrapped: granting the practitioner role inserts a licenseNumber.
    return translateDuplicateLicense(() =>
      withRlsContext(this.db, currentUser, async (tx) => {
        await tx.insert(userRoles).values({ userId, role: dto.role })

        // Only creates the profile row if this user doesn't already have one
        // for this role (relevant if a role was previously granted, then
        // somehow re-granted after removal — defensive, not expected in
        // normal use, but cheap to guard against).
        if (dto.role === UserRole.PRACTITIONER) {
          const hasProfile = await tx.query.practitionerProfiles.findFirst({
            where: eq(practitionerProfiles.userId, userId),
          })
          if (!hasProfile) {
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
            await tx
              .insert(patientProfiles)
              .values({ userId, dateOfBirth: dto.dateOfBirth! })
          }
        } else if (dto.role === UserRole.ADMIN) {
          const hasProfile = await tx.query.adminProfiles.findFirst({
            where: eq(adminProfiles.userId, userId),
          })
          if (!hasProfile) {
            await tx
              .insert(adminProfiles)
              .values({ userId, position: dto.position })
          }
        }

        return this.getRolesForUser(userId, tx)
      }),
    )
  }

  // Uploads a new avatar and stores its object key on the user's row.
  // Authorization (self-or-admin) happens in the controller, matching
  // update()'s rule — same pattern, just triggered by a file instead of a
  // JSON body.
  async updateAvatar(
    id: number,
    file: Express.Multer.File,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findOne(id)
    const objectKey = `avatars/${id}/${Date.now()}.${extensionForMimeType(file.mimetype)}`
    await this.storageService.upload(objectKey, file.buffer, file.mimetype)
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(users)
        .set({ avatarPath: objectKey })
        .where(eq(users.id, id))
        .returning(),
    )
    const roles = await this.getRolesForUser(id)
    return this.attachProfile({ ...this.toPublic(updated), roles }, roles)
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
    return this.attachProfilesToMany(rows.map((u) => this.toPublic(u)))
  }

  // dbOrTx defaults to this.db (a fresh connection, always seeing the
  // latest COMMITTED state) — correct for every caller that runs this
  // after its own writing transaction has already resolved
  // (findOne/update/softDelete/updateAvatar all call this only once
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

  // Shared by findPatientsForPractitioner, isPatientManagedBy, and (new)
  // create()'s clinic-ownership check below — three places that all
  // needed "which clinics does this user actually belong to".
  private async getClinicIdsForUser(userId: number): Promise<number[]> {
    const rows = await this.db
      .select({ clinicId: userClinics.clinicId })
      .from(userClinics)
      .where(eq(userClinics.userId, userId))
    return rows.map((r) => r.clinicId)
  }

  // "My patients," for a practitioner — defined as any active patient who
  // shares at least one clinic with them.
  async findPatientsForPractitioner(practitionerId: number) {
    const clinicIds = await this.getClinicIdsForUser(practitionerId)
    if (clinicIds.length === 0) {
      return []
    }

    const rows = await this.db
      .selectDistinct({ user: users })
      .from(users)
      .innerJoin(userClinics, eq(userClinics.userId, users.id))
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(
        and(
          eq(userRoles.role, UserRole.PATIENT),
          eq(users.isActive, true),
          inArray(userClinics.clinicId, clinicIds),
        ),
      )

    return this.attachProfilesToMany(rows.map((r) => this.toPublic(r.user)))
  }

  // The shared building block behind the PATCH/DELETE ownership checks below
  // — "is this patient one this practitioner can act on," using the same
  // clinic-sharing definition as findPatientsForPractitioner.
  //
  // Mirrored independently in SQL by rls_practitioner_manages_patient() in
  // src/database/migrations/0003_assigned_programs_rls.sql — same rule,
  // TypeScript here vs. a Postgres function there, with no automatic check
  // keeping the two in sync. A future change to either one needs the other
  // checked too. RLS can only narrow what a query returns, never broaden
  // it, so a drift here would fail silently: rows would just start going
  // quietly missing for a practitioner, never throw an error.
  async isPatientManagedBy(
    patientId: number,
    practitionerId: number,
  ): Promise<boolean> {
    const clinicIds = await this.getClinicIdsForUser(practitionerId)
    if (clinicIds.length === 0) {
      return false
    }

    const match = await this.db
      .select()
      .from(userClinics)
      .where(
        and(
          eq(userClinics.userId, patientId),
          inArray(userClinics.clinicId, clinicIds),
        ),
      )
      .limit(1)

    return match.length > 0
  }

  async findOne(id: number) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, id),
    })
    if (!user) {
      throw new NotFoundException(`User ${id} not found`)
    }
    const roles = await this.getRolesForUser(id)
    return this.attachProfile({ ...this.toPublic(user), roles }, roles)
  }

  // INTERNAL USE ONLY — the one method in this service that does NOT strip
  // passwordHash. Never call this from a controller; it exists purely for
  // AuthService to compare a login attempt's password against the real hash.
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
  // One field-level rule sits on top of that: licenseNumber can only be
  // changed by a caller whose ACTIVE role is admin (decisions §4) — see
  // the check below.
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
        const updated =
          Object.keys(userFields).length > 0
            ? (
                await tx
                  .update(users)
                  .set(userFields)
                  .where(eq(users.id, id))
                  .returning()
              )[0]
            : await tx.query.users.findFirst({ where: eq(users.id, id) })

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

        const roles = await this.getRolesForUser(id, tx)
        return this.attachProfile(
          { ...this.toPublic(updated!), roles },
          roles,
          tx,
        )
      }),
    )
  }

  // --- DELETE ROUTES ---

  // Soft delete only — matches the is_active pattern from the schema. There is
  // deliberately no method here that issues a real DELETE against users.
  async softDelete(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    await this.findOne(id)
    const [deactivated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, id))
        .returning(),
    )
    const roles = await this.getRolesForUser(id)
    return this.attachProfile({ ...this.toPublic(deactivated), roles }, roles)
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
    const [reactivated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(users)
        .set({ isActive: true })
        .where(eq(users.id, id))
        .returning(),
    )
    // Audit logging is not optional here — this app treats "who restored
    // access to which account, and when" as exactly the kind of event
    // HIPAA's audit-controls technical safeguard exists to capture,
    // matching the precedent already set by LOGIN_SUCCESS/LOGIN_FAILURE/
    // PASSWORD_RESET_REQUESTED elsewhere in this codebase.
    await this.auditService.log({
      performedBy: currentUser.id,
      action: 'USER_REACTIVATED',
      entityType: 'users',
      entityId: id,
    })
    const roles = await this.getRolesForUser(id)
    return this.attachProfile({ ...this.toPublic(reactivated), roles }, roles)
  }

  // === HELPER FUNCTIONS =====================================================

  // Strips every server-internal field before anything leaves the
  // service: passwordHash (obviously), but also mfaSecret (still an
  // encrypted secret that should never reach a client), and
  // passwordResetTokenHash/passwordResetTokenExpiresAt (reveal whether a
  // password reset is currently pending, and when it expires). This is
  // the one funnel findOne()/findAll()/update()/softDelete()/
  // updateAvatar() all go through — findOne() is also what
  // SessionSerializer.deserializeUser() calls to build req.user on every
  // authenticated request, so this one change is what keeps these fields
  // out of GET /auth/me, POST /auth/mfa/verify, and POST /auth/switch-role.
  private toPublic(user: typeof users.$inferSelect) {
    const {
      passwordHash,
      mfaSecret,
      passwordResetTokenHash,
      passwordResetTokenExpiresAt,
      ...publicUser
    } = user
    return publicUser
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