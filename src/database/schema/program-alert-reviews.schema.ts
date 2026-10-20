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
  pgTable,
  bigserial,
  integer,
  date,
  timestamp,
  index,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { assignedPrograms } from './programs.schema'

// --- TABLE -------------------------------------------------------------------------------------------------

// "This practitioner has looked at this program's attendance alert, and
// this is what was true then" (decided with the person 2026-10-19, after
// testing the To-do — now "For review" — live: an attendance alert that
// the patient never answers sat on the list forever).
//
// The row records the alert's FACTS, not just "seen": the latest run of
// misses (`missed_since`, its first missed day) and the stretch without a
// session (`inactive_since`, its first day) — each null when that fact
// wasn't part of the alert. The alert stays off THIS practitioner's list
// while the same facts hold, and comes back when something NEW appears (a
// new run of misses, or inactivity added to a run) — or after 14 days
// anyway, as a reminder (alert-rules.ts, `isAttendanceReviewed`). The facts
// are computed by the SERVER when the review is written; the client never
// sends them, so a review always describes what the alert really said.
//
// A record like a session review: one row per review, never changed or
// deleted (no UPDATE / DELETE policy — migration 0046), audited
// (PROGRAM_ALERT_REVIEWED). Several rows per program and practitioner over
// time: the LATEST one is the one that counts.
export const programAlertReviews = pgTable(
  'program_alert_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Which program — its foreign key named below.
    assignedProgramId: integer('assigned_program_id').notNull(),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Calendar days, like every schedule date ('YYYY-MM-DD').
    missedSince: date('missed_since'),
    inactiveSince: date('inactive_since'),
    // The database's now() — the trigger of migration 0046 overwrites
    // whatever is sent, like session_reviews.reviewed_at.
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Named by hand: drizzle's generated name,
    // "program_alert_reviews_assigned_program_id_assigned_programs_id_fk",
    // is 65 characters — over Postgres's 63-character limit, so Postgres
    // would silently CUT it (the trap of session_exercises, step 3b-0).
    // RESTRICT: programs with history are never deleted, only archived.
    programFk: foreignKey({
      name: 'program_alert_reviews_program_fk',
      columns: [table.assignedProgramId],
      foreignColumns: [assignedPrograms.id],
    }).onDelete('restrict'),
    // A review of an alert that said nothing is meaningless: at least one
    // of the two facts was there.
    someFact: check(
      'program_alert_reviews_some_fact',
      sql`${table.missedSince} IS NOT NULL OR ${table.inactiveSince} IS NOT NULL`,
    ),
    // "My latest review of each of these programs" — the alerts' question:
    // equality on both columns, then the newest first. One index serves it.
    latestIdx: index('program_alert_reviews_latest_idx').on(
      table.practitionerId,
      table.assignedProgramId,
      table.reviewedAt,
    ),
  }),
)
