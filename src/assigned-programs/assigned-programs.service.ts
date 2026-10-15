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
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { changedFields } from '../common/changed-fields'
import {
  assignedPrograms,
  assignedProgramExercises,
  programSchedules,
  programScheduleDays,
  programScheduleRotation,
  programTemplates,
  programWorkouts,
  sessionExercises,
  sessions,
  templateExercises,
  templateWorkouts,
  exercises,
  users,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateAssignedProgramDto } from './dto/create-assigned-program.dto'
import { UpdateAssignedProgramDto } from './dto/update-assigned-program.dto'
import { AddAssignedProgramExerciseDto } from './dto/add-assigned-program-exercise.dto'
import { UpdateAssignedProgramExerciseDto } from './dto/update-assigned-program-exercise.dto'
import { ScheduleType } from './dto/schedule-input.dto'
import {
  contentFromNewSchedule,
  contentFromVersionInput,
  type ScheduleContent,
  type ScheduleDay,
} from './schedule/schedule-content'
import { AddScheduleVersionDto } from './dto/add-schedule-version.dto'
import { AddWorkoutDto } from './dto/add-workout.dto'
import { RenameWorkoutDto } from './dto/rename-workout.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import { addDays, isPossibleToday, utcToday } from '../common/calendar-date'
import { summarizeSchedule } from './schedule/schedule-summary'
import { AuditService } from '../audit/audit.service'
import { StorageService } from '../storage/storage.service'
import { assertStartDateMovable, planStartDateMove } from './start-date-move'
import { assertProgramOpen, planClosing } from './program-state'
import {
  ASSIGNED_PROGRAM_EXERCISES_WORKOUT_FK,
  isForeignKeyViolation,
  isUniqueViolation,
  PROGRAM_SCHEDULE_DAYS_WORKOUT_FK,
  PROGRAM_SCHEDULE_ROTATION_WORKOUT_FK,
  PROGRAM_SCHEDULES_ONE_PER_DAY,
  SESSION_EXERCISES_PROGRAM_EXERCISE_FK,
  SESSIONS_WORKOUT_FK,
} from '../database/pg-errors'
import { assertEndDateMovable } from './end-date'
import {
  assertCanAddWorkout,
  assertWorkoutRemovable,
  isPermutationOf,
  normalizeWorkoutName,
  orderExercisesByWorkout,
  orderWorkouts,
  resolveWorkoutId,
  workoutLabel,
} from '../common/workout-rules'

// --- SERVICE ------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// What resolveSourceExercises produces for create() to insert — the
// exercise's own snapshotted fields (name/muscles/equipment/
// instructions) alongside the per-patient prescription fields
// (sets/reps/weight/etc). Deliberately NOT AssignedExerciseInputDto
// (what a caller sends in) — that type has no name/muscles fields at
// all, since a client never supplies those directly; they're always
// server-derived from the referenced exercise at snapshot time.
interface ResolvedSourceExercise {
  exerciseId: number
  name: string
  primaryMuscles: string[]
  secondaryMuscles: string[]
  equipment: string[]
  instructions: string[]
  sets?: number
  reps?: number
  durationInSeconds?: number
  weight?: number
  weightUnit?: 'kg' | 'lbs'
  sortOrder: number
  notes?: string
  // Which of the resolved workouts (below) it goes into, by POSITION in
  // that list: the program's own workouts don't exist yet when this is
  // resolved — create() inserts them, then maps positions to their new ids.
  workoutIndex: number
}

// What the new program will contain: its workouts (in order, A first) and
// its exercises, each pointing at one of those workouts by position.
interface ResolvedSource {
  workouts: { name: string | null }[]
  exercises: ResolvedSourceExercise[]
  // Where it came from: the template (also when assigning AGAIN — the
  // source program's own template, so the line back to it isn't lost),
  // and the program it continues ("Assign again"), or null.
  basedOnTemplateId: number | null
  basedOnProgramId: number | null
}

// A workout as an audit entry records it (a plain copy, like
// versionForAudit below).
function workoutForAudit(workout: typeof programWorkouts.$inferSelect) {
  return { id: workout.id, name: workout.name, sortOrder: workout.sortOrder }
}

// A schedule version as the API returns it and the schedule module reads
// it: the program_schedules row plus its content from the two child tables
// — `days` (weekday → workout, in weekday order) and `rotation` (workout
// ids, position 0 first). Empty arrays when the type has none.
export type ScheduleVersion = typeof programSchedules.$inferSelect & {
  days: ScheduleDay[]
  rotation: number[]
}

// A schedule version as an audit entry records it: everything needed to
// know what the schedule was — its days or rotation included — from when,
// and who set it. (A plain object copy, so the entry never depends on what
// the row type happens to carry.)
// What an archived program WAS, for its audit entry — after archiving, no
// list shows it.
function programForAudit(program: typeof assignedPrograms.$inferSelect) {
  return {
    title: program.title,
    status: program.status,
    startDate: program.startDate,
    endDate: program.endDate,
    basedOnTemplateId: program.basedOnTemplateId,
    basedOnProgramId: program.basedOnProgramId,
  }
}

function versionForAudit(version: ScheduleVersion) {
  return {
    id: version.id,
    type: version.type,
    timesPerWeek: version.timesPerWeek,
    days: version.days,
    rotation: version.rotation,
    effectiveFrom: version.effectiveFrom,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
  }
}

// A program exercise as an audit entry records it — everything that says
// what the patient was given: which exercise, in which workout and place,
// its own copy of the description, and the prescription. A plain copy (like
// versionForAudit), so an entry never depends on what the row type carries.
// Used for an added exercise (what was added) and a removed or retired one
// (what is gone from the program — after a DELETE, the entry is the only
// place it still exists).
function exerciseForAudit(row: typeof assignedProgramExercises.$inferSelect) {
  return {
    id: row.id,
    workoutId: row.workoutId,
    exerciseId: row.exerciseId,
    name: row.name,
    primaryMuscles: row.primaryMuscles,
    secondaryMuscles: row.secondaryMuscles,
    equipment: row.equipment,
    instructions: row.instructions,
    sets: row.sets,
    reps: row.reps,
    durationInSeconds: row.durationInSeconds,
    weight: row.weight,
    weightUnit: row.weightUnit,
    sortOrder: row.sortOrder,
    notes: row.notes,
  }
}

// A retired exercise (removed from the program, kept for the sessions that
// used it — step 3b-0) can no longer change: a new prescription or a move
// would rewrite what those sessions point at, and editing something the
// practitioner removed would bring it back silently. 409, like a write on a
// closed program: the request is fine, the state of the row refuses it.
// Migration 0033's trigger is the same rule in the database.
// Removing an exercise that is already removed (retired): 409 — for the
// removal and its preview alike, in the same words.
function assertNotAlreadyRemoved(row: { retiredAt: Date | null }) {
  if (row.retiredAt) {
    throw new ConflictException(
      'This exercise was already removed from the program',
    )
  }
}

// What removing a program exercise WILL do, given how many sessions used it
// (decided 2026-10-13: the dialog asks the backend, as for closing). One
// rule, the same one the removal follows: a session used it → it is RETIRED
// (kept for those sessions), otherwise DELETED. Exported for its unit test.
//
// The removal itself doesn't call this: it lets the foreign key decide,
// atomically, at the moment of the DELETE (a session may start in between —
// the preview is a moment's answer, like the closing preview). The two can't
// disagree on the rule — "any session_exercises row points at it" is
// exactly what RESTRICT refuses — only on timing, and then the removal's
// answer is the true one.
export function planRemoval(sessionCount: number) {
  return {
    outcome: sessionCount > 0 ? ('retired' as const) : ('deleted' as const),
    sessionCount,
  }
}

function assertNotRetired(row: { retiredAt: Date | null }) {
  if (row.retiredAt) {
    throw new ConflictException(
      'This exercise was removed from the program, so it can no longer change',
    )
  }
}

// The end of a program can't come before its start (decisions §5: the
// dates ARE the program's length). Checked here for a clear 400; the
// database's assigned_programs_ends_after_start check is the guarantee
// behind it. Calendar dates compare correctly as strings (calendar-date.ts).
function assertDatesInOrder(
  startDate: string,
  endDate: string | null | undefined,
) {
  if (endDate != null && endDate < startDate) {
    throw new BadRequestException("The end date can't be before the start date")
  }
}

// Which days a NEW schedule version may start on. Exported for its unit
// tests (pure: the program's dates and the clock in, an exception or
// nothing out).
//   - Not before the program starts, nor after it ends: a version there
//     would never apply to any day of the program.
//   - Not in the past: past days were judged by the schedule in force
//     then, and a backdated change would rewrite that history (decided
//     2026-10-09). "The past" with ONE day of slack: the server only knows
//     UTC's date, and a practitioner's today can be a day behind it (21:00
//     in Montreal is already tomorrow in UTC). The INSERT and DELETE
//     policies on program_schedules (migration 0025) enforce the same
//     limit in the database.
// The order of the checks decides which message wins when several apply;
// the program's own dates come first, as the more useful explanation.
export function assertScheduleDayAllowed(
  day: string,
  program: { startDate: string; endDate: string | null },
  now: Date = new Date(),
) {
  if (day < program.startDate) {
    throw new BadRequestException(
      `A schedule change can't apply before the program starts (${program.startDate})`,
    )
  }
  if (program.endDate !== null && day > program.endDate) {
    throw new BadRequestException(
      `A schedule change can't apply after the program ends (${program.endDate})`,
    )
  }
  if (day < addDays(utcToday(now), -1)) {
    throw new BadRequestException(
      "A schedule change can't apply to a day in the past",
    )
  }
}

// `today` sent by the viewer's app (the summary, closing a program, its
// preview) must be a date that is today SOMEWHERE (isPossibleToday): within
// a day of UTC's. One copy of the check and of its message for the three
// routes.
function assertPossibleToday(today: string) {
  if (!isPossibleToday(today)) {
    throw new BadRequestException(
      "today must be today's date in your time zone",
    )
  }
}

@Injectable()
export class AssignedProgramsService {
  // UsersService IS injected here, deliberately, unlike the Clinics/Users
  // relationship — this is a one-directional dependency (AssignedPrograms
  // needs Users' isPatientManagedBy/findPatientsForPractitioner; Users needs
  // nothing back), so there's no circularity risk, and it avoids duplicating
  // that clinic-scoping logic a third time.
  //
  // AuditService (from the global AuditModule) writes the detailed audit
  // entries of the routes tagged @AuditedByService() — create, update and
  // addScheduleVersion — inside the change's own transaction.
  //
  // StorageService signs the URLs of the library photos each program
  // exercise shows (findProgramWithExercises — "Exercise photos", below).
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
    private readonly storageService: StorageService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // --- EXERCISE SNAPSHOTTING ------------------------------------------------

  // Batches ONE lookup for however many distinct exercises are being
  // snapshotted at once, rather than fetching one at a time in a loop —
  // same "fetch base rows, then batch-fetch related data" shape used
  // elsewhere in this codebase (ExercisesService.findAll's author
  // attachment, ProgramsService.withExerciseDetails). Also doubles as
  // existence validation: a referenced exercise that doesn't actually
  // exist throws here, rather than silently producing an incomplete
  // snapshot. In practice this can only ever fire for the INLINE
  // exercises array path (a template row's exerciseId is guaranteed
  // valid by its own foreign key, so that path can never hit a missing
  // id) — but the check lives here, once, rather than being duplicated
  // per caller, so both paths get it for free.
  private async fetchExerciseSnapshots(exerciseIds: number[]) {
    const uniqueIds = [...new Set(exerciseIds)]
    const rows =
      uniqueIds.length > 0
        ? await this.db.query.exercises.findMany({
            where: inArray(exercises.id, uniqueIds),
          })
        : []
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const id of uniqueIds) {
      if (!byId.has(id)) {
        throw new NotFoundException(`Exercise ${id} not found`)
      }
    }
    return byId
  }

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

    assertDatesInOrder(dto.startDate, dto.endDate)

    const source = await this.resolveSourceExercises(dto, currentUser)
    const sourceExercises = source.exercises

    const programId = await withRlsContext(this.db, currentUser, async (tx) => {
      const [program] = await tx
        .insert(assignedPrograms)
        .values({
          patientId: dto.patientId,
          assignedBy: currentUser.id,
          basedOnTemplateId: source.basedOnTemplateId,
          basedOnProgramId: source.basedOnProgramId,
          title: dto.title,
          startDate: dto.startDate,
          endDate: dto.endDate,
        })
        .returning()

      // The program's own workouts, copied in order (positions 0, 1, 2…).
      // One INSERT each, keeping the new ids in the same order: a
      // multi-row INSERT … RETURNING doesn't promise its rows come back in
      // the order they were given, and the exercises below find their
      // workout by position.
      const workouts: (typeof programWorkouts.$inferSelect)[] = []
      for (const [index, workout] of source.workouts.entries()) {
        const [inserted] = await tx
          .insert(programWorkouts)
          .values({
            assignedProgramId: program.id,
            name: workout.name,
            sortOrder: index,
          })
          .returning()
        workouts.push(inserted)
      }

      // The actual "copy, not reference" moment. From here on these rows
      // are entirely independent of template_exercises AND of the
      // exercise's own current data — editing or deleting the source
      // template later, or editing/archiving the exercise itself, never
      // touches this patient's already-assigned program.
      for (const ex of sourceExercises) {
        await tx.insert(assignedProgramExercises).values({
          assignedProgramId: program.id,
          workoutId: workouts[ex.workoutIndex].id,
          exerciseId: ex.exerciseId,
          name: ex.name,
          primaryMuscles: ex.primaryMuscles,
          secondaryMuscles: ex.secondaryMuscles,
          equipment: ex.equipment,
          instructions: ex.instructions,
          sets: ex.sets,
          reps: ex.reps,
          durationInSeconds: ex.durationInSeconds,
          weight: ex.weight,
          weightUnit: ex.weightUnit,
          sortOrder: ex.sortOrder,
          notes: ex.notes,
        })
      }

      // The program's first schedule version, applying from its start date,
      // IN THE SAME TRANSACTION as the program: either both exist or
      // neither does. That's what makes "every program has a schedule"
      // true — the database itself can't require a row in ANOTHER table
      // (a CHECK constraint only sees the row it's checking).
      //
      // Its days or rotation name workouts by POSITION (0 = A): only now
      // that the workouts exist can positions become ids
      // (contentFromNewSchedule). A position the template doesn't have is a
      // 400 — thrown inside the transaction, so everything above rolls back.
      const firstVersion = await this.insertScheduleVersion(tx, {
        assignedProgramId: program.id,
        effectiveFrom: dto.startDate,
        createdBy: currentUser.id,
        content: contentFromNewSchedule(
          dto.schedule,
          workouts.map((workout) => workout.id),
        ),
      })

      // The audit entry, in the same transaction (see AuditService.
      // logInTransaction): the whole prescription as it was assigned —
      // dates, schedule, every exercise with its sets/reps/weight — so the
      // trail shows exactly what the patient was given, and by whom, even
      // after later edits.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_CREATED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: program.id,
        details: {
          title: program.title,
          startDate: program.startDate,
          endDate: program.endDate,
          basedOnTemplateId: program.basedOnTemplateId,
          basedOnProgramId: program.basedOnProgramId,
          schedule: versionForAudit(firstVersion),
          workouts: workouts.map(workoutForAudit),
          exercises: sourceExercises.map((ex) => ({
            workoutId: workouts[ex.workoutIndex].id,
            exerciseId: ex.exerciseId,
            name: ex.name,
            sets: ex.sets ?? null,
            reps: ex.reps ?? null,
            durationInSeconds: ex.durationInSeconds ?? null,
            weight: ex.weight ?? null,
            weightUnit: ex.weightUnit ?? null,
            sortOrder: ex.sortOrder,
            notes: ex.notes ?? null,
          })),
        },
      })

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
    dto: AddAssignedProgramExerciseDto,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    )
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)

    // exercises' SELECT policy is unconditional (USING (true)), so this
    // needs no RLS context — reading it on the normal connection is
    // correct, not a gap.
    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, dto.exerciseId),
    })
    if (!exercise) {
      throw new NotFoundException(`Exercise ${dto.exerciseId} not found`)
    }

    await withRlsContext(this.db, currentUser, async (tx) => {
      // The workout asked for (one of THIS program's — 404 otherwise), or the
      // first. Read inside the transaction: program_workouts has row-level
      // security, like everything about a patient's program.
      const workoutId = resolveWorkoutId(
        dto.workoutId,
        await this.findWorkouts(tx, assignedProgramId),
        'program',
      )
      const [row] = await tx
        .insert(assignedProgramExercises)
        .values({
          assignedProgramId,
          workoutId,
          exerciseId: dto.exerciseId,
          // Snapshotted from the SAME already-fetched `exercise` above —
          // no extra query needed, since the existence check already
          // has everything this needs in scope. Same "copy, not
          // reference" reasoning as create()'s own snapshot, just for
          // adding to an already-assigned program later rather than at
          // creation time.
          name: exercise.name,
          primaryMuscles: exercise.primaryMuscles,
          secondaryMuscles: exercise.secondaryMuscles,
          equipment: exercise.equipment,
          instructions: exercise.instructions,
          sets: dto.sets,
          reps: dto.reps,
          durationInSeconds: dto.durationInSeconds,
          weight: dto.weight,
          weightUnit: dto.weightUnit,
          // The position asked for, or — the usual case since step 3b-0 —
          // after the workout's last exercise. Computed here, inside the
          // transaction, rather than by the client from what it last saw:
          // the client's copy may be stale, and a count is wrong anyway
          // (removals leave gaps, see nextExercisePosition).
          sortOrder:
            dto.sortOrder ?? (await this.nextExercisePosition(tx, workoutId)),
          notes: dto.notes,
        })
        .returning()
      // The audit convention (step 3b-0 brought the four exercise routes to
      // it): ONE complete entry, in the change's own transaction — the whole
      // exercise as added, prescription included.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_EXERCISE_ADDED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: assignedProgramId,
        details: { exercise: exerciseForAudit(row) },
      })
    })
    // The full program, like every other write on it (it used to be the bare
    // inserted row — a screen writing that into its cache would have
    // replaced the whole program with one exercise).
    return this.findProgramWithExercises(assignedProgramId, currentUser)
  }

  // POST /assigned-programs/:id/schedules — "from effectiveFrom on, the
  // schedule is …" (decisions §5, point 5: schedules keep a history).
  //
  // A new version REPLACES every version starting on that day or later:
  //   - the same day → a correction ("I picked the wrong days a minute
  //     ago");
  //   - a later day → a change planned earlier, now superseded. ("From next
  //     Monday: Tue/Thu", then "from today: Mon/Fri" — the practitioner
  //     means Mon/Fri from now on, not Mon/Fri until Monday.)
  // So the rule reads simply: from that day on, THIS is the schedule.
  // Versions before that day are untouched — they judged days that have
  // passed. The delete and the insert share one transaction, so nobody ever
  // sees the program with neither.
  //
  // Returns the full program (exercises and schedules), like every write
  // the program page will put straight into its cache.
  async addScheduleVersion(
    id: number,
    currentUser: CurrentUser,
    dto: AddScheduleVersionDto,
  ) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    assertScheduleDayAllowed(dto.effectiveFrom, program)
    // A pause is something that happens DURING a program (decided
    // 2026-10-11): on the start date it would replace the first version and
    // the program would begin paused — assign it later instead.
    if (
      dto.type === ScheduleType.PAUSED &&
      dto.effectiveFrom === program.startDate
    ) {
      throw new BadRequestException(
        "A program can't start paused: choose its start date for when it begins",
      )
    }

    try {
      await withRlsContext(this.db, currentUser, async (tx) => {
        // The content first — every workout it names must be one of this
        // program's (404 otherwise), checked before anything is deleted.
        const content = contentFromVersionInput(
          dto,
          await this.findWorkouts(tx, id),
        )
        // The versions about to be replaced, read WITH their days and
        // rotations, so the audit entry can record exactly what was
        // replaced — after this transaction, the audit log is the only place
        // they still exist. (A DELETE … RETURNING would return the version
        // rows only; their children go by cascade.)
        const replaced = (await this.readScheduleVersions(tx, [id])).filter(
          (version) => version.effectiveFrom >= dto.effectiveFrom,
        )
        await tx
          .delete(programSchedules)
          .where(
            and(
              eq(programSchedules.assignedProgramId, id),
              gte(programSchedules.effectiveFrom, dto.effectiveFrom),
            ),
          )
        const added = await this.insertScheduleVersion(tx, {
          assignedProgramId: id,
          effectiveFrom: dto.effectiveFrom,
          createdBy: currentUser.id,
          content,
        })
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'ASSIGNED_PROGRAM_SCHEDULE_SET',
          targetUserId: program.patientId,
          entityType: 'assigned-programs',
          entityId: id,
          details: {
            effectiveFrom: dto.effectiveFrom,
            added: versionForAudit(added),
            replaced: replaced.map(versionForAudit),
          },
        })
      })
    } catch (error) {
      // Two changes for the same program and day at the same moment: both
      // transactions delete nothing (neither sees the other's uncommitted
      // row), both insert, and the unique constraint makes the second WAIT
      // for the first, then fail. The database decides atomically, so this
      // is the reliable signal — no "check, then insert" race. (If the
      // requests arrive one after the other instead, the second simply
      // replaces the first: also correct.)
      if (isUniqueViolation(error, PROGRAM_SCHEDULES_ONE_PER_DAY)) {
        throw new ConflictException(
          'Someone else changed this schedule at the same moment. Reload the program and try again.',
        )
      }
      throw error
    }

    return this.findProgramWithExercises(id, currentUser)
  }

  // --- GET ROUTES ---

  // Role-scoped, not a single "list everything": patient sees their own,
  // practitioner sees programs for patients they manage (their care team,
  // through UsersService's definition), admin sees all.
  //
  // `patientId` (GET /assigned-programs?patientId=, added 2026-10-08 for the
  // practitioner's patient page) narrows the list to ONE patient — every
  // program of theirs, whoever assigned it. It is checked with the same
  // rule as viewing a single program (assertCanView): an admin, the patient
  // themselves, or a practitioner on their care team. Anyone else gets the
  // same 403 as for one of that patient's programs — never an empty list,
  // which would quietly say "this patient has no programs" to someone who
  // isn't allowed to know.
  //
  // Every program comes back with its `assigner` (id and name), so a screen
  // can say "assigned by Sam Okafor" without one request per program.
  //
  // ...and with its `schedules` (every version, oldest first), so a list row
  // can say "3× a week · weeks start Thursday" — loaded the same batched way.
  async findAllForCurrentUser(currentUser: CurrentUser, patientId?: number) {
    const programs = await this.findProgramRows(currentUser, patientId)
    return this.withSchedules(currentUser, await this.withAssigners(programs))
  }

  private async findProgramRows(
    currentUser: CurrentUser,
    patientId: number | undefined,
  ) {
    if (patientId !== undefined) {
      await this.assertCanView(patientId, currentUser)
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.assignedPrograms.findMany({
          where: and(
            eq(assignedPrograms.patientId, patientId),
            eq(assignedPrograms.isArchived, false),
          ),
        }),
      )
    }
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

  // Adds `assigner: { id, firstName, lastName }` to each program: ONE query
  // for all the assigners, then a Map lookup per program — not one
  // query per program (the "N+1 queries" problem: 30 programs would be 31
  // round trips). Same batching idea as UsersService.attachProfilesToMany.
  //
  // Read without an RLS context, like every identity read in this app:
  // `users` stays readable without one (migration 0007), and only names
  // are selected — no contact details.
  private async withAssigners<T extends { assignedBy: number }>(programs: T[]) {
    if (programs.length === 0) return []
    // Duplicates are harmless here: `IN (7, 7, 8)` matches exactly what
    // `IN (7, 8)` does (a mutation check showed de-duplicating changed
    // nothing observable, so it was left out).
    const assignerIds = programs.map((p) => p.assignedBy)
    const assigners = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(inArray(users.id, assignerIds))
    const byId = new Map(assigners.map((a) => [a.id, a]))
    // `?? null` can't happen today (assigned_by is NOT NULL and its foreign
    // key RESTRICTs deleting the user), but a missing name must never turn
    // a whole list into a 500.
    return programs.map((p) => ({
      ...p,
      assigner: byId.get(p.assignedBy) ?? null,
    }))
  }

  // Adds `schedules` to each program: ONE query for every program's
  // versions, then grouped by program in memory — the same idea as
  // withAssigners, for a one-to-MANY relation (a program has several
  // versions), hence a Map of arrays rather than a Map of single rows.
  //
  // Unlike `users`, program_schedules has row-level security, so this read
  // runs in the caller's RLS context: it can only ever return versions of
  // programs the caller may see — which are exactly the ones asked for.
  // (Each version comes with its days and rotation — readScheduleVersions,
  // batched the same way: three queries for the whole list.)
  private async withSchedules<T extends { id: number }>(
    currentUser: CurrentUser,
    programs: T[],
  ) {
    if (programs.length === 0) return []
    const rows = await withRlsContext(this.db, currentUser, (tx) =>
      this.readScheduleVersions(
        tx,
        programs.map((p) => p.id),
      ),
    )
    const byProgram = new Map<number, typeof rows>()
    for (const row of rows) {
      const versions = byProgram.get(row.assignedProgramId) ?? []
      versions.push(row)
      byProgram.set(row.assignedProgramId, versions)
    }
    // Rows were read in date order, and pushing keeps that order within
    // each program's array.
    return programs.map((p) => ({ ...p, schedules: byProgram.get(p.id) ?? [] }))
  }

  async findOne(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanView(program.patientId, currentUser)
    return this.findProgramWithExercises(id, currentUser)
  }

  // GET /assigned-programs/:id/summary?today= — what was due, done, made
  // up and missed (decisions §5), computed by the schedule module from the
  // program's dates, its schedule versions and its COMPLETED sessions.
  //
  // This method only gathers the data and checks who may see it; every rule
  // lives in schedule-summary.ts (pure, tested with plain values).
  //
  // Same people as viewing the program (assertCanView): the care team, the
  // patient, an admin. The reads run in their RLS context — sessions and
  // schedule versions have policies of their own, which agree.
  async summary(id: number, currentUser: CurrentUser, today: string) {
    assertPossibleToday(today)
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanView(program.patientId, currentUser)

    const [versions, completed] = await withRlsContext(
      this.db,
      currentUser,
      async (tx) =>
        [
          await this.readScheduleVersions(tx, [id]),
          // Only what the module needs (id, the patient's day, the workout
          // done), and only completed sessions: "done" means completed
          // (decided 2026-10-09) — a session started and abandoned isn't
          // done. The index on (assigned_program_id, local_date) serves this
          // read.
          await tx
            .select({
              id: sessions.id,
              localDate: sessions.localDate,
              workoutId: sessions.workoutId,
              // A swap's day (null for an ordinary session).
              countsFor: sessions.countsFor,
            })
            .from(sessions)
            .where(
              and(
                eq(sessions.assignedProgramId, id),
                eq(sessions.status, 'completed'),
              ),
            ),
        ] as const,
    )

    return summarizeSchedule({
      startDate: program.startDate,
      endDate: program.endDate,
      versions,
      sessions: completed,
      today,
    })
  }

  // --- PATCH ROUTES ---

  async update(
    id: number,
    currentUser: CurrentUser,
    dto: UpdateAssignedProgramDto,
  ) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    // Moving the start date: only while the program hasn't started (see
    // start-date-move.ts) — and then its schedule moves with it, below.
    const newStartDate =
      dto.startDate !== undefined && dto.startDate !== program.startDate
        ? dto.startDate
        : null
    if (newStartDate !== null) {
      assertStartDateMovable(program.startDate, newStartDate)
    }
    // The dates as they WILL be: a PATCH may send only one of them, and the
    // check is about the pair. `undefined` = not sent (keep the stored
    // value); `null` = endDate cleared (open-ended), which is always fine.
    assertDatesInOrder(
      dto.startDate ?? program.startDate,
      dto.endDate === undefined ? program.endDate : dto.endDate,
    )
    // Moving the end date: never into the past (end-date.ts) — past days
    // have been judged, and ending a program now is what complete / cancel
    // do. Only when it really changes: re-sending the stored end date, even
    // a past one, changes nothing and is fine. After the order check, so an
    // end before a (past) start gets that more basic explanation.
    if (dto.endDate !== undefined && dto.endDate !== program.endDate) {
      assertEndDateMovable(dto.endDate)
    }
    await withRlsContext(this.db, currentUser, async (tx) => {
      await tx
        .update(assignedPrograms)
        .set(dto)
        .where(eq(assignedPrograms.id, id))

      // The schedule follows the start: on the new start date, the version
      // that would have been in force that day (planStartDateMove). Same
      // transaction, so the program never exists with a start date its
      // schedule doesn't cover.
      let scheduleVersions:
        | {
            replaced: ReturnType<typeof versionForAudit>[]
            added: ReturnType<typeof versionForAudit> | null
          }
        | undefined
      if (newStartDate !== null) {
        const versions = await this.readScheduleVersions(tx, [id])
        const plan = planStartDateMove(versions, newStartDate)
        // The version the program would START with: the one re-created on
        // the new date, or the one already starting exactly there. A pause
        // can't be it (the same rule as addScheduleVersion's) — moving the
        // start past a planned pause's beginning would make the program
        // begin paused.
        const startsWith =
          plan.insert ??
          versions.find((version) => version.effectiveFrom === newStartDate)
        if (startsWith?.type === 'paused') {
          throw new BadRequestException(
            "A program can't start paused: the new start date falls in a planned pause",
          )
        }
        // Read with their days / rotations before the DELETE (which takes
        // them by cascade), for the audit entry.
        const replaced = versions.filter((version) =>
          plan.deleteIds.includes(version.id),
        )
        if (plan.deleteIds.length > 0) {
          await tx
            .delete(programSchedules)
            .where(inArray(programSchedules.id, plan.deleteIds))
        }
        // The re-created version — the same content, on the new date — is
        // recorded as set by whoever moved the start (it's a new row,
        // created now); who set the ORIGINAL is kept in the audit entry's
        // `replaced`.
        const added = plan.insert
          ? await this.insertScheduleVersion(tx, {
              assignedProgramId: id,
              effectiveFrom: newStartDate,
              createdBy: currentUser.id,
              content: plan.insert,
            })
          : undefined
        scheduleVersions = {
          replaced: replaced.map(versionForAudit),
          added: added ? versionForAudit(added) : null,
        }
      }

      // Every field that really changed, before → after, plus the schedule
      // versions a start-date move replaced.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_UPDATED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: id,
        details: {
          changes: changedFields(program, { ...dto }),
          ...(scheduleVersions ? { scheduleVersions } : {}),
        },
      })
    })
    // The full program, not the bare row — the same reason as
    // updateExercise below: the program page will write this response
    // into its cache, and a bare row has no exercises or schedules.
    return this.findProgramWithExercises(id, currentUser)
  }

  async updateExercise(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
    dto: UpdateAssignedProgramExerciseDto,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    )
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)

    await withRlsContext(this.db, currentUser, async (tx) => {
      // The row as it is NOW, locked until this transaction ends: the audit
      // entry's "from" values must be the ones this UPDATE replaces, and a
      // removal racing this edit waits for it (or this waits for the
      // removal, and then finds the row gone or retired).
      const row = await this.lockProgramExercise(tx, assignedProgramId, rowId)
      assertNotRetired(row)
      const changes: UpdateAssignedProgramExerciseDto & { sortOrder?: number } =
        { ...dto }
      // Moving to another workout of the program (404 if it isn't one):
      // the exercise goes to the END of that workout's list — its old
      // position only meant something in its old workout.
      if (dto.workoutId !== undefined && dto.workoutId !== row.workoutId) {
        resolveWorkoutId(
          dto.workoutId,
          await this.findWorkouts(tx, assignedProgramId),
          'program',
        )
        changes.sortOrder = await this.nextExercisePosition(tx, dto.workoutId)
      }
      // Only what really changes (a field re-sent with its stored value
      // isn't a change). Nothing → no UPDATE and no audit entry: the
      // convention's "a request that changes nothing writes nothing".
      const diff = changedFields(row, { ...changes })
      if (Object.keys(diff).length === 0) return
      await tx
        .update(assignedProgramExercises)
        .set(changes)
        .where(eq(assignedProgramExercises.id, rowId))
      // `name` alongside the changes so the entry reads on its own ("Squat:
      // sets 3 → 4") even after the exercise is renamed or removed. A move
      // shows as workoutId and sortOrder changes.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_EXERCISE_UPDATED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: assignedProgramId,
        details: { exerciseRowId: rowId, name: row.name, changes: diff },
      })
    })
    // The FULL program (exercises in order, schedules), not the bare
    // updated row — closes the gap recorded in deferred-improvements.md,
    // the same fix the template side got (ProgramsService.updateExercise):
    // a screen that writes this response into its cache would otherwise
    // replace the whole program with one exercise row, and the exercise
    // list would vanish.
    return this.findProgramWithExercises(assignedProgramId, currentUser)
  }

  // Reorders the exercises of ONE workout — `workoutId`, or the first when
  // it's omitted (every exercise of a one-workout program). Same rule as
  // ProgramsService.reorderExercises.
  async reorderExercises(
    assignedProgramId: number,
    currentUser: CurrentUser,
    newOrder: number[],
    requestedWorkoutId?: number | null,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    )
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)

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
      const workoutId = resolveWorkoutId(
        requestedWorkoutId,
        await this.findWorkouts(tx, assignedProgramId),
        'program',
      )
      // The workout's ACTIVE exercises, in their current order: a retired
      // one isn't in the list the practitioner reorders (it's no longer part
      // of the program), so it isn't part of the permutation either. The
      // order is read here for the audit entry's "from".
      const currentRows = await tx.query.assignedProgramExercises.findMany({
        where: and(
          eq(assignedProgramExercises.assignedProgramId, assignedProgramId),
          eq(assignedProgramExercises.workoutId, workoutId),
          isNull(assignedProgramExercises.retiredAt),
        ),
        orderBy: (row, { asc }) => [asc(row.sortOrder), asc(row.id)],
      })
      // Same fix as ProgramsService.reorderExercises — a genuine permutation
      // check needs length + no-internal-duplicates + valid-membership
      // together, not just a comparison of deduplicated Set sizes. See that
      // method's comment for the full exploit trace. (Now isPermutationOf,
      // in common/workout-rules.ts.)
      if (
        !isPermutationOf(
          newOrder,
          currentRows.map((r) => r.id),
        )
      ) {
        throw new BadRequestException(
          'The new order must contain exactly the exercises currently in this workout, just reordered',
        )
      }

      // The same order again changes nothing: no writes, no audit entry.
      const from = currentRows.map((r) => r.id)
      if (from.every((id, index) => id === newOrder[index])) return

      for (const [index, rowId] of newOrder.entries()) {
        await tx
          .update(assignedProgramExercises)
          .set({ sortOrder: index })
          .where(eq(assignedProgramExercises.id, rowId))
      }
      // Which workout, and its exercises' order before → after (row ids).
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_EXERCISES_REORDERED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: assignedProgramId,
        details: { workoutId, from, to: newOrder },
      })
    })

    return this.findProgramWithExercises(assignedProgramId, currentUser)
  }

  // --- WORKOUTS ---
  //
  // Add, rename, reorder and delete a program's workouts — the same rules as
  // a template's (common/workout-rules.ts), plus one: a workout that
  // sessions recorded is the patient's history and can't be deleted.
  //
  // These are NEW routes that change a patient's prescription, so they
  // follow the audit convention (decided 2026-10-10): tagged
  // @AuditedByService() in the controller, and each writes ONE complete
  // entry inside its own transaction — no change without its entry, no
  // entry without its change. A request that changes nothing (renaming to
  // the same name, the same order) changes no row and writes no entry.
  //
  // Each answers with the full program. Adding and deleting lock the
  // program's row first (lockProgram), for the same reason as templates:
  // both decide from a count.
  //
  // assertCanManage on these routes is the service layer of "every rule
  // exists twice": a mutation check showed no request can reach it and
  // fail — the patient is stopped by the controller's @Roles, and a
  // practitioner off the care team can't even see the program (row-level
  // security, which applies the same care-team rule, makes it a 404 in
  // findProgramOrThrow). It stays, like on every other route here, so the
  // service is correct on its own, whatever the layers around it.

  async addWorkout(id: number, currentUser: CurrentUser, dto: AddWorkoutDto) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    await withRlsContext(this.db, currentUser, async (tx) => {
      await this.lockProgram(tx, id)
      const workouts = await this.findWorkouts(tx, id)
      assertCanAddWorkout(workouts.length)
      const [added] = await tx
        .insert(programWorkouts)
        .values({
          assignedProgramId: id,
          name: normalizeWorkoutName(dto.name),
          // After the last one (max + 1: positions can have gaps).
          sortOrder: Math.max(-1, ...workouts.map((w) => w.sortOrder)) + 1,
        })
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_WORKOUT_ADDED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: id,
        details: { workout: workoutForAudit(added) },
      })
    })
    return this.findProgramWithExercises(id, currentUser)
  }

  async renameWorkout(
    id: number,
    workoutId: number,
    currentUser: CurrentUser,
    dto: RenameWorkoutDto,
  ) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    await withRlsContext(this.db, currentUser, async (tx) => {
      const workouts = await this.findWorkouts(tx, id)
      resolveWorkoutId(workoutId, workouts, 'program')
      const before = workouts.find((w) => w.id === workoutId)!
      const name = normalizeWorkoutName(dto.name)
      if (name === before.name) return
      await tx
        .update(programWorkouts)
        .set({ name })
        .where(eq(programWorkouts.id, workoutId))
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_WORKOUT_RENAMED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: id,
        details: { workoutId, name: { from: before.name, to: name } },
      })
    })
    return this.findProgramWithExercises(id, currentUser)
  }

  async reorderWorkouts(
    id: number,
    currentUser: CurrentUser,
    newOrder: number[],
  ) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    await withRlsContext(this.db, currentUser, async (tx) => {
      const workouts = orderWorkouts(await this.findWorkouts(tx, id))
      const currentOrder = workouts.map((w) => w.id)
      if (!isPermutationOf(newOrder, currentOrder)) {
        throw new BadRequestException(
          'The new order must contain exactly the workouts currently in this program, just reordered',
        )
      }
      if (newOrder.every((workoutId, i) => workoutId === currentOrder[i])) {
        return
      }
      for (const [index, workoutId] of newOrder.entries()) {
        await tx
          .update(programWorkouts)
          .set({ sortOrder: index })
          .where(eq(programWorkouts.id, workoutId))
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_WORKOUTS_REORDERED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: id,
        // Ids, first = A: enough to say which workout became which letter.
        details: { order: { from: currentOrder, to: newOrder } },
      })
    })
    return this.findProgramWithExercises(id, currentUser)
  }

  // Only an empty workout, never the last, never one with recorded sessions
  // (assertWorkoutRemovable). The audit entry keeps the deleted row whole —
  // after this, the audit log is the only place it still exists.
  async removeWorkout(id: number, workoutId: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    try {
      await withRlsContext(this.db, currentUser, async (tx) => {
        await this.lockProgram(tx, id)
        const workouts = orderWorkouts(await this.findWorkouts(tx, id))
        resolveWorkoutId(workoutId, workouts, 'program')
        // EVERY exercise row of the workout, retired ones included: a retired
        // exercise still belongs to it (workout_id, the composite foreign
        // key), so the DELETE below would fail on it anyway. In practice a
        // workout with a retired exercise also has the sessions that used it
        // (the count below), so the answer is "it has sessions". The page
        // offers Delete only when it would succeed (3a-w), counting the
        // retired ones too.
        const [{ exerciseCount }] = await tx
          .select({ exerciseCount: count() })
          .from(assignedProgramExercises)
          .where(eq(assignedProgramExercises.workoutId, workoutId))
        // Every session, whatever its status: a started one is history too.
        const [{ sessionCount }] = await tx
          .select({ sessionCount: count() })
          .from(sessions)
          .where(eq(sessions.workoutId, workoutId))
        // Every schedule version that names it — current, planned or past
        // (each table has an index on workout_id for exactly this).
        const [{ dayUses }] = await tx
          .select({ dayUses: count() })
          .from(programScheduleDays)
          .where(eq(programScheduleDays.workoutId, workoutId))
        const [{ rotationUses }] = await tx
          .select({ rotationUses: count() })
          .from(programScheduleRotation)
          .where(eq(programScheduleRotation.workoutId, workoutId))
        assertWorkoutRemovable({
          label: workoutLabel(workouts.findIndex((w) => w.id === workoutId)),
          workoutCount: workouts.length,
          exerciseCount,
          sessionCount,
          scheduleUseCount: dayUses + rotationUses,
        })
        const [removed] = await tx
          .delete(programWorkouts)
          .where(eq(programWorkouts.id, workoutId))
          .returning()
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'ASSIGNED_PROGRAM_WORKOUT_REMOVED',
          targetUserId: program.patientId,
          entityType: 'assigned-programs',
          entityId: id,
          details: { workout: workoutForAudit(removed) },
        })
      })
    } catch (error) {
      // An exercise added, a session started or a schedule set between the
      // counts above and the DELETE (none of them takes the program's
      // lock): the database refuses the delete through that row's foreign
      // key. Same answer the counts would have given, a moment later.
      if (
        [
          ASSIGNED_PROGRAM_EXERCISES_WORKOUT_FK,
          SESSIONS_WORKOUT_FK,
          PROGRAM_SCHEDULE_DAYS_WORKOUT_FK,
          PROGRAM_SCHEDULE_ROTATION_WORKOUT_FK,
        ].some((constraint) => isForeignKeyViolation(error, constraint))
      ) {
        throw new ConflictException(
          'This workout was just given exercises, a session or a place in the schedule: reload the program and try again',
        )
      }
      throw error
    }
    return this.findProgramWithExercises(id, currentUser)
  }

  // --- DELETE ROUTES ---

  // DELETE /assigned-programs/:id — archiving, which the app treats as
  // deleting: the program disappears from every list. Only for a program
  // with NO session (step 2b-iii): one with sessions is part of the
  // patient's clinical record, and hiding it would hide that history — it is
  // CANCELLED instead (it stays visible, read-only). Decided from the
  // current state, under the program's row lock, like close().
  async archive(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    return withRlsContext(this.db, currentUser, async (tx) => {
      const current = await this.lockAndReadProgram(tx, id)
      // Already archived: nothing left to delete (the same 409 as any write
      // on it). A completed program with no session may still be archived.
      if (current.isArchived) assertProgramOpen(current)
      if ((await this.readSessionDays(tx, id)).length > 0) {
        throw new ConflictException(
          "This program has sessions, so it is part of the patient's record and can't be deleted: cancel it instead",
        )
      }
      const [archived] = await tx
        .update(assignedPrograms)
        .set({ isArchived: true })
        .where(eq(assignedPrograms.id, id))
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ASSIGNED_PROGRAM_ARCHIVED',
        targetUserId: current.patientId,
        entityType: 'assigned-programs',
        entityId: id,
        details: { program: programForAudit(current) },
      })
      return archived
    })
  }

  // GET /assigned-programs/:id/closing?today= — what cancelling and what
  // completing the program WOULD do today, for the confirmation dialog
  // ("No session yet: cancelling deletes it" / "It will end on Sun 11 Oct
  // and become read-only"). Asked of the server because the answer depends
  // on what the screen can't see: unfinished sessions (they count as
  // "sessions"), and whether one was completed today. Answered by the same
  // planClosing() as close() itself. Read-only, so not audited.
  //
  // The same people as closing (assertCanManage), and only for an open
  // program: a closed one has nothing to preview (409, as close() would).
  // No lock: a preview is a moment's answer; close() decides again under
  // the lock.
  async closingPreview(id: number, currentUser: CurrentUser, today: string) {
    assertPossibleToday(today)
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    const sessionDays = await withRlsContext(this.db, currentUser, (tx) =>
      this.readSessionDays(tx, id),
    )
    return {
      cancel: planClosing('cancel', program, sessionDays, today),
      complete: planClosing('complete', program, sessionDays, today),
    }
  }

  // POST /assigned-programs/:id/cancel and …/complete (decisions §5,
  // "Settled 2026-10-11", point 3). `today` is the practitioner's date.
  //   - CANCEL with no session at all: nothing happened clinically, so the
  //     program is simply ARCHIVED (hidden) — outcome 'archived'.
  //   - Otherwise the status becomes 'cancelled' or 'completed' — FINAL:
  //     every later write is refused (assertProgramOpen) — and the end date
  //     closingEndDate()'s: yesterday, or today if a session was completed
  //     today; never later than the end it had, never before its start.
  // "Any session" counts a started-and-abandoned one too: it is a record of
  // something that happened. Everything is decided under the program's row
  // lock, from the state read AFTER taking it: two requests at once (a
  // cancel and a complete, say) are taken one after the other, and the
  // second finds the program closed (409). The answer has one shape,
  // { outcome, program } — `program` null when archived (it's gone).
  async close(
    id: number,
    currentUser: CurrentUser,
    action: 'cancel' | 'complete',
    today: string,
  ) {
    assertPossibleToday(today)
    const program = await this.findProgramOrThrow(id, currentUser)
    await this.assertCanManage(program.patientId, currentUser)

    const outcome = await withRlsContext(
      this.db,
      currentUser,
      async (tx): Promise<'archived' | 'cancelled' | 'completed'> => {
        const current = await this.lockAndReadProgram(tx, id)
        assertProgramOpen(current)
        const sessionDays = await this.readSessionDays(tx, id)
        // What closing does is planClosing()'s answer — the same function
        // the preview (closingPreview) asks, so what the dialog promised and
        // what happens can't disagree. Decided here from the state read
        // UNDER the lock: the preview's answer may be stale by now (a
        // session started since), and this is the one that counts.
        const plan = planClosing(action, current, sessionDays, today)

        if (plan.outcome === 'archived') {
          await tx
            .update(assignedPrograms)
            .set({ isArchived: true })
            .where(eq(assignedPrograms.id, id))
          await this.auditService.logInTransaction(tx, {
            performedBy: currentUser.id,
            action: 'ASSIGNED_PROGRAM_ARCHIVED',
            targetUserId: current.patientId,
            entityType: 'assigned-programs',
            entityId: id,
            details: {
              reason: 'cancelled before any session',
              program: programForAudit(current),
            },
          })
          return 'archived'
        }

        const status = plan.outcome
        const endDate = plan.endDate!
        await tx
          .update(assignedPrograms)
          .set({ status, endDate })
          .where(eq(assignedPrograms.id, id))
        // The same `changes` shape as a PATCH's entry: only what really
        // changed (the end date may stay).
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action:
            status === 'cancelled'
              ? 'ASSIGNED_PROGRAM_CANCELLED'
              : 'ASSIGNED_PROGRAM_COMPLETED',
          targetUserId: current.patientId,
          entityType: 'assigned-programs',
          entityId: id,
          details: {
            today,
            changes: changedFields(current, { status, endDate }),
          },
        })
        return status
      },
    )

    return {
      outcome,
      program:
        outcome === 'archived'
          ? null
          : await this.findProgramWithExercises(id, currentUser),
    }
  }

  async removeExercise(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    )
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)

    await withRlsContext(this.db, currentUser, async (tx) => {
      // Locked: a concurrent edit of the same exercise waits for this
      // removal (and then finds it gone or retired), and so does a session
      // starting with it in its checklist — its INSERT into
      // session_exercises needs a lock on this row (the foreign key's FOR
      // KEY SHARE), which conflicts with this one.
      const row = await this.lockProgramExercise(tx, assignedProgramId, rowId)
      assertNotAlreadyRemoved(row)

      // DELETE it if no session used it; otherwise RETIRE it. Decided by
      // the DATABASE, not by counting sessions first: the foreign key from
      // session_exercises (ON DELETE RESTRICT) refuses the DELETE exactly
      // when some session points at the row — atomically, at the moment of
      // the DELETE, with no window between a count and the write.
      //
      // The DELETE runs inside a SAVEPOINT (tx.transaction() inside a
      // transaction = a nested transaction, which Postgres implements as a
      // savepoint). An error aborts the whole transaction in Postgres — every
      // later statement would fail with "current transaction is aborted" —
      // unless the statement ran after a savepoint: rolling back TO the
      // savepoint undoes just the failed DELETE and lets the transaction go
      // on, here to retire the row instead.
      let outcome: 'deleted' | 'retired'
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint
            .delete(assignedProgramExercises)
            .where(eq(assignedProgramExercises.id, rowId))
        })
        outcome = 'deleted'
      } catch (error) {
        if (
          !isForeignKeyViolation(error, SESSION_EXERCISES_PROGRAM_EXERCISE_FK)
        ) {
          throw error
        }
        // now(): the database's clock, the same moment as the transaction's
        // other timestamps. retired_by = the person removing it (migration
        // 0033's trigger insists).
        await tx
          .update(assignedProgramExercises)
          .set({ retiredAt: sql`now()`, retiredBy: currentUser.id })
          .where(eq(assignedProgramExercises.id, rowId))
        outcome = 'retired'
      }

      // Two actions, so an audit viewer can tell "taken out, never used"
      // from "taken out, kept for its sessions". Either way the whole
      // exercise as it was: after a DELETE, this entry is the only place it
      // still exists.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action:
          outcome === 'deleted'
            ? 'ASSIGNED_PROGRAM_EXERCISE_REMOVED'
            : 'ASSIGNED_PROGRAM_EXERCISE_RETIRED',
        targetUserId: program.patientId,
        entityType: 'assigned-programs',
        entityId: assignedProgramId,
        details: { exercise: exerciseForAudit(row) },
      })
    })
    // The full program (it used to answer with nothing), like every write.
    return this.findProgramWithExercises(assignedProgramId, currentUser)
  }

  // GET /assigned-programs/:id/exercises/:exerciseRowId/removal — what
  // removing this exercise WOULD do, for the confirmation dialog (decided
  // 2026-10-13): `{ outcome: 'deleted' | 'retired', sessionCount }`. Asked of
  // the server because the answer depends on sessions, which the page can't
  // see. Read-only, so not audited; no lock (removeExercise decides again,
  // under its lock). The same people and refusals as the removal itself:
  // assertCanManage, an open program, an exercise of THIS program (404), not
  // already removed (409).
  //
  // Sessions are counted under the caller's row-level security: the care
  // team and admins — the only people past assertCanManage — see every
  // session of the patient, so the count is complete. DISTINCT sessions: a
  // checklist has one row per exercise today, but "how many sessions used
  // it" shouldn't depend on that.
  async removalPreview(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    )
    await this.assertCanManage(program.patientId, currentUser)
    assertProgramOpen(program)
    return withRlsContext(this.db, currentUser, async (tx) => {
      const row = await this.lockProgramExercise(
        tx,
        assignedProgramId,
        rowId,
        false,
      )
      assertNotAlreadyRemoved(row)
      const [{ sessionCount }] = await tx
        .select({ sessionCount: countDistinct(sessionExercises.sessionId) })
        .from(sessionExercises)
        .where(eq(sessionExercises.assignedProgramExerciseId, rowId))
      return planRemoval(sessionCount)
    })
  }

  // === HELPER FUNCTIONS =================================================================

  private async resolveSourceExercises(
    dto: CreateAssignedProgramDto,
    currentUser: CurrentUser,
  ): Promise<ResolvedSource> {
    // ONE source: a template, a program to continue, or an inline list.
    // Two at once is a client bug — refused rather than one silently
    // winning (before step 2b-iii, a template quietly beat an inline list).
    const sources = [
      dto.basedOnTemplateId != null,
      dto.basedOnProgramId != null,
      (dto.exercises?.length ?? 0) > 0,
    ].filter(Boolean).length
    if (sources > 1) {
      throw new BadRequestException(
        'Give one source: basedOnTemplateId, basedOnProgramId or exercises',
      )
    }
    if (dto.basedOnProgramId != null) {
      return this.resolveProgramToContinue(dto, currentUser)
    }
    if (dto.basedOnTemplateId) {
      // The template ROW first (closes the gap in deferred-improvements.md:
      // this used to read only template_exercises, so an ARCHIVED — i.e.
      // deleted — template could still be assigned by calling the API
      // directly). Same rule and wording style as ProgramsService.duplicate:
      // an archived template can't be built upon. Templates are readable by
      // everyone (their SELECT policy is `true`), so no RLS context needed.
      const template = await this.db.query.programTemplates.findFirst({
        where: eq(programTemplates.id, dto.basedOnTemplateId),
      })
      if (!template) {
        throw new NotFoundException(
          `Program template ${dto.basedOnTemplateId} not found`,
        )
      }
      if (template.isArchived) {
        throw new BadRequestException(
          'Archived program templates cannot be assigned',
        )
      }
      const rows = await this.db.query.templateExercises.findMany({
        where: eq(templateExercises.templateId, dto.basedOnTemplateId),
        orderBy: (te, { asc }) => [asc(te.sortOrder)],
      })
      // Now a 400, not a 404: the template exists (just checked), so "not
      // found" would be wrong — the request is what can't be carried out.
      if (rows.length === 0) {
        throw new BadRequestException(
          `Program template ${dto.basedOnTemplateId} has no exercises to copy`,
        )
      }
      // The template's workouts, in order — copied with the exercises.
      // Every one must have exercises: a patient given an empty workout B
      // would be scheduled sessions with nothing in them. (An empty workout
      // in a TEMPLATE is fine — it's being written; assigning is the moment
      // it has to be complete.)
      const workouts = orderWorkouts(
        await this.db.query.templateWorkouts.findMany({
          where: eq(templateWorkouts.templateId, dto.basedOnTemplateId),
        }),
      )
      const indexOfWorkout = new Map(
        workouts.map((workout, index) => [workout.id, index]),
      )
      workouts.forEach((workout, index) => {
        if (!rows.some((row) => row.workoutId === workout.id)) {
          throw new BadRequestException(
            `Workout ${workoutLabel(index)} of program template ${dto.basedOnTemplateId} has no exercises`,
          )
        }
      })
      const snapshots = await this.fetchExerciseSnapshots(
        rows.map((row) => row.exerciseId),
      )
      // Copied in display order — A's exercises, then B's — rather than by
      // their positions alone (which restart at 0 in every workout, so A's
      // and B's would interleave): the rows are inserted, and the audit
      // entry lists them, in the order the program will show them.
      const inDisplayOrder = orderExercisesByWorkout(rows, workouts)
      const exercisesToCopy = inDisplayOrder.map((row) => {
        // Guaranteed present — a templateExercises row's exerciseId is
        // enforced valid by its own foreign key (onDelete: "restrict"),
        // so fetchExerciseSnapshots can never actually throw for this
        // branch; the ! reflects that real guarantee, not an assumption.
        const snapshot = snapshots.get(row.exerciseId)!
        return {
          exerciseId: row.exerciseId,
          name: snapshot.name,
          primaryMuscles: snapshot.primaryMuscles,
          secondaryMuscles: snapshot.secondaryMuscles,
          equipment: snapshot.equipment,
          instructions: snapshot.instructions,
          sets: row.sets ?? undefined,
          reps: row.reps ?? undefined,
          durationInSeconds: row.durationInSeconds ?? undefined,
          weight: row.weight ?? undefined,
          weightUnit: row.weightUnit ?? undefined,
          sortOrder: row.sortOrder,
          notes: row.notes ?? undefined,
          // The `!` holds: an exercise's workout is one of its template's
          // (composite foreign key), and all of them are in the map.
          workoutIndex: indexOfWorkout.get(row.workoutId)!,
        }
      })
      return {
        workouts: workouts.map((workout) => ({ name: workout.name })),
        exercises: exercisesToCopy,
        basedOnTemplateId: dto.basedOnTemplateId,
        basedOnProgramId: null,
      }
    }

    if (!dto.exercises || dto.exercises.length === 0) {
      throw new BadRequestException(
        'Provide basedOnTemplateId, basedOnProgramId or an inline exercises array',
      )
    }
    // Unlike the template branch, a client-supplied exerciseId here has
    // no foreign key backing it yet — fetchExerciseSnapshots' own
    // existence check is what catches a bad id, a real validation gap
    // this path didn't have before snapshotting made fetching each
    // exercise unavoidable anyway.
    const snapshots = await this.fetchExerciseSnapshots(
      dto.exercises.map((ex) => ex.exerciseId),
    )
    // An inline list is one workout (unnamed, "A"): the list has no way to
    // say otherwise, and workouts can be added on the program afterwards.
    const exercisesToCopy = dto.exercises.map((ex) => {
      const snapshot = snapshots.get(ex.exerciseId)!
      return {
        exerciseId: ex.exerciseId,
        name: snapshot.name,
        primaryMuscles: snapshot.primaryMuscles,
        secondaryMuscles: snapshot.secondaryMuscles,
        equipment: snapshot.equipment,
        instructions: snapshot.instructions,
        sets: ex.sets,
        reps: ex.reps,
        durationInSeconds: ex.durationInSeconds,
        weight: ex.weight,
        weightUnit: ex.weightUnit,
        sortOrder: ex.sortOrder,
        notes: ex.notes,
        workoutIndex: 0,
      }
    })
    return {
      workouts: [{ name: null }],
      exercises: exercisesToCopy,
      basedOnTemplateId: null,
      basedOnProgramId: null,
    }
  }

  // "Assign again" (decisions §5, "Settled 2026-10-11", point 3): a
  // completed or cancelled program is never reopened — it would bring back
  // weeks already judged — so continuing it means a NEW program, copied from
  // its TAILORED workouts and exercises (what the patient was really doing,
  // not the template, which may have changed since). New dates and schedule
  // come with the request, as for any assignment.
  //
  // Read as the caller, under RLS: a program they can't see is a 404, like
  // anywhere else.
  private async resolveProgramToContinue(
    dto: CreateAssignedProgramDto,
    currentUser: CurrentUser,
  ): Promise<ResolvedSource> {
    const sourceId = dto.basedOnProgramId!
    const source = await this.findProgramOrThrow(sourceId, currentUser)
    if (source.isArchived) {
      throw new BadRequestException('Deleted programs cannot be assigned again')
    }
    // Only a CLOSED program is continued: an active one is still going —
    // tailor it, or complete it first.
    if (source.status === 'active') {
      throw new ConflictException(
        'Only a completed or cancelled program can be assigned again: this one is still active',
      )
    }
    // Continuing means the same patient; giving another patient a copy of
    // someone's tailored program isn't what this is for (a template is).
    if (source.patientId !== dto.patientId) {
      throw new BadRequestException(
        `Program ${sourceId} belongs to another patient: a program is assigned again to the same patient`,
      )
    }
    const [workoutRows, exerciseRows] = await withRlsContext(
      this.db,
      currentUser,
      async (tx) =>
        [
          await this.findWorkouts(tx, sourceId),
          // Its ACTIVE exercises only: a retired one was taken out of the
          // program, so the continuation doesn't bring it back.
          await tx.query.assignedProgramExercises.findMany({
            where: and(
              eq(assignedProgramExercises.assignedProgramId, sourceId),
              isNull(assignedProgramExercises.retiredAt),
            ),
          }),
        ] as const,
    )
    const workouts = orderWorkouts(workoutRows)
    // The same rule as a template: every workout must have exercises (an
    // emptied workout of the old program would give the patient sessions
    // with nothing in them).
    workouts.forEach((workout, index) => {
      if (!exerciseRows.some((row) => row.workoutId === workout.id)) {
        throw new BadRequestException(
          `Workout ${workoutLabel(index)} of program ${sourceId} has no exercises`,
        )
      }
    })
    const indexOfWorkout = new Map(
      workouts.map((workout, index) => [workout.id, index]),
    )
    // Copied AS THEY ARE in the old program — its snapshot of each exercise
    // (name, muscles, instructions) included, not re-read from the library:
    // the continuation starts from exactly what the patient was given.
    const exercisesToCopy = orderExercisesByWorkout(exerciseRows, workouts).map(
      (row) => ({
        exerciseId: row.exerciseId,
        name: row.name,
        primaryMuscles: row.primaryMuscles,
        secondaryMuscles: row.secondaryMuscles,
        equipment: row.equipment,
        instructions: row.instructions,
        sets: row.sets ?? undefined,
        reps: row.reps ?? undefined,
        durationInSeconds: row.durationInSeconds ?? undefined,
        weight: row.weight ?? undefined,
        weightUnit: row.weightUnit ?? undefined,
        sortOrder: row.sortOrder,
        notes: row.notes ?? undefined,
        workoutIndex: indexOfWorkout.get(row.workoutId)!,
      }),
    )
    return {
      workouts: workouts.map((workout) => ({ name: workout.name })),
      exercises: exercisesToCopy,
      basedOnTemplateId: source.basedOnTemplateId,
      basedOnProgramId: sourceId,
    }
  }

  // The program with its workouts (A first), its exercises (one flat list,
  // workout by workout — see ProgramsService.findOne for why flat) and its
  // schedule versions (oldest first — the order they took effect in).
  //
  // `exercises` holds the ACTIVE exercises only — what the program IS — so
  // every screen that lists them (the program page, the patient's session
  // flow later) needs to know nothing about retiring. The retired ones come
  // apart, in `retiredExercises`, in the order they were removed: kept for
  // the record (the sessions that used them), and for a screen that wants
  // to show "removed exercises".
  //
  // Every exercise — active and retired — also carries `images`: the
  // LIBRARY exercise's photos, read live (see libraryImagesByExercise).
  private async findProgramWithExercises(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser)
    const [workoutRows, exerciseRows, schedules, imageKeys] =
      await withRlsContext(this.db, currentUser, async (tx) => {
        const rows = await tx.query.assignedProgramExercises.findMany({
          where: eq(assignedProgramExercises.assignedProgramId, id),
        })
        return [
          await this.findWorkouts(tx, id),
          rows,
          await this.readScheduleVersions(tx, [id]),
          await this.libraryImageKeys(tx, rows),
        ] as const
      })
    const workouts = orderWorkouts(workoutRows)
    const withImages = await Promise.all(
      exerciseRows.map(async (row) => ({
        ...row,
        // `?? []`: a row always has its library exercise (a foreign key), so
        // this is only TypeScript's "a Map may not have the key" — no photos.
        images: await this.signImages(imageKeys.get(row.exerciseId) ?? []),
      })),
    )
    // "No retirement date" = active (a falsy check: null from the database).
    const active = withImages.filter((row) => !row.retiredAt)
    const retired = withImages
      .filter((row) => row.retiredAt)
      .sort(
        (a, b) =>
          a.retiredAt!.getTime() - b.retiredAt!.getTime() || a.id - b.id,
      )
    return {
      ...program,
      workouts,
      exercises: orderExercisesByWorkout(active, workouts),
      retiredExercises: retired,
      schedules,
    }
  }

  // --- Exercise photos ---
  //
  // A program exercise shows the photos of the LIBRARY exercise it was copied
  // from, read LIVE — not a copy (decided with the person 2026-10-14). The
  // program copies everything that is the clinical record: the prescription,
  // and the description (name, muscles, equipment, instructions — editable
  // per patient since D-3, copied into every session since D-2). Photos are
  // illustrations, like a leaflet: a better photo uploaded once in the library
  // should reach every patient who does that exercise. What a patient is told
  // to do is the text. (Photos chosen per program: a roadmap item of their
  // own, "Program-specific photos".)
  //
  // The object keys of the library exercises these rows point at, in ONE query
  // for the whole program (not one per exercise — the N+1 problem): exercise
  // id → its `media_urls`, in the library's order (the first is the cover).
  // Read in the caller's transaction, under the actor's RLS context;
  // `exercises_select` is `USING (true)` — the library is readable by every
  // signed-in user, patients included, so the patient's own screens (Phase 4)
  // get the same answer. An archived library exercise keeps its photos (its
  // row is only flagged), so a program that still uses it keeps showing them.
  // No rows → no query (`inArray` with an empty list is an error in Drizzle).
  // An id listed twice (the same exercise in two workouts) is harmless in
  // `IN (…)`, so the ids aren't de-duplicated first.
  private async libraryImageKeys(
    executor: DrizzleDb,
    rows: { exerciseId: number }[],
  ): Promise<Map<number, string[]>> {
    const ids = rows.map((row) => row.exerciseId)
    if (ids.length === 0) {
      return new Map()
    }
    const library = await executor.query.exercises.findMany({
      where: inArray(exercises.id, ids),
      columns: { id: true, mediaUrls: true },
    })
    return new Map(library.map((exercise) => [exercise.id, exercise.mediaUrls]))
  }

  // Object keys → what a client may see: a short-lived signed URL each (the
  // same `getPresignedUrl` the library's own responses use — 15 minutes). The
  // key itself is not sent: a program's screens only DISPLAY the photos, they
  // never reorder or remove them (that's the library's photos page, which has
  // its own responses), so `{ url }` is all they need. Signing is local
  // cryptography (an HMAC over the request, with the storage credentials) —
  // no network call per photo.
  private async signImages(keys: string[]): Promise<{ url: string }[]> {
    return Promise.all(
      keys.map(async (key) => ({
        url: await this.storageService.getPresignedUrl(key),
      })),
    )
  }

  // Where an exercise added (or moved) to this workout goes: after its
  // LAST exercise — the highest position + 1, or 0 in an empty workout. Not
  // a count: removing an exercise leaves a gap (positions 0 and 2, a count
  // of 2 → a clash with position 2). The frontend's nextExercisePosition
  // (src/workouts/workoutGroups.ts) is the same rule. Retired exercises are
  // counted too, deliberately without a filter: a position after one of
  // them is as good as any (only the order of the active ones is shown),
  // and a filter no test could tell apart would be dead weight.
  private async nextExercisePosition(tx: DrizzleDb, workoutId: number) {
    const positions = await tx
      .select({ sortOrder: assignedProgramExercises.sortOrder })
      .from(assignedProgramExercises)
      .where(eq(assignedProgramExercises.workoutId, workoutId))
    return Math.max(-1, ...positions.map((p) => p.sortOrder)) + 1
  }

  // One exercise of THIS program, read and — by default — locked (SELECT …
  // FOR UPDATE) until the end of the caller's transaction; 404 when the
  // program has no such row (or row-level security hides it). The lock makes
  // the edits and the removal of one exercise happen one at a time, each
  // starting from the row as the previous one left it. Under row-level
  // security, FOR UPDATE also asks the UPDATE policy: the care team or an
  // admin, the people allowed to change the program's exercises. A read that
  // changes nothing (the removal preview) passes `lock = false`.
  private async lockProgramExercise(
    tx: DrizzleDb,
    assignedProgramId: number,
    rowId: number,
    lock = true,
  ) {
    const query = tx
      .select()
      .from(assignedProgramExercises)
      .where(
        and(
          eq(assignedProgramExercises.id, rowId),
          eq(assignedProgramExercises.assignedProgramId, assignedProgramId),
        ),
      )
    const [row] = lock ? await query.for('update') : await query
    if (!row) {
      throw new NotFoundException(
        `Exercise ${rowId} not found in this assigned program`,
      )
    }
    return row
  }

  // The schedule versions of these programs, each with its content: the
  // version rows (oldest first within a program), then their days and
  // rotation positions — THREE queries whatever the number of programs or
  // versions (`IN (…)` lists, grouped in memory), not one per version.
  // Always called with a transaction carrying the caller's RLS context: the
  // children's policies show only rows of versions the caller may see.
  private async readScheduleVersions(
    tx: DrizzleDb,
    programIds: number[],
  ): Promise<ScheduleVersion[]> {
    if (programIds.length === 0) return []
    const rows = await tx.query.programSchedules.findMany({
      where: inArray(programSchedules.assignedProgramId, programIds),
      orderBy: (row, { asc }) => [
        asc(row.assignedProgramId),
        asc(row.effectiveFrom),
      ],
    })
    if (rows.length === 0) return []
    const versionIds = rows.map((row) => row.id)
    const [dayRows, rotationRows] = [
      await tx.query.programScheduleDays.findMany({
        where: inArray(programScheduleDays.scheduleId, versionIds),
        orderBy: (row, { asc }) => [asc(row.weekday)],
      }),
      await tx.query.programScheduleRotation.findMany({
        where: inArray(programScheduleRotation.scheduleId, versionIds),
        orderBy: (row, { asc }) => [asc(row.position)],
      }),
    ]
    // Grouped by version; each list keeps the order it was read in.
    const days = new Map<number, ScheduleDay[]>()
    for (const row of dayRows) {
      days.set(row.scheduleId, [
        ...(days.get(row.scheduleId) ?? []),
        { weekday: row.weekday, workoutId: row.workoutId },
      ])
    }
    const rotation = new Map<number, number[]>()
    for (const row of rotationRows) {
      rotation.set(row.scheduleId, [
        ...(rotation.get(row.scheduleId) ?? []),
        row.workoutId,
      ])
    }
    return rows.map((row) => ({
      ...row,
      days: days.get(row.id) ?? [],
      rotation: rotation.get(row.id) ?? [],
    }))
  }

  // Writes ONE schedule version with its content: the version row, then
  // its days or rotation positions — in the caller's transaction, so the
  // children's INSERT policy (migration 0029: only in the transaction that
  // created their version) lets them in, and the whole is atomic. "A
  // 'weekdays' version has at least one day" and "a rotation has at least
  // one position" span two tables, which no constraint can say: the DTOs
  // require a non-empty list, and this refuses one anyway, so no path —
  // a start-date move copying a version, say — can store an empty one.
  private async insertScheduleVersion(
    tx: DrizzleDb,
    version: {
      assignedProgramId: number
      effectiveFrom: string
      createdBy: number
      content: ScheduleContent
    },
  ): Promise<ScheduleVersion> {
    const { content } = version
    if (content.type === 'weekdays' && content.days.length === 0) {
      throw new Error("A 'weekdays' schedule version needs at least one day")
    }
    if (content.type === 'times_per_week' && content.rotation.length === 0) {
      throw new Error('A rotation needs at least one workout')
    }
    const [row] = await tx
      .insert(programSchedules)
      .values({
        assignedProgramId: version.assignedProgramId,
        type: content.type,
        timesPerWeek: content.timesPerWeek,
        effectiveFrom: version.effectiveFrom,
        createdBy: version.createdBy,
      })
      .returning()
    if (content.days.length > 0) {
      await tx.insert(programScheduleDays).values(
        content.days.map((day) => ({
          scheduleId: row.id,
          assignedProgramId: row.assignedProgramId,
          weekday: day.weekday,
          workoutId: day.workoutId,
        })),
      )
    }
    if (content.rotation.length > 0) {
      await tx.insert(programScheduleRotation).values(
        content.rotation.map((workoutId, position) => ({
          scheduleId: row.id,
          assignedProgramId: row.assignedProgramId,
          position,
          workoutId,
        })),
      )
    }
    return { ...row, days: content.days, rotation: content.rotation }
  }

  // A program's workouts, in no particular order (orderWorkouts sorts).
  // Always called with a transaction carrying the caller's RLS context:
  // program_workouts' policies show only workouts of programs the caller
  // may see.
  private async findWorkouts(tx: DrizzleDb, assignedProgramId: number) {
    return tx.query.programWorkouts.findMany({
      where: eq(programWorkouts.assignedProgramId, assignedProgramId),
    })
  }

  // SELECT … FOR UPDATE on the program's row, so the workout changes of one
  // program happen one at a time — see ProgramsService.lockTemplate for the
  // race it prevents. Row-level security asks the UPDATE policy too: an
  // admin or the care team, the people allowed to change the program.
  private async lockProgram(tx: DrizzleDb, assignedProgramId: number) {
    await tx
      .select({ id: assignedPrograms.id })
      .from(assignedPrograms)
      .where(eq(assignedPrograms.id, assignedProgramId))
      .for('update')
  }

  // The program row, read AFTER taking its lock: a state read before the
  // lock could be stale by the time it's used (another request may have
  // closed the program while this one waited). Found by
  // findProgramOrThrow a moment ago, so it exists here.
  private async lockAndReadProgram(tx: DrizzleDb, id: number) {
    await this.lockProgram(tx, id)
    const current = await tx.query.assignedPrograms.findFirst({
      where: eq(assignedPrograms.id, id),
    })
    return current!
  }

  // Every session of the program — any status — as its day and status:
  // enough to know whether it has any, and whether one was completed today.
  private async readSessionDays(tx: DrizzleDb, id: number) {
    return tx
      .select({ localDate: sessions.localDate, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.assignedProgramId, id))
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