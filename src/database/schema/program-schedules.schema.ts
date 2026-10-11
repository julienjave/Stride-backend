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
  pgEnum,
  serial,
  integer,
  smallint,
  date,
  timestamp,
  check,
  unique,
  primaryKey,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { assignedPrograms, programWorkouts } from './programs.schema'

// The kinds of schedule (design decisions §5):
//   - 'weekdays'       → specific days of the week, each with the workout it
//                        uses (e.g. Mon A, Wed B, Fri A) — program_schedule_days;
//   - 'times_per_week' → N sessions per program week, on any days, following
//                        a rotation of workouts (A, B, C, A…) —
//                        program_schedule_rotation;
//   - 'paused'         → nothing is due ("paused from D"; a later version
//                        resumes). Replaces the old `on_hold` status, which
//                        couldn't say since when (decided 2026-10-10).
export const scheduleTypeEnum = pgEnum('schedule_type', [
  'weekdays',
  'times_per_week',
  'paused',
])

// An assigned program's schedule, as a HISTORY of versions (decisions §5,
// point 5). Each row says "from effective_from on, the schedule is …". To
// judge any day, take the latest version whose effective_from is on or
// before that day — so changing Mon/Wed/Fri to Tue/Thu today never turns
// last week's Mondays into misses. The first version starts on the
// program's start date, and stays there: the start date can only move
// before the program starts, and then the schedule moves with it
// (start-date-move.ts) — so every day of a program has a version.
//
// History is protected by the database itself, not just by the API: the
// table has no UPDATE policy at all, its DELETE policy only reaches
// versions starting yesterday or later (UTC), and its INSERT policy refuses
// a version starting earlier than that — except the first one, on the
// program's start date. See migration 0025 (program_schedules_rls) for why
// "yesterday", not "today".
//
// What each version says beyond its type lives in two child tables (step
// 2b-ii): which workout each weekday uses, and the rotation. A version is
// written ONCE, with its children, in one transaction — never edited
// afterwards (see the children's INSERT policy, migration 0029).
//
// Not expressible in Drizzle, so added by custom migrations: the row-level
// security policies (0025 for this table, 0029 for its children).
export const programSchedules = pgTable(
  'program_schedules',
  {
    id: serial('id').primaryKey(),
    // 'cascade', like assigned_program_exercises: a schedule is part of its
    // program. (Programs are archived, never deleted, by the app — this only
    // matters for the dev seed's --reset.)
    assignedProgramId: integer('assigned_program_id')
      .notNull()
      .references(() => assignedPrograms.id, { onDelete: 'cascade' }),
    type: scheduleTypeEnum('type').notNull(),
    // Only for 'times_per_week' (CHECK below).
    timesPerWeek: smallint('times_per_week'),
    // A calendar DATE, not a moment: "from Monday 12 October" is a day in
    // the patient's life, the same kind of value as start_date/end_date.
    effectiveFrom: date('effective_from').notNull(),
    // Who set this version ("changed by Sam on …"). 'restrict': users are
    // deactivated, never deleted.
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // "A count exactly when the type is 'times_per_week'": both sides of `=`
    // are booleans, so the row passes only when they agree — a count with
    // that type, no count with any other. Written without naming the other
    // types on purpose: 'paused' is added to the enum by the same migration,
    // and Postgres refuses to USE an enum value in the transaction that
    // added it.
    fieldsMatchType: check(
      'program_schedules_fields_match_type',
      sql`(${table.type} = 'times_per_week') = (${table.timesPerWeek} IS NOT NULL)`,
    ),
    // 1–7 sessions per week (7 = every day).
    timesPerWeekRange: check(
      'program_schedules_times_per_week_range',
      sql`${table.timesPerWeek} IS NULL OR ${table.timesPerWeek} BETWEEN 1 AND 7`,
    ),
    // One version per program per day: two versions starting the same day
    // would leave "which one applies?" without an answer. Its index also
    // serves "this program's versions, in date order".
    oneVersionPerDay: unique(
      'program_schedules_program_effective_from_unique',
    ).on(table.assignedProgramId, table.effectiveFrom),
    // The target of the children's composite foreign keys (id is unique on
    // its own; a foreign key needs a constraint covering its columns
    // EXACTLY). With `type` in it, a child row can state — and the database
    // check — which kind of version it belongs to.
    idProgramTypeUnique: unique('program_schedules_id_program_type_unique').on(
      table.id,
      table.assignedProgramId,
      table.type,
    ),
  }),
)

// The days of a 'weekdays' version, each with the workout it uses: Monday A,
// Wednesday B, Friday A. One row per day (primary key: version + weekday),
// so a day can't appear twice. ISO weekdays: 1 = Monday … 7 = Sunday
// (Postgres's `isodow`) — the set used to be a sorted array guarded by a
// function (`is_iso_weekday_set`, dropped by 0028); as rows, the primary key
// and a range CHECK say the same thing with plain constraints.
//
// Two composite foreign keys, each a rule of the database:
//   - (schedule_id, assigned_program_id, schedule_type) → the version: the
//     row belongs to THAT version of THAT program, and — with the CHECK on
//     schedule_type — only a 'weekdays' version can have days;
//   - (workout_id, assigned_program_id) → program_workouts: a workout of the
//     SAME program (a NO ACTION key: a workout a schedule uses — even an old
//     version — can't be deleted; it's part of the program's history).
// assigned_program_id is repeated here (it's on the version too) because a
// foreign key can only compare columns of the row itself: both keys need it.
//
// "A 'weekdays' version has at least one day" spans two tables, which no
// constraint can express: the service writes a version and its days in one
// transaction, and refuses an empty list.
export const programScheduleDays = pgTable(
  'program_schedule_days',
  {
    scheduleId: integer('schedule_id').notNull(),
    assignedProgramId: integer('assigned_program_id').notNull(),
    scheduleType: scheduleTypeEnum('schedule_type')
      .notNull()
      .default('weekdays'),
    weekday: smallint('weekday').notNull(),
    workoutId: integer('workout_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'program_schedule_days_pk',
      columns: [table.scheduleId, table.weekday],
    }),
    weekdayRange: check(
      'program_schedule_days_weekday_range',
      sql`${table.weekday} BETWEEN 1 AND 7`,
    ),
    onlyForWeekdays: check(
      'program_schedule_days_only_weekdays',
      sql`${table.scheduleType} = 'weekdays'`,
    ),
    // 'cascade': replacing a version ("from D on") deletes it, and its days
    // go with it — they mean nothing without it.
    versionFk: foreignKey({
      name: 'program_schedule_days_version_fk',
      columns: [table.scheduleId, table.assignedProgramId, table.scheduleType],
      foreignColumns: [
        programSchedules.id,
        programSchedules.assignedProgramId,
        programSchedules.type,
      ],
    }).onDelete('cascade'),
    workoutFk: foreignKey({
      name: 'program_schedule_days_workout_fk',
      columns: [table.workoutId, table.assignedProgramId],
      foreignColumns: [programWorkouts.id, programWorkouts.assignedProgramId],
    }),
    // "Does any schedule use this workout?" — asked before deleting one.
    workoutIdx: index('program_schedule_days_workout_id_idx').on(
      table.workoutId,
    ),
  }),
)

// The rotation of a 'times_per_week' version: the workouts in the order the
// patient goes through them — A, B, C, then A again. Position 0 is the first.
// Each program week needs the NEXT N positions, counted from the version's
// start (decisions §5, "Settled 2026-10-11", point 2) — by plan, not by what
// was done. The same keys as the days, for the same reasons.
export const programScheduleRotation = pgTable(
  'program_schedule_rotation',
  {
    scheduleId: integer('schedule_id').notNull(),
    assignedProgramId: integer('assigned_program_id').notNull(),
    scheduleType: scheduleTypeEnum('schedule_type')
      .notNull()
      .default('times_per_week'),
    position: smallint('position').notNull(),
    workoutId: integer('workout_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'program_schedule_rotation_pk',
      columns: [table.scheduleId, table.position],
    }),
    positionRange: check(
      'program_schedule_rotation_position_range',
      sql`${table.position} >= 0`,
    ),
    onlyForTimesPerWeek: check(
      'program_schedule_rotation_only_times_per_week',
      sql`${table.scheduleType} = 'times_per_week'`,
    ),
    versionFk: foreignKey({
      name: 'program_schedule_rotation_version_fk',
      columns: [table.scheduleId, table.assignedProgramId, table.scheduleType],
      foreignColumns: [
        programSchedules.id,
        programSchedules.assignedProgramId,
        programSchedules.type,
      ],
    }).onDelete('cascade'),
    workoutFk: foreignKey({
      name: 'program_schedule_rotation_workout_fk',
      columns: [table.workoutId, table.assignedProgramId],
      foreignColumns: [programWorkouts.id, programWorkouts.assignedProgramId],
    }),
    workoutIdx: index('program_schedule_rotation_workout_id_idx').on(
      table.workoutId,
    ),
  }),
)