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
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { assignedPrograms } from './programs.schema'

// The two kinds of schedule (design decisions §5):
//   - 'weekdays'       → specific days of the week (e.g. Mon/Wed/Fri);
//   - 'times_per_week' → N sessions per program week, on any days.
export const scheduleTypeEnum = pgEnum('schedule_type', [
  'weekdays',
  'times_per_week',
])

// An assigned program's schedule, as a HISTORY of versions (decisions §5,
// point 5). Each row says "from effective_from on, the schedule is …". To
// judge any day, take the latest version whose effective_from is on or
// before that day — so changing Mon/Wed/Fri to Tue/Thu today never turns
// last week's Mondays into misses. The FIRST version also covers any days
// before its own date (the program's start can be moved earlier after the
// fact); the schedule module (step 2) applies that rule.
//
// History is protected by the database itself, not just by the API: the
// table has no UPDATE policy at all, its DELETE policy only reaches
// versions starting yesterday or later (UTC), and its INSERT policy refuses
// a version starting earlier than that — except the first one, on the
// program's start date. See migration 0025 (program_schedules_rls) for why
// "yesterday", not "today".
//
// Weekdays use ISO numbering: 1 = Monday … 7 = Sunday (Postgres's `isodow`,
// date-fns's `getISODay`), stored as a sorted array without duplicates
// ({1,3,5} for Mon/Wed/Fri).
//
// Not expressible in Drizzle, so added by the custom migration 0025:
//   - the CHECK that `weekdays` is a valid weekday SET (values 1–7, sorted,
//     no duplicates) — it needs a helper function, and a CHECK constraint
//     can't contain a subquery;
//   - the row-level security policies.
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
    // Exactly one of these two is set, matching `type` (CHECK below).
    weekdays: smallint('weekdays').array(),
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
    // "Exactly the right fields per type": weekdays for 'weekdays', a count
    // for 'times_per_week', never both, never neither. Without it, a row
    // could say type 'weekdays' and carry only a count — and every reader
    // would have to decide what that means.
    fieldsMatchType: check(
      'program_schedules_fields_match_type',
      sql`(${table.type} = 'weekdays' AND ${table.weekdays} IS NOT NULL AND ${table.timesPerWeek} IS NULL)
        OR (${table.type} = 'times_per_week' AND ${table.timesPerWeek} IS NOT NULL AND ${table.weekdays} IS NULL)`,
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
  }),
)