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
import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { clinics, users, adminProfiles, userClinics } from '../database/schema'
import { UsersService } from '../users/users.service'
import { UserRole } from '../users/dto/create-user.dto'
import { RegisterDto } from './dto/register.dto'
import { RegisterClinicDto } from './dto/register-clinic.dto'


// --- SERVICE -----------------------------------------------------------------------------------------------
@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService, @Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === REGISTRATION ============================================================

  async register(dto: RegisterDto) {
    return this.usersService.create({
      email: dto.email,
      password: dto.password,
      role: UserRole.PATIENT,
      firstName: dto.firstName,
      lastName: dto.lastName,
      dateOfBirth: dto.dateOfBirth,
    })
  }

  // Bootstraps a brand-new clinic AND its founding admin account together.
  // Gated to only work when NO admin exists anywhere in the system yet —
  // this is deliberately a ONE-TIME setup operation, not an ongoing public
  // signup path. Clinics in this schema are branding/display entities, not
  // isolated multi-tenant boundaries, so letting anyone spin up unlimited
  // clinics indefinitely would be a different product than the one designed.
  async registerClinic(dto: RegisterClinicDto) {
    const existingAdmin = await this.db.query.users.findFirst({
      where: eq(users.role, UserRole.ADMIN),
    })
    if (existingAdmin) {
      throw new ForbiddenException(
        'An administrator account already exists. Ask an existing admin to create additional accounts.',
      )
    }
 
    const passwordHash = await bcrypt.hash(dto.password, 10)
 
    return this.db.transaction(async (tx) => {
      const [clinic] = await tx
        .insert(clinics)
        .values({
          name: dto.clinicName,
          email: dto.clinicEmail,
          phone: dto.clinicPhone,
          website: dto.clinicWebsite,
        })
        .returning()
 
      const [user] = await tx
        .insert(users)
        .values({
          email: dto.email,
          passwordHash,
          role: UserRole.ADMIN,
          firstName: dto.firstName,
          lastName: dto.lastName,
        })
        .returning()
 
      await tx.insert(adminProfiles).values({
        userId: user.id,
        position: dto.position,
      })
 
      await tx.insert(userClinics).values({
        userId: user.id,
        clinicId: clinic.id,
      })
 
      const { passwordHash: _omit, ...publicUser } = user
      return publicUser
    })
  }

  // === VALIDATION / LOGIN =======================================================

  // Called by LocalStrategy on every login attempt.
  // Returns the sanitized user on success, or null on failure
  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmailWithHash(email)
    if (!user) {
      return null
    }
    const passwordMatches = await bcrypt.compare(password, user.passwordHash)
    if (!passwordMatches) {
      return null
    }
    const { passwordHash, ...publicUser } = user
    return publicUser
  }
}