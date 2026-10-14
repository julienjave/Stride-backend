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

import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './drizzle.provider'
import type { UserRole } from '../users/dto/create-user.dto'

// --- HELPER --------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// Session-local context for RLS policies (see the "Row-Level Security" writeup) —
// set_config(..., true) scopes both settings to just this transaction, matching
// the request they were derived from. Shared across every table that grew RLS
// policies during the rollout (medical_files first, more since); callers decide
// which of their queries actually need to run through the returned tx.
//
// currentUser is REQUIRED (since 2026-10-07). It used to be optional for
// one context-less caller: public self-registration, which created accounts
// through UsersService.create() with nobody signed in. Registration was
// removed with invitations — every account is now created by a signed-in
// admin or practitioner — so the compiler now guarantees no request reaches
// a policy here without a user context. (The one remaining context-less
// INSERT on users, the first-admin setup in AuthService.registerClinic(),
// opens its own transaction rather than coming through here; users_insert's
// "no session context" branch exists for it.)
export async function withRlsContext<T>(
  db: DrizzleDb,
  currentUser: CurrentUser,
  fn: (tx: DrizzleDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await applyUserContext(tx, currentUser)
    return fn(tx)
  })
}

// The two settings withRlsContext() starts its transaction with, on their
// own — for a transaction that only learns WHO it acts as part-way through.
// Accepting an invitation is that case: it starts as the token holder
// (withInvitationTokenContext, below), finds out from the invitation which
// account it is, and only then may act as that account to set its password.
// Must be called inside a transaction (set_config(..., true) lasts until the
// transaction ends; outside one, it would vanish after this statement).
export async function applyUserContext(
  tx: DrizzleDb,
  currentUser: CurrentUser,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.current_user_id', ${String(currentUser.id)}, true)`,
  )
  await tx.execute(
    sql`SELECT set_config('app.current_role', ${currentUser.activeRole}, true)`,
  )
}

// The token holder's context, for the invitation accept page — whose
// requests have no session at all (the visitor has no password yet). Puts
// the SHA-256 hash of the emailed token in app.invitation_token_hash for
// this transaction only; the invitations policies (migration 0021) then let
// the transaction see and update exactly the one invitation with that hash,
// and nothing else. Without a matching token it sees no invitation at all.
//
// The HASH, not the raw token: it's what the table stores, so the policy
// compares like with like — and the raw token never reaches the database,
// not even as a setting.
//
// set_config(..., true): transaction-local, like the user context above —
// the setting is gone when the transaction ends, so it can't leak to the
// next request that reuses this pooled connection.
export async function withInvitationTokenContext<T>(
  db: DrizzleDb,
  tokenHash: string,
  fn: (tx: DrizzleDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.invitation_token_hash', ${tokenHash}, true)`,
    )
    return fn(tx)
  })
}
