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

// Same reason as every e2e file: Jest never auto-loads .env, and AppModule
// needs POSTGRES_* the moment it's built.
import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql, type SQL } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { StorageService } from '../src/storage/storage.service'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { addDays, utcToday } from '../src/common/calendar-date'

// Program-specific photos (decided 2026-10-17): a program exercise shows the
// library's photos (live, the default) or photos of its OWN — uploaded for
// this patient, or copied from the library — chosen with
// `useLibraryImages`. Proven here against the real database AND a real S3
// API (moto in the sandbox, RustFS on the developer's machine): the files
// are stored, copied, served by signed URLs and deleted for real.
//
// Its own file, like program-exercises.e2e-spec.ts: rate limits are off in
// the e2e suites (test/support/e2e-env.ts).
describe('Program exercise photos (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb
  let storage: StorageService

  let admin: ReturnType<typeof request.agent>
  // On the patient's care team.
  let practitionerA: ReturnType<typeof request.agent>
  // Same clinic, NOT on the care team.
  let practitionerC: ReturnType<typeof request.agent>
  let patient: ReturnType<typeof request.agent>

  let patientId: number
  let practitionerAId: number
  // A library exercise WITH two photos (uploaded by A), and one without.
  let bridgeId: number
  let plankId: number
  let libraryKeys: string[]
  let templateId: number

  const today = utcToday()

  function bodyOf<T>(res: request.Response): T {
    return res.body as T
  }

  interface Exercise {
    id: number
    exerciseId: number
    retiredAt: string | null
    useLibraryImages: boolean
    images: { url: string }[]
    ownImages: { objectKey: string; url: string }[]
  }
  interface Program {
    id: number
    workouts: { id: number }[]
    exercises: Exercise[]
    retiredExercises: Exercise[]
  }
  interface ErrorBody {
    message: string[]
  }
  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    details: Record<string, unknown> | null
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

    // Never anything but the dedicated test database (see
    // assigned-programs.e2e-spec.ts for why this check exists).
    db = app.get<DrizzleDb>(DRIZZLE)
    storage = app.get(StorageService)
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
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
    practitionerA = request.agent(app.getHttpServer())
    practitionerC = request.agent(app.getHttpServer())
    patient = request.agent(app.getHttpServer())

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Photos E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Ph',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(clinicRes.body)}`)
    }
    const clinicId = bodyOf<{ clinicId: number }>(clinicRes).clinicId

    async function createUser(
      body: Record<string, unknown>,
      agent: ReturnType<typeof request.agent>,
    ): Promise<number> {
      const res = await admin.post('/users').send({ ...body, clinicId })
      if (res.status !== 201) {
        throw new Error(`Setup failed: ${JSON.stringify(res.body)}`)
      }
      await activateAccount(sessionPool, body.email as string)
      await agent
        .post('/auth/login')
        .send({ email: body.email, password: 'password123' })
      return bodyOf<{ id: number }>(res).id
    }

    practitionerAId = await createUser(
      {
        email: `pa-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'A',
        licenseNumber: `PH-A-${stamp}`,
      },
      practitionerA,
    )
    await createUser(
      {
        email: `pc-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'C',
        licenseNumber: `PH-C-${stamp}`,
      },
      practitionerC,
    )
    patientId = await createUser(
      {
        email: `patient-${stamp}@example.com`,
        role: 'patient',
        firstName: 'Ph',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
      },
      patient,
    )
    const join = await practitionerA
      .post(`/users/${patientId}/care-team`)
      .send({})
    expect(join.status).toBe(201)

    const ids: number[] = []
    for (const name of ['Photos E2E Bridge', 'Photos E2E Plank']) {
      const res = await practitionerA.post('/exercises').send({
        name,
        primaryMuscles: ['core'],
        instructions: ['Do it'],
      })
      expect(res.status).toBe(201)
      ids.push(bodyOf<{ id: number }>(res).id)
    }
    ;[bridgeId, plankId] = ids
    const uploaded = await practitionerA
      .post(`/exercises/${bridgeId}/images`)
      .attach('files', Buffer.from('library-one'), {
        filename: 'one.png',
        contentType: 'image/png',
      })
      .attach('files', Buffer.from('library-two'), {
        filename: 'two.jpg',
        contentType: 'image/jpeg',
      })
    expect(uploaded.status).toBe(201)
    libraryKeys = bodyOf<{ images: { objectKey: string }[] }>(
      uploaded,
    ).images.map((image) => image.objectKey)

    const created = await practitionerA
      .post('/programs')
      .send({ title: 'Photos Template' })
    templateId = bodyOf<{ id: number }>(created).id
    for (const [sortOrder, exerciseId] of [bridgeId, plankId].entries()) {
      const res = await practitionerA
        .post(`/programs/${templateId}/exercises`)
        .send({ exerciseId, sets: 2, reps: 10, sortOrder })
      expect(res.status).toBe(201)
    }
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- Helpers -----------------------------------------------------------------------------------------------

  // A program for the patient from the template, every day workout A,
  // started yesterday.
  async function assign(): Promise<Program> {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnTemplateId: templateId,
      title: 'Photos Program',
      startDate: addDays(today, -1),
      schedule: {
        type: 'weekdays',
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          workoutIndex: 0,
        })),
      },
    })
    expect(res.status).toBe(201)
    return bodyOf<Program>(res)
  }

  const bridgeOf = (program: Program) =>
    program.exercises.find((e) => e.exerciseId === bridgeId)!
  const plankOf = (program: Program) =>
    program.exercises.find((e) => e.exerciseId === plankId)!
  const imagesPath = (program: Program, row: Exercise) =>
    `/assigned-programs/${program.id}/exercises/${row.id}/images`

  // Uploads `count` small PNGs, each holding its own text.
  function upload(
    agent: ReturnType<typeof request.agent>,
    path: string,
    contents: string[],
  ) {
    let req = agent.post(path)
    for (const [index, text] of contents.entries()) {
      req = req.attach('files', Buffer.from(text), {
        filename: `photo-${index}.png`,
        contentType: 'image/png',
      })
    }
    return req
  }

  // What storage serves at a signed URL — the file's text, or its status
  // when there is none.
  async function contentAt(url: string) {
    const res = await fetch(url)
    return res.status === 200 ? await res.text() : res.status
  }
  // Whether a key still holds a file (signed here, then fetched).
  async function contentOfKey(key: string) {
    return contentAt(await storage.getPresignedUrl(key))
  }
  // A signed URL's PATH names the file (its query changes at every signing).
  const pathOf = (url: string) => new URL(url).pathname

  async function auditTrail(programId: number) {
    // The generic interceptor would write AFTER the response: the pause
    // gives a duplicate the chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, details FROM audit_logs
       WHERE entity_type = 'assigned-programs' AND entity_id = $1 ORDER BY id`,
      [programId],
    )
    return rows
  }
  // The entries after the program's creation: every one a NAMED action (a
  // route that lost @AuditedByService() would add the interceptor's own
  // "POST /assigned-programs/…" entry), by A, about the patient.
  async function changeEntries(programId: number) {
    const trail = await auditTrail(programId)
    expect(trail[0].action).toBe('ASSIGNED_PROGRAM_CREATED')
    for (const entry of trail.slice(1)) {
      expect(entry.action).toMatch(/^ASSIGNED_PROGRAM_[A-Z_]+$/)
      expect(entry.performed_by).toBe(practitionerAId)
      expect(entry.target_user_id).toBe(patientId)
    }
    return trail.slice(1)
  }

  const KEY = new RegExp(
    '^patients/(\\d+)/exercise-photos/[0-9a-f-]{36}\\.(png|jpg)$',
  )

  // --- 1. The default ----------------------------------------------------------------------------------------

  it("shows the library's photos by default, with no own photos", async () => {
    const program = await assign()
    const bridge = bridgeOf(program)
    expect(bridge.useLibraryImages).toBe(true)
    expect(bridge.ownImages).toEqual([])
    expect(
      await Promise.all(bridge.images.map((i) => contentAt(i.url))),
    ).toEqual(['library-one', 'library-two'])
  })

  // --- 2. Uploading, choosing, the patient's view --------------------------------------------------------------

  describe('uploading, then choosing them', () => {
    let program: Program

    beforeAll(async () => {
      program = await assign()
    })

    it("stores the files in the PATIENT's folder, without switching what the patient sees", async () => {
      const res = await upload(
        practitionerA,
        imagesPath(program, bridgeOf(program)),
        ['chair', 'band'],
      )
      expect(res.status).toBe(201)
      program = bodyOf<Program>(res)
      const bridge = bridgeOf(program)
      const keys = bridge.ownImages.map((image) => image.objectKey)
      expect(keys).toHaveLength(2)
      for (const key of keys) {
        expect(key).toMatch(KEY)
        expect(KEY.exec(key)![1]).toBe(String(patientId))
      }
      expect(
        await Promise.all(bridge.ownImages.map((i) => contentAt(i.url))),
      ).toEqual(['chair', 'band'])
      // Still the library's: adding photos never switches the choice.
      expect(bridge.useLibraryImages).toBe(true)
      expect(
        await Promise.all(bridge.images.map((i) => contentAt(i.url))),
      ).toEqual(['library-one', 'library-two'])

      const [entry] = (await changeEntries(program.id)).slice(-1)
      expect(entry.action).toBe('ASSIGNED_PROGRAM_EXERCISE_PHOTOS_ADDED')
      expect(entry.details).toStrictEqual({
        exerciseRowId: bridge.id,
        name: 'Photos E2E Bridge',
        added: keys,
        source: 'upload',
      })
    })

    it('shows them to the patient once chosen, with one entry for the switch', async () => {
      const bridge = bridgeOf(program)
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${bridge.id}`)
        .send({ useLibraryImages: false })
      expect(res.status).toBe(200)
      const after = bridgeOf(bodyOf<Program>(res))
      expect(after.useLibraryImages).toBe(false)
      expect(
        await Promise.all(after.images.map((i) => contentAt(i.url))),
      ).toEqual(['chair', 'band'])

      const [entry] = (await changeEntries(program.id)).slice(-1)
      expect(entry.action).toBe('ASSIGNED_PROGRAM_EXERCISE_UPDATED')
      expect(entry.details).toStrictEqual({
        exerciseRowId: bridge.id,
        name: 'Photos E2E Bridge',
        changes: { useLibraryImages: { from: true, to: false } },
      })

      // The patient reads their own program — under THEIR database context.
      const mine = await patient.get(`/assigned-programs/${program.id}`)
      expect(mine.status).toBe(200)
      const seen = bridgeOf(bodyOf<Program>(mine))
      expect(
        await Promise.all(seen.images.map((i) => contentAt(i.url))),
      ).toEqual(['chair', 'band'])
      // An exercise left on the library keeps showing the library's (none).
      expect(plankOf(bodyOf<Program>(mine)).images).toEqual([])
    })

    it('keeps them when switching back to the library', async () => {
      const bridge = bridgeOf(program)
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${bridge.id}`)
        .send({ useLibraryImages: true })
      expect(res.status).toBe(200)
      const after = bridgeOf(bodyOf<Program>(res))
      expect(after.ownImages.map((i) => i.objectKey)).toEqual(
        bridge.ownImages.map((i) => i.objectKey),
      )
      expect(
        await Promise.all(after.images.map((i) => contentAt(i.url))),
      ).toEqual(['library-one', 'library-two'])
    })

    // The null trap (is-present.ts) and a string that LOOKS like a boolean.
    it.each([[null], ['false']])(
      'refuses useLibraryImages %p with a 400',
      async (value) => {
        const res = await practitionerA
          .patch(
            `/assigned-programs/${program.id}/exercises/${bridgeOf(program).id}`,
          )
          .send({ useLibraryImages: value })
        expect(res.status).toBe(400)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'useLibraryImages must be a boolean value',
        ])
      },
    )
  })

  // --- 3. Copying the library's photos -----------------------------------------------------------------------

  describe("copying the library's photos", () => {
    let program: Program

    beforeAll(async () => {
      program = await assign()
    })

    it('copies them as NEW files, in order, recording where each came from', async () => {
      const bridge = bridgeOf(program)
      const res = await practitionerA.post(
        `${imagesPath(program, bridge)}/from-library`,
      )
      expect(res.status).toBe(201)
      program = bodyOf<Program>(res)
      const copies = bridgeOf(program).ownImages
      expect(copies.map((i) => i.objectKey)).toEqual([
        expect.stringMatching(/\.png$/),
        expect.stringMatching(/\.jpg$/),
      ])
      for (const copy of copies) expect(copy.objectKey).toMatch(KEY)
      expect(await Promise.all(copies.map((i) => contentAt(i.url)))).toEqual([
        'library-one',
        'library-two',
      ])

      const [entry] = (await changeEntries(program.id)).slice(-1)
      expect(entry.details).toStrictEqual({
        exerciseRowId: bridge.id,
        name: 'Photos E2E Bridge',
        added: copies.map((i) => i.objectKey),
        source: 'library',
        copiedFrom: libraryKeys,
      })
    })

    // The point of a copy: the library can change without reaching it.
    it("keeps the copies when the library's photo is removed", async () => {
      const removed = await practitionerA
        .delete(`/exercises/${bridgeId}/images`)
        .send({ objectKey: libraryKeys[1] })
      expect(removed.status).toBe(200)
      // Put back for the other tests (a new key: re-uploaded).
      const back = await practitionerA
        .post(`/exercises/${bridgeId}/images`)
        .attach('files', Buffer.from('library-two'), {
          filename: 'two.jpg',
          contentType: 'image/jpeg',
        })
      expect(back.status).toBe(201)
      libraryKeys = bodyOf<{ images: { objectKey: string }[] }>(
        back,
      ).images.map((image) => image.objectKey)

      const res = await practitionerA.get(`/assigned-programs/${program.id}`)
      const copies = bridgeOf(bodyOf<Program>(res)).ownImages
      expect(await Promise.all(copies.map((i) => contentAt(i.url)))).toEqual([
        'library-one',
        'library-two',
      ])
    })

    // Asked twice, it copies twice (decided: a duplicate is removed like any
    // photo).
    it('copies again when asked again', async () => {
      const res = await practitionerA.post(
        `${imagesPath(program, bridgeOf(program))}/from-library`,
      )
      expect(res.status).toBe(201)
      expect(bridgeOf(bodyOf<Program>(res)).ownImages).toHaveLength(4)
    })

    it('refuses an exercise whose library entry has no photos', async () => {
      const res = await practitionerA.post(
        `${imagesPath(program, plankOf(program))}/from-library`,
      )
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'This exercise has no photos in the library to copy',
      ])
    })
  })

  // --- 4. Reordering and removing ----------------------------------------------------------------------------

  describe('reordering and removing', () => {
    let program: Program
    let keys: string[]

    beforeAll(async () => {
      program = await assign()
      const res = await upload(
        practitionerA,
        imagesPath(program, bridgeOf(program)),
        ['one', 'two', 'three'],
      )
      program = bodyOf<Program>(res)
      keys = bridgeOf(program).ownImages.map((i) => i.objectKey)
    })

    it('reorders them, with the old and new order in its entry', async () => {
      const order = [keys[2], keys[0], keys[1]]
      const res = await practitionerA
        .patch(imagesPath(program, bridgeOf(program)))
        .send({ order })
      expect(res.status).toBe(200)
      expect(
        bridgeOf(bodyOf<Program>(res)).ownImages.map((i) => i.objectKey),
      ).toEqual(order)
      const [entry] = (await changeEntries(program.id)).slice(-1)
      expect(entry.action).toBe('ASSIGNED_PROGRAM_EXERCISE_PHOTOS_REORDERED')
      expect(entry.details).toStrictEqual({
        exerciseRowId: bridgeOf(program).id,
        name: 'Photos E2E Bridge',
        from: keys,
        to: order,
      })
      keys = order
    })

    it("refuses an order that isn't the same photos", async () => {
      const res = await practitionerA
        .patch(imagesPath(program, bridgeOf(program)))
        .send({ order: [keys[0], keys[1], libraryKeys[0]] })
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        "The new order must contain exactly this exercise's own photos, just reordered",
      ])
    })

    it('removes one: out of the list, its file deleted, one entry', async () => {
      const res = await practitionerA
        .delete(imagesPath(program, bridgeOf(program)))
        .send({ objectKey: keys[1] })
      expect(res.status).toBe(200)
      expect(
        bridgeOf(bodyOf<Program>(res)).ownImages.map((i) => i.objectKey),
      ).toEqual([keys[0], keys[2]])
      expect(await contentOfKey(keys[1])).toBe(404)
      expect(await contentOfKey(keys[0])).toBe('three')
      const [entry] = (await changeEntries(program.id)).slice(-1)
      expect(entry.action).toBe('ASSIGNED_PROGRAM_EXERCISE_PHOTO_REMOVED')
      expect(entry.details).toStrictEqual({
        exerciseRowId: bridgeOf(program).id,
        name: 'Photos E2E Bridge',
        objectKey: keys[1],
      })
    })

    // A LIBRARY photo is not this row's to delete — and its file stays.
    it("refuses to remove a photo that isn't one of the row's own", async () => {
      const res = await practitionerA
        .delete(imagesPath(program, bridgeOf(program)))
        .send({ objectKey: libraryKeys[0] })
      expect(res.status).toBe(404)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        "This photo is not one of this exercise's own photos",
      ])
      expect(await contentOfKey(libraryKeys[0])).toBe('library-one')
    })

    // No session used it, so it is DELETED — and nothing points at its
    // files any more.
    it('deletes the own files when the exercise itself is deleted', async () => {
      const current = await practitionerA.get(
        `/assigned-programs/${program.id}`,
      )
      const kept = bridgeOf(bodyOf<Program>(current)).ownImages.map(
        (i) => i.objectKey,
      )
      expect(kept).toHaveLength(2)
      const res = await practitionerA.delete(
        `/assigned-programs/${program.id}/exercises/${bridgeOf(program).id}`,
      )
      expect(res.status).toBe(200)
      for (const key of kept) {
        expect(await contentOfKey(key)).toBe(404)
      }
      const [entry] = (await changeEntries(program.id)).slice(-1)
      expect(entry.action).toBe('ASSIGNED_PROGRAM_EXERCISE_REMOVED')
      expect(
        (entry.details as { exercise: { ownPhotos: string[] } }).exercise
          .ownPhotos,
      ).toEqual(kept)
    })
  })

  // --- 5. The limit, the people, the states ------------------------------------------------------------------

  describe('refusals', () => {
    let program: Program

    beforeAll(async () => {
      program = await assign()
    })

    it('refuses an 11th photo, saying how many fit — and stores nothing', async () => {
      const path = imagesPath(program, bridgeOf(program))
      expect(
        (await upload(practitionerA, path, ['1', '2', '3', '4', '5'])).status,
      ).toBe(201)
      expect(
        (await upload(practitionerA, path, ['6', '7', '8', '9'])).status,
      ).toBe(201)
      const before = await sessionPool.query<{ count: string }>(
        "SELECT count(*) FROM audit_logs WHERE action = 'ASSIGNED_PROGRAM_EXERCISE_PHOTOS_ADDED'",
      )

      const res = await upload(practitionerA, path, ['10', '11'])
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'A program exercise can have at most 10 photos: this one has 9, so 1 more can be added',
      ])
      const after = await sessionPool.query<{ count: string }>(
        "SELECT count(*) FROM audit_logs WHERE action = 'ASSIGNED_PROGRAM_EXERCISE_PHOTOS_ADDED'",
      )
      expect(after.rows[0].count).toBe(before.rows[0].count)

      // The 10th still fits; then copying the library's 2 doesn't.
      expect((await upload(practitionerA, path, ['10'])).status).toBe(201)
      const copy = await practitionerA.post(`${path}/from-library`)
      expect(copy.status).toBe(409)
      expect(bodyOf<ErrorBody>(copy).message).toEqual([
        'A program exercise can have at most 10 photos: this one has 10, so no more can be added',
      ])
    })

    it('refuses an upload with no files, or a file that is not an image', async () => {
      const path = imagesPath(program, plankOf(program))
      const none = await practitionerA.post(path)
      expect(none.status).toBe(400)
      expect(bodyOf<ErrorBody>(none).message).toEqual(['No files uploaded'])

      const text = await practitionerA
        .post(path)
        .attach('files', Buffer.from('hello'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
      expect(text.status).toBe(400)
      expect(bodyOf<ErrorBody>(text).message).toEqual([
        'Only JPEG, PNG, and WebP images are allowed',
      ])
    })

    // Not on the care team: row-level security doesn't even show them the
    // program — a 404, as everywhere for a patient they don't treat. The
    // patient: the role guard's own 403 — its message proves WHICH layer
    // refused (the service would have said "…manage this assigned program").
    it('refuses a practitioner outside the care team, and the patient', async () => {
      const path = imagesPath(program, plankOf(program))
      for (const res of [
        await upload(practitionerC, path, ['x']),
        await practitionerC.post(`${path}/from-library`),
      ]) {
        expect(res.status).toBe(404)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          `Assigned program ${program.id} not found`,
        ])
      }
      for (const res of [
        await upload(patient, path, ['x']),
        await patient.post(`${path}/from-library`),
        await patient.patch(path).send({ order: [] }),
        await patient.delete(path).send({ objectKey: 'x' }),
      ]) {
        expect(res.status).toBe(403)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'You do not have permission to access this resource',
        ])
      }
    })

    it("refuses another program's exercise (404)", async () => {
      const other = await assign()
      const res = await upload(
        practitionerA,
        `/assigned-programs/${program.id}/exercises/${plankOf(other).id}/images`,
        ['x'],
      )
      expect(res.status).toBe(404)
    })

    // A session used the exercise, so removing it RETIRED it: it can't
    // change any more, and its own photos stay (its sessions' history).
    it('refuses a retired exercise, and keeps its photos', async () => {
      const fresh = await assign()
      const plank = plankOf(fresh)
      const added = await upload(practitionerA, imagesPath(fresh, plank), [
        'kept',
      ])
      const [key] = plankOf(bodyOf<Program>(added)).ownImages.map(
        (i) => i.objectKey,
      )
      const started = await patient.post('/sessions').send({
        assignedProgramId: fresh.id,
        localDate: today,
        workoutId: fresh.workouts[0].id,
      })
      expect(started.status).toBe(201)
      const removed = await practitionerA.delete(
        `/assigned-programs/${fresh.id}/exercises/${plank.id}`,
      )
      expect(removed.status).toBe(200)
      expect(
        bodyOf<Program>(removed).retiredExercises.map((e) => e.id),
      ).toEqual([plank.id])

      const res = await upload(practitionerA, imagesPath(fresh, plank), ['x'])
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'This exercise was removed from the program, so it can no longer change',
      ])
      expect(await contentOfKey(key)).toBe('kept')
    })

    it('refuses a closed program', async () => {
      const fresh = await assign()
      // Completed, not cancelled: cancelling a program with no session
      // ARCHIVES it (deletes it), and an archived program reads as 404.
      const closed = await practitionerA
        .post(`/assigned-programs/${fresh.id}/complete`)
        .send({ today })
      expect(closed.status).toBe(200)
      const res = await upload(
        practitionerA,
        imagesPath(fresh, plankOf(fresh)),
        ['x'],
      )
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'This program is completed, so it can no longer change. To continue it, assign it again',
      ])
    })
  })

  // --- 6. Assign again ---------------------------------------------------------------------------------------

  it('"Assign again" copies the choice and the own photos to NEW files, leaving the old program\'s untouched', async () => {
    let first = await assign()
    const bridge = bridgeOf(first)
    const res = await upload(practitionerA, imagesPath(first, bridge), ['mine'])
    first = bodyOf<Program>(res)
    await practitionerA
      .patch(`/assigned-programs/${first.id}/exercises/${bridge.id}`)
      .send({ useLibraryImages: false })
    const oldKey = bridgeOf(first).ownImages[0].objectKey
    const done = await practitionerA
      .post(`/assigned-programs/${first.id}/complete`)
      .send({ today })
    expect(done.status).toBe(200)

    const again = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnProgramId: first.id,
      title: 'Photos Program, block 2',
      startDate: today,
      schedule: { type: 'times_per_week', timesPerWeek: 2 },
    })
    expect(again.status).toBe(201)
    const second = bodyOf<Program>(again)
    const copied = bridgeOf(second)
    expect(copied.useLibraryImages).toBe(false)
    expect(copied.ownImages).toHaveLength(1)
    const newKey = copied.ownImages[0].objectKey
    expect(newKey).toMatch(KEY)
    expect(newKey).not.toBe(oldKey)
    expect(await contentAt(copied.images[0].url)).toBe('mine')

    // The creation entry lists the copies' keys.
    const [created] = await auditTrail(second.id)
    const listed = (
      created.details as {
        exercises: { useLibraryImages: boolean; ownPhotos: string[] }[]
      }
    ).exercises
    expect(listed.map((e) => [e.useLibraryImages, e.ownPhotos])).toEqual([
      [false, [newKey]],
      [true, []],
    ])

    // Removing the copy leaves the old program's file in place.
    const removed = await practitionerA
      .delete(imagesPath(second, copied))
      .send({ objectKey: newKey })
    expect(removed.status).toBe(200)
    expect(await contentOfKey(newKey)).toBe(404)
    expect(await contentOfKey(oldKey)).toBe('mine')
    // And the old (closed) program still shows it.
    const old = await practitionerA.get(`/assigned-programs/${first.id}`)
    expect(
      bridgeOf(bodyOf<Program>(old)).images.map((i) => pathOf(i.url)),
    ).toEqual([pathOf(bridgeOf(first).ownImages[0].url)])
  })

  // --- 7. The database's own guarantees ----------------------------------------------------------------------

  describe('database guarantees', () => {
    // What node-postgres reports, through Drizzle's wrapper.
    function pgError(error: unknown): { code?: string; constraint?: string } {
      let current: unknown = error
      for (let depth = 0; depth < 5; depth++) {
        if (typeof current !== 'object' || current === null) return {}
        const fields = current as {
          code?: unknown
          constraint?: unknown
          cause?: unknown
        }
        if (typeof fields.code === 'string') {
          return {
            code: fields.code,
            ...(typeof fields.constraint === 'string'
              ? { constraint: fields.constraint }
              : {}),
          }
        }
        current = fields.cause
      }
      return {}
    }
    class RolledBack extends Error {
      constructor(readonly rowCount: number) {
        super('rolled back on purpose')
      }
    }
    // As the APP's role with an actor's context, always rolled back: the
    // rows the statement changed, or the error that stopped it.
    async function run(
      actor: { userId: number; role: string },
      statement: SQL,
    ) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true),
                       set_config('app.current_role', ${actor.role}, true)`,
          )
          const result = await tx.execute(statement)
          throw new RolledBack(result.rowCount ?? 0)
        })
      } catch (error) {
        if (error instanceof RolledBack) return { rowCount: error.rowCount }
        return { error: pgError(error) }
      }
      throw new Error('unreachable: run() always rolls back')
    }

    let program: Program
    beforeAll(async () => {
      program = await assign()
    })

    // The CHECK holds for everyone — the owner included (the service's own
    // count never lets the API reach it).
    it('refuses an 11th key in the database itself', async () => {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        const eleven = Array.from({ length: 11 }, (_, i) => `k/${i}.png`)
        await expect(
          client.query(
            'UPDATE assigned_program_exercises SET media_urls = $1 WHERE id = $2',
            [eleven, bridgeOf(program).id],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'assigned_program_exercises_photo_limit',
        })
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    // A patient reads their program, never writes its photo list: the
    // table's UPDATE policy shows them no row to change.
    it("lets no patient change their program's photo list", async () => {
      const result = await run(
        { userId: patientId, role: 'patient' },
        sql`UPDATE assigned_program_exercises SET media_urls = ARRAY['x'], use_library_images = false
            WHERE id = ${bridgeOf(program).id}`,
      )
      expect(result).toEqual({ rowCount: 0 })
    })

    // The closed-program guard (0031) covers the new columns too: they're
    // part of the row it protects.
    it("refuses a change to a closed program's photos", async () => {
      const fresh = await assign()
      await practitionerA
        .post(`/assigned-programs/${fresh.id}/complete`)
        .send({ today })
      const result = await run(
        { userId: practitionerAId, role: 'practitioner' },
        sql`UPDATE assigned_program_exercises SET use_library_images = false
            WHERE id = ${bridgeOf(fresh).id}`,
      )
      expect(result).toEqual({
        error: { code: '23514', constraint: 'assigned_program_closed' },
      })
    })
  })
})
