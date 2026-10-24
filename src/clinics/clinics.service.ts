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
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { clinics, userClinics, users, userRoles } from '../database/schema'
import { CreateClinicDto } from './dto/create-clinic.dto'
import { UpdateClinicDto } from './dto/update-clinic.dto'
import { StorageService } from '../storage/storage.service'
import { extensionForMimeType } from '../common/config/image-upload.config'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { CareTeamService } from '../care-team/care-team.service'
import { changedFields } from '../common/changed-fields'
import {
  isUniqueViolation,
  USER_CLINICS_USER_CLINIC_UNIQUE,
} from '../database/pg-errors'

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

// Adding a member a clinic already has: user_clinics' UNIQUE (user_id,
// clinic_id) refuses the INSERT, and this turns that refusal into the 409,
// for addMember's .catch(). addMember used to read first and insert after —
// two requests at once could both read "not a member" and the second hit
// the constraint as a 500. The constraint decides atomically, so its verdict
// is the answer, with no read. Always throws: the 409, otherwise the error
// it was given.
function rethrowDuplicateMembership(error: unknown): never {
  if (isUniqueViolation(error, USER_CLINICS_USER_CLINIC_UNIQUE)) {
    throw new ConflictException('This user already belongs to this clinic')
  }
  throw error
}

// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// How long a clinic logo's presigned URL stays valid. Deliberately much
// longer than StorageService's own 900-second (15 min) default: a logo is
// low-sensitivity branding, not a secret, and this URL gets embedded in
// ordinary GET /clinics responses that the frontend may cache for a while
// (TanStack Query's default staleTime is only 30 seconds, but a browser tab
// left idle — no refocus, no navigation — won't naturally refetch on its
// own). 24 hours comfortably covers "left a tab open overnight," while
// still being far short of the 7-day login session — if this URL ever
// leaked outside the app (browser history, a screenshot, a log line), it
// wouldn't stay usable for as long as the session that generated it.
const CLINIC_LOGO_URL_EXPIRY_SECONDS = 60 * 60 * 24

@Injectable()
export class ClinicsService {
  // No UsersService injected here, deliberately — everything this service
  // needs (validating a user exists, listing members with their names) is
  // just another query against the same globally-available DRIZZLE db.
  // Avoids a circular module dependency (Clinics <-> Users) that would
  // otherwise appear the moment UsersModule also needs to check clinics.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
    private readonly careTeamService: CareTeamService,
  ) {}

  // Converts a raw clinic row (which carries logoPath, the internal RustFS
  // object key) into the shape every route actually returns to callers:
  // the same fields, MINUS logoPath, PLUS a fresh logoUrl a browser can
  // load directly. logoPath is dropped rather than sent alongside logoUrl
  // — it's an implementation detail of where the file lives in storage,
  // never read by the frontend (nothing in the app used it even when it
  // WAS the only field available), so there's no reason to expose storage
  // internals through the public API surface. Every route below that
  // returns a clinic — create, update, deactivate, updateLogo, findOne,
  // findAll — funnels through this one helper, so there's exactly one
  // place that knows how a stored key becomes a usable URL.
  //
  // `typeof clinics.$inferSelect` is Drizzle's built-in way to get the
  // exact TypeScript type of "one full row from the clinics table" derived
  // directly from the schema definition — rather than hand-writing a
  // matching interface that could quietly drift out of sync if a column is
  // ever added or renamed.
  private async withLogoUrl(clinic: typeof clinics.$inferSelect) {
    const { logoPath, ...rest } = clinic
    const logoUrl = await this.storageService.getPresignedUrlOrNull(
      logoPath,
      CLINIC_LOGO_URL_EXPIRY_SECONDS,
    )
    return { ...rest, logoUrl }
  }

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Every write below follows the audit convention (the audit review, Phase
  // 6 — decisions §10): ONE entry per request that changes something, written
  // in the change's own transaction; nothing written for a request that
  // changes nothing. A clinic is organisation data: no targetUserId, except
  // where a membership names the person concerned.
  async create(currentUser: CurrentUser, dto: CreateClinicDto) {
    const clinic = await withRlsContext(this.db, currentUser, async (tx) => {
      const [row] = await tx.insert(clinics).values(dto).returning()
      // The record is the request as validated (the jsonb column stores
      // JSON.stringify's output, which leaves out fields not sent).
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'CLINIC_CREATED',
        entityType: 'clinics',
        entityId: row.id,
        details: { record: dto },
      })
      return row
    })
    return this.withLogoUrl(clinic)
  }

  async addMember(clinicId: number, userId: number, currentUser: CurrentUser) {
    await this.findOne(clinicId)

    const userExists = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    })
    if (!userExists) {
      throw new NotFoundException(`User ${userId} not found`)
    }

    // Joining a clinic is what gives a practitioner directory access to its
    // patients (and lets them join care teams there): the person concerned
    // is the target. Already a member: user_clinics' UNIQUE (user_id,
    // clinic_id) refuses the INSERT, and the .catch() turns that into the 409
    // (rethrowDuplicateMembership) — no read beforehand, which two requests
    // at once could both pass (decisions §16).
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [membership] = await tx
        .insert(userClinics)
        .values({ clinicId, userId })
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'CLINIC_MEMBER_ADDED',
        targetUserId: userId,
        entityType: 'user_clinics',
        entityId: membership.id,
        details: { clinicId },
      })
      return membership
    }).catch(rethrowDuplicateMembership)
  }

  // Fetches just enough of a clinic's raw row to know its current
  // logoPath — used by updateLogo() and removeLogo() below, both of
  // which need to know what file (if any) was there BEFORE they change
  // it, so the old object can be cleaned up from storage rather than
  // left orphaned in RustFS forever. findOne() can't be reused for this:
  // it returns the transformed shape (logoUrl, no logoPath at all).
  private async findRawForLogoOp(id: number) {
    const clinic = await this.db.query.clinics.findFirst({
      where: eq(clinics.id, id),
    })
    if (!clinic) {
      throw new NotFoundException(`Clinic ${id} not found`)
    }
    return clinic
  }

  async updateLogo(
    id: number,
    currentUser: CurrentUser,
    file: Express.Multer.File,
  ) {
    await this.findRawForLogoOp(id)
    const objectKey = `clinics/${id}/logo-${Date.now()}.${extensionForMimeType(file.mimetype)}`
    await this.storageService.upload(objectKey, file.buffer, file.mimetype)
    // The logo it replaces is read under the row's lock, inside the
    // transaction — the one the entry names, and the one deleted below.
    const { updated, existing } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const before = await this.lockClinic(tx, id)
        const [row] = await tx
          .update(clinics)
          .set({ logoPath: objectKey })
          .where(eq(clinics.id, id))
          .returning()
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'CLINIC_LOGO_CHANGED',
          entityType: 'clinics',
          entityId: id,
          details: {
            changes: { logoPath: { from: before.logoPath, to: objectKey } },
          },
        })
        return { updated: row, existing: before }
      },
    )
    // Only AFTER the new file is safely uploaded and the DB successfully
    // points at it — deleting the OLD file at this point, not before,
    // means a failure earlier in this method never leaves the clinic
    // pointing at a file that's already been deleted. Best-effort
    // (deleteUnreferenced): the new logo is already saved, so failing to
    // clean up the old file must not turn this into an error response.
    if (existing.logoPath) {
      await this.storageService.deleteUnreferenced(existing.logoPath)
    }
    return this.withLogoUrl(updated)
  }

  // Admin-only (enforced at the controller, same as updateLogo). Clears
  // logoPath back to null and deletes the underlying file from storage —
  // idempotent if the clinic has no logo to begin with: then nothing is
  // written at all (no UPDATE, no audit entry) and no file is deleted.
  async removeLogo(id: number, currentUser: CurrentUser) {
    await this.findRawForLogoOp(id)
    const { updated, existing } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const before = await this.lockClinic(tx, id)
        if (before.logoPath === null) {
          return { updated: before, existing: before }
        }
        const [row] = await tx
          .update(clinics)
          .set({ logoPath: null })
          .where(eq(clinics.id, id))
          .returning()
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'CLINIC_LOGO_REMOVED',
          entityType: 'clinics',
          entityId: id,
          details: {
            changes: { logoPath: { from: before.logoPath, to: null } },
          },
        })
        return { updated: row, existing: before }
      },
    )
    // Same ordering rule as updateLogo() above: the DB is updated FIRST,
    // so if the storage delete below fails, the worst case is an
    // orphaned file sitting in RustFS (recoverable with a cleanup pass
    // later) rather than a clinic record pointing at a file that's
    // already gone (which would 404 the next time anyone tried to load
    // the logo image). Best-effort for the same reason as updateLogo().
    if (existing.logoPath) {
      await this.storageService.deleteUnreferenced(existing.logoPath)
    }
    return this.withLogoUrl(updated)
  }

  // --- GET ROUTES ---

  // includeInactive defaults to false — every existing caller keeps
  // seeing only active clinics, unchanged. Admin-only enforcement of WHO
  // can pass true happens at the controller; this method just does what
  // it's told, mirroring UsersService.findAll()'s identical addition.
  async findAll(includeInactive = false) {
    const rows = await this.db.query.clinics.findMany({
      where: includeInactive ? undefined : eq(clinics.isActive, true),
    })
    return Promise.all(rows.map((clinic) => this.withLogoUrl(clinic)))
  }

  async findOne(id: number) {
    const clinic = await this.db.query.clinics.findFirst({
      where: eq(clinics.id, id),
    })
    if (!clinic) {
      throw new NotFoundException(`Clinic ${id} not found`)
    }
    return this.withLogoUrl(clinic)
  }

  // Used by ExistenceCheck-style callers (e.g. UsersService.create) that just
  // need a yes/no answer, without throwing — a plain findOne() would throw
  // on a missing clinic, which is the wrong shape for a caller that wants to
  // decide for itself how to react.
  async exists(id: number): Promise<boolean> {
    const clinic = await this.db.query.clinics.findFirst({
      where: eq(clinics.id, id),
    })
    return !!clinic
  }

  async listMembers(clinicId: number) {
    await this.findOne(clinicId)
    const members = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(userClinics)
      .innerJoin(users, eq(users.id, userClinics.userId))
      .where(eq(userClinics.clinicId, clinicId))

    // Attaches each member's full roles array
    return Promise.all(
      members.map(async (member) => {
        const roles = await this.db
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(eq(userRoles.userId, member.id))
        return { ...member, roles: roles.map((r) => r.role) }
      }),
    )
  }

  // --- PATCH ROUTES ---

  // Before → after for each field that really changed, read under the
  // row's lock; a PATCH that changes nothing writes nothing.
  async update(id: number, currentUser: CurrentUser, dto: UpdateClinicDto) {
    await this.findOne(id)
    const updated = await withRlsContext(this.db, currentUser, async (tx) => {
      const before = await this.lockClinic(tx, id)
      const changes = changedFields(before, { ...dto })
      if (Object.keys(changes).length === 0) {
        return before
      }
      const [row] = await tx
        .update(clinics)
        .set(dto)
        .where(eq(clinics.id, id))
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'CLINIC_UPDATED',
        entityType: 'clinics',
        entityId: id,
        details: { changes },
      })
      return row
    })
    return this.withLogoUrl(updated)
  }

  // --- DELETE ROUTES ---

  async deactivate(id: number, currentUser: CurrentUser) {
    await this.findOne(id)
    const deactivated = await withRlsContext(this.db, currentUser, (tx) =>
      this.setActive(tx, id, false, currentUser.id),
    )
    return this.withLogoUrl(deactivated)
  }

  // Admin-only — enforced by @Roles(UserRole.ADMIN) on the controller
  // route, not re-checked here, same division of responsibility as every
  // other role-gated route in this service. Mirrors UsersService.
  // reactivate() exactly: flips isActive back to true on the SAME row
  // (a clinic's members, programs, and history all stay attached to the
  // same id), and is audit-logged for the same reason — restoring access
  // is exactly the kind of event this app's audit trail exists to
  // capture. The existing clinics_update RLS policy already covers a
  // plain UPDATE re-flipping is_active, so no new RLS policy was needed
  // for this — only the route and this method. The entry is written in the
  // same transaction as the change (setActive).
  async reactivate(id: number, currentUser: CurrentUser) {
    await this.findOne(id)
    const reactivated = await withRlsContext(this.db, currentUser, (tx) =>
      this.setActive(tx, id, true, currentUser.id),
    )
    return this.withLogoUrl(reactivated)
  }

  // Removes someone from a clinic — and, in the SAME transaction, ends each
  // of their care-team links that no longer has a clinic in common
  // (CareTeamService.endLinksWithoutSharedClinic). Either both happen or
  // neither does: a membership gone but its links still looking active
  // would make the care-team history lie.
  async removeMember(
    clinicId: number,
    userId: number,
    currentUser: CurrentUser,
  ) {
    await this.findOne(clinicId)
    await withRlsContext(this.db, currentUser, async (tx) => {
      const removed = await tx
        .delete(userClinics)
        .where(
          and(
            eq(userClinics.clinicId, clinicId),
            eq(userClinics.userId, userId),
          ),
        )
        .returning({ id: userClinics.id })
      const endedLinks = await this.careTeamService.endLinksWithoutSharedClinic(
        tx,
        userId,
        currentUser.id,
      )
      // The ONE exception to "one entry per request" (decided with the
      // person, 2026-10-21 — decisions §10): this act touches several
      // records. The removal is one entry, about the member; each care-team
      // link it ended is one more, about ITS patient — so "everything that
      // happened to patient X" stays one query on target_user_id. All in
      // this transaction: the membership, the links and their trail commit
      // together or not at all. Not a member any more (nothing deleted):
      // no removal entry.
      if (removed.length > 0) {
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'CLINIC_MEMBER_REMOVED',
          targetUserId: userId,
          entityType: 'user_clinics',
          entityId: removed[0].id,
          details: {
            clinicId,
            endedCareTeamLinkIds: endedLinks.map((link) => link.id),
          },
        })
      }
      for (const link of endedLinks) {
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'CARE_TEAM_ENDED',
          targetUserId: link.patientId,
          entityType: 'care_team_members',
          entityId: link.id,
          details: {
            practitionerId: link.practitionerId,
            startedAt: link.startedAt,
            endsAt: link.endsAt,
            reason: 'No longer share a clinic',
            clinicId,
          },
        })
      }
    })
  }

  // === HELPERS ============================================================

  // The clinic's raw row, LOCKED until the end of the caller's transaction
  // (SELECT … FOR UPDATE) — the same reason as UsersService.lockUser(): a
  // second edit waits for the first, so each entry's "from" is exact.
  // clinics_update allows admins only, the same people the controller lets
  // through; a row it hides is answered like a missing clinic.
  private async lockClinic(tx: DrizzleDb, id: number) {
    const [row] = await tx
      .select()
      .from(clinics)
      .where(eq(clinics.id, id))
      .for('update')
    if (!row) {
      throw new NotFoundException(`Clinic ${id} not found`)
    }
    return row
  }

  // Deactivates (false) or reactivates (true) a clinic with its ONE entry —
  // or, already in that state, writes nothing. Returns the row as it is now.
  private async setActive(
    tx: DrizzleDb,
    id: number,
    isActive: boolean,
    performedBy: number,
  ) {
    const before = await this.lockClinic(tx, id)
    if (before.isActive === isActive) {
      return before
    }
    const [row] = await tx
      .update(clinics)
      .set({ isActive })
      .where(eq(clinics.id, id))
      .returning()
    await this.auditService.logInTransaction(tx, {
      performedBy,
      action: isActive ? 'CLINIC_REACTIVATED' : 'CLINIC_DEACTIVATED',
      entityType: 'clinics',
      entityId: id,
      details: {
        changes: { isActive: { from: before.isActive, to: isActive } },
      },
    })
    return row
  }
}
