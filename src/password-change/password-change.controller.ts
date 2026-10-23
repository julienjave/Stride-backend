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
import { PasswordChangeService } from './password-change.service'
import { ChangePasswordDto } from './dto/change-password.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Changing one's own password from the profile ("Change password",
// decisions §13). Under /auth with the other sign-in routes, in a module of
// its own like the email change (AuthController is long enough). Every role —
// it's about the account, not a role's work — so no @Roles; a signed-in
// session (SessionAuthGuard). Self-service only: no route changes SOMEONE
// ELSE's password (an admin's way to help is the reset email).
@ApiTags('auth')
@Controller('auth/password')
export class PasswordChangeController {
  constructor(private readonly passwordChangeService: PasswordChangeService) {}

  // 204: nothing to answer — this browser stays signed in, as it was. The
  // sign-in limit (5 a minute): the route checks a password, so it must not
  // become a way to guess one from a stolen session. This browser's session
  // id: the one session kept when the account is signed out everywhere else.
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async change(
    @CurrentUser() user: CurrentUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.passwordChangeService.change(user, dto, req.sessionID)
  }
}
