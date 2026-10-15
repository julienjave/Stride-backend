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
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionsService } from './sessions.service'
import { CreateSessionDto } from './dto/create-session.dto'
import { SkipSessionDto } from './dto/skip-session.dto'
import { CompleteSessionDto } from './dto/complete-session.dto'
import { StopSessionDto } from './dto/stop-session.dto'
import { UpdateSessionDto } from './dto/update-session.dto'
import { UpdateSessionExerciseDto } from './dto/update-session-exercise.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER ---------------------------------------------------------------------------------------------

// A session's life is a small state machine (session-rules.ts): start →
// in_progress → completed (Finish) or incomplete (Stop); or skip → skipped.
// Each change of status is its OWN route (decided 2026-10-15), the way a
// program has POST …/cancel and …/complete: one meaning per route, so each
// has its own body, its own rules and its own audit action — rather than one
// PATCH { status } that let any status follow any other.
//
// Every write is patient-only (@Roles — starting, doing and ending a session
// is something a patient does for themselves; the service then checks it's
// THEIR session) and audited by the service (@AuditedByService(): one
// complete entry in the change's transaction, no generic duplicate).
@UseGuards(SessionAuthGuard)
@ApiTags('Sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Start a session: it is created open (in_progress), with its checklist.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @AuditedByService()
  @Post()
  create(@CurrentUser() user: CurrentUser, @Body() dto: CreateSessionDto) {
    return this.sessionsService.create(user, dto)
  }

  // Skip today's scheduled session, with a reason. 201: it creates a row.
  // (A literal path: Nest matches routes in declaration order, and 'skip'
  // has no :id to be confused with anyway — POST ':id/…' has two segments.)
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @AuditedByService()
  @Post('skip')
  skip(@CurrentUser() user: CurrentUser, @Body() dto: SkipSessionDto) {
    return this.sessionsService.skip(user, dto)
  }

  // Finish: completed, with the check-out. 200, not 201 — nothing is
  // created; an existing session changes (as programs' …/complete).
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @AuditedByService()
  @HttpCode(HttpStatus.OK)
  @Post(':id/complete')
  complete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: CompleteSessionDto,
  ) {
    return this.sessionsService.complete(id, user, dto)
  }

  // Stop before finishing: incomplete, with a reason.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @AuditedByService()
  @HttpCode(HttpStatus.OK)
  @Post(':id/stop')
  stop(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: StopSessionDto,
  ) {
    return this.sessionsService.stop(id, user, dto)
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

  // While the session is open: the pain check-in, corrected.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @AuditedByService()
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessionsService.update(id, user, dto)
  }

  // While the session is open: a checklist row ticked, timed, rated.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PATIENT)
  @AuditedByService()
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
