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
  HttpCode, 
  HttpStatus, 
  Post, 
  Req, 
  Res, 
  UseGuards 
} from '@nestjs/common'
import { Throttle, seconds } from '@nestjs/throttler'
import { type Request, type Response } from 'express'
import { LocalAuthGuard } from './guards/local-auth.guard'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuthService } from './auth.service'
import { LoginDto } from './dto/login.dto'
import { RegisterDto } from './dto/register.dto'
import { RegisterClinicDto } from './dto/register-clinic.dto'
import { SwitchRoleDto } from './dto/switch-role.dto'
import { AuditService } from '../audit/audit.service'


// --- CONTROLLER --------------------------------------------------------------------------------------------
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService, 
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES ===========================================================

  // --- POST ROUTES ---

  // == Register ==

  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const user = await this.authService.register(dto)
    return new Promise((resolve, reject) => {
      req.login(user, (err) => (err ? reject(err) : resolve(user)))
    })
  }

  // Public, but self-limiting: AuthService.registerClinic() refuses to run
  // at all once any admin account exists — see the comment there.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('register-clinic')
  async registerClinic(@Body() dto: RegisterClinicDto, @Req() req: Request) {
    const user = await this.authService.registerClinic(dto)
    return new Promise((resolve, reject) => {
      req.login(user, (err) => (err ? reject(err) : resolve(user)))
    })
  }
  
  // == Login ==

  // Overrides just the 'default' throttler for THIS route only
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @UseGuards(LocalAuthGuard)
  @Post('login')
  login(@Body() _dto: LoginDto, @CurrentUser() user: unknown) {
    // By the time this method body runs, LocalAuthGuard has already: run
    // LocalStrategy.validate(), called req.login() internally to establish
    // the session, and set the session cookie on the response. There's
    // nothing left to do here but return the user.
    return user
  }

  // == Switch Roles ==

  // Changes which role is active for THIS session, without a full
  // logout/login round trip — re-calls req.login() with an updated
  // activeRole, which re-triggers serializeUser and overwrites the stored
  // session data. Only lets someone switch to a role they actually hold.
  @UseGuards(SessionAuthGuard)
  @Post('switch-role')
  switchRole(@Body() dto: SwitchRoleDto, @CurrentUser() user: any, @Req() req: Request) {
    if (!user.roles.includes(dto.role)) {
      throw new ForbiddenException(`You do not have the "${dto.role}" role`)
    }
    const updatedUser = { ...user, activeRole: dto.role }
    return new Promise((resolve, reject) => {
      req.login(updatedUser, (err) => (err ? reject(err) : resolve(updatedUser)))
    })
  }

  // == Logout ==

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any
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

  // --- GET ROUTES ---

  @UseGuards(SessionAuthGuard)
  @Get('me')
  me(@CurrentUser() user: unknown) {
    return user
  }
}