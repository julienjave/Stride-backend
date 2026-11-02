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
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle, seconds } from '@nestjs/throttler'
import { type Request } from 'express'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { MfaService } from './mfa.service'
import { ResetMfaDto } from './dto/reset-mfa.dto'
import { DemoLocked } from '../demo/demo-lock.guard'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// An admin turning SOMEONE ELSE's two-factor sign-in off (MFA enrolment,
// pass 2 — the person's choice: the last resort after recovery codes).
// Under /users/:id, beside the other things an admin does to an account; in
// the MFA module, beside the rest of two-factor. Admins only (the active
// role); the sign-in limit, since it checks the admin's password. The
// admin's session id: the ADMIN's step-up, so their session is the one
// signed out after 5 failures in a row (decisions §16).
@ApiTags('Users')
@UseGuards(SessionAuthGuard)
@Controller('users')
export class MfaAdminController {
  constructor(private readonly mfaService: MfaService) {}

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  // The demo's shared accounts are refused (decisions §46).
  @DemoLocked('two_factor', 'param')
  @Post(':id/mfa/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reset(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() admin: CurrentUser,
    @Body() dto: ResetMfaDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.mfaService.resetForUser(
      admin,
      id,
      {
        currentPassword: dto.currentPassword,
        mfaCode: dto.mfaCode,
      },
      req.sessionID,
    )
  }
}
