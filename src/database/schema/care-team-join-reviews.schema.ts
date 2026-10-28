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
  timestamp,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { users } from './users.schema'
import { careTeamMembers } from './care-team.schema'

// --- TABLE -------------------------------------------------------------------------------------------------

// "This practitioner has seen that a colleague joined the care team" — the
// care-team join notice (decided with the person 2026-10-28, decisions §25,
// pass 1 of the tidy-up). When someone joins a patient's care team, or is
// added to it, every OTHER practitioner already on that team gets an item in
// their "For review" list; "Mark as reviewed" writes one row here and takes
// the item off THAT practitioner's list only — the session reviews' shape
// (`session_reviews`), with a care-team link in place of a session.
//
// The notice itself is NOT stored: like every other alert, it is computed on
// each request from the data (here, `care_team_members` — who joined, when,
// who added them). Only the act of looking is a row, written once, never
// changed or deleted (no UPDATE or DELETE policy — migration 0065).
//
// Not expressible here, so in migration 0065 (custom):
//   - the row-level security (a practitioner reads and writes only their own
//     reviews, of links on a patient whose care team they are on);
//   - a trigger: `reviewed_at` is the database's now(), never a client's.
export const careTeamJoinReviews = pgTable(
  'care_team_join_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // The link announced: integer, like care_team_members.id (a serial).
    // RESTRICT: links are never deleted (no DELETE policy, 0019), and a
    // review must never vanish because someone deleted a link by hand.
    // (Its foreign key is declared below, with a name: the one drizzle would
    // generate is 66 characters, and Postgres cuts identifiers at 63.)
    careTeamMemberId: integer('care_team_member_id').notNull(),
    // Who looked — always the practitioner writing the row (the INSERT
    // policy checks it against the session user's id).
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    linkFk: foreignKey({
      name: 'care_team_join_reviews_link_fk',
      columns: [table.careTeamMemberId],
      foreignColumns: [careTeamMembers.id],
    }).onDelete('restrict'),
    // ONE review per practitioner and link: a double tap records one review
    // (the service inserts with ON CONFLICT DO NOTHING on this index). It also
    // serves the list's question, "which of THESE links has this practitioner
    // reviewed?" — both columns — so no second index.
    onePerPractitioner: uniqueIndex(
      'care_team_join_reviews_one_per_practitioner',
    ).on(table.careTeamMemberId, table.practitionerId),
  }),
)
