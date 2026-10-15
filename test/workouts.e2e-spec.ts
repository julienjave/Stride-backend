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
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { addDays, utcToday } from '../src/common/calendar-date'

// Workouts (decisions §5, "Settled 2026-10-10", point 1): a template — and
// an assigned program — has one or more named workouts, and each exercise
// belongs to one.
//   1. templates: the workout routes, exercises by workout;
//   2. assigning: the workouts are COPIED with the exercises;
//   3. programs: the same routes, audited (one complete entry per change);
//   4. sessions record their workout, and their checklist is its exercises;
//   5. the database's own guarantees: the composite foreign keys and the
//      CHECKs (as the owner), and row-level security (as the app's role).
//
// Logins: 3 — the admin's session comes from register-clinic. The
// program-side tests all assign ONE shared two-workout template
// (sharedTemplate, built once) — first to stay under the limit of 60
// requests a minute per route (off in the e2e suites since 2026-10-15:
// test/support/e2e-env.ts); it also keeps the file fast.
describe('Workouts (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb

  let admin: ReturnType<typeof request.agent>
  // Owns the templates; on the patient's care team.
  let practitionerA: ReturnType<typeof request.agent>
  // Same clinic, NOT on the care team, owns no template.
  let practitionerB: ReturnType<typeof request.agent>
  let patient: ReturnType<typeof request.agent>

  let adminId: number
  let practitionerAId: number
  let practitionerBId: number
  let patientId: number
  let exerciseId: number
  // A two-workout template, built once, never changed: what the program-side
  // tests assign (see above).
  let sharedTemplate: WithWorkouts

  const today = utcToday()
  // Monday, Wednesday, Friday, all workout A (position 0 when assigning).
  const MWF = {
    type: 'weekdays',
    days: [1, 3, 5].map((weekday) => ({ weekday, workoutIndex: 0 })),
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
    practitionerB = request.agent(app.getHttpServer())
    patient = request.agent(app.getHttpServer())

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Workouts E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Workouts',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(clinicRes.body)}`)
    }
    const clinicId: number = clinicRes.body.clinicId
    adminId = (await admin.get('/auth/me')).body.id

    async function createAndLogIn(
      agent: ReturnType<typeof request.agent>,
      body: Record<string, unknown>,
    ): Promise<number> {
      const res = await admin.post('/users').send({ ...body, clinicId })
      if (res.status !== 201) {
        throw new Error(`Setup failed: ${JSON.stringify(res.body)}`)
      }
      await activateAccount(sessionPool, body.email as string)
      await agent
        .post('/auth/login')
        .send({ email: body.email, password: 'password123' })
      return res.body.id
    }

    practitionerAId = await createAndLogIn(practitionerA, {
      email: `wa-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `WORK-A-${stamp}`,
    })
    practitionerBId = await createAndLogIn(practitionerB, {
      email: `wb-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `WORK-B-${stamp}`,
    })
    patientId = await createAndLogIn(patient, {
      email: `wpatient-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Workout',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
    })
    const join = await practitionerA
      .post(`/users/${patientId}/care-team`)
      .send({})
    expect(join.status).toBe(201)

    const exercise = await practitionerA.post('/exercises').send({
      name: 'Workouts E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Sit back, stand up'],
    })
    exerciseId = exercise.body.id
    sharedTemplate = await twoWorkoutTemplate()
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  interface Workout {
    id: number
    name: string | null
    sortOrder: number
  }
  interface Exercise {
    id: number
    workoutId: number
    sortOrder: number
    notes: string | null
  }
  interface WithWorkouts {
    id: number
    workouts: Workout[]
    exercises: Exercise[]
  }

  // A template by A, with its first workout's id.
  async function newTemplate(title = 'Workouts Template') {
    const res = await practitionerA.post('/programs').send({ title })
    expect(res.status).toBe(201)
    const full = await practitionerA.get(`/programs/${res.body.id}`)
    return full.body as WithWorkouts
  }

  // An exercise added to a template (to a given workout, or the first).
  async function addTemplateExercise(
    templateId: number,
    extra: Record<string, unknown> = {},
  ) {
    const res = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sets: 2, reps: 8, sortOrder: 0, ...extra })
    expect(res.status).toBe(201)
    return res.body as WithWorkouts
  }

  // A two-workout template, ready to assign: A holds two exercises
  // ("a1", "a2"), B — named "Lower body" — one ("b1"). The notes say which
  // is which in the assertions.
  async function twoWorkoutTemplate() {
    const template = await newTemplate('Two Workouts')
    await addTemplateExercise(template.id, { notes: 'a1', sortOrder: 0 })
    await addTemplateExercise(template.id, { notes: 'a2', sortOrder: 1 })
    const withB = await practitionerA
      .post(`/programs/${template.id}/workouts`)
      .send({ name: 'Lower body' })
    const bId = (withB.body as WithWorkouts).workouts[1].id
    return addTemplateExercise(template.id, {
      notes: 'b1',
      sortOrder: 0,
      workoutId: bId,
    })
  }

  async function assign(templateId: number, schedule: object = MWF) {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnTemplateId: templateId,
      title: 'Workouts Program',
      startDate: today,
      schedule,
    })
    expect(res.status).toBe(201)
    return res.body as WithWorkouts
  }

  // Proves a request takes a ROW LOCK on `table`'s row `id` (SELECT … FOR
  // UPDATE): another connection holds a conflicting lock first; a request
  // that takes it must WAIT — still unanswered after 300 ms — and then
  // completes once the lock is released. A request that doesn't take it
  // answers at once. Deterministic, unlike sending two requests at the same
  // moment and hoping they overlap (a mutation check showed that test alone
  // can pass without the lock: the second request often starts after the
  // first has finished).
  //
  // The test holds FOR NO KEY UPDATE, not FOR UPDATE. Inserting a workout
  // makes Postgres check its foreign key, which takes a light FOR KEY SHARE
  // lock on the parent row — and that conflicts with FOR UPDATE: held by the
  // test, it made the insert wait even with the service's lock removed (a
  // mutation check caught it). FOR NO KEY UPDATE conflicts with the
  // service's FOR UPDATE, but not with the foreign-key check, so only the
  // service's own lock can make the request wait.
  async function waitsForRowLock(
    table: 'program_templates' | 'assigned_programs',
    id: number,
    send: () => request.Test,
  ) {
    const client = await sessionPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT id FROM ${table} WHERE id = $1 FOR NO KEY UPDATE`,
        [id],
      )
      let answered = false
      const pending = send().then((res) => {
        answered = true
        return res
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const waited = !answered
      await client.query('COMMIT')
      return { waited, res: await pending }
    } finally {
      client.release()
    }
  }

  // Exercises as [workout position, notes] pairs — readable in a failing
  // test, and independent of ids.
  function layout(body: WithWorkouts) {
    const position = new Map(body.workouts.map((w, index) => [w.id, index]))
    return body.exercises.map((e) => [position.get(e.workoutId), e.notes])
  }

  // --- 1. Templates ------------------------------------------------------------

  describe('templates', () => {
    it('starts every template with one unnamed workout, where exercises go by default', async () => {
      const template = await newTemplate()
      expect(template.workouts).toEqual([
        {
          id: expect.any(Number),
          templateId: template.id,
          name: null,
          sortOrder: 0,
        },
      ])
      const after = await addTemplateExercise(template.id)
      expect(after.exercises.map((e) => e.workoutId)).toEqual([
        template.workouts[0].id,
      ])
    })

    it('adds a workout after the last one, its name trimmed — or none', async () => {
      const template = await newTemplate()
      const named = await practitionerA
        .post(`/programs/${template.id}/workouts`)
        .send({ name: '  Upper body  ' })
      expect(named.status).toBe(201)
      const blank = await practitionerA
        .post(`/programs/${template.id}/workouts`)
        .send({ name: '   ' })
      expect(
        (blank.body as WithWorkouts).workouts.map((w) => [w.name, w.sortOrder]),
      ).toEqual([
        [null, 0],
        ['Upper body', 1],
        [null, 2],
      ])
    })

    // B's exercise is added FIRST, A's second: the list still shows A's
    // exercises before B's — workout by workout.
    it('lists exercises workout by workout, each with its workoutId', async () => {
      const template = await newTemplate()
      const withB = await practitionerA
        .post(`/programs/${template.id}/workouts`)
        .send({ name: 'B' })
      const [a, b] = (withB.body as WithWorkouts).workouts
      await addTemplateExercise(template.id, { workoutId: b.id, notes: 'in B' })
      const after = await addTemplateExercise(template.id, {
        workoutId: a.id,
        notes: 'in A',
        sortOrder: 5,
      })
      expect(layout(after)).toEqual([
        [0, 'in A'],
        [1, 'in B'],
      ])
    })

    it("refuses an exercise for another template's workout", async () => {
      const mine = await newTemplate()
      const other = await newTemplate('Other')
      const res = await practitionerA
        .post(`/programs/${mine.id}/exercises`)
        .send({ exerciseId, sortOrder: 0, workoutId: other.workouts[0].id })
      expect(res.status).toBe(404)
      expect(res.body.message).toContain(
        `Workout ${other.workouts[0].id} not found in this template`,
      )
    })

    it('trims a new name', async () => {
      const template = await newTemplate()
      const res = await practitionerA
        .patch(`/programs/${template.id}/workouts/${template.workouts[0].id}`)
        .send({ name: '  Mobility  ' })
      expect((res.body as WithWorkouts).workouts[0].name).toBe('Mobility')
    })

    it('renames a workout, and clears its name with null', async () => {
      const template = await newTemplate()
      const workoutId = template.workouts[0].id
      const renamed = await practitionerA
        .patch(`/programs/${template.id}/workouts/${workoutId}`)
        .send({ name: 'Mobility' })
      expect(renamed.status).toBe(200)
      expect((renamed.body as WithWorkouts).workouts[0].name).toBe('Mobility')
      const cleared = await practitionerA
        .patch(`/programs/${template.id}/workouts/${workoutId}`)
        .send({ name: null })
      expect((cleared.body as WithWorkouts).workouts[0].name).toBeNull()
    })

    // Both templates are A's: the database would let the rename through
    // (row-level security checks the OWNER) — the check that the workout is
    // one of THIS template's is the service's.
    it("refuses to rename another template's workout", async () => {
      const mine = await newTemplate()
      const other = await newTemplate('Other')
      const res = await practitionerA
        .patch(`/programs/${mine.id}/workouts/${other.workouts[0].id}`)
        .send({ name: 'Wrong one' })
      expect(res.status).toBe(404)
      const after = await practitionerA.get(`/programs/${other.id}`)
      expect((after.body as WithWorkouts).workouts[0].name).toBeNull()
    })

    // Renaming is the route's only job: no `name` at all is a client bug.
    it('refuses a rename without a name key', async () => {
      const template = await newTemplate()
      const res = await practitionerA
        .patch(`/programs/${template.id}/workouts/${template.workouts[0].id}`)
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('name must be a string')
    })

    it('reorders the workouts — and the exercise list follows', async () => {
      const template = await twoWorkoutTemplate()
      const [a, b] = template.workouts
      const res = await practitionerA
        .patch(`/programs/${template.id}/workouts`)
        .send({ order: [b.id, a.id] })
      expect(res.status).toBe(200)
      const body = res.body as WithWorkouts
      expect(body.workouts.map((w) => [w.id, w.sortOrder])).toEqual([
        [b.id, 0],
        [a.id, 1],
      ])
      expect(layout(body)).toEqual([
        [0, 'b1'],
        [1, 'a1'],
        [1, 'a2'],
      ])
    })

    it('refuses a workout order that is not exactly the current workouts', async () => {
      const template = await twoWorkoutTemplate()
      const [a] = template.workouts
      const res = await practitionerA
        .patch(`/programs/${template.id}/workouts`)
        .send({ order: [a.id, a.id] })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        'The new order must contain exactly the workouts currently in this template, just reordered',
      )
    })

    // Within ONE workout: A's two exercises swap; B's is untouched — and a
    // list naming B's exercise as well is refused.
    it('reorders the exercises of one workout only', async () => {
      const template = await twoWorkoutTemplate()
      const [a] = template.workouts
      const [a1, a2, b1] = template.exercises
      const res = await practitionerA
        .patch(`/programs/${template.id}/exercises`)
        .send({ workoutId: a.id, order: [a2.id, a1.id] })
      expect(res.status).toBe(200)
      expect(layout(res.body as WithWorkouts)).toEqual([
        [0, 'a2'],
        [0, 'a1'],
        [1, 'b1'],
      ])
      const all = await practitionerA
        .patch(`/programs/${template.id}/exercises`)
        .send({ workoutId: a.id, order: [a1.id, a2.id, b1.id] })
      expect(all.status).toBe(400)
      expect(all.body.message).toContain(
        'The new order must contain exactly the exercises currently in this workout, just reordered',
      )
    })

    // What today's screens send: no workoutId — the first workout.
    it('reorders the first workout when no workoutId is sent', async () => {
      const template = await twoWorkoutTemplate()
      const [a1, a2] = template.exercises
      const res = await practitionerA
        .patch(`/programs/${template.id}/exercises`)
        .send({ order: [a2.id, a1.id] })
      expect(res.status).toBe(200)
      expect(layout(res.body as WithWorkouts)[0]).toEqual([0, 'a2'])
    })

    // Moved without a position: to the END of the other workout (a1 had
    // position 0, which would put it before b1).
    it('moves an exercise to the end of another workout', async () => {
      const template = await twoWorkoutTemplate()
      const [, b] = template.workouts
      const [a1] = template.exercises
      const res = await practitionerA
        .patch(`/programs/${template.id}/exercises/${a1.id}`)
        .send({ workoutId: b.id })
      expect(res.status).toBe(200)
      expect(layout(res.body as WithWorkouts)).toEqual([
        [0, 'a2'],
        [1, 'b1'],
        [1, 'a1'],
      ])
    })

    // Checked before the UPDATE: the composite foreign key would refuse it
    // too — but as a 500.
    it("refuses to move an exercise into another template's workout", async () => {
      const template = await twoWorkoutTemplate()
      const other = await newTemplate('Other')
      const res = await practitionerA
        .patch(`/programs/${template.id}/exercises/${template.exercises[0].id}`)
        .send({ workoutId: other.workouts[0].id })
      expect(res.status).toBe(404)
      expect(res.body.message).toContain(
        `Workout ${other.workouts[0].id} not found in this template`,
      )
    })

    // workout_id is NOT NULL: null must be the API's 400, not a 500.
    it('refuses to move an exercise to no workout (null)', async () => {
      const template = await twoWorkoutTemplate()
      const res = await practitionerA
        .patch(`/programs/${template.id}/exercises/${template.exercises[0].id}`)
        .send({ workoutId: null })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain('workoutId must be an integer number')
    })

    // A delete leaves a gap (A=0, C=2); a new workout goes AFTER the last
    // position (3), never onto one in use — counting the workouts (2) would.
    it('adds after the last position, even after a delete left a gap', async () => {
      const template = await newTemplate()
      await practitionerA.post(`/programs/${template.id}/workouts`).send({})
      const withC = await practitionerA
        .post(`/programs/${template.id}/workouts`)
        .send({})
      const b = (withC.body as WithWorkouts).workouts[1]
      await practitionerA.delete(`/programs/${template.id}/workouts/${b.id}`)
      const res = await practitionerA
        .post(`/programs/${template.id}/workouts`)
        .send({})
      expect(
        (res.body as WithWorkouts).workouts.map((w) => w.sortOrder),
      ).toEqual([0, 2, 3])
    })

    describe('deleting a workout', () => {
      it('deletes an empty one, and leaves the others alone', async () => {
        const template = await twoWorkoutTemplate()
        const withC = await practitionerA
          .post(`/programs/${template.id}/workouts`)
          .send({ name: 'C' })
        const c = (withC.body as WithWorkouts).workouts[2]
        const res = await practitionerA.delete(
          `/programs/${template.id}/workouts/${c.id}`,
        )
        expect(res.status).toBe(200)
        const body = res.body as WithWorkouts
        expect(body.workouts.map((w) => w.id)).toEqual(
          template.workouts.map((w) => w.id),
        )
        expect(layout(body)).toEqual(layout(template))
      })

      it('refuses one that still has exercises', async () => {
        const template = await twoWorkoutTemplate()
        const res = await practitionerA.delete(
          `/programs/${template.id}/workouts/${template.workouts[1].id}`,
        )
        expect(res.status).toBe(409)
        expect(res.body.message).toContain(
          'Workout B still has exercises: move or remove them first',
        )
      })

      it('refuses the last one, even empty', async () => {
        const template = await newTemplate()
        const res = await practitionerA.delete(
          `/programs/${template.id}/workouts/${template.workouts[0].id}`,
        )
        expect(res.status).toBe(409)
        expect(res.body.message).toContain(
          'This is the last workout, and there must always be at least one',
        )
      })

      // Adding and deleting both decide from a count, so both lock the
      // template's row first (see waitsForRowLock).
      it('locks the template while adding or deleting a workout', async () => {
        const template = await newTemplate()
        const added = await waitsForRowLock(
          'program_templates',
          template.id,
          () =>
            practitionerA.post(`/programs/${template.id}/workouts`).send({}),
        )
        expect(added).toMatchObject({ waited: true, res: { status: 201 } })
        const b = (added.res.body as WithWorkouts).workouts[1]
        const removed = await waitsForRowLock(
          'program_templates',
          template.id,
          () =>
            practitionerA.delete(`/programs/${template.id}/workouts/${b.id}`),
        )
        expect(removed).toMatchObject({ waited: true, res: { status: 200 } })
      })

      it("refuses another template's workout", async () => {
        const mine = await twoWorkoutTemplate()
        const other = await newTemplate('Other')
        const res = await practitionerA.delete(
          `/programs/${mine.id}/workouts/${other.workouts[0].id}`,
        )
        expect(res.status).toBe(404)
      })

      // The race the template's row lock exists for: two deletes at the
      // same moment on a template with two EMPTY workouts. Each alone is
      // allowed; together they'd leave no workout. With the lock, the
      // second waits, counts again, finds one left — and refuses.
      it('lets only one of two simultaneous deletes through', async () => {
        const template = await newTemplate()
        const withB = await practitionerA
          .post(`/programs/${template.id}/workouts`)
          .send({})
        const [a, b] = (withB.body as WithWorkouts).workouts
        const results = await Promise.all([
          practitionerA.delete(`/programs/${template.id}/workouts/${a.id}`),
          practitionerA.delete(`/programs/${template.id}/workouts/${b.id}`),
        ])
        expect(results.map((r) => r.status).sort()).toEqual([200, 409])
        const after = await practitionerA.get(`/programs/${template.id}`)
        expect((after.body as WithWorkouts).workouts).toHaveLength(1)
      })
    })

    it('refuses an 11th workout', async () => {
      const template = await newTemplate()
      for (let i = 2; i <= 10; i++) {
        const res = await practitionerA
          .post(`/programs/${template.id}/workouts`)
          .send({})
        expect(res.status).toBe(201)
      }
      const eleventh = await practitionerA
        .post(`/programs/${template.id}/workouts`)
        .send({})
      expect(eleventh.status).toBe(400)
      expect(eleventh.body.message).toContain(
        'A program can have at most 10 workouts',
      )
    })

    // Only the template's owner (or an admin) changes its workouts — on
    // each of the four routes (each checks it on its own).
    it.each([
      [
        'add',
        (id: number) => practitionerB.post(`/programs/${id}/workouts`).send({}),
      ],
      [
        'rename',
        (id: number, workoutId: number) =>
          practitionerB
            .patch(`/programs/${id}/workouts/${workoutId}`)
            .send({ name: 'Not mine' }),
      ],
      [
        'reorder',
        (id: number, workoutId: number) =>
          practitionerB
            .patch(`/programs/${id}/workouts`)
            .send({ order: [workoutId] }),
      ],
      [
        'delete',
        (id: number, workoutId: number) =>
          practitionerB.delete(`/programs/${id}/workouts/${workoutId}`),
      ],
    ])("refuses another practitioner's %s", async (_label, call) => {
      const template = await newTemplate()
      const res = await call(template.id, template.workouts[0].id)
      expect(res.status).toBe(403)
    })

    it("lets an admin change a practitioner's workouts", async () => {
      const template = await newTemplate()
      const asAdmin = await admin
        .patch(`/programs/${template.id}/workouts/${template.workouts[0].id}`)
        .send({ name: 'Fixed by the admin' })
      expect(asAdmin.status).toBe(200)
    })
  })

  // --- 2. Assigning: workouts are copied ---------------------------------------

  describe('assigning', () => {
    it("copies the template's workouts, names and exercises into the program's own rows", async () => {
      const template = await twoWorkoutTemplate()
      const program = await assign(template.id)

      expect(program.workouts.map((w) => [w.name, w.sortOrder])).toEqual([
        [null, 0],
        ['Lower body', 1],
      ])
      // New rows: none of the template's workout ids.
      const templateWorkoutIds = template.workouts.map((w) => w.id)
      for (const workout of program.workouts) {
        expect(templateWorkoutIds).not.toContain(workout.id)
      }
      // Each exercise in the program's workout at the same position.
      expect(layout(program)).toEqual([
        [0, 'a1'],
        [0, 'a2'],
        [1, 'b1'],
      ])
    })

    // Copy, not reference: changing the template's workouts afterwards
    // leaves the program as it was assigned.
    it("is unaffected by later changes to the template's workouts", async () => {
      const template = await twoWorkoutTemplate()
      const program = await assign(template.id)
      await practitionerA
        .patch(`/programs/${template.id}/workouts/${template.workouts[1].id}`)
        .send({ name: 'Renamed in the template' })
      const after = await practitionerA.get(`/assigned-programs/${program.id}`)
      expect((after.body as WithWorkouts).workouts[1].name).toBe('Lower body')
    })

    it('refuses a template with an empty workout', async () => {
      const template = await newTemplate('Half Written')
      await addTemplateExercise(template.id)
      await practitionerA.post(`/programs/${template.id}/workouts`).send({})
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: template.id,
        title: 'Half Written Program',
        startDate: today,
        schedule: MWF,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        `Workout B of program template ${template.id} has no exercises`,
      )
    })

    it('makes an inline exercise list one unnamed workout', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        title: 'Inline Program',
        startDate: today,
        schedule: MWF,
        exercises: [
          { exerciseId, sortOrder: 0 },
          { exerciseId, sortOrder: 1 },
        ],
      })
      expect(res.status).toBe(201)
      const body = res.body as WithWorkouts
      expect(body.workouts).toHaveLength(1)
      expect(body.workouts[0].name).toBeNull()
      expect(body.exercises.map((e) => e.workoutId)).toEqual([
        body.workouts[0].id,
        body.workouts[0].id,
      ])
    })

    // An inline list has no workouts to name; a workoutId there could only
    // be ignored — so it's refused (forbidNonWhitelisted).
    it('refuses a workoutId inside an inline exercise list', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        title: 'Inline Program',
        startDate: today,
        schedule: MWF,
        exercises: [{ exerciseId, sortOrder: 0, workoutId: 1 }],
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        'exercises.0.property workoutId should not exist',
      )
    })

    it("records the workouts in the program's creation audit entry", async () => {
      const template = await twoWorkoutTemplate()
      const program = await assign(template.id)
      const [entry] = await auditTrail(program.id)
      expect(entry.action).toBe('ASSIGNED_PROGRAM_CREATED')
      expect(entry.details).toMatchObject({
        workouts: program.workouts.map((w) => ({
          id: w.id,
          name: w.name,
          sortOrder: w.sortOrder,
        })),
        exercises: program.exercises.map((e) => ({ workoutId: e.workoutId })),
      })
    })
  })

  // --- 3. A program's workouts (audited) ---------------------------------------

  // What audit_logs holds for one program, read as the owner. The generic
  // interceptor writes AFTER the response, fire-and-forget: the pause gives
  // a duplicate the chance to appear — otherwise "no generic entry" could
  // pass just by being early.
  async function auditTrail(programId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<{
      action: string
      performed_by: number
      target_user_id: number | null
      details: Record<string, unknown> | null
    }>(
      `SELECT action, performed_by, target_user_id, details FROM audit_logs
       WHERE entity_type = 'assigned-programs' AND entity_id = $1 ORDER BY id`,
      [programId],
    )
    return rows
  }

  describe("a program's workouts", () => {
    let program: WithWorkouts
    beforeEach(async () => {
      program = await assign(sharedTemplate.id)
    })

    // Every entry: one per change, by the practitioner, about the patient,
    // and nothing else after the creation — no generic "POST …" twin.
    async function changeEntries() {
      const trail = await auditTrail(program.id)
      expect(trail[0].action).toBe('ASSIGNED_PROGRAM_CREATED')
      for (const entry of trail.slice(1)) {
        expect(entry.performed_by).toBe(practitionerAId)
        expect(entry.target_user_id).toBe(patientId)
      }
      return trail.slice(1)
    }

    it('adds a workout, with one complete audit entry', async () => {
      const res = await practitionerA
        .post(`/assigned-programs/${program.id}/workouts`)
        .send({ name: 'Core' })
      expect(res.status).toBe(201)
      const added = (res.body as WithWorkouts).workouts[2]
      expect(added).toMatchObject({ name: 'Core', sortOrder: 2 })
      expect(await changeEntries()).toMatchObject([
        {
          action: 'ASSIGNED_PROGRAM_WORKOUT_ADDED',
          details: { workout: { id: added.id, name: 'Core', sortOrder: 2 } },
        },
      ])
    })

    it('renames a workout, recording before and after', async () => {
      const b = program.workouts[1]
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/workouts/${b.id}`)
        .send({ name: 'Legs' })
      expect(res.status).toBe(200)
      expect(await changeEntries()).toMatchObject([
        {
          action: 'ASSIGNED_PROGRAM_WORKOUT_RENAMED',
          details: {
            workoutId: b.id,
            name: { from: 'Lower body', to: 'Legs' },
          },
        },
      ])
    })

    // Nothing changed, so nothing to record.
    it('writes no entry for a rename to the same name, or the same order', async () => {
      const [a, b] = program.workouts
      const same = await practitionerA
        .patch(`/assigned-programs/${program.id}/workouts/${b.id}`)
        .send({ name: ' Lower body ' })
      expect(same.status).toBe(200)
      const sameOrder = await practitionerA
        .patch(`/assigned-programs/${program.id}/workouts`)
        .send({ order: [a.id, b.id] })
      expect(sameOrder.status).toBe(200)
      expect(await changeEntries()).toEqual([])
    })

    // The program LIST carries each program's workouts too (the patient
    // home names a day's workout from it — Phase 4), in the program's
    // order: after B is moved first, B comes first — by position, not by id
    // (A's id is the smaller). Read as the patient, through the policies.
    it("lists each program's workouts, in order, to the patient", async () => {
      const [a, b] = program.workouts
      const moved = await practitionerA
        .patch(`/assigned-programs/${program.id}/workouts`)
        .send({ order: [b.id, a.id] })
      expect(moved.status).toBe(200)

      const res = await patient.get('/assigned-programs')
      expect(res.status).toBe(200)
      const row = (
        res.body as { id: number; workouts: { id: number; name: string }[] }[]
      ).find((p) => p.id === program.id)
      expect(row?.workouts.map((w) => [w.id, w.name])).toEqual([
        [b.id, 'Lower body'],
        [a.id, a.name],
      ])
    })

    it('reorders the workouts, recording both orders', async () => {
      const [a, b] = program.workouts
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/workouts`)
        .send({ order: [b.id, a.id] })
      expect(res.status).toBe(200)
      expect(layout(res.body as WithWorkouts)).toEqual([
        [0, 'b1'],
        [1, 'a1'],
        [1, 'a2'],
      ])
      expect(await changeEntries()).toMatchObject([
        {
          action: 'ASSIGNED_PROGRAM_WORKOUTS_REORDERED',
          details: { order: { from: [a.id, b.id], to: [b.id, a.id] } },
        },
      ])
    })

    it('refuses a workout order that is not exactly the current workouts, writing nothing', async () => {
      const [a, b] = program.workouts
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/workouts`)
        .send({ order: [b.id, b.id] })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        'The new order must contain exactly the workouts currently in this program, just reordered',
      )
      const after = await practitionerA.get(`/assigned-programs/${program.id}`)
      expect((after.body as WithWorkouts).workouts.map((w) => w.id)).toEqual([
        a.id,
        b.id,
      ])
      expect(await changeEntries()).toEqual([])
    })

    // The last workout stays. (Since step 2b-ii a program's last workout is
    // always in its schedule too — every program starts with a schedule
    // naming at least one workout — so the old race, two simultaneous
    // deletes of a program's only two workouts, can't be set up any more:
    // one of the two is always scheduled. The lock itself is proven by
    // "locks the program while adding or deleting a workout" below.)
    it('refuses to delete the last workout', async () => {
      const inline = await practitionerA.post('/assigned-programs').send({
        patientId,
        title: 'One Workout',
        startDate: today,
        schedule: MWF,
        exercises: [{ exerciseId, sortOrder: 0 }],
      })
      const { id, workouts } = inline.body as WithWorkouts
      const res = await practitionerA.delete(
        `/assigned-programs/${id}/workouts/${workouts[0].id}`,
      )
      expect(res.status).toBe(409)
      expect(res.body.message).toContain(
        'This is the last workout, and there must always be at least one',
      )
    })

    it('deletes an empty workout, keeping the whole row in the audit entry', async () => {
      const withC = await practitionerA
        .post(`/assigned-programs/${program.id}/workouts`)
        .send({ name: 'Spare' })
      const spare = (withC.body as WithWorkouts).workouts[2]
      const res = await practitionerA.delete(
        `/assigned-programs/${program.id}/workouts/${spare.id}`,
      )
      expect(res.status).toBe(200)
      expect((res.body as WithWorkouts).workouts).toHaveLength(2)
      const entries = await changeEntries()
      expect(entries.map((e) => e.action)).toEqual([
        'ASSIGNED_PROGRAM_WORKOUT_ADDED',
        'ASSIGNED_PROGRAM_WORKOUT_REMOVED',
      ])
      expect(entries[1].details).toEqual({
        workout: { id: spare.id, name: 'Spare', sortOrder: 2 },
      })
    })

    // A refused change writes no entry.
    it('refuses to delete a workout that still has exercises, writing nothing', async () => {
      const res = await practitionerA.delete(
        `/assigned-programs/${program.id}/workouts/${program.workouts[1].id}`,
      )
      expect(res.status).toBe(409)
      expect(res.body.message).toContain(
        'Workout B still has exercises: move or remove them first',
      )
      expect(await changeEntries()).toEqual([])
    })

    // A session is the patient's history: its workout stays, even emptied.
    it('refuses to delete a workout that a session recorded', async () => {
      const b = program.workouts[1]
      const started = await patient.post('/sessions').send({
        assignedProgramId: program.id,
        localDate: today,
        workoutId: b.id,
      })
      expect(started.status).toBe(201)
      // Empty it (move its exercise to A), so only the session stands in
      // the way.
      const b1 = program.exercises[2]
      const moved = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${b1.id}`)
        .send({ workoutId: program.workouts[0].id })
      expect(moved.status).toBe(200)
      // Moved to the END of A (its old position, 0, would put it first).
      expect(layout(moved.body as WithWorkouts)).toEqual([
        [0, 'a1'],
        [0, 'a2'],
        [0, 'b1'],
      ])
      const res = await practitionerA.delete(
        `/assigned-programs/${program.id}/workouts/${b.id}`,
      )
      expect(res.status).toBe(409)
      expect(res.body.message).toContain(
        "Workout B has recorded sessions, so it is part of the patient's history and can't be deleted",
      )
    })

    // The schedule is the plan the patient follows, and past versions say
    // how past days were judged ("Wednesday = B"): a workout any version
    // names — in force now, or only PLANNED — stays, even emptied.
    // `program` (Monday, Wednesday, Friday = A) never names B, which is why
    // the other tests can delete it once empty.
    describe('a workout in the schedule', () => {
      // B emptied: its one exercise moved to A, so only the schedule can
      // stand in the way.
      async function emptyB(target: WithWorkouts) {
        const b1 = target.exercises.find(
          (e) => e.workoutId === target.workouts[1].id,
        )!
        const moved = await practitionerA
          .patch(`/assigned-programs/${target.id}/exercises/${b1.id}`)
          .send({ workoutId: target.workouts[0].id })
        expect(moved.status).toBe(200)
      }

      it('refuses to delete a workout the current schedule uses, writing nothing', async () => {
        // Monday A, Wednesday B.
        const scheduled = await assign(sharedTemplate.id, {
          type: 'weekdays',
          days: [
            { weekday: 1, workoutIndex: 0 },
            { weekday: 3, workoutIndex: 1 },
          ],
        })
        await emptyB(scheduled)

        const res = await practitionerA.delete(
          `/assigned-programs/${scheduled.id}/workouts/${scheduled.workouts[1].id}`,
        )
        expect(res.status).toBe(409)
        expect(res.body.message).toContain(
          "Workout B is part of the program's schedule (now, planned, or in its history), so it can't be deleted",
        )
        const trail = await auditTrail(scheduled.id)
        expect(trail.map((entry) => entry.action)).not.toContain(
          'ASSIGNED_PROGRAM_WORKOUT_REMOVED',
        )
      })

      // A rotation counts too — and a version planned for next week does.
      it('refuses to delete a workout a planned rotation uses', async () => {
        await emptyB(program)
        const planned = await practitionerA
          .post(`/assigned-programs/${program.id}/schedules`)
          .send({
            type: 'times_per_week',
            timesPerWeek: 2,
            rotation: [program.workouts[1].id],
            effectiveFrom: addDays(today, 7),
          })
        expect(planned.status).toBe(201)

        const res = await practitionerA.delete(
          `/assigned-programs/${program.id}/workouts/${program.workouts[1].id}`,
        )
        expect(res.status).toBe(409)
        expect(res.body.message).toContain(
          "Workout B is part of the program's schedule (now, planned, or in its history), so it can't be deleted",
        )
      })
    })

    it('locks the program while adding or deleting a workout', async () => {
      const added = await waitsForRowLock('assigned_programs', program.id, () =>
        practitionerA
          .post(`/assigned-programs/${program.id}/workouts`)
          .send({}),
      )
      expect(added).toMatchObject({ waited: true, res: { status: 201 } })
      const c = (added.res.body as WithWorkouts).workouts[2]
      const removed = await waitsForRowLock(
        'assigned_programs',
        program.id,
        () =>
          practitionerA.delete(
            `/assigned-programs/${program.id}/workouts/${c.id}`,
          ),
      )
      expect(removed).toMatchObject({ waited: true, res: { status: 200 } })
    })

    // Another program of the SAME patient, so row-level security lets A
    // touch both: only the service's "one of THIS program's workouts" check
    // stands between a request and the wrong program — for each route.
    describe("another program's workout", () => {
      let other: WithWorkouts
      beforeEach(async () => {
        other = await assign(sharedTemplate.id)
      })

      it('cannot receive an exercise moved from this program', async () => {
        const res = await practitionerA
          .patch(
            `/assigned-programs/${program.id}/exercises/${program.exercises[0].id}`,
          )
          .send({ workoutId: other.workouts[0].id })
        expect(res.status).toBe(404)
        expect(res.body.message).toContain(
          `Workout ${other.workouts[0].id} not found in this program`,
        )
      })

      it('cannot be renamed through this program', async () => {
        const res = await practitionerA
          .patch(
            `/assigned-programs/${program.id}/workouts/${other.workouts[1].id}`,
          )
          .send({ name: 'Wrong one' })
        expect(res.status).toBe(404)
        const after = await practitionerA.get(`/assigned-programs/${other.id}`)
        expect((after.body as WithWorkouts).workouts[1].name).toBe('Lower body')
      })

      it('cannot be deleted through this program', async () => {
        const added = await practitionerA
          .post(`/assigned-programs/${other.id}/workouts`)
          .send({})
        const spare = (added.body as WithWorkouts).workouts[2]
        const res = await practitionerA.delete(
          `/assigned-programs/${program.id}/workouts/${spare.id}`,
        )
        expect(res.status).toBe(404)
        const after = await practitionerA.get(`/assigned-programs/${other.id}`)
        expect((after.body as WithWorkouts).workouts).toHaveLength(3)
      })
    })

    it("refuses an exercise for another program's workout", async () => {
      const other = await assign(sharedTemplate.id)
      const res = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({ exerciseId, sortOrder: 0, workoutId: other.workouts[0].id })
      expect(res.status).toBe(404)
      expect(res.body.message).toContain(
        `Workout ${other.workouts[0].id} not found in this program`,
      )
    })

    it('reorders the exercises of one workout of the program', async () => {
      const [a] = program.workouts
      const [a1, a2] = program.exercises
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises`)
        .send({ workoutId: a.id, order: [a2.id, a1.id] })
      expect(res.status).toBe(200)
      expect(layout(res.body as WithWorkouts)).toEqual([
        [0, 'a2'],
        [0, 'a1'],
        [1, 'b1'],
      ])
    })

    // The patient sees their program but never changes it; a colleague off
    // the care team can't even see it (404, like any program they can't see).
    it('refuses the patient and a colleague off the care team', async () => {
      const asPatient = await patient
        .post(`/assigned-programs/${program.id}/workouts`)
        .send({})
      expect(asPatient.status).toBe(403)
      const asColleague = await practitionerB
        .post(`/assigned-programs/${program.id}/workouts`)
        .send({})
      expect(asColleague.status).toBe(404)
      expect(await changeEntries()).toEqual([])
    })
  })

  // --- 4. Sessions ---------------------------------------------------------------

  describe('sessions', () => {
    let program: WithWorkouts
    beforeAll(async () => {
      program = await assign(sharedTemplate.id)
    })

    // The checklist is THAT workout's exercises — B's one, not all three.
    it("records the workout, with that workout's exercises as the checklist", async () => {
      const b = program.workouts[1]
      const res = await patient.post('/sessions').send({
        assignedProgramId: program.id,
        localDate: today,
        workoutId: b.id,
      })
      expect(res.status).toBe(201)
      expect(res.body.workoutId).toBe(b.id)
      expect(
        (res.body.exercises as { assignedProgramExerciseId: number }[]).map(
          (e) => e.assignedProgramExerciseId,
        ),
      ).toEqual([program.exercises[2].id])
    })

    it('refuses to guess the workout of a several-workout program', async () => {
      const res = await patient
        .post('/sessions')
        .send({ assignedProgramId: program.id, localDate: today })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        'This program has 2 workouts (A, B): say which one this session is (workoutId)',
      )
    })

    it("refuses another program's workout", async () => {
      const other = await assign(sharedTemplate.id)
      const res = await patient.post('/sessions').send({
        assignedProgramId: program.id,
        localDate: today,
        workoutId: other.workouts[0].id,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        `Workout ${other.workouts[0].id} is not part of this program`,
      )
    })

    // A one-workout program works as before workouts existed.
    it('uses the only workout when none is sent', async () => {
      const template = await newTemplate('One Workout')
      await addTemplateExercise(template.id)
      const single = await assign(template.id)
      const res = await patient
        .post('/sessions')
        .send({ assignedProgramId: single.id, localDate: today })
      expect(res.status).toBe(201)
      expect(res.body.workoutId).toBe(single.workouts[0].id)
    })
  })

  // --- 5. The database's own guarantees ----------------------------------------

  // What node-postgres reports, through Drizzle's wrapper (the original
  // error is in `cause`) — the code and, when there is one, the constraint.
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

  // Constraints hold for everyone, the owner included (who isn't subject to
  // row-level security). Each statement runs in a transaction that is
  // always rolled back.
  describe('constraints', () => {
    async function asOwner(statement: string, params: unknown[]) {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(statement, params)
        return {}
      } catch (error) {
        return pgError(error)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    let template: WithWorkouts
    let otherTemplate: WithWorkouts
    let program: WithWorkouts
    let otherProgram: WithWorkouts
    beforeAll(async () => {
      template = sharedTemplate
      otherTemplate = await twoWorkoutTemplate()
      program = await assign(template.id)
      otherProgram = await assign(otherTemplate.id)
    })

    // The composite foreign keys: a workout of ANOTHER template or program
    // exists — a plain key on workout_id would accept it.
    it("refuses a template exercise in another template's workout", async () => {
      expect(
        await asOwner(
          'UPDATE template_exercises SET workout_id = $1 WHERE id = $2',
          [otherTemplate.workouts[0].id, template.exercises[0].id],
        ),
      ).toEqual({ code: '23503', constraint: 'template_exercises_workout_fk' })
    })

    it("refuses a program exercise in another program's workout", async () => {
      expect(
        await asOwner(
          'UPDATE assigned_program_exercises SET workout_id = $1 WHERE id = $2',
          [otherProgram.workouts[0].id, program.exercises[0].id],
        ),
      ).toEqual({
        code: '23503',
        constraint: 'assigned_program_exercises_workout_fk',
      })
    })

    it("refuses a session of another program's workout", async () => {
      expect(
        await asOwner(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id, scheduled_date, local_date, status, started_at)
           VALUES ($1, $2, $3, now(), $4, 'in_progress', now())`,
          [program.id, otherProgram.workouts[0].id, patientId, today],
        ),
      ).toEqual({ code: '23503', constraint: 'sessions_workout_fk' })
    })

    // The control case: the same statement with the program's own workout.
    it("accepts a session of the program's own workout", async () => {
      expect(
        await asOwner(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id, scheduled_date, local_date, status, started_at)
           VALUES ($1, $2, $3, now(), $4, 'in_progress', now())`,
          [program.id, program.workouts[0].id, patientId, today],
        ),
      ).toEqual({})
    })

    // NO ACTION on delete: a workout that still has exercises can't go.
    it('refuses to delete a workout that still has exercises', async () => {
      expect(
        await asOwner('DELETE FROM template_workouts WHERE id = $1', [
          template.workouts[0].id,
        ]),
      ).toEqual({ code: '23503', constraint: 'template_exercises_workout_fk' })
    })

    it.each([
      ['template_workouts', 'template_workouts_name_not_blank'],
      ['program_workouts', 'program_workouts_name_not_blank'],
    ])('refuses a blank name in %s', async (table, constraint) => {
      const id =
        table === 'template_workouts'
          ? template.workouts[0].id
          : program.workouts[0].id
      expect(
        await asOwner(`UPDATE ${table} SET name = '   ' WHERE id = $1`, [id]),
      ).toEqual({ code: '23514', constraint })
    })
  })

  // Row-level security, as the app's own database role (the restricted
  // connection the running app uses — `db`), with an actor's context set
  // the way withRlsContext sets it. Everything is rolled back.
  describe('row-level security', () => {
    type Actor = { userId: number; role: string }

    class RolledBack extends Error {
      constructor(readonly rows: Record<string, unknown>[]) {
        super('rolled back on purpose')
      }
    }

    // Statements run in order in ONE transaction; the result is the LAST
    // one's rows, or the error that stopped them.
    async function run(actor: Actor, ...statements: SQL[]) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true)`,
          )
          await tx.execute(
            sql`SELECT set_config('app.current_role', ${actor.role}, true)`,
          )
          let rows: Record<string, unknown>[] = []
          for (const statement of statements) {
            rows = (await tx.execute<Record<string, unknown>>(statement)).rows
          }
          throw new RolledBack(rows)
        })
      } catch (error) {
        if (error instanceof RolledBack) return { rows: error.rows }
        return { error: pgError(error) }
      }
      throw new Error('unreachable: run() always rolls back')
    }

    const asA = (): Actor => ({ userId: practitionerAId, role: 'practitioner' })
    const asB = (): Actor => ({ userId: practitionerBId, role: 'practitioner' })
    const asPatient = (): Actor => ({ userId: patientId, role: 'patient' })
    const asAdmin = (): Actor => ({ userId: adminId, role: 'admin' })

    let template: WithWorkouts
    let program: WithWorkouts
    beforeAll(async () => {
      template = await newTemplate('RLS Template')
      await addTemplateExercise(template.id)
      program = await assign(template.id)
    })

    describe('template_workouts', () => {
      const insert = () => sql`
        INSERT INTO template_workouts (template_id, sort_order)
        VALUES (${template.id}, 1)`
      // RETURNING: an UPDATE / DELETE that RLS filters out changes zero
      // rows without an error — the returned rows are the evidence.
      const rename = () => sql`
        UPDATE template_workouts SET name = 'Changed'
        WHERE id = ${template.workouts[0].id} RETURNING id`
      const remove = () => sql`
        DELETE FROM template_workouts
        WHERE id = ${template.workouts[0].id} RETURNING id`

      // The template library is shared: everyone reads.
      it("lets everyone read a template's workouts", async () => {
        const read = sql`SELECT id FROM template_workouts WHERE template_id = ${template.id}`
        for (const actor of [asA(), asB(), asPatient()]) {
          expect((await run(actor, read)).rows).toHaveLength(1)
        }
      })

      it('lets the owner and an admin add one; nobody else', async () => {
        expect(await run(asA(), insert())).toEqual({ rows: [] })
        expect(await run(asAdmin(), insert())).toEqual({ rows: [] })
        // 42501 = insufficient_privilege: a new row failing WITH CHECK.
        expect(await run(asB(), insert())).toEqual({
          error: { code: '42501' },
        })
      })

      // B CAN see the row (SELECT is open to everyone), so only the
      // UPDATE / DELETE policies' own rule stops them — the actor that
      // proves those rules (decisions §5, "Step 1": someone who can't see
      // the row proves nothing).
      it('lets only the owner rename or delete one', async () => {
        expect((await run(asA(), rename())).rows).toHaveLength(1)
        expect(await run(asB(), rename())).toEqual({ rows: [] })
        expect(await run(asB(), remove())).toEqual({ rows: [] })
      })
    })

    describe('program_workouts', () => {
      const read = () =>
        sql`SELECT id FROM program_workouts WHERE assigned_program_id = ${program.id}`
      const insert = () => sql`
        INSERT INTO program_workouts (assigned_program_id, sort_order)
        VALUES (${program.id}, 1)`
      const rename = () => sql`
        UPDATE program_workouts SET name = 'Changed'
        WHERE id = ${program.workouts[0].id} RETURNING id`
      const remove = (id: number) =>
        sql`DELETE FROM program_workouts WHERE id = ${id} RETURNING id`

      it('lets the care team, the patient and an admin read them; not a colleague off the team', async () => {
        expect((await run(asA(), read())).rows).toHaveLength(1)
        expect((await run(asPatient(), read())).rows).toHaveLength(1)
        expect((await run(asAdmin(), read())).rows).toHaveLength(1)
        expect((await run(asB(), read())).rows).toHaveLength(0)
      })

      it('lets the care team add one; not the patient, nor a colleague off the team', async () => {
        expect(await run(asA(), insert())).toEqual({ rows: [] })
        expect(await run(asPatient(), insert())).toEqual({
          error: { code: '42501' },
        })
        expect(await run(asB(), insert())).toEqual({
          error: { code: '42501' },
        })
      })

      // The PATIENT is the actor that matters: they can see the workouts
      // (SELECT), so only the UPDATE / DELETE policies' "admin or care
      // team" rule stops them.
      it('lets the care team rename and delete; not the patient', async () => {
        expect((await run(asA(), rename())).rows).toHaveLength(1)
        expect(await run(asPatient(), rename())).toEqual({ rows: [] })

        // DELETE needs an EMPTY workout, so that only RLS can refuse it
        // (never the exercises' foreign key): one is committed as the owner
        // first (the app role's transaction must see it), and removed again
        // afterwards whatever happens. Each run() rolls its DELETE back.
        const { rows } = await sessionPool.query<{ id: number }>(
          `INSERT INTO program_workouts (assigned_program_id, sort_order)
           VALUES ($1, 1) RETURNING id`,
          [program.id],
        )
        const emptyId = rows[0].id
        try {
          expect((await run(asA(), remove(emptyId))).rows).toHaveLength(1)
          expect(await run(asPatient(), remove(emptyId))).toEqual({ rows: [] })
        } finally {
          await sessionPool.query(
            'DELETE FROM program_workouts WHERE id = $1',
            [emptyId],
          )
        }
      })
    })
  })
})
