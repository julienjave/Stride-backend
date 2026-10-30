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
import { sql } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { StorageService } from '../src/storage/storage.service'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { addDays, utcToday } from '../src/common/calendar-date'

// Copying several exercises, or a whole workout, at once (roadmap Phase 6.5):
// POST /programs/:id/exercises/copy and POST /assigned-programs/:id/exercises/copy.
// One request, one transaction, one audit entry — proven against the real
// database AND a real S3 API (moto in the sandbox, RustFS on the developer's
// machine), since a program's copy copies its own photo FILES too.
describe('Copying exercises (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb
  let storage: StorageService

  let admin: ReturnType<typeof request.agent>
  // On the patient's care team; owns the template.
  let practitionerA: ReturnType<typeof request.agent>
  // Same clinic, NOT on the care team, not the template's owner.
  let practitionerC: ReturnType<typeof request.agent>
  let patient: ReturnType<typeof request.agent>

  let patientId: number
  let practitionerAId: number
  let bridgeId: number
  let plankId: number
  let templateId: number

  const today = utcToday()

  function bodyOf<T>(res: request.Response): T {
    return res.body as T
  }

  interface TemplateExercise {
    id: number
    workoutId: number
    exerciseId: number
    sets: number | null
    reps: number | null
    notes: string | null
    sortOrder: number
  }
  interface Template {
    id: number
    workouts: { id: number; name: string | null; sortOrder: number }[]
    exercises: TemplateExercise[]
  }
  interface Exercise {
    id: number
    workoutId: number
    exerciseId: number
    name: string
    instructions: string[]
    sets: number | null
    sortOrder: number
    useLibraryImages: boolean
    images: { url: string }[]
    ownImages: { objectKey: string; url: string }[]
  }
  interface Program {
    id: number
    workouts: { id: number; name: string | null; sortOrder: number }[]
    exercises: Exercise[]
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
      clinicName: 'Copy E2E Clinic',
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
        licenseNumber: `CP-A-${stamp}`,
      },
      practitionerA,
    )
    await createUser(
      {
        email: `pc-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'C',
        licenseNumber: `CP-C-${stamp}`,
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
    for (const name of ['Copy E2E Bridge', 'Copy E2E Plank']) {
      const res = await practitionerA.post('/exercises').send({
        name,
        primaryMuscles: ['core'],
        instructions: ['Do it'],
      })
      expect(res.status).toBe(201)
      ids.push(bodyOf<{ id: number }>(res).id)
    }
    ;[bridgeId, plankId] = ids
    // Two library photos on Bridge, for the program's own-photo copies.
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

    const created = await practitionerA
      .post('/programs')
      .send({ title: 'Copy Template' })
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

  // A fresh template of A's: workout A with Bridge (3 × 10, a note) then
  // Plank (2 × 30 s), and an empty workout B.
  async function newTemplate(): Promise<Template> {
    const created = await practitionerA
      .post('/programs')
      .send({ title: 'Copy Source Template' })
    const id = bodyOf<{ id: number }>(created).id
    // Each add checked: a refused one would leave the template quietly
    // shorter, and every test below would fail far from the cause.
    for (const body of [
      {
        exerciseId: bridgeId,
        sets: 3,
        reps: 10,
        notes: 'Slowly',
        sortOrder: 0,
      },
      { exerciseId: plankId, sets: 2, durationInSeconds: 30, sortOrder: 1 },
    ]) {
      const added = await practitionerA
        .post(`/programs/${id}/exercises`)
        .send(body)
      expect(added.status).toBe(201)
    }
    const res = await practitionerA
      .post(`/programs/${id}/workouts`)
      .send({ name: 'Strength' })
    expect(res.status).toBe(201)
    return bodyOf<Template>(res)
  }

  // A program for the patient from the shared template (Bridge, Plank in
  // one workout), plus an empty workout B.
  async function newProgram(): Promise<Program> {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnTemplateId: templateId,
      title: 'Copy Program',
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
    const program = bodyOf<Program>(res)
    const added = await practitionerA
      .post(`/assigned-programs/${program.id}/workouts`)
      .send({ name: 'Strength' })
    expect(added.status).toBe(201)
    return bodyOf<Program>(added)
  }

  const inWorkout = <E extends { workoutId: number; sortOrder: number }>(
    exercises: E[],
    workoutId: number,
  ) =>
    exercises
      .filter((e) => e.workoutId === workoutId)
      .sort((a, b) => a.sortOrder - b.sortOrder)

  async function auditOf(entityType: string, entityId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, details FROM audit_logs
       WHERE entity_type = $1 AND entity_id = $2
         AND action LIKE '%COPIED'
       ORDER BY id`,
      [entityType, entityId],
    )
    return rows
  }

  // Every file stored for the patient — to see copies appear, or not.
  async function patientKeys(): Promise<string[]> {
    const keys: string[] = []
    for await (const object of storage.listObjects(`patients/${patientId}/`)) {
      keys.push(object.key)
    }
    return keys.sort()
  }

  async function contentAt(url: string) {
    const res = await fetch(url)
    return res.status === 200 ? await res.text() : res.status
  }

  // --- 1. Templates ------------------------------------------------------------------------------------------

  describe('a template', () => {
    const copy = (id: number, body: object) =>
      practitionerA.post(`/programs/${id}/exercises/copy`).send(body)

    it('copies several exercises to the end of another workout, in display order, prescriptions included', async () => {
      const template = await newTemplate()
      const [a, b] = template.workouts
      const [bridge, plank] = inWorkout(template.exercises, a.id)
      // Something already in B, so "the end" is after it.
      const addedToB = await practitionerA
        .post(`/programs/${template.id}/exercises`)
        .send({ exerciseId: plankId, workoutId: b.id, sets: 1, sortOrder: 0 })
      expect(addedToB.status).toBe(201)

      // Sent in reverse: the copies still follow the screen's order.
      const res = await copy(template.id, {
        exerciseIds: [plank.id, bridge.id],
        targetWorkoutId: b.id,
      })
      expect(res.status).toBe(201)
      const answered = bodyOf<Template>(res)
      const inB = inWorkout(answered.exercises, b.id)
      expect(
        inB.map(({ exerciseId, sets, reps, notes, sortOrder }) => ({
          exerciseId,
          sets,
          reps,
          notes,
          sortOrder,
        })),
      ).toStrictEqual([
        { exerciseId: plankId, sets: 1, reps: null, notes: null, sortOrder: 0 },
        {
          exerciseId: bridgeId,
          sets: 3,
          reps: 10,
          notes: 'Slowly',
          sortOrder: 1,
        },
        { exerciseId: plankId, sets: 2, reps: null, notes: null, sortOrder: 2 },
      ])
      // The originals are untouched, still in A.
      expect(inWorkout(answered.exercises, a.id).map((e) => e.id)).toEqual([
        bridge.id,
        plank.id,
      ])
    })

    it('copies into a NEW workout, named, after the last one', async () => {
      const template = await newTemplate()
      const [a] = template.workouts
      const ids = inWorkout(template.exercises, a.id).map((e) => e.id)

      const res = await copy(template.id, {
        exerciseIds: ids,
        targetWorkoutId: null,
        newWorkoutName: '  Warm-up  ',
      })
      expect(res.status).toBe(201)
      const answered = bodyOf<Template>(res)
      expect(answered.workouts.map((w) => [w.name, w.sortOrder])).toEqual([
        [null, 0],
        ['Strength', 1],
        ['Warm-up', 2],
      ])
      const created = answered.workouts[2]
      expect(
        inWorkout(answered.exercises, created.id).map((e) => e.exerciseId),
      ).toEqual([bridgeId, plankId])
    })

    it('writes ONE entry: the target, the new workout, and each copy with its source', async () => {
      const template = await newTemplate()
      const [a] = template.workouts
      const [bridge] = inWorkout(template.exercises, a.id)

      const res = await copy(template.id, {
        exerciseIds: [bridge.id],
        targetWorkoutId: null,
      })
      const answered = bodyOf<Template>(res)
      const created = answered.workouts[2]
      const theCopy = inWorkout(answered.exercises, created.id)[0]

      const trail = await auditOf('program_templates', template.id)
      expect(trail).toHaveLength(1)
      expect(trail[0].action).toBe('TEMPLATE_EXERCISES_COPIED')
      expect(trail[0].performed_by).toBe(practitionerAId)
      expect(trail[0].details).toStrictEqual({
        targetWorkoutId: created.id,
        createdWorkout: { id: created.id, name: null, sortOrder: 2 },
        copies: [
          {
            from: bridge.id,
            exercise: {
              id: theCopy.id,
              workoutId: created.id,
              exerciseId: bridgeId,
              sets: 3,
              reps: 10,
              durationInSeconds: null,
              weight: null,
              weightUnit: null,
              sortOrder: 0,
              notes: 'Slowly',
            },
          },
        ],
      })
    })

    it('records no createdWorkout key when copying into an existing workout', async () => {
      const template = await newTemplate()
      const [a, b] = template.workouts
      await copy(template.id, {
        exerciseIds: [inWorkout(template.exercises, a.id)[0].id],
        targetWorkoutId: b.id,
      })
      const [entry] = await auditOf('program_templates', template.id)
      expect(Object.keys(entry.details!).sort()).toEqual([
        'copies',
        'targetWorkoutId',
      ])
    })

    it("refuses another template's exercise (404) — and creates no workout, no copy", async () => {
      const template = await newTemplate()
      const other = await newTemplate()
      const [a] = template.workouts
      const foreign = other.exercises[0].id

      const res = await copy(template.id, {
        exerciseIds: [inWorkout(template.exercises, a.id)[0].id, foreign],
        targetWorkoutId: null,
      })
      expect(res.status).toBe(404)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        `Exercise ${foreign} not found in this template`,
      ])
      const now = bodyOf<Template>(
        await practitionerA.get(`/programs/${template.id}`),
      )
      expect(now.workouts).toHaveLength(2)
      expect(now.exercises).toHaveLength(2)
      expect(await auditOf('program_templates', template.id)).toEqual([])
    })

    it('refuses a target workout of another template (404)', async () => {
      const template = await newTemplate()
      const other = await newTemplate()
      const res = await copy(template.id, {
        exerciseIds: [template.exercises[0].id],
        targetWorkoutId: other.workouts[1].id,
      })
      expect(res.status).toBe(404)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        `Workout ${other.workouts[1].id} not found in this template`,
      ])
    })

    it("refuses someone else's template (403)", async () => {
      const template = await newTemplate()
      const res = await practitionerC
        .post(`/programs/${template.id}/exercises/copy`)
        .send({
          exerciseIds: [template.exercises[0].id],
          targetWorkoutId: null,
        })
      expect(res.status).toBe(403)
    })

    it('refuses a new workout past the limit of 10, copying nothing', async () => {
      const template = await newTemplate()
      for (let i = 2; i < 10; i++) {
        await practitionerA.post(`/programs/${template.id}/workouts`).send({})
      }
      const res = await copy(template.id, {
        exerciseIds: [template.exercises[0].id],
        targetWorkoutId: null,
      })
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'A program can have at most 10 workouts',
      ])
    })
  })

  // --- 2. Assigned programs ----------------------------------------------------------------------------------

  describe('an assigned program', () => {
    const copy = (id: number, body: object) =>
      practitionerA.post(`/assigned-programs/${id}/exercises/copy`).send(body)

    it("copies the patient's OWN description and prescription — not the library's", async () => {
      const program = await newProgram()
      const [a, b] = program.workouts
      const bridge = inWorkout(program.exercises, a.id)[0]
      // Tailored for this patient…
      const edited = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${bridge.id}`)
        .send({
          name: 'Bridge (left leg)',
          instructions: ['Left leg only'],
          sets: 4,
        })
      expect(edited.status).toBe(200)
      // …and the library entry changed since.
      await practitionerA
        .patch(`/exercises/${bridgeId}`)
        .send({ instructions: ['A newer library text'] })

      const res = await copy(program.id, {
        exerciseIds: [bridge.id],
        targetWorkoutId: b.id,
      })
      expect(res.status).toBe(201)
      const [theCopy] = inWorkout(bodyOf<Program>(res).exercises, b.id)
      expect({
        name: theCopy.name,
        instructions: theCopy.instructions,
        sets: theCopy.sets,
      }).toStrictEqual({
        name: 'Bridge (left leg)',
        instructions: ['Left leg only'],
        sets: 4,
      })
      await practitionerA
        .patch(`/exercises/${bridgeId}`)
        .send({ instructions: ['Do it'] })
    })

    it('copies own photos to NEW files with the same content, and keeps the photo choice', async () => {
      const program = await newProgram()
      const [a, b] = program.workouts
      const bridge = inWorkout(program.exercises, a.id)[0]
      const plank = inWorkout(program.exercises, a.id)[1]
      const fromLibrary = await practitionerA.post(
        `/assigned-programs/${program.id}/exercises/${bridge.id}/images/from-library`,
      )
      expect(fromLibrary.status).toBe(201)
      const sourceKeys = inWorkout(
        bodyOf<Program>(fromLibrary).exercises,
        a.id,
      )[0].ownImages.map((image) => image.objectKey)
      expect(sourceKeys).toHaveLength(2)
      // "Add the library's photos" copies the files; the patient is switched
      // to them by its own choice — made here.
      const chosen = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${bridge.id}`)
        .send({ useLibraryImages: false })
      expect(chosen.status).toBe(200)

      const res = await copy(program.id, {
        exerciseIds: [bridge.id, plank.id],
        targetWorkoutId: b.id,
      })
      expect(res.status).toBe(201)
      const [bridgeCopy, plankCopy] = inWorkout(
        bodyOf<Program>(res).exercises,
        b.id,
      )
      // Bridge: own photos (as the source), on new keys, same files' content.
      expect(bridgeCopy.useLibraryImages).toBe(false)
      const copyKeys = bridgeCopy.ownImages.map((image) => image.objectKey)
      expect(copyKeys).toHaveLength(2)
      expect(copyKeys.some((key) => sourceKeys.includes(key))).toBe(false)
      expect(
        await Promise.all(bridgeCopy.ownImages.map((i) => contentAt(i.url))),
      ).toEqual(['library-one', 'library-two'])
      // Plank: still the library's (none here), no own photo invented.
      expect(plankCopy.useLibraryImages).toBe(true)
      expect(plankCopy.ownImages).toEqual([])

      // Independent: removing the source's photo leaves the copy's file.
      const removed = await practitionerA
        .delete(
          `/assigned-programs/${program.id}/exercises/${bridge.id}/images`,
        )
        .send({ objectKey: sourceKeys[0] })
      expect(removed.status).toBe(200)
      expect(await contentAt(bridgeCopy.ownImages[0].url)).toBe('library-one')
    })

    it('writes ONE entry about the patient, each copy with its source and its new photo keys', async () => {
      const program = await newProgram()
      const [a] = program.workouts
      const bridge = inWorkout(program.exercises, a.id)[0]
      await practitionerA.post(
        `/assigned-programs/${program.id}/exercises/${bridge.id}/images/from-library`,
      )
      await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${bridge.id}`)
        .send({ useLibraryImages: false })
      const res = await copy(program.id, {
        exerciseIds: [bridge.id],
        targetWorkoutId: null,
        newWorkoutName: 'Warm-up',
      })
      const answered = bodyOf<Program>(res)
      const created = answered.workouts.find((w) => w.name === 'Warm-up')!
      const [theCopy] = inWorkout(answered.exercises, created.id)

      const trail = await auditOf('assigned-programs', program.id)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({
        action: 'ASSIGNED_PROGRAM_EXERCISES_COPIED',
        performed_by: practitionerAId,
        target_user_id: patientId,
      })
      expect(trail[0].details).toMatchObject({
        targetWorkoutId: created.id,
        createdWorkout: { id: created.id, name: 'Warm-up' },
        copies: [
          {
            from: bridge.id,
            exercise: {
              id: theCopy.id,
              workoutId: created.id,
              name: bridge.name,
              useLibraryImages: false,
              ownPhotos: theCopy.ownImages.map((i) => i.objectKey),
            },
          },
        ],
      })
    })

    it('refuses a retired exercise (404): removed ones are not copied back', async () => {
      const program = await newProgram()
      const [a, b] = program.workouts
      const bridge = inWorkout(program.exercises, a.id)[0]
      // Retired as the owner (exempt from the guards) — the API retires one
      // only when a session used it.
      await sessionPool.query(
        `UPDATE assigned_program_exercises SET retired_at = now(), retired_by = $2 WHERE id = $1`,
        [bridge.id, practitionerAId],
      )
      const res = await copy(program.id, {
        exerciseIds: [bridge.id],
        targetWorkoutId: b.id,
      })
      expect(res.status).toBe(404)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        `Exercise ${bridge.id} not found in this program`,
      ])
    })

    it('deletes the copied files when the write fails, leaving no file behind', async () => {
      const program = await newProgram()
      const [a] = program.workouts
      const bridge = inWorkout(program.exercises, a.id)[0]
      await practitionerA.post(
        `/assigned-programs/${program.id}/exercises/${bridge.id}/images/from-library`,
      )
      const before = await patientKeys()

      // A target workout of ANOTHER program: found missing only in the
      // write's transaction — after the files were copied.
      const other = await newProgram()
      const afterOther = await patientKeys()
      const res = await copy(program.id, {
        exerciseIds: [bridge.id],
        targetWorkoutId: other.workouts[1].id,
      })
      expect(res.status).toBe(404)
      expect(await patientKeys()).toEqual(afterOther)
      expect(afterOther).toEqual(before)
    })

    it('refuses (409) when a source changed between the photo copy and the write, and deletes the copies', async () => {
      const program = await newProgram()
      const [a, b] = program.workouts
      const bridge = inWorkout(program.exercises, a.id)[0]
      await practitionerA.post(
        `/assigned-programs/${program.id}/exercises/${bridge.id}/images/from-library`,
      )
      const before = await patientKeys()

      // Another connection holds the program's row lock: the copy's write
      // transaction waits there (its photo files already copied). Meanwhile
      // the source loses a photo; then the lock is released.
      const holder = await sessionPool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(
          'SELECT id FROM assigned_programs WHERE id = $1 FOR UPDATE',
          [program.id],
        )
        const pending = copy(program.id, {
          exerciseIds: [bridge.id],
          targetWorkoutId: b.id,
        }).then((res) => res)
        for (let tries = 0; ; tries++) {
          const { rows } = await sessionPool.query<{ count: string }>(
            `SELECT count(*) FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query ILIKE '%assigned_programs%'`,
          )
          if (Number(rows[0].count) > 0) break
          if (tries > 100) throw new Error('The copy never waited on the lock')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        await holder.query(
          `UPDATE assigned_program_exercises SET media_urls = media_urls[1:1] WHERE id = $1`,
          [bridge.id],
        )
        await holder.query('COMMIT')

        const res = await pending
        expect(res.status).toBe(409)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'These exercises changed while they were being copied. Reload the program and try again.',
        ])
      } finally {
        holder.release()
      }
      // The two copies made before the write are gone again.
      expect(await patientKeys()).toEqual(before)
      expect(await auditOf('assigned-programs', program.id)).toEqual([])
    })

    it('refuses a practitioner off the care team (404 — the program is hidden)', async () => {
      const program = await newProgram()
      const res = await practitionerC
        .post(`/assigned-programs/${program.id}/exercises/copy`)
        .send({ exerciseIds: [program.exercises[0].id], targetWorkoutId: null })
      expect(res.status).toBe(404)
    })

    it('refuses the patient and an admin (403)', async () => {
      const program = await newProgram()
      for (const agent of [patient, admin]) {
        const res = await agent
          .post(`/assigned-programs/${program.id}/exercises/copy`)
          .send({
            exerciseIds: [program.exercises[0].id],
            targetWorkoutId: null,
          })
        expect(res.status).toBe(403)
      }
    })

    it('refuses a closed program (409)', async () => {
      const program = await newProgram()
      const done = await practitionerA
        .post(`/assigned-programs/${program.id}/complete`)
        .send({ today })
      expect(done.status).toBe(200)
      const res = await copy(program.id, {
        exerciseIds: [program.exercises[0].id],
        targetWorkoutId: null,
      })
      expect(res.status).toBe(409)
      // The SERVICE's words (assertProgramOpen), told before any file is
      // copied — the database's closed-program guard (0031) would also
      // refuse the insert, but only later, and in other words.
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'This program is completed, so it can no longer change. To continue it, assign it again',
      ])
    })
  })
})
