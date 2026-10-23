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
  unique,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// --- SCHEMA ------------------------------------------------------------------------------------------------

// Recovery codes for two-factor sign-in (MFA enrolment, pass 2 — decisions
// §14): ten single-use codes, shown ONCE when MFA is turned on (or when the
// person asks for new ones), for the day the phone is lost. Each one is
// accepted wherever a code from the authenticator app is (signing in,
// turning MFA off, the step-ups), once.
//
// Only a KEYED HASH of each code is stored (HMAC-SHA256 — mfa/recovery-codes.ts
// on why keyed, and why not bcrypt): a copy of the database alone can neither
// read the codes nor test guesses against them.
//
// Rows: created in tens, marked used one by one (used_at), and DELETED when
// replaced, when MFA is turned off, or when an admin resets it — a recovery
// code has no history worth keeping (the audit log records each use).
// Row-level security and the guard trigger: the custom migration after the
// generated one.
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: serial('id').primaryKey(),
    // 'cascade': codes mean nothing without their account (users are never
    // hard-deleted by the app).
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 64 lowercase hex characters: HMAC-SHA256 of the normalised code.
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    // The database's moment (the guard trigger sets it).
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Null = still usable. Set ONCE, to the database's moment (the trigger).
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => ({
    // The lookup a use makes ("this account's code with this hash"), and the
    // proof two of one account's codes never share a hash. Per account, not
    // across the table: a code is only ever valid for its own account. Its
    // index also serves "all of this account's codes" (count, delete): a
    // B-tree's LEADING column is usable on its own, so a separate user_id
    // index would be a second copy of the same order.
    userCode: unique('mfa_recovery_codes_user_code_unique').on(
      table.userId,
      table.codeHash,
    ),
    // The shape of a stored hash — anything else (a raw code stored by
    // mistake, say) is refused.
    hashShape: check(
      'mfa_recovery_codes_hash_shape',
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
)
