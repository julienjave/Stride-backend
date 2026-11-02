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
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { NotAudited } from '../common/decorators/not-audited.decorator'
import { AuthService } from './auth.service'
import { UsersService } from '../users/users.service'
import { LoginDto } from './dto/login.dto'
import { RegisterClinicDto } from './dto/register-clinic.dto'
import { SwitchRoleDto } from './dto/switch-role.dto'
import { ForgotPasswordDto } from './dto/forgot-password.dto'
import { ResetPasswordDto } from './dto/reset-password.dto'
import { CheckResetTokenDto } from './dto/check-reset-token.dto'
import { MfaCodeDto } from './dto/mfa-code.dto'
import { AuditService } from '../audit/audit.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { MfaService } from '../mfa/mfa.service'

// --- CONTROLLER --------------------------------------------------------------------------------------------

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
    private readonly messagingEvents: MessagingEvents,
    private readonly mfaService: MfaService,
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
  @AuditedByService()
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
  @AuditedByService()
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
  @AuditedByService()
  @Post('mfa/verify')
  async verifyMfaLogin(@Body() dto: MfaCodeDto, @Req() req: Request) {
    const pending = req.session.mfaPending
    if (!pending) {
      throw new BadRequestException(
        'No pending MFA verification for this session',
      )
    }

    // A refused code answers 401 with its words: wrong, or already used
    // (mfa/totp.ts — no code works twice). The pending state stays, so the
    // person can type the next code without the password again.
    const outcome = await this.mfaService.verifySignIn(pending, dto.code)
    if (!outcome.ok) {
      throw new UnauthorizedException(outcome.message)
    }

    delete req.session.mfaPending

    const user = await this.usersService.findSelf(pending.userId)
    const authenticatedUser = { ...user, activeRole: pending.activeRole }

    return new Promise((resolve, reject) => {
      req.login(authenticatedUser, (err: Error | null) =>
        err ? reject(err) : resolve(authenticatedUser),
      )
    })
  }

  // Setting up, turning on and turning off two-factor sign-in: MfaController
  // (src/mfa/), at the same /auth/mfa/… addresses.

  // == Switch Roles ==

  // Changes which role is active for THIS session, without a full
  // logout/login round trip — re-calls req.login() with an updated
  // activeRole, which re-triggers serializeUser and overwrites the stored
  // session data. Only lets someone switch to a role they actually hold.
  @UseGuards(SessionAuthGuard)
  @AuditedByService()
  @Post('switch-role')
  async switchRole(
    @Body() dto: SwitchRoleDto,
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
  ) {
    if (!user.roles.includes(dto.role)) {
      throw new ForbiddenException(`You do not have the "${dto.role}" role`)
    }
    const updatedUser = { ...user, activeRole: dto.role }
    // ROLE_SWITCHED (added by the audit review, decided with the person
    // 2026-10-21): the role decides what data this session can read — an
    // admin + practitioner moving into clinical data is worth a trace.
    // Awaited BEFORE the switch, on AuditService's own connection (a session
    // change, not a data change: no transaction to join) — no switch without
    // its entry. "Switching" to the role already active changes nothing and
    // writes nothing.
    if (dto.role !== user.activeRole) {
      await this.auditService.log({
        performedBy: user.id,
        action: 'ROLE_SWITCHED',
        targetUserId: user.id,
        entityType: 'users',
        entityId: user.id,
        details: { from: user.activeRole, to: dto.role },
      })
    }
    // The session's id BEFORE the login: req.login() regenerates the session
    // (a new id — Passport's protection against session fixation), and the
    // open sockets were authenticated with the old one.
    const previousSessionId = req.sessionID
    return new Promise((resolve, reject) => {
      req.login(updatedUser, (err: Error | null) => {
        if (err) return reject(err)
        // The sockets opened in the OLD role are closed (Phase 5): each
        // keeps the role it connected with, so it would go on receiving —
        // and sending — the previous role's messages. The client reconnects
        // and gets a socket in the new role (MessagingEvents).
        this.messagingEvents.disconnectSession(previousSessionId)
        resolve(updatedUser)
      })
    })
  }

  // == Logout ==

  @AuditedByService()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res() res: Response) {
    const user = req.user as CurrentUser | undefined
    if (user) {
      await this.auditService.log({
        performedBy: user.id,
        action: 'LOGOUT',
        targetUserId: user.id,
        entityType: 'users',
        entityId: user.id,
      })
    }

    // Read before the session is destroyed: the id names its sockets' room.
    const sessionId = req.sessionID
    req.logout(() => {
      req.session.destroy(() => {
        // A logged-out tab's socket must not stay connected — it was
        // authenticated once, at its handshake, and would otherwise keep
        // receiving messages (MessagingEvents.disconnectSession). Its
        // reconnect is then refused: no session.
        this.messagingEvents.disconnectSession(sessionId)
        res.clearCookie('connect.sid')
        res.status(HttpStatus.NO_CONTENT).send()
      })
    })
  }

  // == RESET PASSWORD ==

  // 204 — genuinely nothing to describe, on purpose: the whole point is
  // that success and "no such account" look identical from the outside.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email)
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const { endedSessionIds } = await this.authService.resetPassword(
      dto.token,
      dto.newPassword,
    )
    // Every device was signed out (the reason a reset exists: someone else
    // may have had access) — their sockets too, or a signed-out device would
    // keep receiving messages. Same as logout, for every session at once.
    for (const sessionId of endedSessionIds) {
      this.messagingEvents.disconnectSession(sessionId)
    }
  }

  // Is a reset link still usable? The reset page asks first (decided
  // 2026-10-21), so a dead link is said before anyone types a password.
  // 200 { email, expiresAt } or the reset's own 400. A POST although it only
  // reads: the token travels in the body, never in a URL that gets logged.
  // The same throttle as its neighbours — a public route that answers yes or
  // no about a token must not become a fast guessing oracle (the 256-bit
  // token makes guessing hopeless anyway; the limit keeps it that way).
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @NotAudited('Only checks a reset token; nothing changes')
  @Post('reset-password/check')
  @HttpCode(HttpStatus.OK)
  checkResetToken(@Body() dto: CheckResetTokenDto) {
    return this.authService.checkResetToken(dto.token)
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
