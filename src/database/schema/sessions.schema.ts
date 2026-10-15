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
  varchar,
  real,
  smallint,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { weightUnitEnum } from './weight-unit.schema'
import {
  assignedPrograms,
  assignedProgramExercises,
  programWorkouts,
} from './programs.schema'

// How a session stands (Phase 4 step 1, decided 2026-10-15). A row exists
// only once the patient acts — starting or skipping — so there is no
// "pending": what hasn't been done yet is worked out from the schedule
// (the summary's due / upcoming days), never stored.
//   - in_progress: started, still open. The only status that can change.
//   - completed:   finished. Counts for the schedule. Final.
//   - incomplete:  started, never finished — stopped by the patient, or
//                  closed by the app (a newer session started, or the
//                  program closed). Doesn't count. Final.
//   - skipped:     never started — the patient said "not today", with a
//                  reason. Doesn't count. Final.
// What may follow what is the service's table (session-rules.ts) AND the
// database's trigger (migration 0038).
export const sessionStatusEnum = pgEnum('session_status', [
  'in_progress',
  'completed',
  'incomplete',
  'skipped',
])

// Why a session ended without being completed. The first four are the
// PATIENT's to choose (stopping or skipping); the last two are written only
// by the app itself — a new session closing an old unfinished one, a program
// closing its open one — and are refused from any client (the DTOs' enum
// AND, for a skip, the CHECK below). A category, not only free text, so the
// practitioner's alerts can later find "stopped for pain".
export const PATIENT_END_REASONS = [
  'pain',
  'illness',
  'no_time',
  'other',
] as const
export type PatientEndReason = (typeof PATIENT_END_REASONS)[number]
export const sessionEndReasonEnum = pgEnum('session_end_reason', [
  ...PATIENT_END_REASONS,
  'not_finished_in_time',
  'program_closed',
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
    // The three moments, all written by the server with the DATABASE's clock
    // (`now()`), never sent by a client: when it started (NULL for a skip —
    // nothing started), when it was completed, when it ended otherwise
    // (stopped, closed by the app, or skipped). Which ones a row has follows
    // from its status — the `sessions_status_moments` CHECK below.
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    totalDurationInSeconds: integer('total_duration_in_seconds'),
    // No default (changed 2026-10-15; it was 'pending'): every insert says
    // what it writes — starting writes 'in_progress', skipping 'skipped'.
    status: sessionStatusEnum('status').notNull(),
    sessionFeedback: text('session_feedback'),
    // Why it ended without being completed (incomplete or skipped only), and
    // the patient's optional words about it.
    endReason: sessionEndReasonEnum('end_reason'),
    endNote: varchar('end_note', { length: 500 }),
    // Pain and mobility (decisions §6): all optional, never blocking.
    //   - pain_before: the pain check-in when starting (0 = no pain, the
    //     clinical Numeric Rating Scale) — or, for a skip whose reason is
    //     pain, the pain that made the patient skip (decided 2026-10-15);
    //   - pain_after, mobility_after: the check-out — when completing, or
    //     when stopping (someone stopping for pain is exactly the case where
    //     they matter). Mobility is self-assessed, 10 = moving freely.
    // smallint: 0–10 needs 2 bytes, not integer's 4.
    painBefore: smallint('pain_before'),
    painAfter: smallint('pain_after'),
    mobilityAfter: smallint('mobility_after'),
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
    // --- The shape of a row follows its status (2026-10-15) ----------------
    // Each rule is its own CHECK, so a refusal names WHICH rule failed.
    //
    // Which moments a status has: started (all but a skip), completed (only
    // completed), ended (incomplete and skipped).
    statusMoments: check(
      'sessions_status_moments',
      sql`CASE ${table.status}
        WHEN 'in_progress' THEN ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.endedAt} IS NULL
        WHEN 'completed' THEN ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.endedAt} IS NULL
        WHEN 'incomplete' THEN ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.endedAt} IS NOT NULL
        WHEN 'skipped' THEN ${table.startedAt} IS NULL AND ${table.completedAt} IS NULL AND ${table.endedAt} IS NOT NULL
      END`,
    ),
    // A reason exactly when the session ended without being completed; a
    // skip's reason is always the patient's own (the app never skips).
    endReasonMatchesStatus: check(
      'sessions_end_reason_matches_status',
      sql`(${table.endReason} IS NOT NULL) = (${table.status} IN ('incomplete', 'skipped'))
        AND (${table.status} <> 'skipped' OR ${table.endReason} IN ('pain', 'illness', 'no_time', 'other'))`,
    ),
    // A note explains a reason: none without one.
    endNoteNeedsReason: check(
      'sessions_end_note_needs_reason',
      sql`${table.endNote} IS NULL OR ${table.endReason} IS NOT NULL`,
    ),
    // The check-out (pain after, mobility) belongs to a session that was
    // done, completely or in part — never to one still open or skipped.
    checkOutWhenEnded: check(
      'sessions_check_out_when_ended',
      sql`(${table.painAfter} IS NULL AND ${table.mobilityAfter} IS NULL)
        OR ${table.status} IN ('completed', 'incomplete')`,
    ),
    // A skip did nothing: no duration, no feedback — and a pain level only
    // when pain was the reason for skipping.
    skipRecordsNoWork: check(
      'sessions_skip_records_no_work',
      sql`${table.status} <> 'skipped' OR (
        ${table.totalDurationInSeconds} IS NULL
        AND ${table.sessionFeedback} IS NULL
        AND (${table.painBefore} IS NULL OR ${table.endReason} = 'pain')
      )`,
    ),
    painBeforeRange: check(
      'sessions_pain_before_range',
      sql`${table.painBefore} IS NULL OR ${table.painBefore} BETWEEN 0 AND 10`,
    ),
    painAfterRange: check(
      'sessions_pain_after_range',
      sql`${table.painAfter} IS NULL OR ${table.painAfter} BETWEEN 0 AND 10`,
    ),
    mobilityAfterRange: check(
      'sessions_mobility_after_range',
      sql`${table.mobilityAfter} IS NULL OR ${table.mobilityAfter} BETWEEN 0 AND 10`,
    ),
    // --- At most one at a time (2026-10-15) --------------------------------
    // ONE open session per program: starting a new one closes the older one
    // first (in the same transaction), and a second start racing the first
    // fails here with 23505 instead of leaving two open — a guarantee no
    // "check, then insert" in the service could give.
    oneOpenPerProgram: uniqueIndex('sessions_one_open_per_program')
      .on(table.assignedProgramId)
      .where(sql`${table.status} = 'in_progress'`),
    // ONE skip per program per day: a double tap on "Skip today" records
    // one decision, not two.
    oneSkipPerDay: uniqueIndex('sessions_one_skip_per_day')
      .on(table.assignedProgramId, table.localDate)
      .where(sql`${table.status} = 'skipped'`),
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
    // Which exercise of the program this checklist row is. RESTRICT (the
    // foreign key below): a program exercise a session used can't be
    // deleted — removing it RETIRES it instead (step 3b-0).
    assignedProgramExerciseId: integer(
      'assigned_program_exercise_id',
    ).notNull(),
    // --- What was PRESCRIBED, as it was when the session started -----------
    // A COPY of the program exercise's name and prescription (step 3b-0,
    // decided 2026-10-13) — the same "copy, not reference" rule as a program
    // copying its template. Before this, the row only pointed at the program
    // exercise: changing 3×10 to 4×8 after two weeks made every earlier
    // session say 4×8. The program says what to do NOW; each session keeps
    // what it was given. Written by SessionsService.create; fixed afterwards
    // (migration 0033's trigger refuses changing them). `name` is NOT NULL
    // like the program's; the prescription fields are as optional as there.
    name: varchar('name', { length: 255 }).notNull(),
    sets: integer('sets'),
    reps: integer('reps'),
    durationInSeconds: integer('duration_in_seconds'),
    weight: real('weight'),
    weightUnit: weightUnitEnum('weight_unit'),
    notes: text('notes'),
    // ... and its DESCRIPTION (added 2026-10-14, migration 0034), once a
    // program's copy of it became editable per patient: a practitioner who
    // rewrites a step for one patient ("stop at 90°") changes what LATER
    // sessions are told, never what an earlier session was told. All four
    // NOT NULL like the program's columns — but with NO default, unlike
    // there: every row is written by SessionsService.create (or the seed's
    // copy), so a copy forgotten in some future insert must FAIL, not
    // silently record "no instructions". Guarded by the same trigger as the
    // prescription (0034 re-creates it with these columns).
    primaryMuscles: text('primary_muscles').array().notNull(),
    secondaryMuscles: text('secondary_muscles').array().notNull(),
    equipment: text('equipment').array().notNull(),
    instructions: text('instructions').array().notNull(),
    // --- What the patient DID -----------------------------------------------
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
    // Named explicitly (step 3b-0). Drizzle's generated name,
    // "session_exercises_assigned_program_exercise_id_assigned_program_exercises_id_fk",
    // is longer than Postgres's 63-character limit for identifiers, so
    // Postgres silently CUT it ("…_assigned_program"): the code that needs to
    // recognise this constraint's refusal (removing a used exercise) would
    // have had to spell a truncated name. A short name says what it is.
    programExerciseFk: foreignKey({
      name: 'session_exercises_program_exercise_fk',
      columns: [table.assignedProgramExerciseId],
      foreignColumns: [assignedProgramExercises.id],
    }).onDelete('restrict'),
    // Deleting a program exercise makes Postgres check this foreign key —
    // "does any session_exercises row still point at it?". Without an index
    // on the referencing column that check reads the WHOLE table, on every
    // removal. (Postgres indexes the referenced side — a primary key —
    // automatically, never the referencing side.)
    programExerciseIdx: index('session_exercises_program_exercise_id_idx').on(
      table.assignedProgramExerciseId,
    ),
  }),
)