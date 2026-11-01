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

import type { Pool } from 'pg'

// -----------------------------------------------------------------------------------------------------------

// One statement as the tables' OWNER (the pool from POSTGRES_USER: no row
// security, the owner exemptions of the guard triggers), in a transaction
// that is ALWAYS rolled back — so a test can try a write no route would make
// and leave nothing behind. The answer is what a test compares:
//   - { rowCount }            the statement ran (rowCount rows touched);
//   - { code, constraint }    Postgres refused it — its SQLSTATE (23514 for a
//                             CHECK) and the constraint's name.
// The owner bypasses row security but never a CHECK, which is what makes it
// the right actor to prove a CHECK on its own: no policy can be the one
// refusing.
export type OwnerAnswer =
  { rowCount: number } | { code: string; constraint: string | undefined }

export async function asOwner(
  pool: Pool,
  statement: string,
  params: unknown[],
): Promise<OwnerAnswer> {
  // One client for the three statements: BEGIN, the statement and ROLLBACK
  // must run on the SAME connection, or the rollback would undo nothing.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(statement, params)
    return { rowCount: result.rowCount ?? 0 }
  } catch (error) {
    // node-postgres's DatabaseError carries Postgres's fields directly (no
    // drizzle wrapper on a raw pool). Anything else is a real bug in the
    // test — rethrown, never turned into an "answer".
    const fields = error as { code?: unknown; constraint?: unknown }
    if (typeof fields.code !== 'string') throw error
    return {
      code: fields.code,
      constraint:
        typeof fields.constraint === 'string' ? fields.constraint : undefined,
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

// Values with nothing visible: every not-blank CHECK must refuse each one
// (migration 0078). '' and spaces were refused before; the tab, the line
// break and the mix are what the old btrim() rule let through — the values
// that make these tests able to fail on the old CHECKs.
export const BLANK_VALUES = ['', '   ', '\t', '\n', ' \t\r\n '] as const
