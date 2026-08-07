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
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { ProgramsService } from './programs.service'
import { CreateTemplateDto } from './dto/create-template.dto'
import { UpdateTemplateDto } from './dto/update-template.dto'
import { AddTemplateExerciseDto } from './dto/add-template-exercise.dto'
import { UpdateTemplateExerciseDto } from './dto/update-template-exercise.dto'
import { ReorderTemplateExercisesDto } from './dto/reorder-template-exercises.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'

// --- CONTROLLER ---------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@ApiTags('Programs')
@Controller('programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Template creation is practitioner-only — authoring clinical content,
  // same reasoning as exercises.create() staying practitioner-only even
  // though admins can correct/archive afterward.
  @UseGuards(RolesGuard)
  @Roles('practitioner')
  @Post()
  create(@CurrentUser() user: CurrentUser, @Body() dto: CreateTemplateDto) {
    return this.programsService.create(user.id, dto)
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Post(':id/exercises')
  addExercise(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: AddTemplateExerciseDto,
  ) {
    return this.programsService.addExercise(id, user, dto)
  }

  // --- GET ROUTES ---

  @Get()
  findAll() {
    return this.programsService.findAll()
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.programsService.findOne(id)
  }

  // --- PATCH ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.programsService.update(id, user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id/exercises/:templateExerciseId')
  updateExercise(
    @Param('id', ParseIntPipe) id: number,
    @Param('templateExerciseId', ParseIntPipe) templateExerciseId: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateTemplateExerciseDto,
  ) {
    return this.programsService.updateExercise(
      id,
      templateExerciseId,
      user,
      dto,
    )
  }

  // A separate PATCH on the collection path (:id/exercises, no further
  // segment) — distinct from PATCH :id/exercises/:templateExerciseId above,
  // same "reorder the whole collection" shape as ExercisesController's
  // image reordering.
  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id/exercises')
  reorderExercises(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: ReorderTemplateExercisesDto,
  ) {
    return this.programsService.reorderExercises(id, user, dto.order)
  }

  // --- DELETE ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Delete(':id')
  archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.programsService.archive(id, user)
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Delete(':id/exercises/:templateExerciseId')
  removeExercise(
    @Param('id', ParseIntPipe) id: number,
    @Param('templateExerciseId', ParseIntPipe) templateExerciseId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.programsService.removeExercise(id, templateExerciseId, user)
  }
}
