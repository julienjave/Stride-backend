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
  ForbiddenException
} from '@nestjs/common'
import { eq, and, inArray } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  users,
  practitionerProfiles,
  patientProfiles,
  adminProfiles,
  userClinics,
  clinics,
} from '../database/schema'
import { CreateUserDto, UserRole } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'


// --- SERVICE ------------------------------------------------------------------------------------------------
@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(dto: CreateUserDto, requestingUser?: { role: string }) {
    if (requestingUser?.role === UserRole.PRACTITIONER && dto.role !== UserRole.PATIENT) {
      throw new ForbiddenException('Practitioners can only create patient accounts')
    }
 
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, dto.email),
    })
    if (existing) {
      throw new ConflictException('A user with this email already exists')
    }
 
    const passwordHash = await bcrypt.hash(dto.password, 10)
 
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: dto.email,
          passwordHash,
          role: dto.role,
          firstName: dto.firstName,
          lastName: dto.lastName,
        })
        .returning()
 
      if (dto.role === UserRole.PRACTITIONER) {
        await tx.insert(practitionerProfiles).values({
          userId: user.id,
          licenseNumber: dto.licenseNumber!,
          specialties: dto.specialties ?? [],
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
 
      return this.toPublic(user)
    })
  }

  // --- GET ROUTES ---

  async findAll() {
    const rows = await this.db.query.users.findMany({
      where: eq(users.isActive, true),
    })
    return rows.map((u) => this.toPublic(u))
  }

  // "My patients," for a practitioner — defined as any active patient who
  // shares at least one clinic with them. This is the only relationship
  // table we have between users and anything shared right now; a stricter
  // definition ("patients I've actually assigned a program to") becomes
  // possible once AssignedProgramsModule exists, and would be worth
  // tightening to at that point.
  async findPatientsForPractitioner(practitionerId: number) {
    const practitionerClinics = await this.db
      .select({ clinicId: userClinics.clinicId })
      .from(userClinics)
      .where(eq(userClinics.userId, practitionerId))
 
    const clinicIds = practitionerClinics.map((c) => c.clinicId)
    if (clinicIds.length === 0) {
      return []
    }
 
    const rows = await this.db
      .selectDistinct({ user: users })
      .from(users)
      .innerJoin(userClinics, eq(userClinics.userId, users.id))
      .where(
        and(
          eq(users.role, UserRole.PATIENT),
          eq(users.isActive, true),
          inArray(userClinics.clinicId, clinicIds),
        ),
      )
 
    return rows.map((r) => this.toPublic(r.user))
  }

  // The shared building block behind the PATCH/DELETE ownership checks below
  // — "is this patient one this practitioner can act on," using the same
  // clinic-sharing definition as findPatientsForPractitioner.
  async isPatientManagedBy(patientId: number, practitionerId: number): Promise<boolean> {
    const practitionerClinics = await this.db
      .select({ clinicId: userClinics.clinicId })
      .from(userClinics)
      .where(eq(userClinics.userId, practitionerId))
 
    const clinicIds = practitionerClinics.map((c) => c.clinicId)
    if (clinicIds.length === 0) {
      return false
    }
 
    const match = await this.db
      .select()
      .from(userClinics)
      .where(and(eq(userClinics.userId, patientId), inArray(userClinics.clinicId, clinicIds)))
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
    return this.toPublic(user)
  }

  // INTERNAL USE ONLY — the one method in this service that does NOT strip
  // passwordHash. Never call this from a controller; it exists purely for
  // AuthService to compare a login attempt's password against the real hash.
  async findByEmailWithHash(email: string) {
    return this.db.query.users.findFirst({ where: eq(users.email, email) })
  }

  // --- PATCH ROUTES ---

  async update(id: number, dto: UpdateUserDto) {
    await this.findOne(id)
    const [updated] = await this.db
      .update(users)
      .set(dto)
      .where(eq(users.id, id))
      .returning()
    return this.toPublic(updated)
  }

  // --- DELETE ROUTES ---

  // Soft delete only — matches the is_active pattern from the schema. There is
  // deliberately no method here that issues a real DELETE against users.
  async softDelete(id: number) {
    await this.findOne(id)
    const [deactivated] = await this.db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, id))
      .returning()
    return this.toPublic(deactivated)
  }


  // === HELPER FUNCTIONS =====================================================

  // Strips passwordHash before anything leaves the service
  private toPublic(user: typeof users.$inferSelect) {
    const { passwordHash, ...publicUser } = user
    return publicUser
  }
}
