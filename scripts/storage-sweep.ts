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

// npm run storage:sweep                      — lists the files no row uses
// npm run storage:sweep -- --delete          — and deletes them
// npm run storage:sweep -- --min-age-hours=48
//
// Run by hand (decided 2026-10-29), not on a schedule: no scheduler package,
// and no "system" actor to sign audit entries. It writes no audit entry —
// an unreferenced file is not part of anyone's record (the record is the
// rows, and their entries already say when a photo was replaced or
// removed); the printed report is its trace. Every rule it follows is
// explained in scripts/storage/sweep.ts.
//
// It connects as the database OWNER (POSTGRES_USER, like the seeds), and
// builds a StorageService directly — the class reads its settings from the
// environment, so there's no need to boot the whole Nest application.

import 'dotenv/config'
import { Pool } from 'pg'
import { getDatabaseUrl } from '../src/config/database-url'
import { StorageService } from '../src/storage/storage.service'
import {
  parseSweepArgs,
  readReferencedKeys,
  refuseSweep,
  runSweep,
  sweepReport,
  SWEPT_PREFIXES,
} from './storage/sweep'

async function main() {
  const args = parseSweepArgs(process.argv.slice(2))
  const database = process.env.POSTGRES_DB ?? ''
  const refusal = refuseSweep(database)
  if (refusal) throw new Error(refusal)

  const pool = new Pool({ connectionString: getDatabaseUrl() })
  try {
    console.log(
      `${args.delete ? 'Sweeping' : 'Dry run'}: storage folders ${SWEPT_PREFIXES.join(', ')} against the database "${database}".`,
    )
    const result = await runSweep(
      {
        storage: new StorageService(),
        readReferencedKeys: () => readReferencedKeys(pool),
        now: () => new Date(),
      },
      {
        prefixes: SWEPT_PREFIXES,
        minAgeHours: args.minAgeHours,
        delete: args.delete,
      },
    )
    for (const line of sweepReport(result, args)) console.log(line)
    // A file that couldn't be deleted is a failure the person running it
    // must see, even in a script that only checks the exit code.
    if (result.failed.length > 0) process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})