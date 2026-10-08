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

import type { Pool } from 'pg'
import { deletionOrder, type ForeignKey } from './deletion-order'

// Rows the reset KEEPS, per table, as a SQL condition. Everything else in
// every table of the `public` schema is deleted.
//
// The exercise library (source 'api', imported by `npm run
// seed:exercises`) survives: it takes minutes to download again and
// belongs to nobody. Custom exercises go with their authors.
export const KEPT_ROWS: Record<string, string> = {
  exercises: "source = 'api'",
}

// Why DELETE and not TRUNCATE: `TRUNCATE users CASCADE` empties EVERY table
// with a foreign key to users, whatever its rows — exercises.created_by
// points at users, so the whole library would go. And TRUNCATE without
// CASCADE refuses a table that other tables reference unless they're all
// in the same statement. DELETE goes row by row and respects each key's
// rule, so it can keep rows — in the right order (deletionOrder).
export async function resetDatabase(
  pool: Pool,
): Promise<{ table: string; deleted: number }[]> {
  const client = await pool.connect()
  try {
    // From Postgres's own catalog, so a table added by a future migration
    // is reset too, with no change here. (Drizzle's migration journal lives
    // in the separate `drizzle` schema: untouched.)
    const tables = (
      await client.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`,
      )
    ).rows.map((row) => row.name)
    const foreignKeys = (
      await client.query<ForeignKey>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to"
           FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE c.contype = 'f' AND n.nspname = 'public'`,
      )
    ).rows

    // ONE transaction: if any DELETE fails, ROLLBACK undoes all of them —
    // never a half-reset database.
    await client.query('BEGIN')
    const report: { table: string; deleted: number }[] = []
    for (const table of deletionOrder(tables, foreignKeys)) {
      // Table names come from the catalog, not from input — still quoted,
      // as identifiers (doubling any `"`), never pasted raw.
      const quoted = `"${table.replace(/"/g, '""')}"`
      const keep = KEPT_ROWS[table]
      const result = await client.query(
        keep
          ? `DELETE FROM ${quoted} WHERE NOT (${keep})`
          : `DELETE FROM ${quoted}`,
      )
      report.push({ table, deleted: result.rowCount ?? 0 })
    }
    await client.query('COMMIT')
    return report
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}