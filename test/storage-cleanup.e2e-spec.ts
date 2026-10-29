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

// An upload whose database save FAILS leaves no file behind (decided
// 2026-10-29): the library's photos, avatars and clinic logos now undo what
// they stored (src/storage/compensation.ts), as program photos already did.
//
// How a save is made to fail on purpose: a trigger PLANTED in stride_test
// (as the owner) refusing every UPDATE of the table, dropped again in a
// `finally`. The request then answers 500 — and the bucket must hold no new
// file under the resource's folder.
//
// The bucket is SHARED (with earlier suites, and on a development machine
// with the development database), so the tests never assert "the folder is
// empty": they compare the folder's keys before and after. Nothing here
// deletes anything in storage.

import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { StorageService } from '../src/storage/storage.service'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'

describe('Uploads undo their files when the save fails (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let storage: StorageService

  let admin: ReturnType<typeof request.agent>
  let practitioner: ReturnType<typeof request.agent>

  let adminId: number
  let clinicId: number
  let exerciseId: number

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

    const stamp = Date.now()
    admin = request.agent(app.getHttpServer())
    practitioner = request.agent(app.getHttpServer())
    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Cleanup E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Cl',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(clinicRes.body)}`)
    }
    clinicId = bodyOf<{ clinicId: number }>(clinicRes).clinicId
    adminId = bodyOf<{ id: number }>(clinicRes).id

    const email = `pr-${stamp}@example.com`
    const created = await admin.post('/users').send({
      email,
      role: 'practitioner',
      firstName: 'Cl',
      lastName: 'Practitioner',
      licenseNumber: `CL-${stamp}`,
      clinicId,
    })
    expect(created.status).toBe(201)
    await activateAccount(sessionPool, email)
    await practitioner
      .post('/auth/login')
      .send({ email, password: 'password123' })

    const exercise = await practitioner.post('/exercises').send({
      name: 'Cleanup E2E Squat',
      primaryMuscles: ['quadriceps'],
      instructions: ['Squat'],
    })
    expect(exercise.status).toBe(201)
    exerciseId = bodyOf<{ id: number }>(exercise).id
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- helpers ---------------------------------------------------------------------------------------------

  async function keysUnder(prefix: string): Promise<string[]> {
    const keys: string[] = []
    for await (const object of storage.listObjects(prefix)) {
      keys.push(object.key)
    }
    return keys
  }

  // Runs `send` while every UPDATE of `table` fails; the trigger is dropped
  // whatever happens, so a failing test can't leave it for the next suite.
  async function withFailingUpdates<T>(
    table: 'exercises' | 'users' | 'clinics',
    send: () => Promise<T>,
  ): Promise<T> {
    await sessionPool.query(
      `CREATE OR REPLACE FUNCTION test_storage_cleanup_fail() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'planted failure'; END $$`,
    )
    await sessionPool.query(
      `CREATE TRIGGER test_storage_cleanup_fail BEFORE UPDATE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION test_storage_cleanup_fail()`,
    )
    try {
      return await send()
    } finally {
      await sessionPool.query(
        `DROP TRIGGER IF EXISTS test_storage_cleanup_fail ON ${table}`,
      )
      await sessionPool.query(
        'DROP FUNCTION IF EXISTS test_storage_cleanup_fail()',
      )
    }
  }

  const newKeys = (before: string[], after: string[]) =>
    after.filter((key) => !before.includes(key))

  // --- the library -----------------------------------------------------------------------------------------

  describe("the library's photos", () => {
    const folder = () => `exercises/${exerciseId}/`
    const uploadTwo = () =>
      practitioner
        .post(`/exercises/${exerciseId}/images`)
        .attach('files', Buffer.from('one'), {
          filename: 'one.png',
          contentType: 'image/png',
        })
        .attach('files', Buffer.from('two'), {
          filename: 'two.png',
          contentType: 'image/png',
        })

    // The control: a working upload DOES add files the listing sees — so
    // "no new file" below can't pass just because the listing is blind.
    it('stores the files of an upload that is saved', async () => {
      const before = await keysUnder(folder())
      const res = await uploadTwo()
      expect(res.status).toBe(201)
      const saved = bodyOf<{ images: { objectKey: string }[] }>(res).images.map(
        (image) => image.objectKey,
      )
      expect(newKeys(before, await keysUnder(folder())).sort()).toEqual(
        [...saved].sort(),
      )
    })

    it('deletes the files it stored when the save fails, and the exercise keeps its photos', async () => {
      const listBefore = await practitioner.get(`/exercises/${exerciseId}`)
      const photosBefore = bodyOf<{ images: { objectKey: string }[] }>(
        listBefore,
      ).images.map((image) => image.objectKey)
      const before = await keysUnder(folder())

      const res = await withFailingUpdates('exercises', uploadTwo)

      expect(res.status).toBe(500)
      expect(newKeys(before, await keysUnder(folder()))).toEqual([])
      const after = await practitioner.get(`/exercises/${exerciseId}`)
      expect(
        bodyOf<{ images: { objectKey: string }[] }>(after).images.map(
          (image) => image.objectKey,
        ),
      ).toEqual(photosBefore)
    })
  })

  // --- avatars ---------------------------------------------------------------------------------------------

  describe('avatars', () => {
    const folder = () => `avatars/${adminId}/`
    const upload = () =>
      admin
        .post(`/users/${adminId}/avatar`)
        .attach('file', Buffer.from('face'), {
          filename: 'face.png',
          contentType: 'image/png',
        })
    const avatarPath = async () =>
      (
        await sessionPool.query<{ avatar_path: string | null }>(
          'SELECT avatar_path FROM users WHERE id = $1',
          [adminId],
        )
      ).rows[0].avatar_path

    it('stores the photo of an upload that is saved', async () => {
      const before = await keysUnder(folder())
      expect((await upload()).status).toBe(201)
      expect(newKeys(before, await keysUnder(folder()))).toEqual([
        await avatarPath(),
      ])
    })

    // The account keeps the photo it had, and its file is still there.
    it('deletes the photo it stored when the save fails', async () => {
      const kept = await avatarPath()
      const before = await keysUnder(folder())

      const res = await withFailingUpdates('users', upload)

      expect(res.status).toBe(500)
      const after = await keysUnder(folder())
      expect(newKeys(before, after)).toEqual([])
      expect(await avatarPath()).toBe(kept)
      expect(after).toContain(kept)
    })
  })

  // --- clinic logos ----------------------------------------------------------------------------------------

  describe('clinic logos', () => {
    const folder = () => `clinics/${clinicId}/`
    const upload = () =>
      admin
        .post(`/clinics/${clinicId}/logo`)
        .attach('file', Buffer.from('logo'), {
          filename: 'logo.png',
          contentType: 'image/png',
        })
    const logoPath = async () =>
      (
        await sessionPool.query<{ logo_path: string | null }>(
          'SELECT logo_path FROM clinics WHERE id = $1',
          [clinicId],
        )
      ).rows[0].logo_path

    it('stores the logo of an upload that is saved', async () => {
      const before = await keysUnder(folder())
      expect((await upload()).status).toBe(201)
      expect(newKeys(before, await keysUnder(folder()))).toEqual([
        await logoPath(),
      ])
    })

    it('deletes the logo it stored when the save fails', async () => {
      const kept = await logoPath()
      const before = await keysUnder(folder())

      const res = await withFailingUpdates('clinics', upload)

      expect(res.status).toBe(500)
      const after = await keysUnder(folder())
      expect(newKeys(before, after)).toEqual([])
      expect(await logoPath()).toBe(kept)
      expect(after).toContain(kept)
    })
  })
})
