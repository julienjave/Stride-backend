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

// The seed's --reset (scripts/seed/reset.ts) against a real database: it
// DELETES data, so it gets more than unit tests. Two promises to keep:
//   1. everything goes EXCEPT the exercise library (same rows, same ids);
//   2. all or nothing — if one DELETE fails, nothing at all is deleted.
//
// No Nest app here: resetDatabase() only needs a connection. The OWNER
// connection, like the seed script itself (row-level security would hide
// rows from the app's role).

import 'dotenv/config'
import { Pool } from 'pg'
import { getDatabaseUrl } from '../src/config/database-url'
import { resetDatabase } from '../scripts/seed/reset'

describe('Seed reset (e2e)', () => {
  let pool: Pool
  let libraryExerciseId: number

  const count = async (sqlText: string) =>
    Number((await pool.query<{ n: string }>(sqlText)).rows[0].n)

  // A small world: one of everything the reset must delete, plus one
  // library exercise it must keep — referenced by a template, so the
  // template's rows have to go BEFORE anything they point at.
  async function buildWorld() {
    await pool.query(
      'TRUNCATE TABLE users, clinics, exercises, session RESTART IDENTITY CASCADE',
    )
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, first_name, last_name, password_hash)
       VALUES ('reset-${Date.now()}@stride.test', 'Reset', 'Me', 'not-a-real-hash') RETURNING id`,
    )
    const userId = user.rows[0].id
    const clinic = await pool.query<{ id: number }>(
      `INSERT INTO clinics (name, email) VALUES ('Reset Clinic', 'reset@stride.test') RETURNING id`,
    )
    await pool.query(
      'INSERT INTO user_clinics (user_id, clinic_id) VALUES ($1, $2)',
      [userId, clinic.rows[0].id],
    )
    // invited_by is ON DELETE RESTRICT: deleting users first would fail.
    await pool.query(
      `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
       VALUES ($1, md5(random()::text) || md5(random()::text), $1, now() + interval '7 days')`,
      [userId],
    )
    const library = await pool.query<{ id: number }>(
      `INSERT INTO exercises (external_id, name, instructions, source)
       VALUES ('Reset_Library_Exercise', 'Library Squat', '{Stand up}', 'api') RETURNING id`,
    )
    libraryExerciseId = library.rows[0].id
    const custom = await pool.query<{ id: number }>(
      `INSERT INTO exercises (name, instructions, source, created_by)
       VALUES ('My Own Stretch', '{Stretch}', 'custom', $1) RETURNING id`,
      [userId],
    )
    const template = await pool.query<{ id: number }>(
      `INSERT INTO program_templates (practitioner_id, title) VALUES ($1, 'Reset Template') RETURNING id`,
      [userId],
    )
    // Every exercise belongs to one of its template's workouts — another
    // foreign key the reset's deletion order has to respect.
    const workout = await pool.query<{ id: number }>(
      `INSERT INTO template_workouts (template_id, sort_order) VALUES ($1, 0) RETURNING id`,
      [template.rows[0].id],
    )
    await pool.query(
      `INSERT INTO template_exercises (template_id, workout_id, exercise_id, sort_order)
       VALUES ($1, $2, $3, 0), ($1, $2, $4, 1)`,
      [
        template.rows[0].id,
        workout.rows[0].id,
        libraryExerciseId,
        custom.rows[0].id,
      ],
    )
    // A login session: after a reset nobody should stay logged in as a
    // user who no longer exists.
    await pool.query(
      `INSERT INTO session (sid, sess, expire) VALUES ('reset-sid', '{}', now() + interval '1 day')`,
    )
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: getDatabaseUrl() })
    // Same hard check as every e2e suite: this test deletes everything.
    const { rows } = await pool.query<{ db: string }>(
      'SELECT current_database() AS db',
    )
    if (rows[0].db !== 'stride_test') {
      throw new Error(
        `Refusing to run against "${rows[0].db}" — expected "stride_test". Use npm run test:e2e:fresh.`,
      )
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('deletes everything except the exercise library, in an order the foreign keys accept', async () => {
    await buildWorld()
    const migrationsBefore = await count(
      'SELECT count(*) AS n FROM drizzle.__drizzle_migrations',
    )

    const report = await resetDatabase(pool)

    for (const table of [
      'users',
      'clinics',
      'user_clinics',
      'invitations',
      'program_templates',
      'template_exercises',
      'session',
    ]) {
      expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(0)
    }
    // The library exercise is still there — the same row, same id — and
    // only it: the custom exercise went with its author.
    const remaining = await pool.query<{ id: number; source: string }>(
      'SELECT id, source FROM exercises',
    )
    expect(remaining.rows).toEqual([{ id: libraryExerciseId, source: 'api' }])
    // The report says what went (used for the seed's summary line).
    expect(report).toContainEqual({ table: 'users', deleted: 1 })
    expect(report).toContainEqual({ table: 'exercises', deleted: 1 })
    // Drizzle's migration journal (another schema) is untouched.
    expect(
      await count('SELECT count(*) AS n FROM drizzle.__drizzle_migrations'),
    ).toBe(migrationsBefore)
  })

  // A trigger makes the LAST delete (users) fail. If the reset weren't one
  // transaction, everything deleted before it would stay deleted.
  it('deletes nothing at all when one DELETE fails', async () => {
    await buildWorld()
    await pool.query(`
      CREATE FUNCTION refuse_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'users are not deletable right now'; END $$`)
    await pool.query(`
      CREATE TRIGGER refuse_user_delete BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION refuse_user_delete()`)
    try {
      await expect(resetDatabase(pool)).rejects.toThrow(
        'users are not deletable right now',
      )
    } finally {
      await pool.query('DROP TRIGGER refuse_user_delete ON users')
      await pool.query('DROP FUNCTION refuse_user_delete()')
    }

    // Rolled back: the rows deleted BEFORE users are all back.
    expect(await count('SELECT count(*) AS n FROM invitations')).toBe(1)
    expect(await count('SELECT count(*) AS n FROM template_exercises')).toBe(2)
    expect(
      await count(
        "SELECT count(*) AS n FROM exercises WHERE source = 'custom'",
      ),
    ).toBe(1)
    expect(await count('SELECT count(*) AS n FROM session')).toBe(1)
    expect(await count('SELECT count(*) AS n FROM users')).toBe(1)
  })
})
