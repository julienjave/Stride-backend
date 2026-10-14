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
  Body,
  Controller,
  Get,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle, seconds } from '@nestjs/throttler'
import { type Request, type Response } from 'express'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuthService } from './auth.service'
import { UsersService } from '../users/users.service'
import { LoginDto } from './dto/login.dto'
import { RegisterClinicDto } from './dto/register-clinic.dto'
import { SwitchRoleDto } from './dto/switch-role.dto'
import { ForgotPasswordDto } from './dto/forgot-password.dto'
import { ResetPasswordDto } from './dto/reset-password.dto'
import { MfaCodeDto } from './dto/mfa-code.dto'
import { AuditService } from '../audit/audit.service'

// --- CONTROLLER --------------------------------------------------------------------------------------------

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES ===========================================================

  // --- POST ROUTES ---

  // == Register ==

  // POST /auth/register (public self-registration) was REMOVED with
  // invitations (design decisions §3, 2026-10-07): accounts are created by an
  // admin or a practitioner and receive an invitation — a self-registered
  // patient belonged to no clinic and was visible to nobody. What remains is
  // the one-time setup of the very first clinic and admin:

  // Public, but self-limiting: AuthService.registerClinic() refuses to run
  // at all once any admin account exists — see the comment there.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('register-clinic')
  async registerClinic(@Body() dto: RegisterClinicDto, @Req() req: Request) {
    const user = await this.authService.registerClinic(dto)
    return new Promise((resolve, reject) => {
      req.login(user, (err: Error | null) =>
        err ? reject(err) : resolve(user),
      )
    })
  }

  // == Login / MFA ==

  // No longer uses LocalAuthGuard/LocalStrategy — an explicit method,
  // calling AuthService.validateUser() directly, the same manual req.login()
  // pattern already used by register/registerClinic/switchRole above.
  // Passport's Strategy model is single-shot (succeed → immediately log in);
  // MFA needs a genuine intermediate state (password correct, session NOT
  // yet authenticated), which that model has no clean way to express — so
  // this route stopped using it entirely, rather than working around it.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const user = await this.authService.validateUser(
      dto.email,
      dto.password,
      dto.role,
    )
    if (!user) {
      throw new UnauthorizedException('Invalid email or password')
    }

    if (user.mfaEnabled) {
      // Password verified, but req.login() is deliberately NOT called yet.
      // mfaPending is a SEPARATE session key from the one Passport itself
      // checks (req.session.passport) — req.isAuthenticated() still
      // correctly returns false for this session until MFA actually
      // succeeds. The resolved activeRole is carried through here too, so
      // the role-selection logic already run inside validateUser() doesn't
      // need to be repeated once MFA completes.
      req.session.mfaPending = {
        userId: user.id,
        activeRole: user.activeRole,
      }
      return { mfaRequired: true }
    }

    return new Promise((resolve, reject) => {
      req.login(user, (err: Error | null) =>
        err ? reject(err) : resolve(user),
      )
    })
  }

  // The second step of a two-factor login. Deliberately no SessionAuthGuard
  // here — the session isn't authenticated yet, by design; this route's own
  // check of req.session.mfaPending is what stands in for a guard.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('mfa/verify')
  async verifyMfaLogin(@Body() dto: MfaCodeDto, @Req() req: Request) {
    const pending = req.session.mfaPending
    if (!pending) {
      throw new BadRequestException(
        'No pending MFA verification for this session',
      )
    }

    const isValid = await this.authService.verifyMfaCode(
      pending.userId,
      dto.code,
    )
    if (!isValid) {
      throw new UnauthorizedException('Invalid authentication code')
    }

    delete req.session.mfaPending

    const user = await this.usersService.findOne(pending.userId)
    const authenticatedUser = { ...user, activeRole: pending.activeRole }

    return new Promise((resolve, reject) => {
      req.login(authenticatedUser, (err: Error | null) =>
        err ? reject(err) : resolve(authenticatedUser),
      )
    })
  }

  // --- MFA enrollment (requires an already-authenticated session) ---

  @UseGuards(SessionAuthGuard)
  @Post('mfa/setup')
  setupMfa(@CurrentUser() user: CurrentUser) {
    return this.authService.setupMfa(user.id, user)
  }

  // Same 5/60s throttle as mfa/verify, for consistency with this app's own
  // rationale for requiring a fresh code on sensitive MFA actions — enabling
  // or disabling MFA is exactly that. (A concrete brute-force scenario was
  // not found: otplib here uses the default epochTolerance of 0, so only the
  // single exact 30s window is ever valid, and there's no account-lockout
  // layer behind this — but tightening this is cheap and has no meaningful
  // downside for a legitimate user entering a fresh code.)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('mfa/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async enableMfa(@CurrentUser() user: CurrentUser, @Body() dto: MfaCodeDto) {
    await this.authService.enableMfa(user.id, dto.code, user)
  }

  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('mfa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableMfa(@CurrentUser() user: CurrentUser, @Body() dto: MfaCodeDto) {
    await this.authService.disableMfa(user.id, dto.code, user)
  }

  // == Switch Roles ==

  // Changes which role is active for THIS session, without a full
  // logout/login round trip — re-calls req.login() with an updated
  // activeRole, which re-triggers serializeUser and overwrites the stored
  // session data. Only lets someone switch to a role they actually hold.
  @UseGuards(SessionAuthGuard)
  @Post('switch-role')
  switchRole(
    @Body() dto: SwitchRoleDto,
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
  ) {
    if (!user.roles.includes(dto.role)) {
      throw new ForbiddenException(`You do not have the "${dto.role}" role`)
    }
    const updatedUser = { ...user, activeRole: dto.role }
    return new Promise((resolve, reject) => {
      req.login(updatedUser, (err: Error | null) =>
        err ? reject(err) : resolve(updatedUser),
      )
    })
  }

  // == Logout ==

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res() res: Response) {
    const user = req.user as CurrentUser | undefined
    if (user) {
      await this.auditService.log({
        performedBy: user.id,
        action: 'LOGOUT',
        entityType: 'users',
        entityId: user.id,
      })
    }

    req.logout(() => {
      req.session.destroy(() => {
        res.clearCookie('connect.sid')
        res.status(HttpStatus.NO_CONTENT).send()
      })
    })
  }

  // == RESET PASSWORD ==

  // 204 — genuinely nothing to describe, on purpose: the whole point is
  // that success and "no such account" look identical from the outside.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email)
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword)
  }

  // --- GET ROUTES ---

  // == First-time setup ==

  // Public: the sign-in page asks before anyone is signed in, to decide
  // whether to offer "First time? Set up Stride" (decisions §3). It reveals
  // one bit — whether Stride has been set up — which POST
  // /auth/register-clinic already reveals to anyone (it answers 403 once it
  // has). One small read; the global rate limit is enough.
  @Get('setup-status')
  async setupStatus(): Promise<{ setupComplete: boolean }> {
    return { setupComplete: await this.authService.isSetupComplete() }
  }

  // == Current user ==

  @UseGuards(SessionAuthGuard)
  @Get('me')
  me(@CurrentUser() user: CurrentUser) {
    return user
  }
}
