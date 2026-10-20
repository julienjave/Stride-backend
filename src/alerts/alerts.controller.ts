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
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { AlertsService } from './alerts.service'
import { AlertsQueryDto } from './dto/alerts-query.dto'
import { ReviewProgramAlertDto } from './dto/review-program-alert.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The practitioner home's To-do (decided 2026-10-19). Practitioners only: an
// admin has no care team (the To-do is "my patients"), and a patient never
// sees alerts about themselves — they are the care team's workflow.
//
// The list is a read: no @AuditedByService (the interceptor logs writes
// only). Logging READS of clinical data is the whole-app audit review's
// question (Phase 6), for every read route at once. The review is a write,
// audited by the service (the convention).
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PRACTITIONER)
@ApiTags('Alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUser, @Query() query: AlertsQueryDto) {
    return this.alertsService.list(user, query.today)
  }

  // "Mark as reviewed" for a program's attendance alert (2026-10-19). 200,
  // not 201: idempotent — while my latest review still covers the alert,
  // a second call writes nothing and answers that review.
  @AuditedByService()
  @HttpCode(HttpStatus.OK)
  @Post('programs/:programId/review')
  reviewProgram(
    @Param('programId', ParseIntPipe) programId: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: ReviewProgramAlertDto,
  ) {
    return this.alertsService.reviewAttendance(programId, user, dto.today)
  }
}
