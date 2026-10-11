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
  sessions,
  sessionExercises,
  assignedPrograms,
  assignedProgramExercises,
  programWorkouts,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateSessionDto } from './dto/create-session.dto'
import { UpdateSessionDto, SessionStatus } from './dto/update-session.dto'
import { UpdateSessionExerciseDto } from './dto/update-session-exercise.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import { isPossibleToday } from '../common/calendar-date'
import { workoutLabel, type WorkoutRow } from '../common/workout-rules'

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
    assertLocalDateIsToday(dto.localDate)

    const sessionId = await withRlsContext(this.db, currentUser, async (tx) => {
      // The patient can read their own program's workouts (program_workouts'
      // SELECT policy follows the program's).
      const workouts = await tx.query.programWorkouts.findMany({
        where: eq(programWorkouts.assignedProgramId, dto.assignedProgramId),
      })
      const workoutId = chooseSessionWorkout(dto.workoutId, workouts)

      // Today's checklist: the exercises of THAT workout, in their order.
      // Each row REFERENCES its assignedProgramExerciseId, it doesn't
      // duplicate sets/reps. The prescription lives on the assigned
      // program; the session just tracks actual performance against it.
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
          status: 'pending',
        })
        .returning()

      for (const pe of programExerciseRows) {
        await tx.insert(sessionExercises).values({
          sessionId: session.id,
          assignedProgramExerciseId: pe.id,
          completed: false,
          sortOrder: pe.sortOrder,
        })
      }

      return session.id
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