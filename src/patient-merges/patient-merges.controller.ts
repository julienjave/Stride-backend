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

// Merging two accounts of the same patient (decisions §27, pass 3) — admins
// only. Under /users, like every admin action on an account.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  Body,
  Controller,
  Get,
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
import { MergePatientDto } from './dto/merge-patient.dto'
import {
  PatientMergesService,
  type PatientMergeAnswer,
  type PatientMergeRecord,
} from './patient-merges.service'
import { DemoLocked } from '../demo/demo-lock.guard'

// --- CONTROLLER --------------------------------------------------------------------------------------------

@ApiTags('Users')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('users')
export class PatientMergesController {
  constructor(private readonly mergesService: PatientMergesService) {}

  // The account in the address is merged AWAY into `intoUserId`. 200 (not
  // 201): the merge record is created, but what the admin asked for is a
  // change to two existing accounts — the answer names the merge. 5 a
  // minute, like every route that checks a password (a stolen session must
  // not become a way to guess one); the session id for the step-up's
  // "signed out after 5 failures in a row".
  @AuditedByService()
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  // The demo's shared accounts are refused (decisions §46).
  @DemoLocked('merge', 'param')
  @Post(':id/merge')
  @HttpCode(HttpStatus.OK)
  merge(
    @Param('id', ParseIntPipe) mergedId: number,
    @Body() dto: MergePatientDto,
    @CurrentUser() admin: CurrentUser,
    @Req() req: Request,
  ): Promise<PatientMergeAnswer> {
    return this.mergesService.merge(
      admin,
      mergedId,
      dto.intoUserId,
      { currentPassword: dto.currentPassword, mfaCode: dto.mfaCode },
      req.sessionID,
    )
  }
}

// Every merge, for the admin's screens (pass 4): the users list's "Merged"
// badge and a merged account's "Merged into …" banner. Its own path rather
// than /users/merges: GET /users/:id parses `:id` as a number and would
// answer "merges" with a 400 if Nest tried it first.
@ApiTags('Users')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('patient-merges')
export class PatientMergesListController {
  constructor(private readonly mergesService: PatientMergesService) {}

  @Get()
  list(@CurrentUser() admin: CurrentUser): Promise<PatientMergeRecord[]> {
    return this.mergesService.list(admin)
  }
}
