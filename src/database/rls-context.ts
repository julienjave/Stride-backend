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
// currentUser is optional — undefined for the two genuinely unauthenticated
// callers on the users table (AuthService.register()'s self-signup, routed
// through UsersService.create()). When undefined, both set_config calls are
// skipped entirely, so app.current_user_id/app.current_role stay genuinely
// unset for the transaction, not set to some placeholder value — this is
// exactly the state users_insert's third policy branch
// (current_setting(...) IS NULL) checks for. Every other caller across every
// other service always passes a real, defined currentUser, so this is
// additive: their behavior is unchanged, since the new branch only triggers
// on a value none of them ever pass.
export async function withRlsContext<T>(
  db: DrizzleDb,
  currentUser: CurrentUser | undefined,
  fn: (tx: DrizzleDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (currentUser) {
      await tx.execute(
        sql`SELECT set_config('app.current_user_id', ${String(currentUser.id)}, true)`,
      )
      await tx.execute(
        sql`SELECT set_config('app.current_role', ${currentUser.activeRole}, true)`,
      )
    }
    return fn(tx)
  })
}
