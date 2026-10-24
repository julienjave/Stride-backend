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
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  sessions,
  sessionExercises,
  assignedPrograms,
  assignedProgramExercises,
  programWorkouts,
  programSchedules,
  programScheduleDays,
  sessionReviews,
  users,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { CreateSessionDto } from './dto/create-session.dto'
import { SkipSessionDto } from './dto/skip-session.dto'
import { CompleteSessionDto } from './dto/complete-session.dto'
import { StopSessionDto } from './dto/stop-session.dto'
import { UpdateSessionDto } from './dto/update-session.dto'
import { UpdateSessionExerciseDto } from './dto/update-session-exercise.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import { isPossibleToday } from '../common/calendar-date'
import { changedFields } from '../common/changed-fields'
import { workoutLabel, type WorkoutRow } from '../common/workout-rules'
import { assertProgramOpen } from '../assigned-programs/program-state'
import {
  sessionForOtherDay,
  type SwapVersion,
} from '../assigned-programs/schedule/swap-rules'
import {
  assertCompletableOnItsDay,
  assertDurationPossible,
  assertLateMakeUpAllowed,
  assertSessionOpen,
  assertSkipPain,
  DAY_HAS_SESSION_MESSAGE,
  ONE_SESSION_A_DAY_MESSAGE,
  SESSION_OPEN_TODAY_MESSAGE,
  skippedWorkoutId,
} from './session-rules'
import { summarizeProgram } from '../assigned-programs/program-summary'
import {
  isForeignKeyViolation,
  isUniqueViolation,
  SESSION_EXERCISES_PROGRAM_EXERCISE_FK,
  SESSIONS_ONE_OPEN_PER_PROGRAM,
  SESSIONS_ONE_SKIP_PER_DAY,
} from '../database/pg-errors'
import { resultsForAudit, sessionForAudit } from './session-audit'

// --- SERVICE ------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }
type SessionRow = typeof sessions.$inferSelect

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
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // START a session (POST /sessions): it is created OPEN — in_progress, its
  // start written by the database's clock — with the pain check-in if given,
  // and its checklist. (No 'pending' any more: a row exists only once the
  // patient starts, so "created" and "started" are the same moment —
  // decided 2026-10-15.)
  async create(currentUser: CurrentUser, dto: CreateSessionDto) {
    // assigned_programs has RLS (see AssignedProgramsService) — this is
    // the one other place in the app that reads it directly, so it needs
    // the same withRlsContext() scoping, or FORCE ROW LEVEL SECURITY makes
    // every row here invisible (no app.current_role/app.current_user_id
    // set on a plain connection), not just out-of-scope ones.
    const program = await this.findOwnOpenProgram(
      currentUser,
      dto.assignedProgramId,
    )
    assertLocalDateIsToday(dto.localDate)

    // An exercise of the checklist DELETED by the practitioner while this
    // session was starting (read just before the delete committed): the
    // checklist row's foreign key refuses the insert, and the patient gets a
    // 409 — start again, with the program as it now is — instead of a 500.
    // (One RETIRED in that moment stays in this checklist: the session
    // started with it, and a retired exercise is exactly one kept for the
    // sessions that used it.)
    const sessionId = await withRlsContext(this.db, currentUser, async (tx) => {
      // ONE SESSION A DAY (decided 2026-10-16): a day that already has a
      // COMPLETED session of this program takes no other — not the same
      // workout again, not a swap half, not a make-up. Asked first: it
      // answers every start that day, whatever else the request says. (A
      // STOPPED session doesn't count: the day is still to do. An OPEN one
      // today is the unique index's 409, below.) The database says the same
      // (migration 0041's trigger), which also closes the race this read
      // can't: a completion committing between this read and the insert.
      const [completedToday] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.assignedProgramId, dto.assignedProgramId),
            eq(sessions.localDate, dto.localDate),
            eq(sessions.status, 'completed'),
          ),
        )
        .limit(1)
      if (completedToday) {
        throw new ConflictException(ONE_SESSION_A_DAY_MESSAGE)
      }

      // The patient can read their own program's workouts (program_workouts'
      // SELECT policy follows the program's).
      const workouts = await tx.query.programWorkouts.findMany({
        where: eq(programWorkouts.assignedProgramId, dto.assignedProgramId),
      })
      // A session for another day (a swap half, done early, a late make-up):
      // the workout is the one scheduled on `countsFor`, after the rules in
      // swap-rules.ts (400 if any fails). They need the schedule on TWO days
      // — the counted day (its workout) and today (is it a scheduled day?)
      // — each judged by the version in force on it: so every version
      // starting on or before the later of the two (readVersions).
      let requested = dto.workoutId
      if (dto.countsFor != null) {
        const lastDay =
          dto.countsFor > dto.localDate ? dto.countsFor : dto.localDate
        const other = sessionForOtherDay({
          program,
          versions: await this.readVersions(tx, dto.assignedProgramId, lastDay),
          localDate: dto.localDate,
          countsFor: dto.countsFor,
          requestedWorkoutId: dto.workoutId,
        })
        // A late make-up is judged on the program's SUMMARY for today — the
        // one the home and the start page read (summarizeProgram), so the
        // button and this answer can't disagree. In this transaction, as
        // the patient: their policies show them all of their program.
        if (other.kind === 'late_make_up') {
          assertLateMakeUpAllowed(
            await summarizeProgram(tx, program, dto.localDate),
            dto.countsFor,
            program.lateMakeUpDays,
          )
        }
        requested = other.workoutId
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
      // check in findOwnOpenProgram).
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

      // An unfinished session of this program from ANOTHER day is closed
      // first — it can no longer be completed (assertCompletableOnItsDay),
      // and one open session per program is the rule (the unique index). One
      // still open TODAY is not closed: the patient is told to finish or
      // stop it (the insert below fails on the index → 409).
      await this.closeUnfinished(tx, currentUser, dto.assignedProgramId, {
        except: dto.localDate,
      })

      // Its two moments — the row's creation (scheduled_date) and the start
      // — are the DATABASE's now(), never a client value (decided
      // 2026-10-15: scheduledDate left the DTO).
      const [session] = await tx
        .insert(sessions)
        .values({
          assignedProgramId: dto.assignedProgramId,
          workoutId,
          patientId: currentUser.id,
          scheduledDate: sql`now()`,
          localDate: dto.localDate,
          countsFor: dto.countsFor ?? null,
          status: 'in_progress',
          startedAt: sql`now()`,
          painBefore: dto.painBefore ?? null,
        })
        .returning()

      const checklist = programExerciseRows.map((pe) => ({
        sessionId: session.id,
        assignedProgramExerciseId: pe.id,
        ...exerciseSnapshot(pe),
        completed: false,
        sortOrder: pe.sortOrder,
      }))
      for (const row of checklist) {
        await tx.insert(sessionExercises).values(row)
      }

      // The whole start: what the session is, and what it was given — each
      // checklist row's program exercise and prescription (the description
      // is in the rows themselves, fixed by 0033; repeating every
      // instruction step here would make each entry long and add nothing).
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_STARTED',
        targetUserId: currentUser.id,
        entityType: 'sessions',
        entityId: session.id,
        details: {
          session: sessionForAudit(session),
          exercises: checklist.map((row) => ({
            assignedProgramExerciseId: row.assignedProgramExerciseId,
            name: row.name,
            sets: row.sets,
            reps: row.reps,
            durationInSeconds: row.durationInSeconds,
            weight: row.weight,
            weightUnit: row.weightUnit,
            notes: row.notes,
          })),
        },
      })

      return session.id
    }).catch((error: unknown) => {
      if (isForeignKeyViolation(error, SESSION_EXERCISES_PROGRAM_EXERCISE_FK)) {
        throw new ConflictException(
          'Your program was just changed: start the session again',
        )
      }
      // A session of this program still open today — found by the index,
      // which also catches two starts racing each other (both see nothing
      // open; the second insert fails).
      if (isUniqueViolation(error, SESSIONS_ONE_OPEN_PER_PROGRAM)) {
        throw new ConflictException(SESSION_OPEN_TODAY_MESSAGE)
      }
      throw error
    })

    // Deliberately its own, separate RLS-scoped transaction — by the time
    // this runs, the transaction above has committed, so the newly
    // inserted rows are safely visible.
    return this.findSessionWithExercises(sessionId, currentUser)
  }

  // SKIP today (POST /sessions/skip): a 'skipped' row — no start, no
  // checklist (nothing was done), the patient's reason, and a pain level
  // only when pain is that reason. Only a scheduled day of a specific-days
  // schedule can be skipped (skippedWorkoutId), and only a day with no
  // session yet: a skip says "nothing today", which is no longer true once
  // something was started, done or skipped.
  async skip(currentUser: CurrentUser, dto: SkipSessionDto) {
    const program = await this.findOwnOpenProgram(
      currentUser,
      dto.assignedProgramId,
    )
    assertLocalDateIsToday(dto.localDate)
    assertSkipPain(dto.reason, dto.painBefore)

    const sessionId = await withRlsContext(this.db, currentUser, async (tx) => {
      const workoutId = skippedWorkoutId({
        program,
        versions: await this.readVersions(
          tx,
          dto.assignedProgramId,
          dto.localDate,
        ),
        localDate: dto.localDate,
      })
      const [existing] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.assignedProgramId, dto.assignedProgramId),
            eq(sessions.localDate, dto.localDate),
          ),
        )
        .limit(1)
      if (existing) {
        throw new ConflictException(DAY_HAS_SESSION_MESSAGE)
      }
      const [session] = await tx
        .insert(sessions)
        .values({
          assignedProgramId: dto.assignedProgramId,
          workoutId,
          patientId: currentUser.id,
          scheduledDate: sql`now()`,
          localDate: dto.localDate,
          status: 'skipped',
          endedAt: sql`now()`,
          endReason: dto.reason,
          endNote: dto.note ?? null,
          painBefore: dto.painBefore ?? null,
        })
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_SKIPPED',
        targetUserId: currentUser.id,
        entityType: 'sessions',
        entityId: session.id,
        details: { session: sessionForAudit(session) },
      })
      return session.id
    }).catch((error: unknown) => {
      // Two skips of the same day racing: both found no session; the
      // second insert fails on the index (one skip per program per day).
      if (isUniqueViolation(error, SESSIONS_ONE_SKIP_PER_DAY)) {
        throw new ConflictException(DAY_HAS_SESSION_MESSAGE)
      }
      throw error
    })
    return this.findSessionWithExercises(sessionId, currentUser)
  }

  // FINISH (POST /sessions/:id/complete): completed, with the check-out.
  // Final from then on. Only on the session's own day.
  async complete(
    id: number,
    currentUser: CurrentUser,
    dto: CompleteSessionDto,
  ) {
    await this.findOwnSession(id, currentUser)
    await withRlsContext(this.db, currentUser, async (tx) => {
      const session = await this.lockSession(tx, id)
      assertSessionOpen(session)
      assertCompletableOnItsDay(session.localDate, session.now)
      // startedAt is never null on an open session (sessions_status_moments).
      assertDurationPossible(
        dto.totalDurationInSeconds,
        session.startedAt!,
        session.now,
      )
      const [completed] = await tx
        .update(sessions)
        .set({
          status: 'completed',
          completedAt: sql`now()`,
          painAfter: dto.painAfter ?? null,
          mobilityAfter: dto.mobilityAfter ?? null,
          totalDurationInSeconds: dto.totalDurationInSeconds ?? null,
          sessionFeedback: dto.sessionFeedback ?? null,
        })
        .where(eq(sessions.id, id))
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_COMPLETED',
        targetUserId: completed.patientId,
        entityType: 'sessions',
        entityId: id,
        details: {
          session: sessionForAudit(completed),
          exercises: resultsForAudit(await this.readChecklist(tx, id)),
        },
      })
    })
    return this.findSessionWithExercises(id, currentUser)
  }

  // STOP (POST /sessions/:id/stop): incomplete, with the patient's reason
  // and, optionally, how they feel. Final from then on. Any day: a stopped
  // session counts for nothing, so stopping one from an earlier day changes
  // no judged day.
  async stop(id: number, currentUser: CurrentUser, dto: StopSessionDto) {
    await this.findOwnSession(id, currentUser)
    await withRlsContext(this.db, currentUser, async (tx) => {
      const session = await this.lockSession(tx, id)
      assertSessionOpen(session)
      const [stopped] = await tx
        .update(sessions)
        .set({
          status: 'incomplete',
          endedAt: sql`now()`,
          endReason: dto.reason,
          endNote: dto.note ?? null,
          painAfter: dto.painAfter ?? null,
          mobilityAfter: dto.mobilityAfter ?? null,
        })
        .where(eq(sessions.id, id))
        .returning()
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_STOPPED',
        targetUserId: stopped.patientId,
        entityType: 'sessions',
        entityId: id,
        details: {
          session: sessionForAudit(stopped),
          exercises: resultsForAudit(await this.readChecklist(tx, id)),
        },
      })
    })
    return this.findSessionWithExercises(id, currentUser)
  }

  // --- GET ROUTES ---

  // One session with its checklist. For the care team, also its
  // REVIEWS (the To-do, 2026-10-19): who on the team has looked at it, and
  // when — oldest first. The patient's answer has no `reviews` key at all
  // (not an empty list, which would read as "nobody looked"): reviews are
  // the staff's workflow, and the row-level security agrees — the patient
  // has no branch in session_reviews' SELECT policy.
  async findOne(id: number, currentUser: CurrentUser) {
    const session = await this.findSessionOrThrow(id, currentUser)
    await this.assertCanView(session.patientId, currentUser)
    const withExercises = await this.findSessionWithExercises(id, currentUser)
    if (currentUser.activeRole === UserRole.PATIENT) return withExercises
    // AUDITED (the audit review, step 2): someone else read this session —
    // its pain scores, ratings and the patient's words. Written before the
    // answer; a refused read (404, 403) threw above and wrote nothing. Only
    // past the patient's return: a patient reads only their own sessions
    // (row security), and logReads drops a self-read anyway.
    await this.auditService.logReads([
      {
        performedBy: currentUser.id,
        action: 'SESSION_VIEWED',
        targetUserId: session.patientId,
        entityType: 'sessions',
        entityId: id,
      },
    ])
    const reviews = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .select({
          practitionerId: sessionReviews.practitionerId,
          firstName: users.firstName,
          lastName: users.lastName,
          reviewedAt: sessionReviews.reviewedAt,
        })
        .from(sessionReviews)
        .innerJoin(users, eq(users.id, sessionReviews.practitionerId))
        .where(eq(sessionReviews.sessionId, id))
        .orderBy(asc(sessionReviews.reviewedAt), asc(sessionReviews.id)),
    )
    return {
      ...withExercises,
      reviews: reviews.map((review) => ({
        practitioner: {
          id: review.practitionerId,
          firstName: review.firstName,
          lastName: review.lastName,
        },
        reviewedAt: review.reviewedAt,
      })),
    }
  }

  // --- PATCH ROUTES ---

  // What may change while a session is OPEN: the pain check-in (a number
  // given when starting, corrected). Only real changes are written and
  // audited — a request that changes nothing writes nothing (the
  // convention). Answers the whole session, like every session write.
  async update(id: number, currentUser: CurrentUser, dto: UpdateSessionDto) {
    await this.findOwnSession(id, currentUser)
    await withRlsContext(this.db, currentUser, async (tx) => {
      // The lock makes `from` exact: the value this UPDATE replaces, not one
      // a concurrent request is about to replace (the lesson of 3b-0).
      const session = await this.lockSession(tx, id)
      assertSessionOpen(session)
      const changes = changedFields(session, { painBefore: dto.painBefore })
      if (Object.keys(changes).length === 0) return
      await tx
        .update(sessions)
        .set({ painBefore: dto.painBefore })
        .where(eq(sessions.id, id))
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_UPDATED',
        targetUserId: session.patientId,
        entityType: 'sessions',
        entityId: id,
        details: { changes },
      })
    })
    return this.findSessionWithExercises(id, currentUser)
  }

  // A checklist row — ticked, timed, rated, commented — while its session is
  // OPEN (once finished, the checklist is as final as the session). Only
  // real changes are written and audited. Answers the whole session.
  async updateExercise(
    sessionId: number,
    rowId: number,
    currentUser: CurrentUser,
    dto: UpdateSessionExerciseDto,
  ) {
    const session = await this.findOwnSession(sessionId, currentUser)
    await this.findSessionExerciseOrThrow(sessionId, rowId, currentUser)
    // A friendly 409 before the transaction. Not the guarantee: a tick
    // racing a Finish can pass this check and still arrive after it — the
    // database's trigger (0038) catches that one (it waits for the
    // completion, then refuses), and the filter answers the same 409.
    assertSessionOpen(session)

    await withRlsContext(this.db, currentUser, async (tx) => {
      const [row] = await tx
        .select()
        .from(sessionExercises)
        .where(eq(sessionExercises.id, rowId))
        .for('update')
      const changes = changedFields(row, { ...dto })
      if (Object.keys(changes).length === 0) return
      await tx
        .update(sessionExercises)
        .set(dto)
        .where(eq(sessionExercises.id, rowId))
      // `name` beside the changes, so the entry reads on its own ("Squat:
      // completed false → true").
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_EXERCISE_UPDATED',
        targetUserId: session.patientId,
        entityType: 'sessions',
        entityId: sessionId,
        details: { exerciseRowId: rowId, name: row.name, changes },
      })
    })
    return this.findSessionWithExercises(sessionId, currentUser)
  }

  // === HELPER FUNCTIONS =====================================================

  // The program a patient starts or skips a session of: it exists (404),
  // it is THEIRS (403 — self only, no clinic-scoping here at all, unlike
  // practitioner management elsewhere: a patient can only ever act on their
  // OWN assigned program), and it is open (409 — a completed, cancelled or
  // archived program is closed, part of the record: step 2b-iii).
  private async findOwnOpenProgram(
    currentUser: CurrentUser,
    assignedProgramId: number,
  ) {
    const program = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedPrograms.findFirst({
        where: eq(assignedPrograms.id, assignedProgramId),
      }),
    )
    if (!program) {
      throw new NotFoundException(
        `Assigned program ${assignedProgramId} not found`,
      )
    }
    if (program.patientId !== currentUser.id) {
      throw new ForbiddenException(
        'You can only create sessions for your own assigned programs',
      )
    }
    assertProgramOpen(program)
    return program
  }

  // The program's schedule versions starting on or before `lastDay`, each
  // with its days — enough to know the version in force on any day up to
  // it (versionOn picks it). Two queries whatever the days. (The patient may
  // read both tables: their policies follow the program's.) Rotations aren't
  // read: no rule here needs them.
  private async readVersions(
    tx: DrizzleDb,
    assignedProgramId: number,
    lastDay: string,
  ): Promise<SwapVersion[]> {
    const versionRows = await tx
      .select({
        id: programSchedules.id,
        type: programSchedules.type,
        effectiveFrom: programSchedules.effectiveFrom,
      })
      .from(programSchedules)
      .where(
        and(
          eq(programSchedules.assignedProgramId, assignedProgramId),
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
    return versionRows.map((version) => ({
      type: version.type,
      effectiveFrom: version.effectiveFrom,
      days: dayRows
        .filter((day) => day.scheduleId === version.id)
        .map(({ weekday, workoutId }) => ({ weekday, workoutId })),
    }))
  }

  // Closes the program's open session — of another day than `except` — as
  // the app does (decided 2026-10-15): incomplete, 'not_finished_in_time',
  // ended now. It can no longer be completed (its day is over), so it is
  // closed at the next moment someone acts: the patient starting a new
  // session. That patient signs the entry — every audit entry names a real
  // user (audit_logs.performed_by is NOT NULL), which is why this happens
  // here rather than on a timer.
  //
  // One UPDATE … RETURNING, no read first: `status = 'in_progress'` in the
  // WHERE is re-checked after any lock wait, so a session finished by a
  // concurrent request is simply not matched (and not closed twice).
  private async closeUnfinished(
    tx: DrizzleDb,
    currentUser: CurrentUser,
    assignedProgramId: number,
    { except }: { except: string },
  ) {
    const closed = await tx
      .update(sessions)
      .set({
        status: 'incomplete',
        endedAt: sql`now()`,
        endReason: 'not_finished_in_time',
      })
      .where(
        and(
          eq(sessions.assignedProgramId, assignedProgramId),
          eq(sessions.status, 'in_progress'),
          ne(sessions.localDate, except),
        ),
      )
      .returning()
    for (const session of closed) {
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_STOPPED',
        targetUserId: session.patientId,
        entityType: 'sessions',
        entityId: session.id,
        details: {
          session: sessionForAudit(session),
          exercises: resultsForAudit(await this.readChecklist(tx, session.id)),
        },
      })
    }
  }

  // The session's row, LOCKED until the end of the transaction (SELECT …
  // FOR UPDATE), with the DATABASE's now() beside it. The lock makes each
  // write see the session as it really is when it changes it: two Finish
  // taps, or a Finish and a Stop, are taken one after the other, and the
  // second finds the session finished (409). Under row-level security FOR
  // UPDATE also asks the UPDATE policy — the session's patient, the only
  // one past findOwnSession. now() is read in the same transaction as the
  // write, so the rules (its own day, the duration) judge by the same clock
  // as the trigger and the stored moments.
  private async lockSession(tx: DrizzleDb, id: number) {
    const [session] = await tx
      .select({
        ...getTableColumns(sessions),
        now: sql<Date>`now()`.mapWith(sessions.completedAt),
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .for('update')
    return session
  }

  private readChecklist(tx: DrizzleDb, sessionId: number) {
    return tx.query.sessionExercises.findMany({
      where: eq(sessionExercises.sessionId, sessionId),
      orderBy: (row, { asc }) => [asc(row.sortOrder)],
    })
  }

  // The session, for a write: it exists and the caller may see it (404),
  // and it is the caller's own, as a patient (403).
  private async findOwnSession(id: number, currentUser: CurrentUser) {
    const session = await this.findSessionOrThrow(id, currentUser)
    this.assertIsOwner(session, currentUser)
    return session
  }

  private async findSessionWithExercises(id: number, currentUser: CurrentUser) {
    const session = await this.findSessionOrThrow(id, currentUser)
    const exerciseRows = await withRlsContext(this.db, currentUser, (tx) =>
      this.readChecklist(tx, id),
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
    // deliberate exception (a managing practitioner IS visible via
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

  // No admin branch (2026-10-23, decisions §16): the controller answers an
  // admin 403 before this runs, and the policies hide every session anyway.
  private async assertCanView(patientId: number, currentUser: CurrentUser) {
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

  // No practitioner branch at all — sessions are patient-only to
  // modify, full stop. Practitioners get read access via
  // assertCanView, never write access via this check.
  private assertIsOwner(session: SessionRow, currentUser: CurrentUser) {
    if (
      currentUser.activeRole !== UserRole.PATIENT ||
      session.patientId !== currentUser.id
    ) {
      throw new ForbiddenException('You can only modify your own sessions')
    }
  }
}
