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
  integer,
  varchar,
  timestamp,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// How many wrong dates of birth end a link (the person's choice, decisions
// §20). Written into the CHECK and the index below, and into the guard
// trigger (custom migration): the database and the service agree on ONE
// number.
export const RECORDS_EXPORT_DOB_ATTEMPTS = 5

// --- SCHEMA ------------------------------------------------------------------------------------------------

// The records export's EMAILED LINK (decisions §20, pass 2): a patient who
// can't sign in — deactivated, or who never set a password — asks the
// clinic for their record; an admin sends a link to the address on file.
// The link downloads the record ONCE, within 72 hours, after the visitor
// types the patient's date of birth (5 wrong tries end it).
//
// One row = one link SENT. Sending another closes the open one (replaced_at)
// and inserts a new row, so only the newest link works; rows are never
// deleted (no DELETE policy) — "who sent a copy to whom, and when was it
// used" stays readable. The status is DERIVED from the columns, never
// stored:
//   used_at set               → used
//   replaced_at set           → replaced
//   dob_failures at the limit → locked (too many wrong dates of birth)
//   expires_at past           → expired
//   otherwise                 → open
//
// Row-level security and the guard trigger are in the custom migration that
// follows the generated one (Drizzle can't express policies or triggers).
export const recordsExportLinks = pgTable(
  'records_export_links',
  {
    id: serial('id').primaryKey(),
    // Whose record the link hands out. 'cascade': a link means nothing
    // without its patient (same choice as invitations).
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 (64 hex characters) of the token in the link. The raw token
    // exists only in the email: a leaked database can't download anyone's
    // record. UNIQUE also gives the lookup its index.
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    // The admin who sent it. 'restrict', like invitations.invited_by: the
    // trail of who sent a health record somewhere must not vanish.
    sentBy: integer('sent_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The database's moment (the guard trigger sets it — a client can't send
    // one). The default is for the tables' owner (seed, tests).
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Written by the service as `now() + 72 hours` IN SQL, and compared with
    // now() in SQL: one clock decides when a link dies.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // When the email went out; NULL if it couldn't be sent (the admin's
    // screen says so, and offers to send another) — as invitations do.
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    // When the record was downloaded through it — the link's one use.
    usedAt: timestamp('used_at', { withTimezone: true }),
    // When a newer link replaced it.
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    // Wrong dates of birth so far. Counted by the database (`+ 1` in one
    // UPDATE), never reset: at the limit the link is over.
    dobFailures: integer('dob_failures').notNull().default(0),
  },
  (table) => ({
    // AT MOST ONE OPEN LINK PER PATIENT — the invitations' partial unique
    // index again. Sending a new one closes the open one first; two sends
    // racing meet here, and the second gets a 409. Expiry is not part of it
    // (an expired link is closed by the next send like any other), and a
    // LOCKED link is not open: nothing to close.
    oneOpenPerPatient: uniqueIndex('records_export_links_one_open_per_patient')
      .on(table.patientId)
      .where(
        sql`${table.usedAt} IS NULL AND ${table.replacedAt} IS NULL AND ${table.dobFailures} < ${sql.raw(String(RECORDS_EXPORT_DOB_ATTEMPTS))}`,
      ),
    // A patient's links, open or not (the partial index can't serve it).
    patientIdIdx: index('records_export_links_patient_id_idx').on(
      table.patientId,
    ),
    // A link ends ONE way: used or replaced, never both.
    usedOrReplaced: check(
      'records_export_links_used_or_replaced',
      sql`${table.usedAt} IS NULL OR ${table.replacedAt} IS NULL`,
    ),
    dobFailuresInRange: check(
      'records_export_links_dob_failures_in_range',
      sql`${table.dobFailures} BETWEEN 0 AND ${sql.raw(String(RECORDS_EXPORT_DOB_ATTEMPTS))}`,
    ),
    expiresAfterCreation: check(
      'records_export_links_expires_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  }),
)
