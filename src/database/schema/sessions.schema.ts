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

import {
  pgTable,
  bigserial,
  bigint,
  integer,
  timestamp,
  date,
  boolean,
  text,
  pgEnum,
  check,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import {
  assignedPrograms,
  assignedProgramExercises,
  programWorkouts,
} from './programs.schema'

export const sessionStatusEnum = pgEnum('session_status', [
  'pending',
  'in_progress',
  'completed',
  'skipped',
])

export const sessions = pgTable(
  'sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    assignedProgramId: integer('assigned_program_id')
      .notNull()
      .references(() => assignedPrograms.id, { onDelete: 'restrict' }),
    // Which of the program's workouts this session did (decisions §5,
    // "Settled 2026-10-10"): the schedule asks "was Monday's upper body
    // done?", not just "was something done on Monday?". The session's
    // checklist is that workout's exercises. A workout of THIS program —
    // composite foreign key below.
    workoutId: integer('workout_id').notNull(),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scheduledDate: timestamp('scheduled_date', {
      withTimezone: true,
    }).notNull(),
    // The PATIENT'S calendar day for this session, sent by their app
    // (decisions §5, point 4). "Was Monday's session done?" is a question
    // about the patient's day, and a moment alone can't answer it: 11 pm on
    // Monday in Montreal is already Tuesday in UTC. The server can't work
    // the day out either — it doesn't know the patient's time zone. So the
    // app, which does, sends the day itself. The schedule module matches
    // sessions to scheduled days on THIS column, never on scheduled_date.
    localDate: date('local_date').notNull(),
    // A SWAP (step 2b-iii): "this session fulfils the workout scheduled on
    // that day" — Wednesday's lower body done on Monday says counts_for =
    // that Wednesday. NULL = the usual rules (the session counts for its
    // own day, or makes up a missed one). Set only when the session starts;
    // the service checks what can be checked then (a scheduled day of the
    // same program week, its workout), and the schedule module judges the
    // rest (was that day already done by then?).
    countsFor: date('counts_for'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    totalDurationInSeconds: integer('total_duration_in_seconds'),
    status: sessionStatusEnum('status').notNull().default('pending'),
    sessionFeedback: text('session_feedback'),
  },
  (table) => ({
    patientIdIdx: index('sessions_patient_id_idx').on(table.patientId),
    // "This program's sessions between two days" — the question every
    // schedule summary asks (done / made up / missed over a date range).
    // Column order matters: equality on the program first, then a RANGE on
    // the day, which a B-tree index answers by reading one contiguous slice.
    programLocalDateIdx: index(
      'sessions_assigned_program_id_local_date_idx',
    ).on(table.assignedProgramId, table.localDate),
    // (workout_id, assigned_program_id) must be one of the program's own
    // workouts — the same composite-key idea as the exercise tables. NO
    // ACTION on delete: a workout with sessions is history and can't be
    // deleted (the service refuses first, with a clear message).
    //
    // No index of its own on workout_id: the only query that needs one is
    // the check Postgres runs when a workout is deleted ("does any session
    // use it?") — rare, and it filters on assigned_program_id too, which the
    // index above already serves.
    workoutFk: foreignKey({
      name: 'sessions_workout_fk',
      columns: [table.workoutId, table.assignedProgramId],
      foreignColumns: [programWorkouts.id, programWorkouts.assignedProgramId],
    }),
    // A swap is with ANOTHER day: a session already counts for its own.
    countsForOtherDay: check(
      'sessions_counts_for_other_day',
      sql`${table.countsFor} IS NULL OR ${table.countsFor} <> ${table.localDate}`,
    ),
  }),
)

export const sessionExercises = pgTable(
  'session_exercises',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // sessions.id is bigserial (a bigint) — the column referencing it must match that
    // width, so this is bigint too, not integer. Getting this mismatched is a real,
    // easy-to-miss bug: Postgres will still accept it, but we risk overflow the moment
    // sessions.id exceeds the range a plain integer can hold.
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    assignedProgramExerciseId: integer('assigned_program_exercise_id')
      .notNull()
      .references(() => assignedProgramExercises.id, { onDelete: 'restrict' }),
    completed: boolean('completed').notNull().default(false),
    durationActualInSeconds: integer('duration_actual_in_seconds'),
    difficultyRating: integer('difficulty_rating'),
    sortOrder: integer('sort_order').notNull(),
    feedback: text('feedback'),
  },
  (table) => ({
    difficultyRatingRange: check(
      'difficulty_rating_range',
      sql`${table.difficultyRating} IS NULL OR ${table.difficultyRating} BETWEEN 1 AND 10`,
    ),
    sessionIdIdx: index('session_exercises_session_id_idx').on(table.sessionId),
  }),
)