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
  pgEnum,
  serial,
  bigserial,
  integer,
  text,
  varchar,
  boolean,
  date,
  timestamp,
  check,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The longest texts accepted — written into the CHECKs below and the DTO,
// one number for both.
export const LEGAL_DISCLOSURE_NAME_MAX = 200
export const LEGAL_DISCLOSURE_REFERENCE_MAX = 100
export const LEGAL_DISCLOSURE_EXPLANATION_MAX = 1000
export const LEGAL_DISCLOSURE_STATEMENT_MAX = 2000

// WHY the law lets the clinic release a record without the patient's
// authorisation — HIPAA 45 CFR 164.512, the cases a physiotherapy clinic can
// meet (decisions §25, pass 3). The list is the database's (an enum): a
// basis nobody has thought about can't be typed in by mistake; "other" exists
// for the rest, and then requires an explanation (the details table's CHECK).
//   - court_order        164.512(e)(1)(i)   an order of a court or tribunal;
//   - subpoena           164.512(e)(1)(ii)  a subpoena or discovery request,
//                                           WITH the "satisfactory
//                                           assurances" the rule asks for;
//   - required_by_law    164.512(a)         a statute or regulation demands it
//                                           (a mandatory report, say);
//   - law_enforcement    164.512(f)         a request from the police, under
//                                           its conditions;
//   - health_oversight   164.512(d)         a licensing body, an inspector;
//   - coroner            164.512(g)         a coroner or medical examiner;
//   - other                                 with an explanation.
export const LEGAL_BASES = [
  'court_order',
  'subpoena',
  'required_by_law',
  'law_enforcement',
  'health_oversight',
  'coroner',
  'other',
] as const
export type LegalBasis = (typeof LEGAL_BASES)[number]

export const legalBasisEnum = pgEnum('legal_basis', LEGAL_BASES)

// --- TABLES ------------------------------------------------------------------------------------------------

// THE LEGAL DISCLOSURE (decisions §25, pass 3 of the post-Phase-6 tidy-up).
// The law can require a clinic to hand a record to someone outside it —
// a court, the police, a licensing body — without the patient's approval.
// The clinic must then produce exactly what the order covers, and the release
// goes in the patient's ACCOUNTING OF DISCLOSURES (HIPAA 164.528): the list,
// which the patient may ask for, of who received their record outside
// treatment, payment and operations.
//
// One row = one disclosure: one PDF, made in the same transaction as the row
// (the records export's generator, read AS THE PATIENT — the complaint
// review's path), stamped "Disclosed to … under … on …" on every page.
//
// WHY FOUR TABLES. Row-level security decides which ROWS a session sees,
// never which COLUMNS; three audiences see three different slices of one
// disclosure (the person's choices):
//
//   what                              admins  the patient   the care team
//   legal_disclosures (who to, when)    ✓     ✓ (released)       ✓
//   legal_disclosure_details (why,      ✓     ✓ (released)       —
//     which parts, which period)
//   legal_disclosure_orders (the        ✓          —             —
//     order's reference, when it was
//     received, the agency's statement)
//
// …plus `legal_disclosure_notice_reviews`, each practitioner's "seen" (the
// complaint review notices' shape). "Released" is the HOLD: law enforcement
// or a health-oversight agency may ask the clinic to keep a disclosure out of
// the patient's accounting for a time (164.528(a)(2)); until `withheld_until`
// the patient's own policies don't show the row at all — the database itself
// keeps it from them, whatever screen or export asks.
//
// Nothing here is ever changed or deleted (no UPDATE or DELETE policy on any
// of the four): a disclosure is a fact about the past.
export const legalDisclosures = pgTable(
  'legal_disclosures',
  {
    id: serial('id').primaryKey(),
    // Whose record. RESTRICT: accounts are never deleted, and the trail of
    // who received a record must never vanish.
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The admin who made it — checked against the session user by the
    // INSERT policy: no disclosure recorded in someone else's name.
    madeBy: integer('made_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Written by the guard trigger from the database's now() — the moment
    // the copy was made, which is the date of the disclosure. The default is
    // for the tables' owner (tests).
    madeAt: timestamp('made_at', { withTimezone: true }).notNull().defaultNow(),
    // WHO received it — a person, and the organisation they act for (the
    // accounting's "name of the entity or person", 164.528(b)(2)(ii)). The
    // organisation is optional: a recipient may be a person alone.
    recipientName: varchar('recipient_name', {
      length: LEGAL_DISCLOSURE_NAME_MAX,
    }).notNull(),
    recipientOrganisation: varchar('recipient_organisation', {
      length: LEGAL_DISCLOSURE_NAME_MAX,
    }),
    // THE HOLD (see above): the patient sees the disclosure from this moment
    // on — null when there is none. An INSTANT, not a day: the admin picks a
    // day, and the service turns it into the start of that day in the
    // admin's time zone (Postgres does the arithmetic, from its own zone
    // database), so "until November 30" means the same moment for everyone.
    // The care team sees it (their notice says when the patient will know,
    // so nobody mentions it earlier).
    withheldUntil: timestamp('withheld_until', { withTimezone: true }),
  },
  (table) => ({
    // "This patient's disclosures": the admin's list, the patient's
    // accounting, the care team's notices.
    patientIdIdx: index('legal_disclosures_patient_id_idx').on(table.patientId),
    recipientNameNotBlank: check(
      'legal_disclosures_recipient_name_not_blank',
      sql`btrim(${table.recipientName}) <> ''`,
    ),
    // An empty organisation is "none": stored as NULL, never as ''.
    recipientOrganisationNotBlank: check(
      'legal_disclosures_recipient_organisation_not_blank',
      sql`${table.recipientOrganisation} IS NULL OR btrim(${table.recipientOrganisation}) <> ''`,
    ),
  }),
)

// WHY, and WHAT — the part of a disclosure the patient's accounting lists
// besides who and when (164.528(b)(2)(iii)–(iv)): the legal basis, the parts
// of the record that went, the period they covered. Admins and the patient
// (once released) read it; NOT the care team (the person's choice: they are
// told who made it, when, and to whom — not the order's details). One row per
// disclosure: its primary key IS the disclosure's id.
export const legalDisclosureDetails = pgTable(
  'legal_disclosure_details',
  {
    disclosureId: integer('disclosure_id')
      .primaryKey()
      .references(() => legalDisclosures.id, { onDelete: 'restrict' }),
    legalBasis: legalBasisEnum('legal_basis').notNull(),
    // Required with 'other', refused with anything else (the CHECK): a list
    // value says enough on its own; "other" says nothing without it.
    basisExplanation: text('basis_explanation'),
    // The parts chosen (at least one — the CHECK). Messages are possible
    // ONLY here, in the whole app (decisions §25: the Phase 5 promise holds
    // for everything routine; an order covering them is the one, recorded,
    // exception).
    includesMedicalFile: boolean('includes_medical_file').notNull(),
    includesPrograms: boolean('includes_programs').notNull(),
    includesSessions: boolean('includes_sessions').notNull(),
    includesMessages: boolean('includes_messages').notNull(),
    // The period the order covers, as DAYS (each side optional: null = no
    // limit on that side). Each part is filtered by its own date: a note by
    // the day it was written, a session by its day, a message by the day it
    // was sent, a program if its dates overlap the period.
    periodFrom: date('period_from'),
    periodTo: date('period_to'),
  },
  (table) => ({
    explanationWithOther: check(
      'legal_disclosure_details_explanation_with_other',
      sql`(${table.legalBasis} = 'other') = (${table.basisExplanation} IS NOT NULL)`,
    ),
    explanationNotBlank: check(
      'legal_disclosure_details_explanation_not_blank',
      sql`${table.basisExplanation} IS NULL OR (btrim(${table.basisExplanation}) <> '' AND char_length(${table.basisExplanation}) <= ${sql.raw(String(LEGAL_DISCLOSURE_EXPLANATION_MAX))})`,
    ),
    somePart: check(
      'legal_disclosure_details_some_part',
      sql`${table.includesMedicalFile} OR ${table.includesPrograms} OR ${table.includesSessions} OR ${table.includesMessages}`,
    ),
    periodInOrder: check(
      'legal_disclosure_details_period_in_order',
      sql`${table.periodFrom} IS NULL OR ${table.periodTo} IS NULL OR ${table.periodFrom} <= ${table.periodTo}`,
    ),
  }),
)

// THE ORDER — admins only: its reference, the day it reached the clinic, and,
// for a hold, the agency's statement asking for it (164.528(a)(2) requires
// the clinic to document it). Neither the patient nor the care team reads
// this table: a case number may identify an investigation the patient isn't
// to hear about yet.
export const legalDisclosureOrders = pgTable(
  'legal_disclosure_orders',
  {
    disclosureId: integer('disclosure_id')
      .primaryKey()
      .references(() => legalDisclosures.id, { onDelete: 'restrict' }),
    // The order's own number, if it has one (a statute requiring a report
    // has none).
    orderReference: varchar('order_reference', {
      length: LEGAL_DISCLOSURE_REFERENCE_MAX,
    }),
    // The day the request reached the clinic.
    receivedOn: date('received_on').notNull(),
    // Present exactly when the disclosure is held back (the INSERT policy
    // compares it with the disclosure's withheld_until — a rule across two
    // tables, which a CHECK can't express).
    withholdingStatement: text('withholding_statement'),
  },
  (table) => ({
    referenceNotBlank: check(
      'legal_disclosure_orders_reference_not_blank',
      sql`${table.orderReference} IS NULL OR btrim(${table.orderReference}) <> ''`,
    ),
    statementNotBlank: check(
      'legal_disclosure_orders_statement_not_blank',
      sql`${table.withholdingStatement} IS NULL OR (btrim(${table.withholdingStatement}) <> '' AND char_length(${table.withholdingStatement}) <= ${sql.raw(String(LEGAL_DISCLOSURE_STATEMENT_MAX))})`,
    ),
  }),
)

// "This practitioner has seen that their patient's record was disclosed" —
// the complaint review notices' table again (complaint_review_notice_reviews),
// on a disclosure. The notice is computed on every request; only the act of
// looking is a row.
export const legalDisclosureNoticeReviews = pgTable(
  'legal_disclosure_notice_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // (Its foreign key is declared below with a name: drizzle's would be
    // "legal_disclosure_notice_reviews_disclosure_id_legal_disclosures_id_fk",
    // 70 characters — Postgres cuts identifiers at 63.)
    disclosureId: integer('disclosure_id').notNull(),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    disclosureFk: foreignKey({
      name: 'legal_disclosure_notice_reviews_disclosure_fk',
      columns: [table.disclosureId],
      foreignColumns: [legalDisclosures.id],
    }).onDelete('restrict'),
    // One per practitioner and disclosure: a double tap records one.
    onePerPractitioner: uniqueIndex(
      'legal_disclosure_notice_reviews_one_per_practitioner',
    ).on(table.disclosureId, table.practitionerId),
  }),
)
