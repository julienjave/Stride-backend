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

// Merging two accounts of the same patient (decisions §27, pass 3).
//
// One row per merge: the account merged AWAY (`merged_id` — deactivated, its
// records moved) and the account that SURVIVES (`survivor_id` — the admin's
// choice). This row IS the "merged into" link the design names: one fact,
// stored once, rather than a `users.merged_into_id` column repeating it.
// `merged_id` is UNIQUE, so an account is merged away at most once.
//
// What moved — every row, by id — is the merge's audit entry
// (PATIENT_MERGED): the audit log is the append-only history; this table is
// what the app needs to ASK ("was this account merged? into whom? which
// merges must the care team be told about?").
//
// Not expressible here, so in migration 0072 (custom):
//   - the row-level security (admins read every merge; a practitioner reads
//     the merges of their own patients; NOBODY inserts — only the merge
//     function does);
//   - merge_patients(), the SECURITY DEFINER function that does the merge;
//   - a trigger setting `reviewed_at` to the database's now().

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  pgTable,
  serial,
  bigserial,
  integer,
  timestamp,
  check,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// --- TABLES ------------------------------------------------------------------------------------------------

export const patientMerges = pgTable(
  'patient_merges',
  {
    id: serial('id').primaryKey(),
    // The account that keeps everything. RESTRICT everywhere: users are
    // never deleted, and a merge record must never vanish with one.
    survivorId: integer('survivor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The account merged away (deactivated by the merge).
    mergedId: integer('merged_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The admin who merged.
    mergedBy: integer('merged_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    mergedAt: timestamp('merged_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    notSelf: check(
      'patient_merges_not_self',
      sql`${table.survivorId} <> ${table.mergedId}`,
    ),
    // Merged away once, ever — and the index behind "was THIS account
    // merged?" (reactivation refuses a merged account; the duplicate check
    // leaves them out).
    mergedOnce: uniqueIndex('patient_merges_merged_once').on(table.mergedId),
    // "The merges of these patients" — the care team's notices.
    survivorIdx: index('patient_merges_survivor_idx').on(table.survivorId),
  }),
)

// "This practitioner has seen that two accounts of their patient were
// merged" — the legal disclosure notices' table again, on a merge. The
// notice is computed on every request; only the act of looking is a row,
// never changed or deleted.
export const patientMergeNoticeReviews = pgTable(
  'patient_merge_notice_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // (Named foreign key below: drizzle's generated name would be
    // "patient_merge_notice_reviews_merge_id_patient_merges_id_fk", fine at
    // 58 characters — named anyway, like its three siblings.)
    mergeId: integer('merge_id').notNull(),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    mergeFk: foreignKey({
      name: 'patient_merge_notice_reviews_merge_fk',
      columns: [table.mergeId],
      foreignColumns: [patientMerges.id],
    }).onDelete('restrict'),
    // One per practitioner and merge: a double tap records one.
    onePerPractitioner: uniqueIndex(
      'patient_merge_notice_reviews_one_per_practitioner',
    ).on(table.mergeId, table.practitionerId),
  }),
)
