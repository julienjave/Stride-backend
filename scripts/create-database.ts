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
// -----------------------------------------------------------------------------------------------------------

// Creates the database named by POSTGRES_DB if it doesn't exist yet — the
// first step of `npm run db:prepare:e2e` (decisions §34), which gives the
// browser suite its OWN database, `stride_e2e`, beside the development one
// (`stride`) and the API suites' one (`stride_test`).
//
// Why a script: `CREATE DATABASE` can't run inside the database it creates,
// and drizzle-kit's migrate only connects to a database that already exists.
// So this one connects to `postgres` — the maintenance database every
// Postgres server has — as the owner (POSTGRES_USER, from .env), asks
// whether the database exists, and creates it when it doesn't. Running it
// twice is harmless: the second run finds it and says so.
//
// Like create-app-role.ts: run by hand (through npm), never imported by the
// app.

import 'dotenv/config'
import { Client } from 'pg'
import { getDatabaseUrl } from '../src/config/database-url'

// Postgres has no placeholder for an identifier in DDL, so the name is put
// into the SQL text itself — which is only safe once its shape is checked:
// lowercase letters, digits and underscores, starting with a letter or an
// underscore (the same rule as create-app-role.ts's role name). No quote
// can then get in.
const DATABASE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/

// The statement for a name, or why the name is refused. Pure, so the rule
// is tested without a server (create-database.spec.ts).
export function createDatabaseStatement(name: string | undefined): string {
  if (!name) {
    throw new Error('Missing required environment variable: POSTGRES_DB')
  }
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `POSTGRES_DB (${name}) is not a valid database name for this script. ` +
        'Use only lowercase letters, digits, and underscores, starting with a letter or underscore.',
    )
  }
  return `CREATE DATABASE ${name}`
}

// The owner's connection, pointed at the maintenance database instead of
// POSTGRES_DB: the same host, port, user and password — only the path (the
// database name, after the last "/") changes.
export function maintenanceDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.pathname = '/postgres'
  return url.toString()
}

async function run(): Promise<void> {
  const name = process.env.POSTGRES_DB
  const statement = createDatabaseStatement(name)
  const client = new Client({
    connectionString: maintenanceDatabaseUrl(getDatabaseUrl()),
  })
  await client.connect()
  try {
    // pg_database lists every database on the server; the name IS a
    // parameter here (a value, not an identifier).
    const found = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    )
    if (found.rowCount === 0) {
      await client.query(statement)
      console.log(`Created database "${name}".`)
    } else {
      console.log(`Database "${name}" already exists.`)
    }
  } finally {
    await client.end()
  }
}

// Only when run as a script (`ts-node scripts/create-database.ts`), not when
// the spec imports the two functions above.
if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}