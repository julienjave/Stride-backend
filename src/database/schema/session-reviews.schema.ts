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
  bigint,
  integer,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { users } from './users.schema'
import { sessions } from './sessions.schema'

// --- TABLE -------------------------------------------------------------------------------------------------

// "This practitioner has looked at this session" — the practitioner home's
// To-do (decided with the person 2026-10-19, decisions §3). A session with
// high pain, a hard exercise or a note from the patient becomes a to-do for
// every member of the patient's care team; marking it reviewed takes it off
// THAT practitioner's list only (one row per practitioner and session), so
// Sam's review never hides from Alex a session Alex hasn't seen. The session
// page shows every review to the whole care team ("Reviewed by Sam, Oct 19").
//
// A review is a RECORD, like the care-team history: written once, never
// changed or deleted (no UPDATE or DELETE policy — migration 0044), and
// audited (SESSION_REVIEWED). It records the act of looking, not a clinical
// judgement: anything to say to the patient goes through Messages (Phase 5).
//
// Not expressible here, so in migration 0044 (custom):
//   - the row-level security (who may read and write a review);
//   - a trigger: `reviewed_at` is the database's now(), never a client's, and
//     a session still in progress can't be reviewed (nothing final to read).
export const sessionReviews = pgTable(
  'session_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // bigint, like every column pointing at sessions.id (a bigserial).
    // RESTRICT: sessions are never deleted (no DELETE policy), and a review
    // must never vanish because someone deleted a session by hand.
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    // Who reviewed — always the practitioner writing the row (the INSERT
    // policy checks it against the session's user id).
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // ONE review per practitioner and session: a double tap on "Mark as
    // reviewed" records one review, not two — the second insert fails with
    // 23505 and the service answers with the review that already exists.
    //
    // The same index serves both reads, so no second one: "this session's
    // reviews" (the session page) uses its leading column alone, and "which
    // of THESE sessions has this practitioner reviewed?" (the alerts) gives
    // both columns. Another index would only cost every insert.
    onePerPractitioner: uniqueIndex('session_reviews_one_per_practitioner').on(
      table.sessionId,
      table.practitionerId,
    ),
  }),
)
