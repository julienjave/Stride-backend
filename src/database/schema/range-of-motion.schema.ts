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
  text,
  date,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import {
  AMENDMENT_REASON_MAX_LENGTH,
  medicalFiles,
} from './medical-files.schema'
import {
  LOWEST_DEGREES,
  ROM_MODES,
  ROM_MOVEMENTS,
  ROM_SIDES,
  SIDED_MOVEMENTS,
  highestDegrees,
  type RomMovement,
} from '../../range-of-motion/movement-catalogue'

// --- LIMITS ------------------------------------------------------------------------------------------------

// A measurement's optional note ("pain at end range", "measured lying
// down") — a remark, not a clinical note: the SOAP note linked to the visit
// is where the narrative goes.
export const ROM_NOTE_MAX_LENGTH = 200
// How many measurements one assessment may hold. A full lower-limb
// assessment — six hip movements, two knee, four ankle, both sides, active
// and passive — is 48; 60 leaves room without letting one request carry
// thousands of rows. The DTO's only (a size limit isn't a data rule).
export const ROM_MEASUREMENTS_MAX = 60

// --- ENUMS -------------------------------------------------------------------------------------------------

// Each from the catalogue's own tuple (movement-catalogue.ts): the database
// refuses a code the API doesn't know, and the two lists can't drift apart.
export const romMovementEnum = pgEnum('rom_movement', ROM_MOVEMENTS)
export const romSideEnum = pgEnum('rom_side', ROM_SIDES)
export const romModeEnum = pgEnum('rom_mode', ROM_MODES)

// --- ASSESSMENTS -------------------------------------------------------------------------------------------

// One range-of-motion ASSESSMENT: the measurements a practitioner took of a
// patient on one day (Phase 7, decided with the person 2026-10-31). Part of
// the patient's record, with the medical file's rules:
//   - APPEND-ONLY: never edited, never deleted (no UPDATE or DELETE policy,
//     migration 0077). A wrong value is corrected by an AMENDMENT — a new,
//     complete assessment pointing at the one it replaces, with the reason;
//     the original stays readable, marked as amended. The same chain as
//     medical_files (one amendment per assessment, same patient only).
//   - Its measurements (rom_measurements) are written in the SAME transaction
//     as the assessment and never after (0077's insert policy): an
//     assessment, once recorded, can't gain or lose a value.
//   - It may be LINKED to the medical file entry of the same visit (the
//     person's choice: "own record, linkable", the link on the assessment).
//     Both records are append-only, so the link is set when the assessment is
//     recorded; linking one later is an amendment.
//
// Two dates, two meanings:
//   - measured_on: the CLINICAL day, chosen by the practitioner — it may be
//     earlier than today (measurements taken on paper, typed in the next
//     morning). A calendar day ('YYYY-MM-DD'), not a moment: a clinician
//     dates a measurement by its day.
//   - created_at: when it was RECORDED — the database's own clock (the insert
//     trigger, 0077, overwrites whatever a client sent), so the record of
//     when something was written can't be forged.
export const romAssessments = pgTable(
  'rom_assessments',
  {
    id: serial('id').primaryKey(),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    measuredOn: date('measured_on').notNull(),
    // The medical file entry of the same visit — NULL when none. Its foreign
    // key is COMPOSITE (below), like an amendment's: a link can only point
    // at an entry of the SAME patient.
    medicalFileEntryId: integer('medical_file_entry_id'),
    amendsId: integer('amends_id'),
    amendmentReason: text('amendment_reason'),
  },
  (table) => ({
    // Every read filters on the patient.
    patientIdIdx: index('rom_assessments_patient_id_idx').on(table.patientId),
    // "Which assessments are linked to this note?" — and Postgres's own
    // check, when a medical_files row's (id, patient_id) changes (only ever
    // in a merge), that nothing still points at the old pair: without an
    // index that check reads the whole table.
    medicalFileEntryIdx: index('rom_assessments_medical_file_entry_idx').on(
      table.medicalFileEntryId,
    ),

    // The target of the two composite foreign keys that point at THIS table
    // (an amendment) — Postgres needs the pair declared unique first.
    idPatientUnique: unique('rom_assessments_id_patient_unique').on(
      table.id,
      table.patientId,
    ),
    // An amendment corrects an assessment of the same patient (medical_files'
    // idiom: the pair must exist; a NULL amends_id is never checked).
    amendsSamePatientFk: foreignKey({
      name: 'rom_assessments_amends_same_patient_fk',
      columns: [table.amendsId, table.patientId],
      foreignColumns: [table.id, table.patientId],
    }).onDelete('restrict'),
    // The linked note is in the same patient's medical file: (entry, patient)
    // must exist as (id, patient_id) of medical_files — the pair that table
    // declares unique (medical_files_id_patient_unique). A practitioner can't
    // link another patient's note, by mistake or on purpose, whatever the
    // query.
    noteSamePatientFk: foreignKey({
      name: 'rom_assessments_note_same_patient_fk',
      columns: [table.medicalFileEntryId, table.patientId],
      foreignColumns: [medicalFiles.id, medicalFiles.patientId],
    }).onDelete('restrict'),
    // Amended at most once: corrections are a chain, so "the latest version"
    // has one answer, and two simultaneous amendments can't both win (the
    // second meets this index — 23505 → 409).
    oneAmendmentPerAssessment: unique(
      'rom_assessments_one_amendment_per_assessment',
    ).on(table.amendsId),
    notSelfAmending: check(
      'rom_assessments_not_self_amending',
      sql`${table.amendsId} IS NULL OR ${table.amendsId} <> ${table.id}`,
    ),
    // The reason goes with an amendment, and only with one (medical_files'
    // CHECK, word for word — the same rule with the same limit).
    amendmentReasonValid: check(
      'rom_assessments_amendment_reason_valid',
      sql`(${table.amendsId} IS NULL) = (${table.amendmentReason} IS NULL) AND (${table.amendmentReason} IS NULL OR (${table.amendmentReason} ~ '\\S' AND char_length(${table.amendmentReason}) <= ${sql.raw(String(AMENDMENT_REASON_MAX_LENGTH))}))`,
    ),
    // Not measured after the day it was recorded. created_at is set by the
    // insert trigger BEFORE constraints are checked (a BEFORE trigger runs
    // first), so for the app this reads "not in the future". "+ 1": the
    // practitioner's day can be one ahead of UTC's (Auckland's morning is
    // still yesterday in UTC) — a day that is today SOMEWHERE (the API's
    // isPossibleToday rule). Comparing two columns of the same row, it needs
    // no clock of its own — which is what lets it be a CHECK.
    measuredByRecording: check(
      'rom_assessments_measured_by_recording',
      sql`${table.measuredOn} <= (${table.createdAt} AT TIME ZONE 'UTC')::date + 1`,
    ),
  }),
)

// --- MEASUREMENTS ------------------------------------------------------------------------------------------

// One value of an assessment: a movement, on a side (or none, for neck and
// trunk flexion / extension), active or passive, in degrees.
export const romMeasurements = pgTable(
  'rom_measurements',
  {
    id: serial('id').primaryKey(),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => romAssessments.id, { onDelete: 'restrict' }),
    movement: romMovementEnum('movement').notNull(),
    side: romSideEnum('side'),
    mode: romModeEnum('mode').notNull(),
    // smallint: −90…200 needs 2 bytes. Whole degrees: a goniometer is read
    // to the nearest degree (its own error is several), so a decimal would
    // claim a precision the instrument doesn't have.
    degrees: smallint('degrees').notNull(),
    note: text('note'),
  },
  (table) => ({
    // Each movement once per side and mode in an assessment: two values for
    // "knee flexion, right, active" on one day would leave a chart (and a
    // reader) to guess which is THE measurement. NULLS NOT DISTINCT
    // (Postgres 15+): side is NULL for neck flexion, and in an ordinary
    // unique index two NULLs never clash — this makes them clash, so neck
    // flexion can't be recorded twice either.
    //
    // It also serves every "measurements of these assessments" read: an
    // index on (assessment_id, …) is used for assessment_id alone (its
    // leading column), so no second index is needed.
    oneValuePerKind: unique('rom_measurements_one_value_per_kind')
      .on(table.assessmentId, table.movement, table.side, table.mode)
      .nullsNotDistinct(),
    // A side exactly for the movements measured on one (the catalogue's
    // `sided`). Generated from the catalogue: the list in the database is
    // the list in the code.
    sideMatchesMovement: check(
      'rom_measurements_side_matches_movement',
      sql.raw(
        `(side IS NOT NULL) = (movement IN (${SIDED_MOVEMENTS.map((movement) => `'${movement}'`).join(', ')}))`,
      ),
    ),
    // Degrees within the movement's plausible bounds (movement-catalogue.ts:
    // typing mistakes, not clinical limits). Movements sharing a highest
    // value share a WHEN. `ELSE false`: a movement the CASE didn't list
    // FAILS the CHECK — a CASE with no ELSE gives NULL, and a CHECK passes on
    // NULL, so a forgotten movement would have accepted any value.
    degreesPlausible: check(
      'rom_measurements_degrees_plausible',
      sql.raw(degreesCheck()),
    ),
    // A note is NULL or visible text of at most ROM_NOTE_MAX_LENGTH — the
    // `\S` test of every text field.
    noteValid: check(
      'rom_measurements_note_valid',
      sql.raw(
        `note IS NULL OR (note ~ '\\S' AND char_length(note) <= ${ROM_NOTE_MAX_LENGTH})`,
      ),
    ),
  }),
)

// The degrees CHECK's text: one WHEN per distinct highest value, in
// ascending order (a stable text — drizzle-kit compares it on every
// generate, and a reordering would look like a change).
function degreesCheck(): string {
  const byHighest = new Map<number, RomMovement[]>()
  for (const movement of ROM_MOVEMENTS) {
    const highest = highestDegrees(movement)
    byHighest.set(highest, [...(byHighest.get(highest) ?? []), movement])
  }
  const whens = [...byHighest.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([highest, movements]) =>
        `WHEN movement IN (${movements.map((movement) => `'${movement}'`).join(', ')}) THEN degrees BETWEEN ${LOWEST_DEGREES} AND ${highest}`,
    )
  return `CASE ${whens.join(' ')} ELSE false END`
}
