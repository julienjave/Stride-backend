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
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle, seconds } from '@nestjs/throttler'
import { type Request } from 'express'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { MfaCodeDto } from '../auth/dto/mfa-code.dto'
import { MfaService, type MfaSetup } from './mfa.service'
import { SetupMfaDto } from './dto/setup-mfa.dto'
import { DisableMfaDto } from './dto/disable-mfa.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Turning two-factor sign-in on and off (MFA enrolment, Phase 6). The same
// addresses as when these routes lived in AuthController — /auth/mfa/… — in a
// module of their own, like the email and password changes. The sign-in step
// itself (mfa/verify) stays in AuthController: it ends with req.login().
//
// Every route: a signed-in session, every role (it's about the account), and
// the sign-in limit — 5 a minute. Each checks a password or a code, so none
// may become a way to guess one from a stolen session.
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  // 201 with the secret and its QR code — shown once, never readable again.
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('setup')
  setup(
    @CurrentUser() user: CurrentUser,
    @Body() dto: SetupMfaDto,
  ): Promise<MfaSetup> {
    return this.mfaService.setup(user, dto.currentPassword)
  }

  // 204. This browser's session id: the one session kept when the others end.
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async enable(
    @CurrentUser() user: CurrentUser,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.mfaService.enable(user, dto.code, req.sessionID)
  }

  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disable(
    @CurrentUser() user: CurrentUser,
    @Body() dto: DisableMfaDto,
  ): Promise<void> {
    await this.mfaService.disable(user, dto.currentPassword, dto.code)
  }
}
