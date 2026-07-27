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

import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { MedicalFilesService } from './medical-files.service'
import { CreateMedicalFileDto } from './dto/create-medical-file.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'


// --- CONTROLLER --------------------------------------------------------------------------------------------

// No PATCH, no DELETE routes anywhere in this controller — deliberate, not
// an incomplete module. See MedicalFilesService for the reasoning.
@UseGuards(SessionAuthGuard)
@Controller('medical-files')
export class MedicalFilesController {
  constructor(private readonly medicalFilesService: MedicalFilesService) {}


  // === ROUTES =============================================================

  // --- POST ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner')
  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateMedicalFileDto) {
    return this.medicalFilesService.create(user, dto)
  }


  // --- GET ROUTES ---

  // Patient: their own history, no query param needed. Practitioner/admin:
  // must specify which patient's file to view.
  @Get()
  findAll(@CurrentUser() user: any, @Query('patientId') patientId?: string) {
    return this.medicalFilesService.findAll(user, patientId ? Number(patientId) : undefined)
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.medicalFilesService.findOne(id, user)
  }
}