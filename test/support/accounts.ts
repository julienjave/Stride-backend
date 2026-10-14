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

import * as bcrypt from 'bcrypt'
import type { Pool } from 'pg'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The password every e2e account signs in with.
export const TEST_PASSWORD = 'password123'

// --- HELPERS -----------------------------------------------------------------------------------------------

// Hashed once per test file, not once per account: bcrypt is deliberately
// slow (~70 ms at cost 10), and a suite activates a dozen accounts or more.
// A Promise, cached: concurrent callers all await the same single hash.
let testPasswordHash: Promise<string> | undefined

// Finishes setting up an account created through POST /users, the way the
// person would by accepting their invitation: sets a known password and
// closes the open invitation as accepted — the same END STATE as
// POST /invitations/accept, written directly to the database.
//
// Why not accept the real invitation (read the email, follow the link)?
// The accept route allows 5 calls a minute, and a suite creates many
// accounts. test/invitations.e2e-spec.ts tests accepting for real; every
// other suite only needs accounts that can sign in.
//
// Why create through POST /users at all, rather than inserting the whole
// account here? Because POST /users does real work the suites rely on: a
// practitioner who creates a patient joins their care team, the clinic is
// checked, row-level security applies. A hand-written INSERT would bypass
// all of it — and drift from it.
//
// STRICT on purpose: it only activates an account that exists AND has no
// password yet, and throws otherwise. Activating after a creation that was
// meant to fail (a 409, a 403…), or twice, is a mistake in the test — it
// should fail loudly, not "work" by accident.
//
// Runs on `pool` — the suite's OWNER connection (sessionPool), which is
// not subject to row-level security: this is test setup, not what's under
// test.
export async function activateAccount(
  pool: Pool,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<number> {
  const passwordHash =
    password === TEST_PASSWORD
      ? await (testPasswordHash ??= bcrypt.hash(TEST_PASSWORD, 10))
      : await bcrypt.hash(password, 10)

  // One transaction: the password and the accepted invitation together.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: number }>(
      `UPDATE users SET password_hash = $1
        WHERE email = $2 AND password_hash IS NULL
       RETURNING id`,
      [passwordHash, email],
    )
    if (rows.length !== 1) {
      throw new Error(
        `activateAccount: no account waiting for a password with email ${email}`,
      )
    }
    await client.query(
      `UPDATE invitations SET accepted_at = now()
        WHERE user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [rows[0].id],
    )
    await client.query('COMMIT')
    return rows[0].id
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
