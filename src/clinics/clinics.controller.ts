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
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { FileInterceptor } from '@nestjs/platform-express'
import { ClinicsService } from './clinics.service'
import { CreateClinicDto } from './dto/create-clinic.dto'
import { UpdateClinicDto } from './dto/update-clinic.dto'
import { AddMemberDto } from './dto/add-member.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { imageUploadOptions } from '../common/config/image-upload.config'

// --- CONTROLLER --------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@ApiTags('Clinics')
@Controller('clinics')
export class ClinicsController {
  constructor(private readonly clinicsService: ClinicsService) {}

  // === ROUTES ===========================================================

  // --- POST ROUTES ---

  // Creating ADDITIONAL clinics, by an existing admin — distinct from
  // POST /auth/register-clinic, which only ever creates the very first one.
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post()
  create(@Body() dto: CreateClinicDto) {
    return this.clinicsService.create(dto)
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/members')
  addMember(@Param('id', ParseIntPipe) id: number, @Body() dto: AddMemberDto) {
    return this.clinicsService.addMember(id, dto.userId)
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/logo')
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  uploadLogo(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded')
    }
    return this.clinicsService.updateLogo(id, file)
  }

  // --- GET ROUTES ---

  // Open to any authenticated user — clinic info is branding/display, not
  // clinically sensitive, matching how it was framed in the schema design.
  @Get()
  findAll() {
    return this.clinicsService.findAll()
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.clinicsService.findOne(id)
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get(':id/members')
  listMembers(@Param('id', ParseIntPipe) id: number) {
    return this.clinicsService.listMembers(id)
  }

  // --- PATCH ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateClinicDto) {
    return this.clinicsService.update(id, dto)
  }

  // --- DELETE ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Delete(':id')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.clinicsService.deactivate(id)
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.clinicsService.removeMember(id, userId)
  }
}
