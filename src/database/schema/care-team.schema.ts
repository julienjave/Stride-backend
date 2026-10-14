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
  serial,
  integer,
  varchar,
  timestamp,
  check,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// A patient's care team: which practitioners are treating which patient, and
// over which period (design decisions §3, "Care team and accounts").
//
// Being on a patient's care team is what gives a practitioner CLINICAL access
// to them — medical files, sessions, assigned programs, messaging, profile
// editing — provided they also still share a clinic (see CareTeamService and
// rls_care_team_member() in migration 0019). Sharing a clinic alone only gives
// DIRECTORY access: finding the patient and joining their care team.
//
// One row = one period of care. A link is never deleted, only ENDED (ends_at
// set): "who treated this patient, and when" is history worth keeping. The
// table has no DELETE policy at all, so the database itself refuses deletes.
//
// ends_at does double duty:
//   - NULL        → open-ended, active until someone ends it;
//   - in the past → ended;
//   - in the future → a planned cover period ("covering until 12 October"):
//                     active now, and stops on its own at that moment.
//
// Not expressible in Drizzle, so added by the custom migration 0019:
//   - an EXCLUSION constraint forbidding two OVERLAPPING periods for the same
//     patient and practitioner (a plain UNIQUE can't express "no overlap in
//     time"), which also makes "join twice at the same moment" impossible;
//   - the row-level security policies.
export const careTeamMembers = pgTable(
  'care_team_members',
  {
    id: serial('id').primaryKey(),
    // 'restrict': users are never hard-deleted in this app (deactivated
    // instead), and a care-team history must never silently vanish because
    // someone deleted a row by hand.
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    // NULL only for the rows the migration backfilled (links reproducing the
    // old "shares a clinic" rule) — nobody created those by hand, and
    // inventing a creator would make the history lie.
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    // Who ended the link. Also in the audit log, but kept here so the care
    // team's history ("ended by X on …") reads without searching the log.
    endedBy: integer('ended_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    reason: varchar('reason', { length: 255 }),
  },
  (table) => ({
    // Nobody is on their own care team — possible to attempt with a
    // multi-role (practitioner + patient) account.
    notSelf: check(
      'care_team_members_not_self',
      sql`${table.patientId} <> ${table.practitionerId}`,
    ),
    // >= rather than >: ending a link in the same transaction that created it
    // gives ends_at = started_at (now() is fixed for a whole transaction).
    endsAfterStart: check(
      'care_team_members_ends_after_start',
      sql`${table.endsAt} IS NULL OR ${table.endsAt} >= ${table.startedAt}`,
    ),
    // "My patients" (by practitioner) and "this patient's team" (by
    // patient). Lookups by the PAIR use the exclusion constraint's own index.
    practitionerIdIdx: index('care_team_members_practitioner_id_idx').on(
      table.practitionerId,
    ),
    patientIdIdx: index('care_team_members_patient_id_idx').on(table.patientId),
  }),
)
