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

  async create(currentUser: CurrentUser, dto: CreateClinicDto) {
    const [clinic] = await withRlsContext(this.db, currentUser, (tx) =>
      tx.insert(clinics).values(dto).returning(),
    )
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

    const existing = await this.db.query.userClinics.findFirst({
      where: and(
        eq(userClinics.clinicId, clinicId),
        eq(userClinics.userId, userId),
      ),
    })
    if (existing) {
      throw new ConflictException('This user already belongs to this clinic')
    }

    const [membership] = await withRlsContext(this.db, currentUser, (tx) =>
      tx.insert(userClinics).values({ clinicId, userId }).returning(),
    )
    return membership
  }

  async updateLogo(
    id: number,
    currentUser: CurrentUser,
    file: Express.Multer.File,
  ) {
    await this.findOne(id)
    const objectKey = `clinics/${id}/logo-${Date.now()}.${extensionForMimeType(file.mimetype)}`
    await this.storageService.upload(objectKey, file.buffer, file.mimetype)
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(clinics)
        .set({ logoPath: objectKey })
        .where(eq(clinics.id, id))
        .returning(),
    )
    return this.withLogoUrl(updated)
  }

  // --- GET ROUTES ---

  async findAll() {
    const rows = await this.db.query.clinics.findMany({
      where: eq(clinics.isActive, true),
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

  async update(id: number, currentUser: CurrentUser, dto: UpdateClinicDto) {
    await this.findOne(id)
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx.update(clinics).set(dto).where(eq(clinics.id, id)).returning(),
    )
    return this.withLogoUrl(updated)
  }

  // --- DELETE ROUTES ---

  async deactivate(id: number, currentUser: CurrentUser) {
    await this.findOne(id)
    const [deactivated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(clinics)
        .set({ isActive: false })
        .where(eq(clinics.id, id))
        .returning(),
    )
    return this.withLogoUrl(deactivated)
  }

  async removeMember(
    clinicId: number,
    userId: number,
    currentUser: CurrentUser,
  ) {
    await this.findOne(clinicId)
    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .delete(userClinics)
        .where(
          and(
            eq(userClinics.clinicId, clinicId),
            eq(userClinics.userId, userId),
          ),
        ),
    )
  }
}