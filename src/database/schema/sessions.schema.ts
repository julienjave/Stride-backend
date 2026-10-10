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
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { assignedPrograms, assignedProgramExercises } from './programs.schema'

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