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

// The storage sweeper's logic (decided 2026-10-29): find the files in storage
// that no database row points at, and — only when asked — delete them. The
// command itself is scripts/storage-sweep.ts; everything it decides is here,
// in functions a test can call with plain values (sweep.spec.ts) or with a
// real database and a real S3 server (test/storage-sweep.e2e-spec.ts).
//
// Why files get left behind at all: storage is not part of a database
// transaction. The app undoes what it can (src/storage/compensation.ts), but
// a best-effort delete that fails — the storage server down for a moment —
// only logs a warning, and `npm run seed:dev -- --reset` deletes rows, not
// files. This is the net under all of them.
//
// The safety rules, each one below where it's enforced:
//   1. Dry run by default: without --delete it only PRINTS.
//   2. A minimum age (24 hours by default): a file uploaded a second ago may
//      not be saved on its row YET (the upload comes first, then the
//      transaction) — it must never be mistaken for an orphan.
//   3. Storage is listed FIRST, the database read AFTER (runSweep): a key
//      saved on a row at any moment before the read is seen as referenced.
//   4. The database is read with row security OFF, or not at all
//      (readReferencedKeys): a role that row security would filter gets an
//      error, never a silently short list — a short list would make every
//      hidden file look like an orphan.
//   5. Only the app's own folders are listed (SWEPT_PREFIXES): a file put in
//      the bucket by anything else is never even looked at.
//   6. Never against a database ending in _test (refuseSweep): on a
//      development machine the e2e tests share the bucket with the
//      development database, so sweeping with the TEST database's references
//      would delete every development file.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type { Pool } from 'pg'
import type { StoredObject } from '../../src/storage/storage.service'

// --- WHAT IS SWEPT -----------------------------------------------------------------------------------------

// The folders the app writes files into — every key the app builds starts
// with one of these (users.service.ts, clinics.service.ts,
// exercises.service.ts and scripts/seed-exercises.ts, program-photos.ts).
export const SWEPT_PREFIXES = [
  'avatars/',
  'clinics/',
  'exercises/',
  'patients/',
] as const

// Every database column that holds storage keys. A NEW column holding keys
// must be added here, or the sweeper would take its files for orphans and
// delete them — sweep.spec.ts fails if a column named `…_path` or
// `media_urls` appears in the schema without being listed here.
//   - `array`: a text[] of keys (unnest gives one row per key), else one key
//     or NULL.
export const REFERENCE_COLUMNS = [
  { table: 'users', column: 'avatar_path', array: false },
  { table: 'clinics', column: 'logo_path', array: false },
  { table: 'exercises', column: 'media_urls', array: true },
  { table: 'assigned_program_exercises', column: 'media_urls', array: true },
] as const

// The query, built from the list above: one key per row, each key once
// (UNION, not UNION ALL — a key in two places only needs saying once).
// The names come from the constant above, never from input, so building
// the text is safe here.
export const REFERENCED_KEYS_SQL = REFERENCE_COLUMNS.map(
  ({ table, column, array }) =>
    array
      ? `SELECT unnest(${column}) AS key FROM ${table}`
      : `SELECT ${column} AS key FROM ${table} WHERE ${column} IS NOT NULL`,
).join('\nUNION\n')

// --- THE COMMAND'S ARGUMENTS -------------------------------------------------------------------------------

export const DEFAULT_MIN_AGE_HOURS = 24

export interface SweepArgs {
  delete: boolean
  minAgeHours: number
}

// `--delete` and `--min-age-hours=N` (a whole number of hours, at least 1 —
// 0 would remove the guard against an upload whose row isn't saved yet).
// Anything else is refused rather than ignored: a mistyped `--delet` must
// not quietly turn into a dry run that looks like it did nothing.
export function parseSweepArgs(argv: readonly string[]): SweepArgs {
  const args: SweepArgs = {
    delete: false,
    minAgeHours: DEFAULT_MIN_AGE_HOURS,
  }
  for (const arg of argv) {
    if (arg === '--delete') {
      args.delete = true
      continue
    }
    const minAge = /^--min-age-hours=(\d+)$/.exec(arg)
    if (minAge) {
      const hours = Number(minAge[1])
      if (hours < 1) {
        throw new Error(
          '--min-age-hours must be at least 1: a younger file may belong to an upload whose row is not saved yet.',
        )
      }
      args.minAgeHours = hours
      continue
    }
    throw new Error(
      `Unknown argument "${arg}". Use --delete to delete (without it, nothing is deleted) and --min-age-hours=N (default ${DEFAULT_MIN_AGE_HOURS}).`,
    )
  }
  return args
}

// Rule 6 above. Returns the refusal's sentence, or null when the database
// may be swept — the shape of the seed's refuseSeed (scripts/seed/safety.ts).
export function refuseSweep(database: string): string | null {
  if (database.endsWith('_test')) {
    return `Refusing to sweep with "${database}": databases ending in _test belong to the e2e tests, and their files share the bucket with the development database's — sweeping with the test database's references would delete the development files. Sweep with the development database (POSTGRES_DB in .env).`
  }
  return null
}

// --- THE PLAN ----------------------------------------------------------------------------------------------

export interface SweepPlan {
  // Not referenced and old enough: what --delete deletes.
  orphans: StoredObject[]
  // Not referenced, but younger than the minimum age: left alone.
  tooRecent: StoredObject[]
  // How many listed objects some row points at.
  referenced: number
}

// Sorts each listed object into one of the three groups. Pure: the clock
// and the minimum age are parameters, so a test pins both.
export function planSweep(
  objects: readonly StoredObject[],
  referencedKeys: ReadonlySet<string>,
  now: Date,
  minAgeMs: number,
): SweepPlan {
  const plan: SweepPlan = { orphans: [], tooRecent: [], referenced: 0 }
  for (const object of objects) {
    if (referencedKeys.has(object.key)) {
      plan.referenced += 1
    } else if (now.getTime() - object.lastModified.getTime() < minAgeMs) {
      plan.tooRecent.push(object)
    } else {
      plan.orphans.push(object)
    }
  }
  return plan
}

// --- READING THE DATABASE ----------------------------------------------------------------------------------

// Every key a row points at, as a Set (constant-time "is this key used?").
//
// `SET LOCAL row_security = off` (rule 4): every one of these tables has
// FORCE ROW LEVEL SECURITY, so even their owner is filtered — unless it is
// a superuser or has BYPASSRLS. With row_security off, Postgres does NOT
// filter: a query that row security WOULD affect fails with an error
// ("query would be affected by row-level security policy"). So the answer
// is either complete or an error; never a short list. LOCAL: the setting
// ends with this transaction, so the connection goes back to the pool as
// it came. READ ONLY: the sweep never writes to the database.
export async function readReferencedKeys(pool: Pool): Promise<Set<string>> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL row_security = off')
    const { rows } = await client.query<{ key: string }>(REFERENCED_KEYS_SQL)
    await client.query('COMMIT')
    return new Set(rows.map((row) => row.key))
  } catch (error) {
    // The transaction is already failed; ROLLBACK ends it so the client
    // can go back to the pool. Its own failure would hide the real error.
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

// --- THE SWEEP ---------------------------------------------------------------------------------------------

export interface SweepDependencies {
  storage: {
    listObjects(prefix: string): AsyncIterable<StoredObject>
    delete(key: string): Promise<void>
  }
  readReferencedKeys: () => Promise<ReadonlySet<string>>
  now: () => Date
}

export interface SweepOptions {
  prefixes: readonly string[]
  minAgeHours: number
  delete: boolean
}

export interface SweepResult {
  plan: SweepPlan
  deleted: string[]
  failed: { key: string; reason: string }[]
}

export async function runSweep(
  dependencies: SweepDependencies,
  options: SweepOptions,
): Promise<SweepResult> {
  // 1. Storage first (rule 3). The clock is read after the listing, so an
  //    object listed is judged against a "now" no earlier than its listing.
  const objects: StoredObject[] = []
  for (const prefix of options.prefixes) {
    for await (const object of dependencies.storage.listObjects(prefix)) {
      objects.push(object)
    }
  }
  // 2. Then the database: any key saved before this read is referenced.
  const referencedKeys = await dependencies.readReferencedKeys()
  const plan = planSweep(
    objects,
    referencedKeys,
    dependencies.now(),
    options.minAgeHours * 60 * 60 * 1000,
  )

  const result: SweepResult = { plan, deleted: [], failed: [] }
  if (!options.delete) return result

  // 3. One at a time, each failure noted and the sweep going on: one file
  //    the server won't delete shouldn't keep the others. delete(), not
  //    deleteUnreferenced(): the sweep wants to KNOW what failed, to report
  //    it and end with a failing exit code.
  for (const orphan of plan.orphans) {
    try {
      await dependencies.storage.delete(orphan.key)
      result.deleted.push(orphan.key)
    } catch (error) {
      result.failed.push({
        key: orphan.key,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

// --- THE REPORT --------------------------------------------------------------------------------------------

// What the command prints, as lines. Dates in ISO form (UTC): a log read
// later, on another machine, means the same moment.
export function sweepReport(
  result: SweepResult,
  options: Pick<SweepOptions, 'delete' | 'minAgeHours'>,
): string[] {
  const { plan } = result
  const lines: string[] = []
  const total = plan.referenced + plan.tooRecent.length + plan.orphans.length
  lines.push(
    `Listed ${total} file(s): ${plan.referenced} in use, ${plan.tooRecent.length} not in use but younger than ${options.minAgeHours} hour(s) (left alone), ${plan.orphans.length} not in use.`,
  )
  if (plan.orphans.length === 0) {
    lines.push('Nothing to delete.')
    return lines
  }
  if (!options.delete) {
    lines.push('Not in use (dry run — nothing deleted; add --delete):')
    for (const orphan of plan.orphans) {
      lines.push(
        `  ${orphan.key}  (${orphan.size} bytes, written ${orphan.lastModified.toISOString()})`,
      )
    }
    return lines
  }
  lines.push(`Deleted ${result.deleted.length} file(s):`)
  for (const key of result.deleted) lines.push(`  ${key}`)
  if (result.failed.length > 0) {
    lines.push(`Could not delete ${result.failed.length} file(s):`)
    for (const { key, reason } of result.failed) {
      lines.push(`  ${key}: ${reason}`)
    }
  }
  return lines
}