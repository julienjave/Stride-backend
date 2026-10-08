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

// --- SCHEMA ------------------------------------------------------------------------------------------------

// Accounts are created by invitation only (design decisions §3). The
// account itself exists from the start — a practitioner can assign a program
// to a patient who hasn't opened the email yet — but with no password
// (users.password_hash NULL). An invitation is a one-time permission for
// that existing account to choose its first password.
//
// One row = one invitation SENT. Resending closes the open row (revoked_at,
// revoked_by = whoever resent) and inserts a new one, so the old link stops
// working; "invited by X on …, resent on …" stays readable as rows. Rows are
// never deleted (no DELETE policy).
//
// The status is DERIVED, never stored — a stored status could contradict the
// timestamps it summarises:
//   accepted_at set → accepted
//   revoked_at set  → revoked
//   expires_at past → expired
//   otherwise       → pending
//
// The row-level security policies are in the custom migration that follows
// the generated one (Drizzle can't express policies).
export const invitations = pgTable(
  'invitations',
  {
    id: serial('id').primaryKey(),
    // The account being invited. 'cascade': an invitation means nothing
    // without its account (same choice as user_roles). Users are never
    // hard-deleted by the app anyway.
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the token in the emailed link, as 64 hex characters — the
    // raw token is never stored, same as password reset: a leaked database
    // can't be used to accept anyone's invitation. UNIQUE also gives the
    // index that the accept page's lookup ("which invitation is this
    // token?") uses.
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    // Always known: every invitation is sent by a signed-in admin or
    // practitioner. 'restrict' (like care_team_members): the record of who
    // invited whom must never silently vanish.
    invitedBy: integer('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by the service (7 days after creation — decisions §3). Not a
    // database default, so the rule lives in one place, in TypeScript.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // When the mail server ACCEPTED this invitation's email; NULL = the
    // email couldn't be sent (so the person doesn't have the link), until a
    // new invitation is sent. "Accepted by the server", not "delivered to
    // the inbox": nothing tells an app the second. Recorded so the user
    // page can say so later — before, only POST /users' response knew
    // (emailSent), and the page showed "Sent" either way.
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: integer('revoked_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => ({
    // AT MOST ONE OPEN INVITATION PER ACCOUNT. A partial unique index: the
    // uniqueness only applies to the rows matching the WHERE — the open
    // ones. Any number of closed (accepted or revoked) rows may share a
    // user_id; two OPEN rows can't, even if two "Resend" clicks race —
    // the second INSERT fails with 23505 instead of leaving two working
    // links. A plain UNIQUE(user_id) would forbid the history; no index at
    // all would allow two open invitations.
    oneOpenPerUser: uniqueIndex('invitations_one_open_per_user')
      .on(table.userId)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    // Listing an account's invitations, open or not (the partial index above
    // only covers the open ones, so it can't serve this).
    userIdIdx: index('invitations_user_id_idx').on(table.userId),
    // An invitation ends ONE way: accepted, or revoked — never both.
    acceptedOrRevoked: check(
      'invitations_accepted_or_revoked',
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
    // revoked_at and revoked_by come as a pair: a revocation always says
    // who did it, and "revoked by" never appears on a live invitation.
    // (A = B on two booleans: both true or both false.)
    revokedWithActor: check(
      'invitations_revoked_with_actor',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`,
    ),
    expiresAfterCreation: check(
      'invitations_expires_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  }),
)