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
import { and, eq, inArray, isNull, lte } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  sessions,
  sessionExercises,
  assignedPrograms,
  assignedProgramExercises,
  programWorkouts,
  programSchedules,
  programScheduleDays,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateSessionDto } from './dto/create-session.dto'
import { UpdateSessionDto, SessionStatus } from './dto/update-session.dto'
import { UpdateSessionExerciseDto } from './dto/update-session-exercise.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import { isPossibleToday } from '../common/calendar-date'
import { workoutLabel, type WorkoutRow } from '../common/workout-rules'
import { assertProgramOpen } from '../assigned-programs/program-state'
import { swapWorkoutId } from '../assigned-programs/schedule/swap-rules'
import {
  isForeignKeyViolation,
  SESSION_EXERCISES_PROGRAM_EXERCISE_FK,
} from '../database/pg-errors'

// --- SERVICE ------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// A session's local date must be the patient's TODAY. The server can't
// know which day that is (it doesn't know their time zone), but it knows
// the possible answers: every time zone's date is UTC's date, the day
// before, or the day after (UTC−12 to UTC+14). Anything else can't be "now"
// anywhere on Earth — a buggy client, or a session being filed under a
// day it didn't happen on. Exported for its unit tests; `now` pins the
// clock there.
//
// (Recording a session done on an EARLIER day — offline, say — would need
// its own rules; that belongs to the Phase 4 session flow.)
export function assertLocalDateIsToday(
  localDate: string,
  now: Date = new Date(),
) {
  if (!isPossibleToday(localDate, now)) {
    throw new BadRequestException(
      "localDate must be today's date in the patient's time zone",
    )
  }
}

// Which of the program's workouts a new session does (decisions §5,
// "Settled 2026-10-10": sessions record their workout). Exported for its
// unit tests — pure: the request's workoutId and the program's workouts in,
// a workout id (or an exception) out.
//   - Asked for: it must be one of THIS program's workouts. 400, not 404:
//     the program exists and was found; it's the request that names a
//     workout the program doesn't have.
//   - Not asked for, one workout: that one — a one-workout program works
//     exactly as before workouts existed.
//   - Not asked for, several: refused. Unlike adding an exercise (where
//     "the first workout" is a harmless default), a session done as the
//     wrong workout would be judged against the wrong day by the schedule —
//     guessing here would quietly corrupt the patient's adherence.
export function chooseSessionWorkout(
  requested: number | null | undefined,
  workouts: WorkoutRow[],
): number {
  // null counts as "not asked for" (the DTO's @IsOptional lets it through).
  if (requested != null) {
    if (!workouts.some((workout) => workout.id === requested)) {
      throw new BadRequestException(
        `Workout ${requested} is not part of this program`,
      )
    }
    return requested
  }
  if (workouts.length === 1) return workouts[0].id
  // A, B, … — one per workout (the labels depend only on how many there
  // are, so the workouts' order doesn't matter here).
  const labels = workouts.map((_, index) => workoutLabel(index))
  throw new BadRequestException(
    `This program has ${workouts.length} workouts (${labels.join(', ')}): say which one this session is (workoutId)`,
  )
}

// What a session's checklist row keeps of its program exercise: the name and
// the prescription (step 3b-0), and the description — muscles, equipment,
// instructions (2026-10-14, once a program's copy became editable per
// patient) — AS THEY ARE when the session starts. The program can change
// afterwards (a new prescription, a rewritten instruction, a removal) — this
// session's record of what it was given doesn't. A plain copy, field by
// field: the create test checks every field of the inserted row
// (toStrictEqual), so a field forgotten here fails it — and the four
// description columns have no default, so the database refuses a row
// without them too.
function exerciseSnapshot(programExercise: {
  name: string
  sets: number | null
  reps: number | null
  durationInSeconds: number | null
  weight: number | null
  weightUnit: 'kg' | 'lbs' | null
  notes: string | null
  primaryMuscles: string[]
  secondaryMuscles: string[]
  equipment: string[]
  instructions: string[]
}) {
  return {
    name: programExercise.name,
    sets: programExercise.sets,
    reps: programExercise.reps,
    durationInSeconds: programExercise.durationInSeconds,
    weight: programExercise.weight,
    weightUnit: programExercise.weightUnit,
    notes: programExercise.notes,
    primaryMuscles: programExercise.primaryMuscles,
    secondaryMuscles: programExercise.secondaryMuscles,
    equipment: programExercise.equipment,
    instructions: programExercise.instructions,
  }
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(currentUser: CurrentUser, dto: CreateSessionDto) {
    // assigned_programs has RLS (see AssignedProgramsService) — this is
    // the one other place in the app that reads it directly, so it needs
    // the same withRlsContext() scoping, or FORCE ROW LEVEL SECURITY makes
    // every row here invisible (no app.current_role/app.current_user_id
    // set on a plain connection), not just out-of-scope ones.
    const program = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedPrograms.findFirst({
        where: eq(assignedPrograms.id, dto.assignedProgramId),
      }),
    )
    if (!program) {
      throw new NotFoundException(
        `Assigned program ${dto.assignedProgramId} not found`,
      )
    }
    // Self only — no clinic-scoping here at all, unlike practitioner
    // management elsewhere. A patient can only ever start a session for
    // THEIR OWN assigned program.
    if (program.patientId !== currentUser.id) {
      throw new ForbiddenException(
        'You can only create sessions for your own assigned programs',
      )
    }
    // A completed, cancelled or archived program takes no new session
    // (409): it is closed, part of the record (step 2b-iii).
    assertProgramOpen(program)
    assertLocalDateIsToday(dto.localDate)

    // An exercise of the checklist DELETED by the practitioner while this
    // session was starting (read just before the delete committed): the
    // checklist row's foreign key refuses the insert, and the patient gets a
    // 409 — start again, with the program as it now is — instead of a 500.
    // (One RETIRED in that moment stays in this checklist: the session
    // started with it, and a retired exercise is exactly one kept for the
    // sessions that used it.)
    const sessionId = await withRlsContext(this.db, currentUser, async (tx) => {
      // The patient can read their own program's workouts (program_workouts'
      // SELECT policy follows the program's).
      const workouts = await tx.query.programWorkouts.findMany({
        where: eq(programWorkouts.assignedProgramId, dto.assignedProgramId),
      })
      // A session for another day (done early, or half of a swap): the
      // workout is the one scheduled on `countsFor`, after the rules in
      // swap-rules.ts (400 if any fails). They need the schedule on TWO days
      // — the counted day (its workout) and today (is it a scheduled day?)
      // — each judged by the version in force on it. So: every version
      // starting on or before the later of the two, then their days, and
      // the pure rules pick the version for each day (versionOn). Two
      // queries whatever the days. (The patient may read both tables: their
      // policies follow the program's.)
      let requested = dto.workoutId
      if (dto.countsFor != null) {
        const lastDay =
          dto.countsFor > dto.localDate ? dto.countsFor : dto.localDate
        const versionRows = await tx
          .select({
            id: programSchedules.id,
            type: programSchedules.type,
            effectiveFrom: programSchedules.effectiveFrom,
          })
          .from(programSchedules)
          .where(
            and(
              eq(programSchedules.assignedProgramId, dto.assignedProgramId),
              lte(programSchedules.effectiveFrom, lastDay),
            ),
          )
        const dayRows =
          versionRows.length > 0
            ? await tx
                .select({
                  scheduleId: programScheduleDays.scheduleId,
                  weekday: programScheduleDays.weekday,
                  workoutId: programScheduleDays.workoutId,
                })
                .from(programScheduleDays)
                .where(
                  inArray(
                    programScheduleDays.scheduleId,
                    versionRows.map((version) => version.id),
                  ),
                )
            : []
        requested = swapWorkoutId({
          program,
          versions: versionRows.map((version) => ({
            type: version.type,
            effectiveFrom: version.effectiveFrom,
            days: dayRows
              .filter((day) => day.scheduleId === version.id)
              .map(({ weekday, workoutId }) => ({ weekday, workoutId })),
          })),
          localDate: dto.localDate,
          countsFor: dto.countsFor,
          requestedWorkoutId: dto.workoutId,
        })
      }
      const workoutId = chooseSessionWorkout(requested, workouts)

      // Today's checklist: the ACTIVE exercises of THAT workout, in their
      // order — a retired one was taken out of the program (step 3b-0). Each
      // row points at its program exercise AND keeps a copy of its name,
      // prescription and description as they are now (exerciseSnapshot): the
      // program says what to do from now on, each session what it was given.
      // assigned_program_exercises, sessions, and session_exercises all
      // have RLS, so this whole insert running through withRlsContext isn't
      // just harmless, it's required — sessions_insert /
      // session_exercises_insert only pass WITH CHECK for the owning
      // patient, which currentUser genuinely is here (see the patientId
      // check above).
      const programExerciseRows =
        await tx.query.assignedProgramExercises.findMany({
          where: and(
            eq(
              assignedProgramExercises.assignedProgramId,
              dto.assignedProgramId,
            ),
            eq(assignedProgramExercises.workoutId, workoutId),
            isNull(assignedProgramExercises.retiredAt),
          ),
          orderBy: (row, { asc }) => [asc(row.sortOrder)],
        })
      // A session with an empty checklist would be "completed" with nothing
      // done in it. Assigning refuses a template with an empty workout, but
      // a program's workout can be emptied later by its practitioner.
      if (programExerciseRows.length === 0) {
        throw new BadRequestException(
          'This workout has no exercises yet: ask your practitioner',
        )
      }

      const [session] = await tx
        .insert(sessions)
        .values({
          assignedProgramId: dto.assignedProgramId,
          workoutId,
          patientId: currentUser.id,
          scheduledDate: dto.scheduledDate
            ? new Date(dto.scheduledDate)
            : new Date(),
          localDate: dto.localDate,
          countsFor: dto.countsFor ?? null,
          status: 'pending',
        })
        .returning()

      for (const pe of programExerciseRows) {
        await tx.insert(sessionExercises).values({
          sessionId: session.id,
          assignedProgramExerciseId: pe.id,
          ...exerciseSnapshot(pe),
          completed: false,
          sortOrder: pe.sortOrder,
        })
      }

      return session.id
    }).catch((error: unknown) => {
      if (isForeignKeyViolation(error, SESSION_EXERCISES_PROGRAM_EXERCISE_FK)) {
        throw new ConflictException(
          'Your program was just changed: start the session again',
        )
      }
      throw error
    })

    // Deliberately its own, separate RLS-scoped transaction — by the time
    // this runs, the transaction above has committed, so the newly
    // inserted rows are safely visible.
    return this.findSessionWithExercises(sessionId, currentUser)
  }

  // --- GET ROUTES ---

  async findAllForCurrentUser(currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) {
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.sessions.findMany(),
      )
    }
    if (currentUser.activeRole === UserRole.PATIENT) {
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.sessions.findMany({
          where: eq(sessions.patientId, currentUser.id),
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
      tx.query.sessions.findMany({
        where: inArray(sessions.patientId, patientIds),
      }),
    )
  }

  async findOne(id: number, currentUser: CurrentUser) {
    const session = await this.findSessionOrThrow(id, currentUser)
    await this.assertCanView(session.patientId, currentUser)
    return this.findSessionWithExercises(id, currentUser)
  }

  // --- PATCH ROUTES ---

  // Server sets startedAt/completedAt itself, based on the status
  // transition — never trusts a client-supplied timestamp for either,
  // matching the same "timestamps are authoritative, server-set" rule
  // applied to created_at/sent_at everywhere else in this schema.
  async update(id: number, currentUser: CurrentUser, dto: UpdateSessionDto) {
    const session = await this.findSessionOrThrow(id, currentUser)
    this.assertIsOwner(session, currentUser)

    const updates: Record<string, unknown> = { ...dto }
    if (dto.status === SessionStatus.IN_PROGRESS && !session.startedAt) {
      updates.startedAt = new Date()
    }
    if (dto.status === SessionStatus.COMPLETED) {
      updates.completedAt = new Date()
    }

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx.update(sessions).set(updates).where(eq(sessions.id, id)).returning(),
    )
    return updated
  }

  async updateExercise(
    sessionId: number,
    rowId: number,
    currentUser: CurrentUser,
    dto: UpdateSessionExerciseDto,
  ) {
    const session = await this.findSessionOrThrow(sessionId, currentUser)
    this.assertIsOwner(session, currentUser)
    await this.findSessionExerciseOrThrow(sessionId, rowId, currentUser)

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(sessionExercises)
        .set(dto)
        .where(eq(sessionExercises.id, rowId))
        .returning(),
    )
    return updated
  }

  // === HELPER FUNCTIONS =====================================================

  private async findSessionWithExercises(id: number, currentUser: CurrentUser) {
    const session = await this.findSessionOrThrow(id, currentUser)
    const exerciseRows = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.sessionExercises.findMany({
        where: eq(sessionExercises.sessionId, id),
        orderBy: (row, { asc }) => [asc(row.sortOrder)],
      }),
    )
    return { ...session, exercises: exerciseRows }
  }

  private async findSessionOrThrow(id: number, currentUser: CurrentUser) {
    const session = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.sessions.findFirst({
        where: eq(sessions.id, id),
      }),
    )
    // Covers both "genuinely does not exist" and "exists, but RLS made it
    // invisible to this session" — assertCanView/assertIsOwner never run on
    // a session this query didn't return, so an out-of-scope row reads as
    // 404, not 403. See assertCanView/assertIsOwner below for the one
    // deliberate exception (a managing practitioner/admin IS visible via
    // RLS, so the 403 on write there is a real app-layer decision, not RLS
    // filtering).
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`)
    }
    return session
  }

  private async findSessionExerciseOrThrow(
    sessionId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const row = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.sessionExercises.findFirst({
        where: and(
          eq(sessionExercises.id, rowId),
          eq(sessionExercises.sessionId, sessionId),
        ),
      }),
    )
    if (!row) {
      throw new NotFoundException(`Exercise ${rowId} not found in this session`)
    }
    return row
  }

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
      'You do not have permission to view this session',
    )
  }

  // No practitioner/admin branch at all — sessions are patient-only to
  // modify, full stop. Practitioners and admins get read access via
  // assertCanView, never write access via this check.
  private assertIsOwner(
    session: typeof sessions.$inferSelect,
    currentUser: CurrentUser,
  ) {
    if (
      currentUser.activeRole !== UserRole.PATIENT ||
      session.patientId !== currentUser.id
    ) {
      throw new ForbiddenException('You can only modify your own sessions')
    }
  }
}