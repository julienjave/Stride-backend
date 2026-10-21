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
import { MedicalFilesService } from './medical-files.service'
import { CreateMedicalFileDto } from './dto/create-medical-file.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// A patient's medical file (Phase 6, 2026-10-20). Practitioners and patients
// only: admins get 403 on every route (decided with the person, the same as
// messaging — and migration 0050 hides every row from them too).
//
// No PATCH and no DELETE, deliberately: entries are append-only, and a
// correction is a new entry that amends the old one (POST with amendsId).
// The reads are audited too — by the service, in the read's transaction.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PRACTITIONER, UserRole.PATIENT)
@ApiTags('Medical Files')
@Controller('medical-files')
export class MedicalFilesController {
  constructor(private readonly medicalFilesService: MedicalFilesService) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Writing clinical content: practitioners only. @Roles on the method
  // REPLACES the controller's list for this route (the guard reads the
  // handler's first — getAllAndOverride).
  @Roles(UserRole.PRACTITIONER)
  @AuditedByService()
  @Post()
  create(@CurrentUser() user: CurrentUser, @Body() dto: CreateMedicalFileDto) {
    return this.medicalFilesService.create(user, dto)
  }

  // --- GET ROUTES ---

  // A patient: their own file (no parameter needed). A practitioner: the
  // patient they name. `optional: true` lets the parameter be absent, and
  // anything present must be an integer ("abc" → 400 — it used to become
  // NaN and reach the database).
  @Get()
  findAll(
    @CurrentUser() user: CurrentUser,
    @Query('patientId', new ParseIntPipe({ optional: true }))
    patientId?: number,
  ) {
    return this.medicalFilesService.findAll(user, patientId)
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.medicalFilesService.findOne(id, user)
  }
}
