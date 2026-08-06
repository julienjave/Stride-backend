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
import { AssignedProgramsService } from './assigned-programs.service'
import { CreateAssignedProgramDto } from './dto/create-assigned-program.dto'
import { UpdateAssignedProgramDto } from './dto/update-assigned-program.dto'
import { AssignedExerciseInputDto } from './dto/assigned-exercise-input.dto'
import { UpdateAssignedProgramExerciseDto } from './dto/update-assigned-program-exercise.dto'
import { ReorderAssignedProgramExercisesDto } from './dto/reorder-assigned-program-exercises.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'

// --- CONTROLLER ---------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@ApiTags('Users')
@Controller('assigned-programs')
export class AssignedProgramsController {
  constructor(
    private readonly assignedProgramsService: AssignedProgramsService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Practitioner-only — assigning a treatment plan is a clinical action,
  // same authorship reasoning as exercises/templates staying
  // practitioner-only at creation. Service-level clinic-scope check (does
  // this practitioner actually manage this patient) happens on top.
  @UseGuards(RolesGuard)
  @Roles('practitioner')
  @Post()
  create(
    @CurrentUser() user: CurrentUser,
    @Body() dto: CreateAssignedProgramDto,
  ) {
    return this.assignedProgramsService.create(user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Post(':id/exercises')
  addExercise(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: AssignedExerciseInputDto,
  ) {
    return this.assignedProgramsService.addExercise(id, user, dto)
  }

  // --- GET ROUTES ---

  // Role-scoped inside the service — patient sees their own, practitioner
  // sees their managed patients', admin sees all. No @Roles() restriction
  // here since every role is allowed, just to a different slice of data.
  @Get()
  findAll(@CurrentUser() user: CurrentUser) {
    return this.assignedProgramsService.findAllForCurrentUser(user)
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.findOne(id, user)
  }

  // --- PATCH ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateAssignedProgramDto,
  ) {
    return this.assignedProgramsService.update(id, user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id/exercises/:exerciseRowId')
  updateExercise(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateAssignedProgramExerciseDto,
  ) {
    return this.assignedProgramsService.updateExercise(
      id,
      exerciseRowId,
      user,
      dto,
    )
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id/exercises')
  reorderExercises(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: ReorderAssignedProgramExercisesDto,
  ) {
    return this.assignedProgramsService.reorderExercises(id, user, dto.order)
  }

  // --- DELETE ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Delete(':id')
  archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.archive(id, user)
  }

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Delete(':id/exercises/:exerciseRowId')
  removeExercise(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.removeExercise(id, exerciseRowId, user)
  }
}
