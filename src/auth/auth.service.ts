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
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { clinics, users, adminProfiles, userClinics, userRoles } from '../database/schema'
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
    const user = await this.usersService.create({
      email: dto.email,
      password: dto.password,
      role: UserRole.PATIENT,
      firstName: dto.firstName,
      lastName: dto.lastName,
      dateOfBirth: dto.dateOfBirth,
    })

    return { ...user, activeRole: UserRole.PATIENT }
  }

  // Bootstraps a brand-new clinic AND its founding admin account together.
  // Gated to only work when NO admin exists anywhere in the system yet —
  // this is deliberately a ONE-TIME setup operation, not an ongoing public
  // signup path. Clinics in this schema are branding/display entities, not
  // isolated multi-tenant boundaries, so letting anyone spin up unlimited
  // clinics indefinitely would be a different product than the one designed.
  async registerClinic(dto: RegisterClinicDto) {
    const existingAdmin = await this.db.query.userRoles.findFirst({
      where: eq(userRoles.role, UserRole.ADMIN),
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
          firstName: dto.firstName,
          lastName: dto.lastName,
        })
        .returning()
 
      await tx.insert(userRoles).values({ userId: user.id, role: UserRole.ADMIN })
 
      await tx.insert(adminProfiles).values({
        userId: user.id,
        position: dto.position,
      })
 
      await tx.insert(userClinics).values({
        userId: user.id,
        clinicId: clinic.id,
      })
 
      const { passwordHash: _omit, ...publicUser } = user
      return {
        ...publicUser,
        roles: [UserRole.ADMIN],
        activeRole: UserRole.ADMIN,
        clinicId: clinic.id,
      }
    })
  }


  // === VALIDATION / LOGIN =======================================================

  // Called by LocalStrategy on every login attempt. requestedRole is
  // optional — required only when the account holds more than one role,
  // since there's no safe way to silently guess which one someone means to
  // use for this session.
  async validateUser(email: string, password: string, requestedRole?: string) {
    const user = await this.usersService.findByEmailWithHash(email)
    if (!user) {
      return null
    }
    const passwordMatches = await bcrypt.compare(password, user.passwordHash)
    if (!passwordMatches) {
      return null
    }
 
    const roles = await this.usersService.getRolesForUser(user.id)
 
    let activeRole: string
    if (requestedRole) {
      if (!roles.includes(requestedRole)) {
        throw new ForbiddenException(`This account does not have the "${requestedRole}" role`)
      }
      activeRole = requestedRole
    } else if (roles.length === 1) {
      activeRole = roles[0]
    } else {
      // Multiple roles, none specified — refuse to silently pick one.
      throw new BadRequestException(
        'This account has multiple roles. Specify which one to log in as.',
      )
    }
 
    const { passwordHash, ...publicUser } = user
    return { ...publicUser, roles, activeRole }
  }
}