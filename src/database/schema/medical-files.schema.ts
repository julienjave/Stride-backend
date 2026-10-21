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
  text,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// --- LIMITS ------------------------------------------------------------------------------------------------

// The longest text one SOAP section may hold, and an amendment's reason
// (Phase 6, decided 2026-10-20). Written once here and used by the CHECKs
// below AND by the DTO (medical-files/dto/), so the two layers can't
// disagree. 10,000 characters is several pages of clinical prose per
// section — four of them stay under the 50 KB the old jsonb column allowed.
export const MEDICAL_FILE_SECTION_MAX_LENGTH = 10_000
export const AMENDMENT_REASON_MAX_LENGTH = 500

// --- ENTRY TYPES -------------------------------------------------------------------------------------------

// What kind of note an entry is (Phase 6, decided with the person
// 2026-10-20): the three moments of an episode of care in physiotherapy.
//   - initial_assessment: the first visit — history, tests, the goals;
//   - progress_note:      any follow-up — what changed, what's next;
//   - discharge_summary:  the end of the episode — the outcome, advice.
// An ENUM, not free text: the screens label and filter by it, and a typo
// ('progres_note') must be refused by the database, not stored. Practitioner-
// defined templates (their own types and sections) are a later idea —
// deferred-improvements.md, "Medical file templates".
export const medicalFileEntryTypeEnum = pgEnum('medical_file_entry_type', [
  'initial_assessment',
  'progress_note',
  'discharge_summary',
])

// --- TABLE -------------------------------------------------------------------------------------------------

// One entry of a patient's medical file — a clinical note written by a
// practitioner on their care team. APPEND-ONLY: an entry is never edited and
// never deleted (no UPDATE or DELETE policy — migration 0050 — so the app's
// role can't change one). A mistake is corrected by an AMENDMENT: a new,
// complete entry that points at the one it replaces (`amends_id`), with the
// reason. The original stays, readable, marked as amended — what the record
// said, and when, is never lost (HIPAA's integrity rule and its "right to
// amend", which keeps the original too).
//
// The content is SOAP, the standard shape of a physiotherapy note (decided
// 2026-10-20 — it replaced a free-form `clinical_data jsonb`, migration
// 0049):
//   - subjective: what the patient reports (pain, history, goals);
//   - objective:  what the practitioner measured or observed;
//   - assessment: their clinical judgement;
//   - plan:       what happens next.
// Each section is optional — a short progress note may only have a plan —
// but an entry needs at least one (a CHECK below), and none may be blank.
export const medicalFiles = pgTable(
  'medical_files',
  {
    id: serial('id').primaryKey(),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The DEFAULT is only a default: the insert trigger (migration 0050)
    // overwrites it with the database's now(), so a client can't backdate an
    // entry — the moment a note was written is part of the record.
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    entryType: medicalFileEntryTypeEnum('entry_type').notNull(),
    subjective: text('subjective'),
    objective: text('objective'),
    assessment: text('assessment'),
    plan: text('plan'),
    // The entry this one corrects — NULL for an ordinary entry. Its foreign
    // key is COMPOSITE (below): it points at (id, patient_id), not at id
    // alone, so an amendment can only ever point at an entry of the SAME
    // patient — the database refuses anything else, whatever the query.
    amendsId: integer('amends_id'),
    // Why the correction was made ("Wrong knee recorded"). Present exactly
    // when amends_id is (a CHECK below).
    amendmentReason: text('amendment_reason'),
  },
  (table) => ({
    // Every read filters on the patient and sorts newest first.
    patientIdIdx: index('medical_files_patient_id_idx').on(table.patientId),

    // The TARGET of the composite foreign key below. A foreign key must
    // point at columns the database knows to be unique together; id alone
    // is (the primary key), so (id, patient_id) trivially is too — but
    // Postgres needs it DECLARED, as a unique constraint, before another
    // row may reference the pair.
    idPatientUnique: unique('medical_files_id_patient_unique').on(
      table.id,
      table.patientId,
    ),
    // "An amendment points at an entry of the same patient." The pair
    // (amends_id, patient_id) must exist as (id, patient_id) in this table.
    // When amends_id is NULL the key isn't checked at all (SQL's MATCH
    // SIMPLE: a key with a NULL column references nothing) — an ordinary
    // entry. RESTRICT is moot (rows are never deleted) but says so.
    amendsSamePatientFk: foreignKey({
      name: 'medical_files_amends_same_patient_fk',
      columns: [table.amendsId, table.patientId],
      foreignColumns: [table.id, table.patientId],
    }).onDelete('restrict'),
    // An entry is amended at most ONCE — corrections form a chain (original
    // → amendment → amendment of the amendment…), never a tree. So "the
    // latest version" always has one answer, and two practitioners amending
    // the same entry at the same moment can't both win: the second INSERT
    // meets this index and gets 23505 — the service answers 409 "amend the
    // latest version instead". NULLs are distinct in a unique index, so any
    // number of ordinary entries (amends_id NULL) coexist.
    oneAmendmentPerEntry: unique('medical_files_one_amendment_per_entry').on(
      table.amendsId,
    ),
    // An entry can't amend itself. The foreign key alone wouldn't stop it:
    // a row inserted with id = 7 and amends_id = 7 references a row that
    // exists — itself.
    notSelfAmending: check(
      'medical_files_not_self_amending',
      sql`${table.amendsId} IS NULL OR ${table.amendsId} <> ${table.id}`,
    ),
    // At least one section: num_nonnulls counts the arguments that aren't
    // NULL. An entry with no content says nothing and is refused.
    hasContent: check(
      'medical_files_has_content',
      sql`num_nonnulls(${table.subjective}, ${table.objective}, ${table.assessment}, ${table.plan}) >= 1`,
    ),
    // A section is NULL (not written) or holds something visible — the same
    // `\S` test as titles and messages, so '   ' or a lone tab is refused —
    // and at most MEDICAL_FILE_SECTION_MAX_LENGTH characters. One CHECK for
    // the four: the refusal means the same thing whichever section broke it.
    sectionsValid: check(
      'medical_files_sections_valid',
      sql.raw(
        ['subjective', 'objective', 'assessment', 'plan']
          .map(
            (column) =>
              `(${column} IS NULL OR (${column} ~ '\\S' AND char_length(${column}) <= ${MEDICAL_FILE_SECTION_MAX_LENGTH}))`,
          )
          .join(' AND '),
      ),
    ),
    // The reason goes with an amendment, and only with one: both NULL, or
    // both present — "(a IS NULL) = (b IS NULL)" compares the two booleans.
    // A present reason is visible text of at most AMENDMENT_REASON_MAX_LENGTH.
    amendmentReasonValid: check(
      'medical_files_amendment_reason_valid',
      sql`(${table.amendsId} IS NULL) = (${table.amendmentReason} IS NULL) AND (${table.amendmentReason} IS NULL OR (${table.amendmentReason} ~ '\\S' AND char_length(${table.amendmentReason}) <= ${sql.raw(String(AMENDMENT_REASON_MAX_LENGTH))}))`,
    ),
  }),
)
