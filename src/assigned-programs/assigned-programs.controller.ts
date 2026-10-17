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
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { FilesInterceptor } from '@nestjs/platform-express'
import { AssignedProgramsService } from './assigned-programs.service'
import { CreateAssignedProgramDto } from './dto/create-assigned-program.dto'
import { UpdateAssignedProgramDto } from './dto/update-assigned-program.dto'
import { AddAssignedProgramExerciseDto } from './dto/add-assigned-program-exercise.dto'
import { UpdateAssignedProgramExerciseDto } from './dto/update-assigned-program-exercise.dto'
import { ReorderAssignedProgramExercisesDto } from './dto/reorder-assigned-program-exercises.dto'
import { ListAssignedProgramsQueryDto } from './dto/list-assigned-programs-query.dto'
import { AddScheduleVersionDto } from './dto/add-schedule-version.dto'
import {
  ProgramSummaryQueryDto,
  ScheduleSummaryQueryDto,
} from './dto/schedule-summary-query.dto'
import { ProgramSessionsQueryDto } from './dto/program-sessions-query.dto'
import { AddWorkoutDto } from './dto/add-workout.dto'
import { RenameWorkoutDto } from './dto/rename-workout.dto'
import { ReorderWorkoutsDto } from './dto/reorder-workouts.dto'
import { CloseAssignedProgramDto } from './dto/close-assigned-program.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { imageUploadOptions } from '../common/config/image-upload.config'
// The library's own photo DTOs, reused on purpose: the same request shapes
// ({ order: keys } and { objectKey }), so the frontend talks to both photo
// pages the same way.
import { ReorderImagesDto } from '../exercises/dto/reorder-images.dto'
import { RemoveImageDto } from '../exercises/dto/remove-image.dto'

// --- CONTROLLER ---------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@ApiTags('Assigned Programs')
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
  // @AuditedByService: the service writes the audit entry (the whole
  // prescription as assigned), in the same transaction as the program.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER)
  @AuditedByService()
  @Post()
  create(
    @CurrentUser() user: CurrentUser,
    @Body() dto: CreateAssignedProgramDto,
  ) {
    return this.assignedProgramsService.create(user, dto)
  }

  // The four EXERCISE routes below (add, edit / move, reorder, remove)
  // predate the audit convention and relied on the generic interceptor,
  // which records only "PATCH /assigned-programs/1/exercises/3" — not that
  // sets went from 3 to 4. Step 3b-0 brought them to it: tagged
  // @AuditedByService(), each writes ONE complete entry (before → after) in
  // its own transaction, and each answers with the full program.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/exercises')
  addExercise(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: AddAssignedProgramExerciseDto,
  ) {
    return this.assignedProgramsService.addExercise(id, user, dto)
  }

  // A new schedule version: "from effectiveFrom on, the schedule is …".
  // Same roles as every other change to an assigned program; the service
  // checks the care team on top, and which days are allowed.
  // A POST, not a PATCH of the program: it ADDS a version to a history
  // (the earlier versions stay), rather than editing a field in place.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/schedules')
  addScheduleVersion(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: AddScheduleVersionDto,
  ) {
    return this.assignedProgramsService.addScheduleVersion(id, user, dto)
  }

  // Closing a program (step 2b-iii): ACTIONS, not a PATCH of `status`,
  // because each applies rules a field update would skip — the end date,
  // archiving a program cancelled before any session. POST, since they
  // change state and aren't idempotent (a second call finds the program
  // closed: 409). 200, not POST's default 201: nothing new is created, the
  // answer is the program as it now is. Audited by the service, in the
  // change's own transaction.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: CloseAssignedProgramDto,
  ) {
    return this.assignedProgramsService.close(id, user, 'cancel', dto.today)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @HttpCode(HttpStatus.OK)
  @Post(':id/complete')
  complete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: CloseAssignedProgramDto,
  ) {
    return this.assignedProgramsService.close(id, user, 'complete', dto.today)
  }

  // --- GET ROUTES ---

  // Role-scoped inside the service — patient sees their own, practitioner
  // sees their managed patients', admin sees all. No @Roles() restriction
  // here since every role is allowed, just to a different slice of data.
  // ?patientId= narrows it to one patient (the patient page) — see the
  // service for who may ask.
  @Get()
  findAll(
    @CurrentUser() user: CurrentUser,
    @Query() query: ListAssignedProgramsQueryDto,
  ) {
    return this.assignedProgramsService.findAllForCurrentUser(
      user,
      query.patientId,
    )
  }

  // Due / done / made up / missed for the whole program (the schedule
  // module). Every role may ask; the service checks it's someone who may
  // see this program.
  // What cancelling / completing would do today — for the confirmation
  // dialog. A read: no @AuditedByService (the interceptor only logs writes).
  @Get(':id/closing')
  closingPreview(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    // The same one-field query as the summary's: { today }.
    @Query() query: ScheduleSummaryQueryDto,
  ) {
    return this.assignedProgramsService.closingPreview(id, user, query.today)
  }

  // What removing this exercise WOULD do — deleted, or kept (retired) for
  // the sessions that used it — for the confirmation dialog (decided
  // 2026-10-13). A read like the closing preview: no @AuditedByService, any
  // role reaches the service, which refuses anyone who couldn't remove it.
  @Get(':id/exercises/:exerciseRowId/removal')
  removalPreview(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.removalPreview(id, exerciseRowId, user)
  }

  // The program's sessions, newest first, without their checklists (Phase 4
  // step 1b). A read: no @AuditedByService; any role reaches the service,
  // which lets through the people who may view the program.
  @Get(':id/sessions')
  listSessions(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Query() query: ProgramSessionsQueryDto,
  ) {
    return this.assignedProgramsService.listSessions(id, user, query)
  }

  @Get(':id/summary')
  summary(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Query() query: ProgramSummaryQueryDto,
  ) {
    return this.assignedProgramsService.summary(
      id,
      user,
      query.today,
      query.through,
    )
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
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateAssignedProgramDto,
  ) {
    return this.assignedProgramsService.update(id, user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
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
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Patch(':id/exercises')
  reorderExercises(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: ReorderAssignedProgramExercisesDto,
  ) {
    return this.assignedProgramsService.reorderExercises(
      id,
      user,
      dto.order,
      dto.workoutId,
    )
  }

  // --- A PROGRAM EXERCISE'S OWN PHOTOS (decided 2026-10-17) ---
  //
  // Photos uploaded for THIS patient, or copied from the library. The same
  // roles as every change to a program (the service checks the care team on
  // top); each changes the patient's program, so each follows the audit
  // convention — @AuditedByService(), ONE entry written by the service.
  // Which photos the patient sees (library or own) is `useLibraryImages`, on
  // PATCH :id/exercises/:exerciseRowId. Each answers with the full program.

  // Multipart, field "files", up to 5 per request — the library's route,
  // with the same image rules (imageUploadOptions: JPEG / PNG / WebP, 5 MB
  // each). 201: photos were created.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/exercises/:exerciseRowId/images')
  @UseInterceptors(FilesInterceptor('files', 5, imageUploadOptions))
  addExerciseImages(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: CurrentUser,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded')
    }
    return this.assignedProgramsService.addImages(
      id,
      exerciseRowId,
      user,
      files,
    )
  }

  // Copies the library exercise's current photos into this exercise's own.
  // No body. 201 like the upload: photos were created.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/exercises/:exerciseRowId/images/from-library')
  addExerciseLibraryImages(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.addLibraryImages(
      id,
      exerciseRowId,
      user,
    )
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Patch(':id/exercises/:exerciseRowId/images')
  reorderExerciseImages(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @Body() dto: ReorderImagesDto,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.reorderImages(
      id,
      exerciseRowId,
      user,
      dto.order,
    )
  }

  // A DELETE with a body, like the library's: an object key holds slashes,
  // awkward in a URL path.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Delete(':id/exercises/:exerciseRowId/images')
  removeExerciseImage(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @Body() dto: RemoveImageDto,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.removeImage(
      id,
      exerciseRowId,
      user,
      dto.objectKey,
    )
  }

  // --- WORKOUTS ---
  //
  // The program's workouts: add, reorder, rename, delete an empty one. Same
  // roles as every other change to a program; the service checks the care
  // team on top. NEW routes that change a patient's prescription, so they
  // follow the audit convention: @AuditedByService() — the service writes
  // one complete entry in the change's own transaction, and the generic
  // interceptor stays out of the way.

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/workouts')
  addWorkout(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: AddWorkoutDto,
  ) {
    return this.assignedProgramsService.addWorkout(id, user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Patch(':id/workouts')
  reorderWorkouts(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: ReorderWorkoutsDto,
  ) {
    return this.assignedProgramsService.reorderWorkouts(id, user, dto.order)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Patch(':id/workouts/:workoutId')
  renameWorkout(
    @Param('id', ParseIntPipe) id: number,
    @Param('workoutId', ParseIntPipe) workoutId: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: RenameWorkoutDto,
  ) {
    return this.assignedProgramsService.renameWorkout(id, workoutId, user, dto)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Delete(':id/workouts/:workoutId')
  removeWorkout(
    @Param('id', ParseIntPipe) id: number,
    @Param('workoutId', ParseIntPipe) workoutId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.removeWorkout(id, workoutId, user)
  }

  // --- DELETE ROUTES ---

  // Archiving = deleting, for the app. Refused (409) for a program with
  // sessions: cancel it instead. Audited by the service since step 2b-iii.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Delete(':id')
  archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.archive(id, user)
  }

  // Deletes the exercise if no session used it, RETIRES it otherwise
  // (kept for those sessions' history, out of the program) — the database's
  // foreign key decides. Answers with the full program (200).
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Delete(':id/exercises/:exerciseRowId')
  removeExercise(
    @Param('id', ParseIntPipe) id: number,
    @Param('exerciseRowId', ParseIntPipe) exerciseRowId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.assignedProgramsService.removeExercise(id, exerciseRowId, user)
  }
}
