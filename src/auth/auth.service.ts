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
import { eq, sql } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { randomBytes, createHash } from 'crypto'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { clinics, users, adminProfiles, userClinics, userRoles } from '../database/schema'
import { UsersService } from '../users/users.service'
import { UserRole } from '../users/dto/create-user.dto'
import { RegisterDto } from './dto/register.dto'
import { RegisterClinicDto } from './dto/register-clinic.dto'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'


// --- SERVICE -----------------------------------------------------------------------------------------------

interface RegisterClinicResult {
  id: number
  email: string
  firstName: string
  lastName: string
  avatarPath: string | null
  isActive: boolean
  createdAt: Date
  roles: UserRole[]
  activeRole: UserRole
  clinicId: number
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService, 
    @Inject(DRIZZLE) private readonly db: DrizzleDb, 
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
  ) {}

  
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

    await this.auditService.log({
      performedBy: user.id,
      action: 'REGISTER',
      entityType: 'users',
      entityId: user.id,
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
 
    const result: RegisterClinicResult = await this.db.transaction(async (tx): Promise<RegisterClinicResult> => {
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

    await this.auditService.log({
      performedBy: result.id,
      action: 'REGISTER_CLINIC',
      entityType: 'clinics',
      entityId: result.clinicId,
      details: { adminUserId: result.id },
    })

    return result
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
      await this.auditService.log({
        performedBy: user.id,
        action: 'LOGIN_FAILURE',
        entityType: 'users',
        entityId: user.id,
      })
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

    await this.auditService.log({
      performedBy: user.id,
      action: 'LOGIN_SUCCESS',
      entityType: 'users',
      entityId: user.id,
      details: { activeRole },
    })
 
    const { passwordHash, ...publicUser } = user
    return { ...publicUser, roles, activeRole }
  }


  // === PASSWORD RESET =============================================================

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmailWithHash(email)
 
    // Always the same outcome from the caller's point of view, whether the
    // email matches a real account or not — the response never reveals
    // which case actually happened. Only a real match generates a token
    // and sends an email at all.
    if (!user) {
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
    await this.db
      .update(users)
      .set({ passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: expiresAt })
      .where(eq(users.id, user.id))
 
    // The raw token — never the hash — is the only thing that ever leaves
    // this server.
    await this.emailService.sendPasswordResetEmail(user.email, rawToken)
 
    await this.auditService.log({
      performedBy: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      entityType: 'users',
      entityId: user.id,
    })
  }
 
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
 
    const user = await this.db.query.users.findFirst({
      where: eq(users.passwordResetTokenHash, tokenHash),
    })
 
    if (!user || !user.passwordResetTokenExpiresAt || user.passwordResetTokenExpiresAt < new Date()) {
      throw new BadRequestException('This password reset link is invalid or has expired')
    }
 
    const newPasswordHash = await bcrypt.hash(newPassword, 10)
 
    await this.db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      })
      .where(eq(users.id, user.id))
 
    // The whole reason a password needed resetting might be that someone
    // else had access to the account — leaving their existing session
    // alive afterward would defeat the entire point of resetting it.
    await this.destroyAllSessionsForUser(user.id)
 
    await this.auditService.log({
      performedBy: user.id,
      action: 'PASSWORD_RESET_COMPLETED',
      entityType: 'users',
      entityId: user.id,
    })
  }
 
  // Raw SQL, deliberately — the "session" table is created and managed
  // entirely by connect-pg-simple, outside Drizzle's own schema and
  // migrations. There's no typed table definition for it to query through
  // the normal query builder; Session data is stored as JSON in the "sess"
  // column, matching the shape SessionSerializer writes: reaching the
  // stored user id means walking that same JSON path back out.
  private async destroyAllSessionsForUser(userId: number): Promise<void> {
    await this.db.execute(
      sql`DELETE FROM session WHERE (sess::jsonb)->'passport'->'user'->>'id' = ${String(userId)}`,
    )
  }
}