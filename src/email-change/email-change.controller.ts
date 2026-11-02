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
  Delete,
  Get,
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
import {
  EmailChangeService,
  type PendingEmailChange,
} from './email-change.service'
import { RequestEmailChangeDto } from './dto/request-email-change.dto'
import { EmailChangeTokenDto } from './dto/email-change-token.dto'
import { DemoLocked } from '../demo/demo-lock.guard'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Changing one's own sign-in email ("Change email", decisions §12). Under
// /auth with the other sign-in routes, in a module of its own (AuthController
// is long enough). Every role may use it — it's about the account, not a
// role's work — so no @Roles: a signed-in session (SessionAuthGuard) for the
// three routes about MY request; nothing for the two links, which are opened
// from an inbox, maybe on a device that isn't signed in.
//
// The password-guessing routes keep the sign-in limit (5 a minute): the
// request checks a password, and the two link routes answer yes or no about
// a token.
@ApiTags('auth')
@Controller('auth/email-change')
export class EmailChangeController {
  constructor(private readonly emailChangeService: EmailChangeService) {}

  // { pending: … | null } rather than a bare null: an empty body is easy to
  // misread on the client, an object never is.
  @UseGuards(SessionAuthGuard)
  @Get()
  async findPending(
    @CurrentUser() user: CurrentUser,
  ): Promise<{ pending: PendingEmailChange | null }> {
    return { pending: await this.emailChangeService.findPending(user) }
  }

  // 201 with the new pending request — the same answer whether the address
  // is free or taken (decisions §12, "reveal nothing"). This browser's
  // session id: the one signed out after 5 failed step-ups in a row.
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  // The demo's shared accounts are refused (decisions §46).
  @DemoLocked('email')
  @Post()
  async request(
    @CurrentUser() user: CurrentUser,
    @Body() dto: RequestEmailChangeDto,
    @Req() req: Request,
  ): Promise<{ pending: PendingEmailChange }> {
    const pending = await this.emailChangeService.request(
      user,
      dto.newEmail,
      {
        currentPassword: dto.currentPassword,
        mfaCode: dto.mfaCode,
      },
      req.sessionID,
    )
    return { pending }
  }

  @UseGuards(SessionAuthGuard)
  @AuditedByService()
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelPending(@CurrentUser() user: CurrentUser): Promise<void> {
    await this.emailChangeService.cancelPending(user)
  }

  // 200 { email } — the address the account now signs in with, for the
  // page's "sign in with …". This browser's session id: if it is signed in
  // as the account, its session is the one kept when the account is signed
  // out everywhere else.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() dto: EmailChangeTokenDto, @Req() req: Request) {
    return this.emailChangeService.confirm(dto.token, {
      sessionId: req.sessionID,
    })
  }

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelByLink(@Body() dto: EmailChangeTokenDto): Promise<void> {
    await this.emailChangeService.cancelByLink(dto.token)
  }
}
