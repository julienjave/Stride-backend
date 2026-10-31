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
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { RangeOfMotionService } from './range-of-motion.service'
import { CreateRomAssessmentDto } from './dto/create-rom-assessment.dto'
import { movementCatalogue } from './range-of-motion-rules'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// A patient's range-of-motion record (Phase 7, 2026-10-31) — the medical
// file's routes, with the same roles: practitioners and patients only
// (admins 403 — and 0077's policies hide every row from them anyway).
//
// No PATCH and no DELETE, deliberately: append-only; a correction is a new
// assessment that amends the old one (POST with amendsId).
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PRACTITIONER, UserRole.PATIENT)
@ApiTags('Range of Motion')
@Controller('range-of-motion')
export class RangeOfMotionController {
  constructor(private readonly rangeOfMotionService: RangeOfMotionService) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  @Roles(UserRole.PRACTITIONER)
  @AuditedByService()
  @Post()
  create(
    @CurrentUser() user: CurrentUser,
    @Body() dto: CreateRomAssessmentDto,
  ) {
    return this.rangeOfMotionService.create(user, dto)
  }

  // --- GET ROUTES ---

  // The catalogue the screens build their picker and labels from — the same
  // list the database was built from. Not clinical (it is the app's, the
  // same for everyone), so not audited. DECLARED BEFORE ':id': Nest matches
  // routes in order, and ':id' with ParseIntPipe would answer "movements"
  // with a 400.
  @Get('movements')
  movements() {
    return movementCatalogue()
  }

  // A patient: their own record. A practitioner: the patient they name.
  @Get()
  findAll(
    @CurrentUser() user: CurrentUser,
    @Query('patientId', new ParseIntPipe({ optional: true }))
    patientId?: number,
  ) {
    return this.rangeOfMotionService.findAll(user, patientId)
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.rangeOfMotionService.findOne(id, user)
  }
}
