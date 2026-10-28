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
  serial,
  bigserial,
  integer,
  text,
  varchar,
  timestamp,
  check,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// How long a complaint review lasts (the person's choice, decisions §25 pass
// 2): 7 days — a working week. In HOURS, like the emailed link's 72: a fixed
// length whatever the time zone (a "day" across a daylight-saving change is
// 23 or 25 hours). The guard trigger (migration 0067) writes expires_at with
// this same number: the database, not the app, decides how long one lasts.
export const COMPLAINT_REVIEW_HOURS = 7 * 24

// The longest reason and case reference accepted — written into the CHECKs
// below and the DTO, one number for both.
export const COMPLAINT_REVIEW_REASON_MAX = 1000
export const COMPLAINT_REVIEW_CASE_REFERENCE_MAX = 100

// --- TABLES ------------------------------------------------------------------------------------------------

// THE COMPLAINT REVIEW (decisions §25, pass 2 of the post-Phase-6 tidy-up).
// A patient complains; an admin must see what was done. Admins have no
// standing access to clinical data (decisions §16) — so instead of reopening
// that door for every admin, forever, ONE admin opens a review on ONE patient,
// with a reason, for 7 days at most. While it is open, that admin can download
// the records export's PDF, stamped "Review copy"; every copy is recorded.
// The patient's care team is told (their "For review" list) — who, when,
// until — but not why.
//
// One row = one review opened. Rows are never deleted (no DELETE policy) or
// changed except to END one early. The status is DERIVED, never stored:
//   ended_at set      → ended (an admin closed it before its time)
//   expires_at past   → expired
//   otherwise         → open
//
// WHY THE REASON IS IN ANOTHER TABLE: row-level security decides which ROWS
// a session sees, never which COLUMNS. The care team must see that a review
// exists (this table — they read it through a practitioner branch) without
// reading the reason, which may name a colleague or the complaint itself
// (the person's choice). Split in two, each part gets its own policy: this
// table for admins AND the care team, `complaint_review_reasons` for admins
// only. The database enforces "not the reason", not just the app's SELECT.
export const complaintReviews = pgTable(
  'complaint_reviews',
  {
    id: serial('id').primaryKey(),
    // Whose record. RESTRICT: accounts are never deleted (they're
    // deactivated), and the trail of who read a record must never vanish.
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The admin who opened it — the only one who may make copies (the
    // review is a personal grant: "I, for this reason"). Checked against the
    // session user by the INSERT policy: no review opened in someone else's
    // name.
    openedBy: integer('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Both written by the guard trigger from the database's now(): a client
    // can't backdate a review, nor make one last longer than 7 days. The
    // defaults are for the tables' owner (seed, tests).
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Ended early: when, and by which admin (any admin may close a review —
    // less access is always allowed). Both or neither (the CHECK below).
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: integer('ended_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => ({
    // "This patient's reviews" — the admin's list, and the care team's
    // notices (by patient).
    patientIdIdx: index('complaint_reviews_patient_id_idx').on(table.patientId),
    endedTogether: check(
      'complaint_reviews_ended_together',
      sql`(${table.endedAt} IS NULL) = (${table.endedBy} IS NULL)`,
    ),
    expiresAfterOpening: check(
      'complaint_reviews_expires_after_opening',
      sql`${table.expiresAt} > ${table.openedAt}`,
    ),
  }),
)

// WHY a review was opened — admins only (see above). One row per review, its
// primary key IS the review's id (a reason belongs to exactly one review, and
// a second one can't be added). Written once, in the same transaction as the
// review; no UPDATE or DELETE policy: a reason is part of the record of the
// access, and can't be rewritten after the copies were made.
export const complaintReviewReasons = pgTable(
  'complaint_review_reasons',
  {
    reviewId: integer('review_id')
      .primaryKey()
      .references(() => complaintReviews.id, { onDelete: 'restrict' }),
    // Required, and not just spaces (the CHECK) — "accountability instead of
    // approval" only works if the reason says something.
    reason: text('reason').notNull(),
    // The clinic's own complaint number, if it has one (optional).
    caseReference: varchar('case_reference', {
      length: COMPLAINT_REVIEW_CASE_REFERENCE_MAX,
    }),
  },
  (table) => ({
    reasonNotBlank: check(
      'complaint_review_reasons_reason_not_blank',
      sql`btrim(${table.reason}) <> '' AND char_length(${table.reason}) <= ${sql.raw(String(COMPLAINT_REVIEW_REASON_MAX))}`,
    ),
    // An empty reference is "none": stored as NULL, never as ''.
    caseReferenceNotBlank: check(
      'complaint_review_reasons_case_reference_not_blank',
      sql`${table.caseReference} IS NULL OR btrim(${table.caseReference}) <> ''`,
    ),
  }),
)

// "This practitioner has seen that a review of their patient's record was
// opened" — the care team's notice, marked as reviewed. The care-team join
// reviews' shape exactly (care_team_join_reviews, pass 1): the notice itself
// is computed from complaint_reviews on every request; only the act of
// looking is a row, written once.
export const complaintReviewNoticeReviews = pgTable(
  'complaint_review_notice_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // (Its foreign key is declared below with a name: drizzle's would be
    // "complaint_review_notice_reviews_complaint_review_id_complaint_reviews_id_fk",
    // 73 characters — Postgres cuts identifiers at 63.)
    complaintReviewId: integer('complaint_review_id').notNull(),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reviewFk: foreignKey({
      name: 'complaint_review_notice_reviews_review_fk',
      columns: [table.complaintReviewId],
      foreignColumns: [complaintReviews.id],
    }).onDelete('restrict'),
    // One per practitioner and review: a double tap records one (ON CONFLICT
    // DO NOTHING on this index), and it answers "which of these has this
    // practitioner seen?".
    onePerPractitioner: uniqueIndex(
      'complaint_review_notice_reviews_one_per_practitioner',
    ).on(table.complaintReviewId, table.practitionerId),
  }),
)
