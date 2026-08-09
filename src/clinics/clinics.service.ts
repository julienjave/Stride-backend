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

// --- SERVICE -----------------------------------------------------------------------------------------------

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

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(dto: CreateClinicDto) {
    const [clinic] = await this.db.insert(clinics).values(dto).returning()
    return clinic
  }

  async addMember(clinicId: number, userId: number) {
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

    const [membership] = await this.db
      .insert(userClinics)
      .values({ clinicId, userId })
      .returning()
    return membership
  }

  async updateLogo(id: number, file: Express.Multer.File) {
    await this.findOne(id)
    const objectKey = `clinics/${id}/logo-${Date.now()}.${extensionForMimeType(file.mimetype)}`
    await this.storageService.upload(objectKey, file.buffer, file.mimetype)
    const [updated] = await this.db
      .update(clinics)
      .set({ logoPath: objectKey })
      .where(eq(clinics.id, id))
      .returning()
    return updated
  }

  // --- GET ROUTES ---

  async findAll() {
    return this.db.query.clinics.findMany({ where: eq(clinics.isActive, true) })
  }

  async findOne(id: number) {
    const clinic = await this.db.query.clinics.findFirst({
      where: eq(clinics.id, id),
    })
    if (!clinic) {
      throw new NotFoundException(`Clinic ${id} not found`)
    }
    return clinic
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

  async update(id: number, dto: UpdateClinicDto) {
    await this.findOne(id)
    const [updated] = await this.db
      .update(clinics)
      .set(dto)
      .where(eq(clinics.id, id))
      .returning()
    return updated
  }

  // --- DELETE ROUTES ---

  async deactivate(id: number) {
    await this.findOne(id)
    const [deactivated] = await this.db
      .update(clinics)
      .set({ isActive: false })
      .where(eq(clinics.id, id))
      .returning()
    return deactivated
  }

  async removeMember(clinicId: number, userId: number) {
    await this.findOne(clinicId)
    await this.db
      .delete(userClinics)
      .where(
        and(eq(userClinics.clinicId, clinicId), eq(userClinics.userId, userId)),
      )
  }
}
