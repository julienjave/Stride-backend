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
import { eq } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  users,
  practitionerProfiles,
  patientProfiles,
  adminProfiles,
} from '../database/schema'
import { CreateUserDto, UserRole } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'


// --- SERVICE ------------------------------------------------------------------------------------------------
@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(dto: CreateUserDto) {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, dto.email),
    })
    if (existing) {
      throw new ConflictException('A user with this email already exists')
    }

    const passwordHash = await bcrypt.hash(dto.password, 10)

    return this.db.transaction(async (tx) => {
      // .returning() asks Postgres to hand back the row it just inserted —
      // without it, an INSERT tells nothing about what was created,
      // including the auto-generated id we need for the next insert below.
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
