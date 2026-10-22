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

// Why a request was closed without being confirmed (decisions §12):
// - replaced: the person asked for another change — one open request per
//   account, so the older one closes;
// - cancelled_in_app: the person cancelled it from their profile;
// - cancelled_by_email_link: someone holding the OLD inbox used the cancel
//   link of the "someone asked to change your email" notice;
// - password_reset: a password reset cancels a pending change — the person
//   who resets may be recovering from someone who knew the password.
export const emailChangeCancelReasonEnum = pgEnum(
  'email_change_cancel_reason',
  ['replaced', 'cancelled_in_app', 'cancelled_by_email_link', 'password_reset'],
)

// A person changing their own sign-in email ("Change email", Phase 6 —
// decisions §12). The change takes effect only when the NEW address proves
// it receives mail: a link with a one-time token is emailed there. Until
// then the account keeps its email, and this row says what is waiting.
//
// One row = one request. Rows are never deleted (no DELETE policy): "who
// asked to move this account to which address, when, and what happened" is
// kept, like invitations. The state is DERIVED from the timestamps, never
// stored:
//   confirmed_at set → confirmed (users.email now holds new_email)
//   cancelled_at set → cancelled (cancel_reason says why)
//   expires_at past  → expired (still "open" for the index below, harmless)
//   otherwise        → pending
//
// Its own table rather than columns on users (like the reset token's): the
// tokens stay out of the row every user response is built from, so
// UsersService.toPublic() has nothing more to strip; and the history of
// requests survives.
//
// Row-level security and the guard trigger are in the custom migration that
// follows the generated one (Drizzle can't express policies or triggers).
export const emailChangeRequests = pgTable(
  'email_change_requests',
  {
    id: serial('id').primaryKey(),
    // The account whose email would change. 'cascade': a request means
    // nothing without its account (users are never hard-deleted by the app).
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The address asked for, in the same normalised spelling users.email
    // holds (common/email-address.ts) — the CHECK below is users' own. Not
    // UNIQUE: two people may both ask for an address; users_email_unique
    // decides, at the moment one of them confirms.
    newEmail: varchar('new_email', { length: 255 }).notNull(),
    // SHA-256 (64 hex characters) of the token in the CONFIRM link, sent to
    // the new address. The raw token is never stored: a leaked database
    // can't confirm anyone's change. UNIQUE also gives the lookup its index.
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    // SHA-256 of the token in the CANCEL link, sent to the OLD address with
    // the "someone asked to change your email" notice. A separate token: the
    // old inbox may only stop the change, the new one may only make it.
    cancelTokenHash: varchar('cancel_token_hash', { length: 64 })
      .notNull()
      .unique(),
    // The database's moment (the guard trigger sets it — a client can't send
    // one). The default is for the tables' owner (seed, tests).
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Written by the service as `now() + 24 hours` IN SQL, and compared with
    // `now()` in SQL too: one clock decides when a link dies (the two-clock
    // lesson, decisions §12).
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: emailChangeCancelReasonEnum('cancel_reason'),
  },
  (table) => ({
    // AT MOST ONE OPEN REQUEST PER ACCOUNT — the same partial unique index
    // as invitations_one_open_per_user. A new request closes the open one
    // first (as 'replaced'), so only one confirm link works at a time.
    oneOpenPerUser: uniqueIndex('email_change_requests_one_open_per_user')
      .on(table.userId)
      .where(
        sql`${table.confirmedAt} IS NULL AND ${table.cancelledAt} IS NULL`,
      ),
    // An account's requests, open or not (the partial index can't serve it).
    userIdIdx: index('email_change_requests_user_id_idx').on(table.userId),
    // A request ends ONE way: confirmed or cancelled, never both.
    confirmedOrCancelled: check(
      'email_change_requests_confirmed_or_cancelled',
      sql`${table.confirmedAt} IS NULL OR ${table.cancelledAt} IS NULL`,
    ),
    // A cancellation always says why, and "why" never appears without one.
    cancelledWithReason: check(
      'email_change_requests_cancelled_with_reason',
      sql`(${table.cancelledAt} IS NULL) = (${table.cancelReason} IS NULL)`,
    ),
    expiresAfterCreation: check(
      'email_change_requests_expires_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    // The spelling users.email accepts (users_email_normalized): a request
    // for 'Pat@X.com' could otherwise be confirmed into a row the users
    // CHECK refuses.
    newEmailNormalized: check(
      'email_change_requests_new_email_normalized',
      sql`${table.newEmail} = btrim(lower(${table.newEmail} COLLATE "C"))`,
    ),
  }),
)
