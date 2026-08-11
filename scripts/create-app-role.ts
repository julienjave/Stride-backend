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

// Creates (or syncs) the restricted, non-superuser, non-table-owning
// Postgres role the app's own runtime queries connect as — step 0 of an
// incremental RLS rollout. RLS policies have no effect at all on a
// superuser or table-owning connection, so this role is the prerequisite
// every future policy will depend on. Run manually/once (and again after
// any migration that adds new tables/sequences, though ALTER DEFAULT
// PRIVILEGES below means that's not strictly required); never imported by
// AppModule — same pattern as scripts/seed-exercises.ts.
//
// Deliberately connects using the EXISTING owner connection
// (getDatabaseUrl()), not the role being created here — creating a role
// and granting privileges requires real admin rights, which stride_app is
// intentionally never given.

import 'dotenv/config'
import { Pool } from 'pg'
import { getDatabaseUrl } from '../src/config/database-url'

// Postgres has no parameter placeholder for identifiers (role/schema
// names) in DDL — they have to be interpolated directly into the SQL
// text. Validating the shape up front, rather than trusting the env var
// blindly, is what keeps that interpolation safe.
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

async function run() {
  const { POSTGRES_APP_USER, POSTGRES_APP_PASSWORD } = process.env

  if (!POSTGRES_APP_USER) {
    throw new Error('Missing required environment variable: POSTGRES_APP_USER')
  }
  if (!POSTGRES_APP_PASSWORD) {
    throw new Error('Missing required environment variable: POSTGRES_APP_PASSWORD')
  }
  if (!IDENTIFIER_PATTERN.test(POSTGRES_APP_USER)) {
    throw new Error(
      `POSTGRES_APP_USER (${POSTGRES_APP_USER}) is not a valid Postgres identifier. ` +
        'Use only lowercase letters, digits, and underscores, starting with a letter or underscore.',
    )
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() })

  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [POSTGRES_APP_USER],
    )

    if (rows.length === 0) {
      console.log(`Role "${POSTGRES_APP_USER}" does not exist yet — creating it...`)
      await pool.query(
        `CREATE ROLE ${POSTGRES_APP_USER} LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}'`,
      )
    } else {
      console.log(`Role "${POSTGRES_APP_USER}" already exists — syncing its password...`)
      await pool.query(
        `ALTER ROLE ${POSTGRES_APP_USER} WITH LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}'`,
      )
    }

    // USAGE on the schema — without this, the role can't even see objects
    // inside `public`, regardless of any table-level grant below.
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${POSTGRES_APP_USER}`)

    // Normal query traffic (via Drizzle) needs exactly these four, and
    // nothing else — deliberately no CREATE/ALTER/DROP TABLE or any other
    // DDL right, verified separately as part of this rollout step.
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${POSTGRES_APP_USER}`,
    )

    // Sequences back every serial/identity primary key — INSERT needs
    // USAGE to call nextval(), and SELECT to read currval()/the sequence
    // itself (e.g. for RETURNING id).
    await pool.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${POSTGRES_APP_USER}`,
    )

    // Without these, every future migration that adds a table or sequence
    // would silently leave it ungranted to stride_app, breaking the app
    // the moment it tried to query the new table — this makes new objects
    // automatically inherit the same grants as everything that exists now.
    // Scoped to whichever role is running THIS script (the owner/migration
    // role) — the same role that actually runs migrations and creates
    // those future tables in the first place.
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_APP_USER}`,
    )
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_APP_USER}`,
    )

    console.log('')
    console.log(`Done. Role "${POSTGRES_APP_USER}" is ready:`)
    console.log('  - NOT a superuser, owns no tables')
    console.log('  - USAGE on schema public')
    console.log('  - SELECT, INSERT, UPDATE, DELETE on all existing tables in public')
    console.log('  - USAGE, SELECT on all existing sequences in public')
    console.log('  - Default privileges set so future tables/sequences are granted automatically')
  } finally {
    await pool.end()
  }
}

run().catch((err) => {
  console.error('create-app-role script failed:', err)
  process.exit(1)
})
