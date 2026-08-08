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
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionsService } from './sessions.service'
import { CreateSessionDto } from './dto/create-session.dto'
import { UpdateSessionDto } from './dto/update-session.dto'
import { UpdateSessionExerciseDto } from './dto/update-session-exercise.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER ---------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@ApiTags('Sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Patient-only — starting a session is something a patient does for
  // themselves, not something staff initiate on their behalf.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @Post()
  create(@CurrentUser() user: CurrentUser, @Body() dto: CreateSessionDto) {
    return this.sessionsService.create(user, dto)
  }

  // --- GET ROUTES ---

  // Role-scoped inside the service, same as AssignedPrograms — every role
  // is allowed, just to a different slice of data.
  @Get()
  findAll(@CurrentUser() user: CurrentUser) {
    return this.sessionsService.findAllForCurrentUser(user)
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.sessionsService.findOne(id, user)
  }

  // --- PATCH ROUTES ---

  // Drives the whole state machine (pending -> in_progress -> completed /
  // skipped) through one generic endpoint — the frontend's "Start" and
  // "Finish" buttons both just PATCH a new status.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessionsService.update(id, user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @Patch(':id/exercises/:exerciseRowId')
  updateExercise(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateSessionExerciseDto,
  ) {
    return this.sessionsService.updateExercise(id, exerciseRowId, user, dto)
  }
}
