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

// The storage sweeper (scripts/storage/sweep.ts) against a real database and
// a real S3 server: its query reads every column that holds keys, row
// security can't shorten its answer, and it deletes exactly the old files
// no row uses.
//
// SAFETY OF THE TEST ITSELF: the bucket is shared — with the other suites,
// and on a development machine with the DEVELOPMENT database. Sweeping
// "avatars/" with the test database's references would delete development
// files. So this suite only ever sweeps folders made for this run
// (`avatars/sweep-<uuid>/`…), which nothing else uses; runSweep lists only
// the prefixes it is given.

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { AppModule } from '../src/app.module'
import { getAppDatabaseUrl, getDatabaseUrl } from '../src/config/database-url'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { StorageService } from '../src/storage/storage.service'
import { addDays, utcToday } from '../src/common/calendar-date'
import { readReferencedKeys, runSweep } from '../scripts/storage/sweep'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'

describe('Storage sweeper (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let storage: StorageService

  // This run's own folders, one under each swept prefix.
  const run = `sweep-${randomUUID()}`
  const folders = ['avatars', 'clinics', 'exercises', 'patients'].map(
    (prefix) => `${prefix}/${run}/`,
  )
  // A key a row points at, and an orphan, in each folder.
  const used = folders.map((folder) => `${folder}used.png`)
  const orphans = folders.map((folder) => `${folder}orphan.png`)

  const DAY_AND_AN_HOUR = 25 * 60 * 60 * 1000

  function bodyOf<T>(res: request.Response): T {
    return res.body as T
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue(new InMemoryEmailTransport())
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    sessionPool = new Pool({ connectionString: getDatabaseUrl() })
    const PgSessionStore = connectPgSimple(session)
    app.use(
      session({
        store: new PgSessionStore({
          pool: sessionPool,
          createTableIfMissing: true,
        }),
        secret: 'e2e-test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
      }),
    )
    app.use(passport.initialize())
    app.use(passport.session())
    await app.init()
    storage = app.get(StorageService)

    const { rows } = await sessionPool.query<{ current_database: string }>(
      'SELECT current_database()',
    )
    if (rows[0].current_database !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${rows[0].current_database}" — expected "stride_test".`,
      )
    }
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    // One row of each kind that holds keys, made through the API: a clinic
    // and its admin, an exercise, a patient's program.
    const stamp = Date.now()
    const admin = request.agent(app.getHttpServer())
    const practitioner = request.agent(app.getHttpServer())
    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Sweep E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Sw',
      lastName: 'Admin',
    })
    expect(clinicRes.status).toBe(201)
    const { id: adminId, clinicId } = bodyOf<{ id: number; clinicId: number }>(
      clinicRes,
    )
    const practitionerEmail = `pr-${stamp}@example.com`
    expect(
      (
        await admin.post('/users').send({
          email: practitionerEmail,
          role: 'practitioner',
          firstName: 'Sw',
          lastName: 'Practitioner',
          licenseNumber: `SW-${stamp}`,
          clinicId,
        })
      ).status,
    ).toBe(201)
    await activateAccount(sessionPool, practitionerEmail)
    await practitioner
      .post('/auth/login')
      .send({ email: practitionerEmail, password: 'password123' })
    const patientRes = await practitioner.post('/users').send({
      email: `patient-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Sw',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    expect(patientRes.status).toBe(201)
    const patientId = bodyOf<{ id: number }>(patientRes).id
    const exerciseRes = await practitioner.post('/exercises').send({
      name: 'Sweep E2E Lunge',
      primaryMuscles: ['quadriceps'],
      instructions: ['Lunge'],
    })
    expect(exerciseRes.status).toBe(201)
    const exerciseId = bodyOf<{ id: number }>(exerciseRes).id
    const programRes = await practitioner.post('/assigned-programs').send({
      patientId,
      title: 'Sweep Program',
      startDate: addDays(utcToday(), -1),
      exercises: [{ exerciseId, sets: 1, reps: 1, sortOrder: 0 }],
      schedule: { type: 'times_per_week', timesPerWeek: 2 },
    })
    if (programRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(programRes.body)}`)
    }
    const rowId = bodyOf<{ exercises: { id: number }[] }>(programRes)
      .exercises[0].id

    // Point each row at this run's "used" key, as the owner (no route sets
    // a key of our choosing).
    await sessionPool.query('UPDATE users SET avatar_path = $1 WHERE id = $2', [
      used[0],
      adminId,
    ])
    await sessionPool.query('UPDATE clinics SET logo_path = $1 WHERE id = $2', [
      used[1],
      clinicId,
    ])
    await sessionPool.query(
      'UPDATE exercises SET media_urls = ARRAY[$1] WHERE id = $2',
      [used[2], exerciseId],
    )
    await sessionPool.query(
      'UPDATE assigned_program_exercises SET media_urls = ARRAY[$1] WHERE id = $2',
      [used[3], rowId],
    )
    for (const key of [...used, ...orphans]) {
      await storage.upload(key, Buffer.from(key), 'image/png')
    }
  })

  afterAll(async () => {
    for (const key of used) await storage.deleteUnreferenced(key)
    await app.close()
    await sessionPool.end()
  })

  async function keysInFolders(): Promise<string[]> {
    const keys: string[] = []
    for (const folder of folders) {
      for await (const object of storage.listObjects(folder)) {
        keys.push(object.key)
      }
    }
    return keys.sort()
  }

  const sweep = (options: { delete: boolean; nowShift: number }) =>
    runSweep(
      {
        storage,
        readReferencedKeys: () => readReferencedKeys(sessionPool),
        now: () => new Date(Date.now() + options.nowShift),
      },
      { prefixes: folders, minAgeHours: 24, delete: options.delete },
    )

  // --- the database's answer --------------------------------------------------------------------------------

  it('reads the keys of every column that holds them', async () => {
    const referenced = await readReferencedKeys(sessionPool)
    for (const key of used) expect(referenced.has(key)).toBe(true)
    for (const key of orphans) expect(referenced.has(key)).toBe(false)
  })

  // The app's role is filtered by row security (FORCE ROW LEVEL SECURITY on
  // every table read): with row_security off, Postgres refuses the query
  // instead of answering with the few rows the role may see — which would
  // make every other file look like an orphan.
  it('refuses to answer for a role that row security would filter', async () => {
    const appPool = new Pool({ connectionString: getAppDatabaseUrl() })
    try {
      await expect(readReferencedKeys(appPool)).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining(
          'would be affected by row-level security policy',
        ) as unknown,
      })
      // The connection went back to the pool usable (the failed
      // transaction was rolled back).
      const { rows } = await appPool.query<{ ok: number }>('SELECT 1 AS ok')
      expect(rows).toEqual([{ ok: 1 }])
    } finally {
      await appPool.end()
    }
  })

  // --- the sweep --------------------------------------------------------------------------------------------

  it('lists the orphans without deleting anything in a dry run', async () => {
    const result = await sweep({ delete: false, nowShift: DAY_AND_AN_HOUR })

    expect(result.plan.referenced).toBe(4)
    expect(result.plan.tooRecent).toEqual([])
    expect(result.plan.orphans.map((o) => o.key).sort()).toEqual(
      [...orphans].sort(),
    )
    expect(result.deleted).toEqual([])
    expect(await keysInFolders()).toEqual([...used, ...orphans].sort())
  })

  // The files were written seconds ago: younger than 24 hours, left alone
  // even with --delete.
  it('leaves files younger than the minimum age, even when deleting', async () => {
    const result = await sweep({ delete: true, nowShift: 0 })

    expect(result.plan.orphans).toEqual([])
    expect(result.plan.tooRecent.map((o) => o.key).sort()).toEqual(
      [...orphans].sort(),
    )
    expect(result.deleted).toEqual([])
    expect(await keysInFolders()).toEqual([...used, ...orphans].sort())
  })

  it('deletes the old orphans, and only them', async () => {
    const result = await sweep({ delete: true, nowShift: DAY_AND_AN_HOUR })

    expect([...result.deleted].sort()).toEqual([...orphans].sort())
    expect(result.failed).toEqual([])
    expect(await keysInFolders()).toEqual([...used].sort())
  })
})
