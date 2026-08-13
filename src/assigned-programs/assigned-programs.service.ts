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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  assignedPrograms,
  assignedProgramExercises,
  templateExercises,
  exercises,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateAssignedProgramDto } from './dto/create-assigned-program.dto'
import { UpdateAssignedProgramDto } from './dto/update-assigned-program.dto'
import { AssignedExerciseInputDto } from './dto/assigned-exercise-input.dto'
import { UpdateAssignedProgramExerciseDto } from './dto/update-assigned-program-exercise.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'

// --- SERVICE ------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

@Injectable()
export class AssignedProgramsService {
  // UsersService IS injected here, deliberately, unlike the Clinics/Users
  // relationship — this is a one-directional dependency (AssignedPrograms
  // needs Users' isPatientManagedBy/findPatientsForPractitioner; Users needs
  // nothing back), so there's no circularity risk, and it avoids duplicating
  // that clinic-scoping logic a third time.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(currentUser: CurrentUser, dto: CreateAssignedProgramDto) {
    const managed = await this.usersService.isPatientManagedBy(
      dto.patientId,
      currentUser.id,
    )
    if (!managed) {
      throw new ForbiddenException(
        'You can only assign programs to patients you manage',
      )
    }

    const sourceExercises = await this.resolveSourceExercises(dto)

    const programId = await withRlsContext(this.db, currentUser, async (tx) => {
      const [program] = await tx
        .insert(assignedPrograms)
        .values({
          patientId: dto.patientId,
          assignedBy: currentUser.id,
          basedOnTemplateId: dto.basedOnTemplateId ?? null,
          title: dto.title,
          startDate: dto.startDate,
          endDate: dto.endDate,
        })
        .returning()

      // The actual "copy, not reference" moment. From here on these rows
      // are entirely independent of template_exercises — editing or
      // deleting the source template later never touches this patient's
      // assigned program.
      for (const ex of sourceExercises) {
        await tx.insert(assignedProgramExercises).values({
          assignedProgramId: program.id,
          exerciseId: ex.exerciseId,
          sets: ex.sets,
          reps: ex.reps,
          durationInSeconds: ex.durationInSeconds,
          sortOrder: ex.sortOrder,
          notes: ex.notes,
        })
      }

      return program.id
    })

    // Deliberately its own, separate RLS-scoped transaction — by the time
    // this runs, the transaction above has committed, so the newly
    // inserted rows are safely visible.
    return this.findProgramWithExercises(programId, currentUser)
  }

  async addExercise(
    assignedProgramId: number,
    currentUser: CurrentUser,
    dto: AssignedExerciseInputDto,
  ) {
    const program = await this.findProgramOrThrow(assignedProgramId, currentUser)
    await this.assertCanManage(program.patientId, currentUser)

    // exercises' SELECT policy is unconditional (USING (true)), so this
    // needs no RLS context — reading it on the normal connection is
    // correct, not a gap.
    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, dto.exerciseId),
    })
    if (!exercise) {
      throw new NotFoundException(`Exercise ${dto.exerciseId} not found`)
    }

    const [row] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .insert(assignedProgramExercises)
        .values({
          assignedProgramId,
          exerciseId: dto.exerciseId,
          sets: dto.sets,
          reps: dto.reps,
          durationInSeconds: dto.durationInSeconds,
          sortOrder: dto.sortOrder,
          notes: dto.notes,
        })
        .returning(),
    )
    return row
  }

  // --- GET ROUTES ---

  // Role-scoped, not a single "list everything": patient sees their own,
  // practitioner sees programs for patients they manage (clinic-scoped,
  // reusing UsersService's existing definition), admin sees all.
  async findAllForCurrentUser(currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) {
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.assignedPrograms.findMany({
          where: eq(assignedPrograms.isArchived, false),
        }),
      )
    }
    if (currentUser.activeRole === UserRole.PATIENT) {
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.assignedPrograms.findMany({
          where: and(
            eq(assignedPrograms.patientId, currentUser.id),
            eq(assignedPrograms.isArchived, false),
          ),
        }),
      )
    }
    const managedPatients = await this.usersService.findPatientsForPractitioner(
      currentUser.id,
    )
    const patientIds = managedPatients.map((p) => p.id)
    if (patientIds.length === 0) {
      return []
    }
    return withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedPrograms.findMany({
        where: and(
          inArray(assignedPrograms.patientId, patientIds),
          eq(assignedPrograms.isArchived, false),
        ),
      }),
    )
  }

  async findOne(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanView(program.patientId, currentUser)
    return this.findProgramWithExercises(id, currentUser)
  }

  // --- PATCH ROUTES ---

  async update(
    id: number,
    currentUser: CurrentUser,
    dto: UpdateAssignedProgramDto,
  ) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(assignedPrograms)
        .set(dto)
        .where(eq(assignedPrograms.id, id))
        .returning(),
    )
    return updated
  }

  async updateExercise(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
    dto: UpdateAssignedProgramExerciseDto,
  ) {
    const program = await this.findProgramOrThrow(assignedProgramId, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    await this.findProgramExerciseOrThrow(assignedProgramId, rowId, currentUser)

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(assignedProgramExercises)
        .set(dto)
        .where(eq(assignedProgramExercises.id, rowId))
        .returning(),
    )
    return updated
  }

  async reorderExercises(
    assignedProgramId: number,
    currentUser: CurrentUser,
    newOrder: number[],
  ) {
    const program = await this.findProgramOrThrow(assignedProgramId, currentUser)
    await this.assertCanManage(program.patientId, currentUser)

    // Read, permutation-check, and write all happen inside ONE transaction
    // (tx.query instead of this.db.query) — same fix as
    // ProgramsService.reorderExercises, closing the same "separate
    // transaction" TOCTOU gap where a concurrent addExercise/removeExercise
    // could land between the old read and the old write. See that method's
    // comment for the full trace of why this narrows rather than fully
    // closes the race, and why full closure (row locking / SERIALIZABLE +
    // retry) isn't justified given the confirmed failure mode is a harmless
    // sortOrder inconsistency, never a privilege or data-boundary issue —
    // and the response below already reflects genuine post-write state.
    // withRlsContext() supplies this same transaction, scoped to
    // currentUser, rather than a separate set_config step around a plain
    // this.db.transaction(...).
    await withRlsContext(this.db, currentUser, async (tx) => {
      const currentRows = await tx.query.assignedProgramExercises.findMany({
        where: eq(assignedProgramExercises.assignedProgramId, assignedProgramId),
      })
      const currentIds = new Set(currentRows.map((r) => r.id))
      // Same fix as ProgramsService.reorderExercises — a genuine permutation
      // check needs length + no-internal-duplicates + valid-membership
      // together, not just a comparison of deduplicated Set sizes. See that
      // method's comment for the full exploit trace.
      const isSamePermutation =
        newOrder.length === currentRows.length &&
        new Set(newOrder).size === newOrder.length &&
        newOrder.every((id) => currentIds.has(id))

      if (!isSamePermutation) {
        throw new BadRequestException(
          'The new order must contain exactly the exercises currently in this program, just reordered',
        )
      }

      for (const [index, rowId] of newOrder.entries()) {
        await tx
          .update(assignedProgramExercises)
          .set({ sortOrder: index })
          .where(eq(assignedProgramExercises.id, rowId))
      }
    })

    return this.findProgramWithExercises(assignedProgramId, currentUser)
  }

  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    const [archived] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(assignedPrograms)
        .set({ isArchived: true })
        .where(eq(assignedPrograms.id, id))
        .returning(),
    )
    return archived
  }

  async removeExercise(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const program = await this.findProgramOrThrow(assignedProgramId, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    await this.findProgramExerciseOrThrow(assignedProgramId, rowId, currentUser)

    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .delete(assignedProgramExercises)
        .where(eq(assignedProgramExercises.id, rowId)),
    )
  }

  // === HELPER FUNCTIONS =================================================================

  private async resolveSourceExercises(
    dto: CreateAssignedProgramDto,
  ): Promise<AssignedExerciseInputDto[]> {
    if (dto.basedOnTemplateId) {
      const rows = await this.db.query.templateExercises.findMany({
        where: eq(templateExercises.templateId, dto.basedOnTemplateId),
        orderBy: (te, { asc }) => [asc(te.sortOrder)],
      })
      if (rows.length === 0) {
        throw new NotFoundException(
          `Template ${dto.basedOnTemplateId} not found, or has no exercises to copy`,
        )
      }
      return rows.map((row) => ({
        exerciseId: row.exerciseId,
        sets: row.sets ?? undefined,
        reps: row.reps ?? undefined,
        durationInSeconds: row.durationInSeconds ?? undefined,
        sortOrder: row.sortOrder,
        notes: row.notes ?? undefined,
      }))
    }

    if (!dto.exercises || dto.exercises.length === 0) {
      throw new BadRequestException(
        'Provide either basedOnTemplateId or an inline exercises array',
      )
    }
    return dto.exercises
  }

  private async findProgramWithExercises(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    const exerciseRows = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedProgramExercises.findMany({
        where: eq(assignedProgramExercises.assignedProgramId, id),
        orderBy: (row, { asc }) => [asc(row.sortOrder)],
      }),
    )
    return { ...program, exercises: exerciseRows }
  }

  private async findProgramOrThrow(id: number, currentUser: CurrentUser) {
    const program = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedPrograms.findFirst({
        where: eq(assignedPrograms.id, id),
      }),
    )
    // Covers both "genuinely does not exist" and "exists, but RLS made it
    // invisible to this session" — assertCanView/assertCanManage never run
    // on a program this query didn't return, so an out-of-scope row reads
    // as 404, not 403. See assertCanView/assertCanManage below for the one
    // deliberate exception (the owning patient IS visible via RLS, so the
    // 403 there is a real app-layer decision, not RLS filtering).
    if (!program) {
      throw new NotFoundException(`Assigned program ${id} not found`)
    }
    return program
  }

  private async findProgramExerciseOrThrow(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const row = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedProgramExercises.findFirst({
        where: and(
          eq(assignedProgramExercises.id, rowId),
          eq(assignedProgramExercises.assignedProgramId, assignedProgramId),
        ),
      }),
    )
    if (!row) {
      throw new NotFoundException(
        `Exercise ${rowId} not found in this assigned program`,
      )
    }
    return row
  }

  // Viewing allows a third case beyond manage: the patient viewing their
  // own program.
  private async assertCanView(patientId: number, currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) return
    if (
      currentUser.activeRole === UserRole.PATIENT &&
      patientId === currentUser.id
    )
      return
    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      const managed = await this.usersService.isPatientManagedBy(
        patientId,
        currentUser.id,
      )
      if (managed) return
    }
    throw new ForbiddenException(
      'You do not have permission to view this assigned program',
    )
  }

  // Managing (create/update/archive/exercise CRUD) never allows the patient
  // themselves — a patient can see their program, not edit its prescription.
  private async assertCanManage(patientId: number, currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) return
    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      const managed = await this.usersService.isPatientManagedBy(
        patientId,
        currentUser.id,
      )
      if (managed) return
    }
    throw new ForbiddenException(
      'You do not have permission to manage this assigned program',
    )
  }
}
