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

// Assigned programs' schedules (decisions §5, "Settled 2026-10-09"):
//   1. creating a program stores its first schedule version — its days
//      (each with a workout) or its rotation of workouts (step 2b-ii);
//   2. adding a version "from day D" replaces the versions from D on, and
//      keeps the ones before; a version can also be a pause;
//   3. which days are allowed, and who may change a schedule;
//   4. the two gaps closed with this work (archived template, the full
//      program from PATCH exercise) and the program's date order;
//   5. the database's own guarantees: constraints (as the owner) and
//      row-level security (as the app's role).
//
// Dates are computed from the real clock (utcToday), never written as
// constants: the rules are about "the past", so fixed dates would start
// failing as time passes.
//
// Rate limits: 3 logins (5 per minute allowed) — the admin's session comes
// from register-clinic.
describe('Program schedules (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb

  let admin: ReturnType<typeof request.agent>
  // On the patient's care team.
  let practitionerA: ReturnType<typeof request.agent>
  // Same clinic as the patient, NOT on the care team: directory access only.
  let practitionerC: ReturnType<typeof request.agent>
  let patient: ReturnType<typeof request.agent>

  let adminId: number
  let practitionerAId: number
  let practitionerCId: number
  let patientId: number
  let templateId: number
  // Two workouts: A and B, one exercise each.
  let twoWorkoutTemplateId: number
  let emptyTemplateId: number
  let archivedTemplateId: number

  const today = utcToday()
  // When assigning, workouts are named by POSITION (0 = A): the program —
  // and its workout ids — doesn't exist yet. Monday, Wednesday, Friday,
  // all workout A (the usual template has only A).
  const MWF = {
    type: 'weekdays',
    days: [1, 3, 5].map((weekday) => ({ weekday, workoutIndex: 0 })),
  }
  // No rotation: the suggestion, every workout in order.
  const THREE_A_WEEK = { type: 'times_per_week', timesPerWeek: 3 }

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
    practitionerC = request.agent(app.getHttpServer())
    patient = request.agent(app.getHttpServer())

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Schedules E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Sched',
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
      email: `pa-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `SCHED-A-${stamp}`,
    })
    practitionerCId = await createAndLogIn(practitionerC, {
      email: `pc-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'C',
      licenseNumber: `SCHED-C-${stamp}`,
    })
    patientId = await createAndLogIn(patient, {
      email: `patient-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Sched',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
    })
    // The admin created the patient, so nobody is on the care team yet:
    // practitionerA joins; practitionerC deliberately doesn't.
    const join = await practitionerA
      .post(`/users/${patientId}/care-team`)
      .send({})
    expect(join.status).toBe(201)

    const exercise = await practitionerA.post('/exercises').send({
      name: 'Schedules E2E Bridge',
      primaryMuscles: ['glutes'],
      instructions: ['Lift the hips'],
    })
    const exerciseId: number = exercise.body.id

    async function template(title: string, withExercise: boolean) {
      const res = await practitionerA.post('/programs').send({ title })
      if (withExercise) {
        await practitionerA
          .post(`/programs/${res.body.id}/exercises`)
          .send({ exerciseId, sets: 2, reps: 10, sortOrder: 0 })
      }
      return res.body.id as number
    }
    templateId = await template('Schedules Template', true)
    twoWorkoutTemplateId = await template('Two Workouts Template', true)
    const withB = await practitionerA
      .post(`/programs/${twoWorkoutTemplateId}/workouts`)
      .send({})
    expect(withB.status).toBe(201)
    await practitionerA
      .post(`/programs/${twoWorkoutTemplateId}/exercises`)
      .send({
        exerciseId,
        sets: 3,
        reps: 8,
        sortOrder: 0,
        workoutId: withB.body.workouts[1].id,
      })
    emptyTemplateId = await template('Empty Template', false)
    archivedTemplateId = await template('Archived Template', true)
    const archived = await practitionerA.delete(
      `/programs/${archivedTemplateId}`,
    )
    expect(archived.status).toBe(200)

    sharedMwf = await createProgram({ startsIn: -30 })
    sharedPerWeek = await createProgram({
      startsIn: -30,
      schedule: THREE_A_WEEK,
    })
  })

  // Two programs started 30 days ago — Monday/Wednesday/Friday = A, and
  // three a week with the rotation [A] — for the tests that only read them,
  // change them inside rolled-back transactions, or need "another
  // program's workout". Created once: POST /assigned-programs allows 60
  // requests a minute, and this file creates many programs.
  let sharedMwf: Program
  let sharedPerWeek: Program

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // A program for the patient from the usual template (or another).
  // `startsIn` days from today (negative = started in the past).
  async function createProgram(
    options: {
      startsIn?: number
      endsIn?: number
      schedule?: object
      template?: number
    } = {},
  ) {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnTemplateId: options.template ?? templateId,
      title: 'Schedules E2E Program',
      startDate: addDays(today, options.startsIn ?? -20),
      ...(options.endsIn !== undefined
        ? { endDate: addDays(today, options.endsIn) }
        : {}),
      schedule: options.schedule ?? MWF,
    })
    expect(res.status).toBe(201)
    return res.body as Program
  }

  interface Program {
    id: number
    startDate: string
    schedules: ScheduleVersion[]
    workouts: { id: number; name: string | null; sortOrder: number }[]
    exercises: { id: number; workoutId: number }[]
  }

  interface ScheduleVersion {
    id: number
    assignedProgramId: number
    type: string
    timesPerWeek: number | null
    days: { weekday: number; workoutId: number }[]
    rotation: number[]
    effectiveFrom: string
    createdBy: number
    createdAt: string
  }

  // A LATER version's days: the program exists, so workouts are named by
  // id — here every day is the program's first workout.
  function onDays(program: Program, weekdays: number[]) {
    const workoutId = program.workouts[0].id
    return {
      type: 'weekdays',
      days: weekdays.map((weekday) => ({ weekday, workoutId })),
    }
  }

  // Versions as [effectiveFrom, what] pairs — readable in a failing test:
  // the weekdays, the count, or 'paused'.
  function summary(versions: ScheduleVersion[]) {
    return versions.map((v) => [
      v.effectiveFrom,
      v.type === 'weekdays'
        ? v.days.map((day) => day.weekday)
        : v.type === 'times_per_week'
          ? v.timesPerWeek
          : v.type,
    ])
  }

  // --- 1. Creating a program ---------------------------------------------------

  describe('creating a program', () => {
    it('stores the schedule as its first version, from the start date, days sorted', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: templateId,
        title: 'First Version',
        startDate: addDays(today, 3),
        schedule: { ...MWF, days: [...MWF.days].reverse() },
      })
      expect(res.status).toBe(201)

      // Read back separately: what the database holds, not just what the
      // create response said. Position 0 became the program's OWN workout A
      // (a new row, copied from the template's).
      const readBack = await practitionerA.get(
        `/assigned-programs/${res.body.id}`,
      )
      const a = (readBack.body as Program).workouts[0].id
      expect(readBack.body.schedules).toHaveLength(1)
      const [version] = readBack.body.schedules as ScheduleVersion[]
      expect(version).toEqual({
        id: expect.any(Number),
        assignedProgramId: res.body.id,
        type: 'weekdays',
        timesPerWeek: null,
        days: [
          { weekday: 1, workoutId: a },
          { weekday: 3, workoutId: a },
          { weekday: 5, workoutId: a },
        ],
        rotation: [],
        effectiveFrom: addDays(today, 3),
        createdBy: practitionerAId,
        createdAt: expect.any(String),
      })
    })

    // Each position becomes the NEW program's workout at that position.
    it('gives each day the workout at its position', async () => {
      const program = await createProgram({
        template: twoWorkoutTemplateId,
        schedule: {
          type: 'weekdays',
          days: [
            { weekday: 1, workoutIndex: 1 },
            { weekday: 4, workoutIndex: 0 },
          ],
        },
      })
      const [a, b] = program.workouts.map((w) => w.id)
      expect(program.schedules[0].days).toEqual([
        { weekday: 1, workoutId: b },
        { weekday: 4, workoutId: a },
      ])
    })

    // No rotation sent: the suggestion, every workout in order (A, B). A
    // rotation sent: kept as given, repeats included.
    it.each([
      ['suggests every workout in order', undefined, [0, 1]],
      ['keeps a rotation as given', [1, 1, 0], [1, 1, 0]],
    ])(
      '%s for a times-per-week schedule',
      async (_label, rotation, positions) => {
        const program = await createProgram({
          template: twoWorkoutTemplateId,
          schedule: { ...THREE_A_WEEK, ...(rotation ? { rotation } : {}) },
        })
        const ids = program.workouts.map((w) => w.id)
        expect(program.schedules[0]).toMatchObject({
          type: 'times_per_week',
          timesPerWeek: 3,
          days: [],
          rotation: positions.map((position) => ids[position]),
        })
      },
    )

    // The position is checked against the copied workouts, inside the
    // transaction that copied them: a refusal leaves no program behind.
    it("refuses a workout position the template doesn't have, creating nothing", async () => {
      const list = () =>
        practitionerA.get(`/assigned-programs?patientId=${patientId}`)
      const before = (await list()).body.length

      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: templateId,
        title: 'Too Far',
        startDate: today,
        schedule: { type: 'weekdays', days: [{ weekday: 1, workoutIndex: 1 }] },
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "workoutIndex 1 doesn't exist: the program has 1 workout (A)",
      ])
      expect((await list()).body).toHaveLength(before)
    })

    // A program that began last week can be recorded: its first version
    // goes on its (past) start date — the one past day the database's
    // INSERT policy allows.
    it('accepts a start date in the past, with the first version on it', async () => {
      const program = await createProgram({
        startsIn: -10,
        schedule: THREE_A_WEEK,
      })
      expect(summary(program.schedules)).toEqual([[addDays(today, -10), 3]])
    })

    it('refuses a program without a schedule', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: templateId,
        title: 'No Schedule',
        startDate: today,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(
        'schedule should not be null or undefined',
      )
    })

    it('refuses an end date before the start date', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: templateId,
        title: 'Backwards',
        startDate: today,
        endDate: addDays(today, -1),
        schedule: MWF,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "The end date can't be before the start date",
      ])
    })

    // The gap from deferred-improvements.md: nothing in the UI offers an
    // archived template, but the API used to accept one.
    it('refuses an archived template', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: archivedTemplateId,
        title: 'From The Bin',
        startDate: today,
        schedule: MWF,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'Archived program templates cannot be assigned',
      ])
    })

    it('refuses an empty template (400) and a missing one (404)', async () => {
      const empty = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: emptyTemplateId,
        title: 'Nothing To Copy',
        startDate: today,
        schedule: MWF,
      })
      expect(empty.status).toBe(400)
      expect(empty.body.message).toEqual([
        `Program template ${emptyTemplateId} has no exercises to copy`,
      ])

      const missing = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: 999999,
        title: 'Nowhere',
        startDate: today,
        schedule: MWF,
      })
      expect(missing.status).toBe(404)
    })

    // Batched in the service (one query for every program's versions):
    // check the grouping against real rows — two programs, each must get
    // its OWN versions.
    it('lists each program with its own versions', async () => {
      const first = await createProgram({ schedule: MWF })
      const second = await createProgram({ schedule: THREE_A_WEEK })

      const list = await practitionerA.get(
        `/assigned-programs?patientId=${patientId}`,
      )
      expect(list.status).toBe(200)
      const byId = new Map(
        (list.body as { id: number; schedules: ScheduleVersion[] }[]).map(
          (p) => [p.id, p],
        ),
      )
      expect(summary(byId.get(first.id)!.schedules)).toEqual([
        [first.startDate, [1, 3, 5]],
      ])
      expect(summary(byId.get(second.id)!.schedules)).toEqual([
        [second.startDate, 3],
      ])
      // …and each version its own days and rotation (read in one query
      // each, for every version of every program, then grouped).
      expect(byId.get(first.id)!.schedules[0]).toMatchObject({
        days: first.schedules[0].days,
        rotation: [],
      })
      expect(byId.get(second.id)!.schedules[0]).toMatchObject({
        days: [],
        rotation: [second.workouts[0].id],
      })
    })
  })

  // --- 2. Adding a version -----------------------------------------------------

  describe('adding a version', () => {
    const add = (programId: number, body: object) =>
      practitionerA.post(`/assigned-programs/${programId}/schedules`).send(body)

    it('keeps the earlier version and adds the new one after it', async () => {
      const program = await createProgram()

      const res = await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: today,
      })
      expect(res.status).toBe(201)
      // The response is the full program, schedules oldest first.
      expect(summary(res.body.schedules)).toEqual([
        [program.startDate, [1, 3, 5]],
        [today, 3],
      ])
      expect(res.body.exercises).toHaveLength(1)
    })

    // A correction: the same day again replaces, it doesn't pile up (and
    // doesn't fail on the one-version-per-day constraint).
    it('replaces a version set for the same day', async () => {
      const program = await createProgram()
      await add(program.id, { ...THREE_A_WEEK, effectiveFrom: today })

      const res = await add(program.id, {
        ...onDays(program, [2, 4]),
        effectiveFrom: today,
      })
      expect(res.status).toBe(201)
      expect(summary(res.body.schedules)).toEqual([
        [program.startDate, [1, 3, 5]],
        [today, [2, 4]],
      ])
    })

    // A change planned for next week, then a change from today: "from today
    // on, this is the schedule" — the planned one is superseded.
    it('supersedes a version planned for later', async () => {
      const program = await createProgram()
      await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: addDays(today, 7),
      })

      const res = await add(program.id, {
        ...onDays(program, [2]),
        effectiveFrom: today,
      })
      expect(summary(res.body.schedules)).toEqual([
        [program.startDate, [1, 3, 5]],
        [today, [2]],
      ])
    })

    // The other direction: only versions from the new day ON are replaced.
    // A naive "replace every future version" would also drop the +3 one.
    it('keeps a version that starts before the new one', async () => {
      const program = await createProgram()
      await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: addDays(today, 3),
      })

      const res = await add(program.id, {
        ...onDays(program, [6, 7]),
        effectiveFrom: addDays(today, 7),
      })
      expect(summary(res.body.schedules)).toEqual([
        [program.startDate, [1, 3, 5]],
        [addDays(today, 3), 3],
        [addDays(today, 7), [6, 7]],
      ])
    })

    // "From day D on" is about THIS program. Without the program in the
    // delete's WHERE, the change would also wipe every other program's
    // versions from D on — which each test's own fresh program can't see.
    it("leaves other programs' versions alone", async () => {
      const program = await createProgram()
      const other = await createProgram()
      await add(other.id, { ...THREE_A_WEEK, effectiveFrom: addDays(today, 5) })

      await add(program.id, {
        ...onDays(program, [2]),
        effectiveFrom: today,
      })

      const readBack = await practitionerA.get(`/assigned-programs/${other.id}`)
      expect(summary(readBack.body.schedules)).toEqual([
        [other.startDate, [1, 3, 5]],
        [addDays(today, 5), 3],
      ])
    })

    // Before the program has started, the first version can be replaced:
    // a version from the start date itself (it's in the future).
    it("replaces the first version of a program that hasn't started yet", async () => {
      const program = await createProgram({ startsIn: 5 })

      const res = await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: program.startDate,
      })
      expect(summary(res.body.schedules)).toEqual([[program.startDate, 3]])
    })

    it.each([
      [
        'two days ago',
        { startsIn: -20 },
        -2,
        "A schedule change can't apply to a day in the past",
      ],
      [
        'before the program starts',
        { startsIn: 10 },
        5,
        `A schedule change can't apply before the program starts (${addDays(today, 10)})`,
      ],
      [
        'after the program ends',
        { startsIn: -20, endsIn: 30 },
        31,
        `A schedule change can't apply after the program ends (${addDays(today, 30)})`,
      ],
    ])(
      'refuses a version starting %s, changing nothing',
      async (_label, dates, offset, message) => {
        const program = await createProgram(dates)

        const res = await add(program.id, {
          ...THREE_A_WEEK,
          effectiveFrom: addDays(today, offset),
        })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual([message])

        const readBack = await practitionerA.get(
          `/assigned-programs/${program.id}`,
        )
        expect(summary(readBack.body.schedules)).toEqual(
          summary(program.schedules),
        )
      },
    )

    // The one day of slack, at the API: yesterday in UTC is someone's today.
    it('accepts yesterday (UTC)', async () => {
      const program = await createProgram()
      const res = await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: addDays(today, -1),
      })
      expect(res.status).toBe(201)
    })

    it('refuses an invalid schedule with a 400', async () => {
      const program = await createProgram()
      const res = await add(program.id, {
        ...onDays(program, [1, 1]),
        effectiveFrom: today,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'days must not list the same weekday twice',
      ])
    })

    // A later version names workouts by id — and only THIS program's: a
    // workout of another program is "not found" from here, in a day or in
    // a rotation, and nothing changes.
    it.each([
      [
        'a day',
        (workoutId: number) => ({
          type: 'weekdays',
          days: [{ weekday: 2, workoutId }],
        }),
      ],
      [
        'a rotation',
        (workoutId: number) => ({
          type: 'times_per_week',
          timesPerWeek: 2,
          rotation: [workoutId],
        }),
      ],
    ])(
      "refuses another program's workout in %s (404)",
      async (_label, schedule) => {
        const program = await createProgram()
        const foreign = sharedPerWeek.workouts[0].id

        const res = await add(program.id, {
          ...schedule(foreign),
          effectiveFrom: today,
        })
        expect(res.status).toBe(404)
        expect(res.body.message).toEqual([
          `Workout ${foreign} not found in this program`,
        ])
        const readBack = await practitionerA.get(
          `/assigned-programs/${program.id}`,
        )
        expect(summary(readBack.body.schedules)).toEqual(
          summary(program.schedules),
        )
      },
    )

    // A pause is a version like any other (decisions §5): from its day on,
    // nothing is expected — until a later version resumes the program.
    it('adds a pause, with neither days nor a rotation', async () => {
      const program = await createProgram()

      const paused = await add(program.id, {
        type: 'paused',
        effectiveFrom: today,
      })
      expect(paused.status).toBe(201)
      const version = (paused.body.schedules as ScheduleVersion[])[1]
      expect(version).toMatchObject({
        type: 'paused',
        timesPerWeek: null,
        days: [],
        rotation: [],
        effectiveFrom: today,
      })

      // Resumed a week later, as a later version.
      const resumed = await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: addDays(today, 7),
      })
      expect(summary(resumed.body.schedules)).toEqual([
        [program.startDate, [1, 3, 5]],
        [today, 'paused'],
        [addDays(today, 7), 3],
      ])
    })

    it('refuses a pause on the start date: a program begins with a schedule', async () => {
      const program = await createProgram({ startsIn: 5 })
      const res = await add(program.id, {
        type: 'paused',
        effectiveFrom: program.startDate,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "A program can't start paused: choose its start date for when it begins",
      ])
    })

    // The old way of pausing — the `on_hold` status — is gone.
    it("refuses the old 'on_hold' status", async () => {
      const program = await createProgram()
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ status: 'on_hold' })
      expect(res.status).toBe(400)
    })

    // Replacing a version deletes its row — and, by the foreign key's
    // ON DELETE CASCADE, its days. Child rows have no DELETE policy (nobody
    // may delete them directly); the cascade runs as the system, past
    // row-level security, so they still go. Checked as the owner: the app
    // role couldn't see an orphan anyway.
    it("takes a replaced version's days with it", async () => {
      const program = await createProgram({ startsIn: 5 })
      const planned = await add(program.id, {
        ...onDays(program, [2, 4]),
        effectiveFrom: addDays(today, 7),
      })
      const replacedId = (planned.body.schedules as ScheduleVersion[])[1].id

      const res = await add(program.id, {
        ...THREE_A_WEEK,
        effectiveFrom: addDays(today, 7),
      })
      expect(res.status).toBe(201)
      const { rows } = await sessionPool.query(
        'SELECT weekday FROM program_schedule_days WHERE schedule_id = $1',
        [replacedId],
      )
      expect(rows).toEqual([])
    })
  })

  // --- 3. Who may change a schedule --------------------------------------------

  describe('who may change a schedule', () => {
    it('lets an admin add a version, recorded as set by the admin', async () => {
      const program = await createProgram()
      const res = await admin
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...THREE_A_WEEK, effectiveFrom: today })
      expect(res.status).toBe(201)
      const added = (res.body.schedules as ScheduleVersion[]).find(
        (v) => v.effectiveFrom === today,
      )
      expect(added?.createdBy).toBe(adminId)
    })

    // The role guard answers before anything is looked up.
    it('refuses the patient (403)', async () => {
      const program = await createProgram()
      const res = await patient
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...THREE_A_WEEK, effectiveFrom: today })
      expect(res.status).toBe(403)
    })

    // Same clinic, not on the care team: row-level security hides the
    // program entirely, so it's a 404 — the API doesn't confirm it exists.
    it('refuses a practitioner who is not on the care team (404)', async () => {
      const program = await createProgram()
      const res = await practitionerC
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...THREE_A_WEEK, effectiveFrom: today })
      expect(res.status).toBe(404)
    })
  })

  // --- 3b. Moving the start date ------------------------------------------------

  describe('moving the start date', () => {
    const patch = (programId: number, body: object) =>
      practitionerA.patch(`/assigned-programs/${programId}`).send(body)

    // Before the program starts, the schedule moves with it: still one
    // version, now on the new start date.
    it('moves the schedule with the start of a program that has not started', async () => {
      const program = await createProgram({ startsIn: 10 })

      const res = await patch(program.id, { startDate: addDays(today, 14) })
      expect(res.status).toBe(200)
      expect(summary(res.body.schedules)).toEqual([
        [addDays(today, 14), [1, 3, 5]],
      ])
    })

    // A change planned after the old start, and the start moved past it:
    // the planned schedule is what starts on the new day.
    it('starts with the schedule that would have been in force on the new day', async () => {
      const program = await createProgram({ startsIn: 10 })
      await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...THREE_A_WEEK, effectiveFrom: addDays(today, 15) })

      const res = await patch(program.id, { startDate: addDays(today, 20) })
      expect(res.status).toBe(200)
      expect(summary(res.body.schedules)).toEqual([[addDays(today, 20), 3]])
    })

    it('refuses to move the start of a program that has started, changing nothing', async () => {
      const program = await createProgram({ startsIn: -20 })

      const res = await patch(program.id, { startDate: addDays(today, 2) })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        `The start date can't change once the program has started (it started on ${program.startDate})`,
      ])
      const readBack = await practitionerA.get(
        `/assigned-programs/${program.id}`,
      )
      expect(readBack.body.startDate).toBe(program.startDate)
      expect(summary(readBack.body.schedules)).toEqual(
        summary(program.schedules),
      )
    })

    // A pause planned from day +15. Moving the start to +20 would make the
    // program BEGIN paused: refused — and the program row's own UPDATE,
    // already sent in the same transaction, is undone with it.
    it('refuses moving the start into a planned pause, changing nothing', async () => {
      const program = await createProgram({ startsIn: 10 })
      const paused = await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ type: 'paused', effectiveFrom: addDays(today, 15) })
      expect(paused.status).toBe(201)

      const res = await patch(program.id, { startDate: addDays(today, 20) })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "A program can't start paused: the new start date falls in a planned pause",
      ])
      const readBack = await practitionerA.get(
        `/assigned-programs/${program.id}`,
      )
      expect(readBack.body.startDate).toBe(program.startDate)
      expect(summary(readBack.body.schedules)).toEqual([
        [program.startDate, [1, 3, 5]],
        [addDays(today, 15), 'paused'],
      ])
    })

    it('refuses to move a future start into the past', async () => {
      const program = await createProgram({ startsIn: 10 })
      const res = await patch(program.id, { startDate: addDays(today, -5) })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "The start date can't be moved into the past",
      ])
    })

    // Re-sending the start date it already has isn't a move: a program that
    // has started can still have its title changed by a form sending both.
    it('accepts the unchanged start date of a started program', async () => {
      const program = await createProgram({ startsIn: -20 })
      const res = await patch(program.id, {
        startDate: program.startDate,
        title: 'Renamed',
      })
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Renamed')
    })
  })

  // --- 3c. The audit trail -------------------------------------------------------

  // What audit_logs holds for one program, read as the owner (an admin-only
  // table for the app). The generic interceptor writes AFTER the response,
  // fire-and-forget, so a short pause first gives a duplicate the chance to
  // appear — otherwise "no generic entry" could pass just by being early.
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

  describe('the audit trail', () => {
    // ONE entry per change, complete — and no generic "POST
    // /assigned-programs" beside it (the route is @AuditedByService()).
    it('records the program as assigned, once', async () => {
      const program = await createProgram({ startsIn: 3 })

      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual(['ASSIGNED_PROGRAM_CREATED'])
      const [entry] = trail
      expect(entry.performed_by).toBe(practitionerAId)
      expect(entry.target_user_id).toBe(patientId)
      // The schedule with its days — each with its workout's id.
      const a = program.workouts[0].id
      expect(entry.details).toMatchObject({
        title: 'Schedules E2E Program',
        startDate: addDays(today, 3),
        endDate: null,
        basedOnTemplateId: templateId,
        schedule: {
          type: 'weekdays',
          timesPerWeek: null,
          days: [1, 3, 5].map((weekday) => ({ weekday, workoutId: a })),
          rotation: [],
          effectiveFrom: addDays(today, 3),
          createdBy: practitionerAId,
        },
      })
      // The prescription itself, copied from the template.
      expect(entry.details?.exercises).toEqual([
        expect.objectContaining({
          sets: 2,
          reps: 10,
          name: 'Schedules E2E Bridge',
        }),
      ])
    })

    // After a replace, the audit entry is the only place the replaced
    // version still exists — so it must be there, whole.
    it('records each schedule change with the versions it replaced', async () => {
      const program = await createProgram()
      await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...THREE_A_WEEK, effectiveFrom: addDays(today, 7) })
      await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...onDays(program, [2, 4]), effectiveFrom: today })

      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_SCHEDULE_SET',
        'ASSIGNED_PROGRAM_SCHEDULE_SET',
      ])
      // Both versions whole, content included: the replaced one's rotation
      // exists nowhere else any more.
      const a = program.workouts[0].id
      expect(trail[2].details).toMatchObject({
        effectiveFrom: today,
        added: {
          type: 'weekdays',
          days: [
            { weekday: 2, workoutId: a },
            { weekday: 4, workoutId: a },
          ],
          rotation: [],
          effectiveFrom: today,
        },
        replaced: [
          {
            type: 'times_per_week',
            timesPerWeek: 3,
            days: [],
            rotation: [a],
            effectiveFrom: addDays(today, 7),
            createdBy: practitionerAId,
          },
        ],
      })
    })

    // A refused change leaves no trace in the trail (it never happened).
    it('records nothing for a refused change', async () => {
      const program = await createProgram()
      const res = await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ ...THREE_A_WEEK, effectiveFrom: addDays(today, -5) })
      expect(res.status).toBe(400)

      expect((await auditTrail(program.id)).map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
      ])
    })

    it('records a PATCH with what changed, and the schedule a start move replaced', async () => {
      const program = await createProgram({ startsIn: 10 })
      await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ startDate: addDays(today, 12), title: 'Schedules E2E Program' })

      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_UPDATED',
      ])
      // The title was re-sent unchanged: not a change, not listed. The
      // re-created version has the same days as the one it replaced.
      const days = program.schedules[0].days
      expect(trail[1].details).toMatchObject({
        changes: {
          startDate: { from: addDays(today, 10), to: addDays(today, 12) },
        },
        scheduleVersions: {
          replaced: [{ effectiveFrom: addDays(today, 10), days }],
          added: { effectiveFrom: addDays(today, 12), days },
        },
      })
      expect(trail[1].details?.changes).not.toHaveProperty('title')
    })
  })

  // --- 3d. The summary ---------------------------------------------------------------

  // The rules are tested in schedule-summary.spec.ts with plain values; here,
  // that the endpoint feeds the module the right data (only COMPLETED
  // sessions, by the patient's local date) and that only the right people
  // may ask.
  describe('the summary', () => {
    const summaryOf = (
      agent: ReturnType<typeof request.agent>,
      programId: number,
      day = today,
    ) => agent.get(`/assigned-programs/${programId}/summary?today=${day}`)

    it('covers the program from its start, with no total for an open-ended one', async () => {
      const program = await createProgram({
        startsIn: -3,
        schedule: THREE_A_WEEK,
      })

      const res = await summaryOf(practitionerA, program.id)
      expect(res.status).toBe(200)
      expect(res.body.firstDay).toBe(program.startDate)
      // Open-ended: up to the end of the current program week (7 days from
      // a start 3 days ago).
      expect(res.body.lastDay).toBe(addDays(program.startDate, 6))
      expect(res.body.today).toBe(today)
      expect(res.body.totals).toEqual({
        expected: null,
        done: 0,
        madeUp: 0,
        swapped: 0,
        missed: 0,
        extra: 0,
      })
      // Three slots, each for the rotation's next workout — A every time
      // (one workout) — and A is what's next.
      const a = program.workouts[0].id
      expect(res.body.weeks).toEqual([
        {
          programWeek: 1,
          start: program.startDate,
          end: addDays(program.startDate, 6),
          timesPerWeek: 3,
          target: 3,
          done: 0,
          state: 'in_progress',
          sessionIds: [],
          workouts: [a, a, a].map((workoutId) => ({
            workoutId,
            sessionId: null,
          })),
        },
      ])
      expect(res.body.nextWorkout).toEqual({
        workoutId: a,
        forDay: null,
        programWeek: 1,
      })
      expect(res.body.pauses).toEqual([])
    })

    // The sessions reach the module WITH their workout: a rotation of B
    // only, and a session of A today — done, but not what the week needs.
    it('judges a session by its workout', async () => {
      const program = await createProgram({
        startsIn: -3,
        template: twoWorkoutTemplateId,
        schedule: { ...THREE_A_WEEK, rotation: [1] },
      })
      const [a] = program.workouts.map((w) => w.id)
      const started = await patient.post('/sessions').send({
        assignedProgramId: program.id,
        localDate: today,
        workoutId: a,
      })
      expect(started.status).toBe(201)
      await patient
        .patch(`/sessions/${started.body.id}`)
        .send({ status: 'completed' })

      const res = await summaryOf(practitionerA, program.id)
      expect(res.body.totals).toMatchObject({ done: 0, extra: 1 })
      expect(res.body.extraSessions).toEqual([
        { sessionId: started.body.id, date: today, reason: 'wrong_workout' },
      ])
    })

    // The versions reach it with their type: a pause from today shows.
    it('shows a pause', async () => {
      const program = await createProgram({
        startsIn: -3,
        schedule: THREE_A_WEEK,
      })
      await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({ type: 'paused', effectiveFrom: today })

      const res = await summaryOf(practitionerA, program.id)
      expect(res.status).toBe(200)
      expect(res.body.pauses).toEqual([{ from: today, to: null }])
    })

    // A real session through the real endpoints: started → not done;
    // completed → done. (A started-and-abandoned session must never count.)
    it('counts a session only once it is completed', async () => {
      const program = await createProgram({
        startsIn: -3,
        schedule: THREE_A_WEEK,
      })
      const started = await patient
        .post('/sessions')
        .send({ assignedProgramId: program.id, localDate: today })
      expect(started.status).toBe(201)
      await patient
        .patch(`/sessions/${started.body.id}`)
        .send({ status: 'in_progress' })

      const before = await summaryOf(practitionerA, program.id)
      expect(before.body.totals.done).toBe(0)

      await patient
        .patch(`/sessions/${started.body.id}`)
        .send({ status: 'completed' })
      const after = await summaryOf(practitionerA, program.id)
      expect(after.body.totals.done).toBe(1)
      expect(after.body.weeks[0].sessionIds).toEqual([started.body.id])
    })

    // Specific days, judged against real dates: a program started 20 days
    // ago on Mon/Wed/Fri, with no sessions, has missed days — and none of
    // them is today or later.
    it('judges specific days with nothing done as missed, never today', async () => {
      const program = await createProgram({ startsIn: -20 })
      const res = await summaryOf(practitionerA, program.id)

      const days = res.body.days as { date: string; state: string }[]
      expect(days.length).toBeGreaterThan(0)
      for (const day of days) {
        if (day.date > today) expect(day.state).toBe('upcoming')
        else expect(['missed', 'due']).toContain(day.state)
      }
      // Missed only once the make-up window has closed — so never today.
      expect(days.find((day) => day.date === today)?.state ?? 'due').toBe('due')
      expect(res.body.totals.missed).toBe(
        days.filter((day) => day.state === 'missed').length,
      )
    })

    it('lets the patient and an admin see it; not a colleague off the care team', async () => {
      const program = await createProgram({
        startsIn: -3,
        schedule: THREE_A_WEEK,
      })
      expect((await summaryOf(patient, program.id)).status).toBe(200)
      expect((await summaryOf(admin, program.id)).status).toBe(200)
      // RLS hides the program from them: 404, existence not confirmed.
      expect((await summaryOf(practitionerC, program.id)).status).toBe(404)
    })

    it('requires a today that is a date, and possibly today', async () => {
      const program = await createProgram({
        startsIn: -3,
        schedule: THREE_A_WEEK,
      })

      const missing = await practitionerA.get(
        `/assigned-programs/${program.id}/summary`,
      )
      expect(missing.status).toBe(400)
      expect(missing.body.message).toEqual([
        'today must be a date written as YYYY-MM-DD',
      ])

      const tooEarly = await summaryOf(
        practitionerA,
        program.id,
        addDays(today, -2),
      )
      expect(tooEarly.status).toBe(400)
      expect(tooEarly.body.message).toEqual([
        "today must be today's date in your time zone",
      ])
    })
  })

  // --- 4. The program's other writes -------------------------------------------

  describe('other writes on a program', () => {
    // The gap from deferred-improvements.md: it used to answer with the bare
    // updated row.
    it('PATCH of an exercise answers with the full program', async () => {
      const program = await createProgram()
      const detail = await practitionerA.get(`/assigned-programs/${program.id}`)
      const rowId: number = detail.body.exercises[0].id

      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${rowId}`)
        .send({ sets: 5 })
      expect(res.status).toBe(200)
      expect(res.body.id).toBe(program.id)
      expect(res.body.exercises).toHaveLength(1)
      expect(res.body.exercises[0].sets).toBe(5)
      expect(res.body.schedules).toHaveLength(1)
    })

    it('PATCH of the program refuses an end before the (stored) start', async () => {
      const program = await createProgram()
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ endDate: addDays(program.startDate, -1) })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "The end date can't be before the start date",
      ])
    })

    it('PATCH of the program refuses null for a required field', async () => {
      const program = await createProgram()
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ startDate: null })
      expect(res.status).toBe(400)
    })
  })

  // --- 5. The database's own guarantees ---------------------------------------

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
  // row-level security). The statements run in order in one transaction
  // that is always rolled back; the result is the error that stopped them,
  // or {} when none did.
  describe('constraints', () => {
    async function asOwner(...steps: [string, unknown[]][]) {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        for (const [statement, params] of steps) {
          await client.query(statement, params)
        }
        return {}
      } catch (error) {
        return pgError(error)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    // The Monday/Wednesday/Friday program (its version: 1, 3, 5 = A) and
    // the three-a-week one (its rotation: A). Each is "another program"
    // for the other. (Assigned in a beforeAll: they exist once the
    // top-level beforeAll has run, not when this file is read.)
    let weekdaysProgram: Program
    let perWeekProgram: Program
    beforeAll(() => {
      weekdaysProgram = sharedMwf
      perWeekProgram = sharedPerWeek
    })

    const insertVersion = `
      INSERT INTO program_schedules
        (assigned_program_id, type, times_per_week, effective_from, created_by)
      VALUES ($1, $2, $3, $4, $5)`

    // "A count exactly when the type is times_per_week" — for each type.
    it.each([
      [
        "'weekdays' with a count",
        ['weekdays', 3],
        'program_schedules_fields_match_type',
      ],
      [
        "'times_per_week' without one",
        ['times_per_week', null],
        'program_schedules_fields_match_type',
      ],
      [
        "'paused' with a count",
        ['paused', 3],
        'program_schedules_fields_match_type',
      ],
      [
        '8 times a week',
        ['times_per_week', 8],
        'program_schedules_times_per_week_range',
      ],
    ])(
      'refuses a version: %s',
      async (_label, [type, timesPerWeek], constraint) => {
        expect(
          await asOwner([
            insertVersion,
            [
              weekdaysProgram.id,
              type,
              timesPerWeek,
              addDays(today, 40),
              practitionerAId,
            ],
          ]),
        ).toEqual({ code: '23514', constraint })
      },
    )

    // The control cases: the same statement with valid rows succeeds, so
    // the refusals above are about their values, not the statement.
    it.each([
      ['weekdays', null],
      ['times_per_week', 7],
      ['paused', null],
    ])('accepts a valid %s version', async (type, timesPerWeek) => {
      expect(
        await asOwner([
          insertVersion,
          [
            weekdaysProgram.id,
            type,
            timesPerWeek,
            addDays(today, 40),
            practitionerAId,
          ],
        ]),
      ).toEqual({})
    })

    it('refuses two versions of one program on the same day', async () => {
      const program = weekdaysProgram
      expect(
        await asOwner([
          insertVersion,
          [program.id, 'times_per_week', 2, program.startDate, practitionerAId],
        ]),
      ).toEqual({
        code: '23505',
        constraint: 'program_schedules_program_effective_from_unique',
      })
    })

    it('refuses a program that ends before it starts', async () => {
      expect(
        await asOwner([
          'UPDATE assigned_programs SET end_date = start_date - 1 WHERE id = $1',
          [weekdaysProgram.id],
        ]),
      ).toEqual({
        code: '23514',
        constraint: 'assigned_programs_ends_after_start',
      })
    })

    // --- A version's days ---
    // (version, program, weekday, workout) — the type column left to its
    // default, 'weekdays', unless a case sets it.
    const insertDay = `
      INSERT INTO program_schedule_days
        (schedule_id, assigned_program_id, weekday, workout_id)
      VALUES ($1, $2, $3, $4)`
    const day = (
      program: Program,
      weekday: number,
      workoutId = program.workouts[0].id,
      versionId = program.schedules[0].id,
    ): [string, unknown[]] => [
      insertDay,
      [versionId, program.id, weekday, workoutId],
    ]

    it.each([
      [
        'weekday 0',
        () => day(weekdaysProgram, 0),
        '23514',
        'program_schedule_days_weekday_range',
      ],
      [
        'weekday 8',
        () => day(weekdaysProgram, 8),
        '23514',
        'program_schedule_days_weekday_range',
      ],
      // Monday is already in the version.
      [
        'the same weekday twice',
        () => day(weekdaysProgram, 1),
        '23505',
        'program_schedule_days_pk',
      ],
      [
        "another program's workout",
        () => day(weekdaysProgram, 2, perWeekProgram.workouts[0].id),
        '23503',
        'program_schedule_days_workout_fk',
      ],
      // The composite key (version, program, type): a day can't belong to
      // a times-per-week version…
      [
        'a day of a times-per-week version',
        () => day(perWeekProgram, 2),
        '23503',
        'program_schedule_days_version_fk',
      ],
      // …nor claim another program than its version's.
      [
        "a day claiming another program than its version's",
        (): [string, unknown[]] => [
          insertDay,
          [
            weekdaysProgram.schedules[0].id,
            perWeekProgram.id,
            2,
            perWeekProgram.workouts[0].id,
          ],
        ],
        '23503',
        'program_schedule_days_version_fk',
      ],
      // And its type column can't be set to anything but 'weekdays'.
      [
        "a day whose type says 'times_per_week'",
        (): [string, unknown[]] => [
          `INSERT INTO program_schedule_days
             (schedule_id, assigned_program_id, schedule_type, weekday, workout_id)
           VALUES ($1, $2, 'times_per_week', 2, $3)`,
          [
            perWeekProgram.schedules[0].id,
            perWeekProgram.id,
            perWeekProgram.workouts[0].id,
          ],
        ],
        '23514',
        'program_schedule_days_only_weekdays',
      ],
    ])('refuses %s', async (_label, step, code, constraint) => {
      expect(await asOwner(step())).toEqual({ code, constraint })
    })

    it('accepts a new day of a weekdays version (the control case)', async () => {
      expect(await asOwner(day(weekdaysProgram, 2))).toEqual({})
    })

    // --- A version's rotation ---
    const insertPosition = `
      INSERT INTO program_schedule_rotation
        (schedule_id, assigned_program_id, position, workout_id)
      VALUES ($1, $2, $3, $4)`
    const position = (
      program: Program,
      at: number,
      workoutId = program.workouts[0].id,
    ): [string, unknown[]] => [
      insertPosition,
      [program.schedules[0].id, program.id, at, workoutId],
    ]

    it.each([
      [
        'position -1',
        () => position(perWeekProgram, -1),
        '23514',
        'program_schedule_rotation_position_range',
      ],
      // Position 0 is already in the rotation.
      [
        'the same position twice',
        () => position(perWeekProgram, 0),
        '23505',
        'program_schedule_rotation_pk',
      ],
      [
        "another program's workout",
        () => position(perWeekProgram, 1, weekdaysProgram.workouts[0].id),
        '23503',
        'program_schedule_rotation_workout_fk',
      ],
      [
        'a rotation of a weekdays version',
        () => position(weekdaysProgram, 1),
        '23503',
        'program_schedule_rotation_version_fk',
      ],
      [
        "a position whose type says 'weekdays'",
        (): [string, unknown[]] => [
          `INSERT INTO program_schedule_rotation
             (schedule_id, assigned_program_id, schedule_type, position, workout_id)
           VALUES ($1, $2, 'weekdays', 1, $3)`,
          [
            weekdaysProgram.schedules[0].id,
            weekdaysProgram.id,
            weekdaysProgram.workouts[0].id,
          ],
        ],
        '23514',
        'program_schedule_rotation_only_times_per_week',
      ],
    ])('refuses %s', async (_label, step, code, constraint) => {
      expect(await asOwner(step())).toEqual({ code, constraint })
    })

    it('accepts a next position of a rotation (the control case)', async () => {
      expect(await asOwner(position(perWeekProgram, 1))).toEqual({})
    })

    // A version's type can't change under its children: the composite
    // keys point at (id, program, type), and nothing cascades an update.
    it('refuses changing the type of a version that has days', async () => {
      expect(
        await asOwner([
          `UPDATE program_schedules SET type = 'times_per_week', times_per_week = 2
           WHERE id = $1`,
          [weekdaysProgram.schedules[0].id],
        ]),
      ).toEqual({
        code: '23503',
        constraint: 'program_schedule_days_version_fk',
      })
    })

    // A workout a schedule names can't be deleted, even by the owner: the
    // foreign keys are NO ACTION, behind the service's own 409.
    it.each([
      ['a day', () => weekdaysProgram, 'program_schedule_days_workout_fk'],
      [
        'a rotation',
        () => perWeekProgram,
        'program_schedule_rotation_workout_fk',
      ],
    ])(
      'refuses deleting a workout %s uses',
      async (_label, program, constraint) => {
        // Its exercise first (moved away is simplest: deleted, in the same
        // rolled-back transaction), so only the schedule stands in the way.
        const { id, workouts } = program()
        expect(
          await asOwner(
            [
              'DELETE FROM assigned_program_exercises WHERE workout_id = $1',
              [workouts[0].id],
            ],
            [
              'DELETE FROM program_workouts WHERE id = $1 AND assigned_program_id = $2',
              [workouts[0].id, id],
            ],
          ),
        ).toEqual({ code: '23503', constraint })
      },
    )
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
    const asC = (): Actor => ({ userId: practitionerCId, role: 'practitioner' })
    const asPatient = (): Actor => ({ userId: patientId, role: 'patient' })

    // A program started 30 days ago: its first version is well in the past.
    let program: Program
    beforeAll(() => {
      program = sharedMwf
    })

    const insert = (day: string, createdBy: number) => sql`
      INSERT INTO program_schedules
        (assigned_program_id, type, times_per_week, effective_from, created_by)
      VALUES (${program.id}, 'times_per_week', 2, ${day}, ${createdBy})`
    const deleteFrom = (day: string) => sql`
      DELETE FROM program_schedules
      WHERE assigned_program_id = ${program.id} AND effective_from = ${day}
      RETURNING id`

    it('lets the care team, the patient and an admin read the versions; not a colleague off the team', async () => {
      const read = sql`SELECT id FROM program_schedules WHERE assigned_program_id = ${program.id}`
      expect((await run(asA(), read)).rows).toHaveLength(1)
      expect((await run(asPatient(), read)).rows).toHaveLength(1)
      expect(
        (await run({ userId: adminId, role: 'admin' }, read)).rows,
      ).toHaveLength(1)
      expect((await run(asC(), read)).rows).toHaveLength(0)
    })

    it('lets the care team add a version from today', async () => {
      expect(await run(asA(), insert(today, practitionerAId))).toEqual({
        rows: [],
      })
    })

    // 42501 = insufficient_privilege: what Postgres reports when a new row
    // fails a policy's WITH CHECK.
    it.each([
      ['in the name of someone else', () => insert(today, adminId), asA],
      ['as the patient', () => insert(today, patientId), asPatient],
      [
        'as a colleague off the care team',
        () => insert(today, practitionerCId),
        asC,
      ],
      // History: a backdated version would change how past days are judged.
      [
        'backdated (two days ago)',
        () => insert(addDays(today, -2), practitionerAId),
        asA,
      ],
    ])('refuses a version %s', async (_label, statement, actor) => {
      expect(await run(actor(), statement())).toEqual({
        error: { code: '42501' },
      })
    })

    // No UPDATE policy: the row is simply not reachable for an UPDATE —
    // zero rows changed, no error (RLS filters rows, it doesn't announce
    // them). An admin is no exception.
    it('never lets a version be edited in place', async () => {
      const update = sql`
        UPDATE program_schedules SET times_per_week = 1
        WHERE assigned_program_id = ${program.id} RETURNING id`
      expect(await run(asA(), update)).toEqual({ rows: [] })
      expect(await run({ userId: adminId, role: 'admin' }, update)).toEqual({
        rows: [],
      })
    })

    // The DELETE policy's limit: from yesterday (UTC) on. The versions are
    // inserted in the same rolled-back transaction, as the owner would see
    // them — inserted as the app role they'd be refused when backdated.
    it('deletes only versions starting yesterday or later', async () => {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        for (const day of [addDays(today, -2), addDays(today, -1)]) {
          await client.query(
            `INSERT INTO program_schedules
               (assigned_program_id, type, times_per_week, effective_from, created_by)
             VALUES ($1, 'times_per_week', 2, $2, $3)`,
            [program.id, day, practitionerAId],
          )
        }
        await client.query('COMMIT')

        // The first version (30 days ago) and two days ago: untouchable.
        expect(await run(asA(), deleteFrom(program.startDate))).toEqual({
          rows: [],
        })
        expect(await run(asA(), deleteFrom(addDays(today, -2)))).toEqual({
          rows: [],
        })
        // Yesterday: reachable (and rolled back by run()).
        expect(
          (await run(asA(), deleteFrom(addDays(today, -1)))).rows,
        ).toHaveLength(1)
        // ...but not by the PATIENT. They're the case that matters: a
        // DELETE also applies the SELECT policy to the rows it targets, so
        // someone who can't even see the versions (a colleague off the
        // team) is refused by that alone. The patient CAN see them — only
        // the DELETE policy's own "admin or care team" rule stops them. (A
        // mutation check showed the colleague case alone proved nothing
        // about that rule.)
        expect(await run(asPatient(), deleteFrom(addDays(today, -1)))).toEqual({
          rows: [],
        })
        expect(await run(asC(), deleteFrom(addDays(today, -1)))).toEqual({
          rows: [],
        })
      } finally {
        // Committed above (the app role's transaction must see them), so
        // removed here, as the owner, whatever happened.
        await client.query(
          'DELETE FROM program_schedules WHERE assigned_program_id = $1 AND effective_from > $2',
          [program.id, program.startDate],
        )
        client.release()
      }
    })

    // --- A version's days and rotation (migration 0029) ---
    // They're part of their version: visible with it, written with it —
    // in the transaction that creates it, by whoever creates it — and
    // never changed or removed on their own (a change is a new version).

    // The two kinds of child row, each with the shared program whose
    // first version is of its kind (Monday/Wednesday/Friday; three a week)
    // and how to add one to a version (a SQL expression for its id). Each
    // INSERT returns what it added, as `added`. (Functions throughout: the
    // programs only exist once beforeAll has run.)
    const kinds = {
      day: {
        type: 'weekdays',
        program: () => sharedMwf,
        add: (p: Program, version: SQL | number) => sql`
          INSERT INTO program_schedule_days
            (schedule_id, assigned_program_id, weekday, workout_id)
          VALUES (${version}, ${p.id}, 2, ${p.workouts[0].id})
          RETURNING weekday AS added`,
      },
      position: {
        type: 'times_per_week',
        program: () => sharedPerWeek,
        add: (p: Program, version: SQL | number) => sql`
          INSERT INTO program_schedule_rotation
            (schedule_id, assigned_program_id, position, workout_id)
          VALUES (${version}, ${p.id}, 1, ${p.workouts[0].id})
          RETURNING position AS added`,
      },
    }
    type Kind = keyof typeof kinds
    // A version of `p` from today, created by `createdBy`…
    const newVersion = (
      p: Program,
      type: string,
      createdBy = practitionerAId,
    ) => sql`
      INSERT INTO program_schedules
        (assigned_program_id, type, times_per_week, effective_from, created_by)
      VALUES (${p.id}, ${type}, ${type === 'times_per_week' ? 2 : null},
              ${today}, ${createdBy})`
    // …and the id of p's NEWEST version (the one just created, in the same
    // transaction).
    const newest = (p: Program) =>
      sql`(SELECT max(id) FROM program_schedules WHERE assigned_program_id = ${p.id})`
    // Switches who is acting, mid-transaction (the same set_config calls
    // run() starts with).
    const actAs = (actor: Actor) => sql`
      SELECT set_config('app.current_user_id', ${String(actor.userId)}, true),
             set_config('app.current_role', ${actor.role}, true)`

    it.each([
      ['days', 'program_schedule_days', 'weekday', () => sharedMwf, [1, 3, 5]],
      [
        'rotation',
        'program_schedule_rotation',
        'position',
        () => sharedPerWeek,
        [0],
      ],
    ])(
      'lets those who see the version see its %s; not a colleague off the team',
      async (_label, table, column, p, values) => {
        const read = sql`
          SELECT ${sql.identifier(column)} AS value FROM ${sql.identifier(table)}
          WHERE assigned_program_id = ${p().id} ORDER BY 1`
        const expected = values.map((value) => ({ value }))
        expect((await run(asA(), read)).rows).toEqual(expected)
        expect((await run(asPatient(), read)).rows).toEqual(expected)
        expect(
          (await run({ userId: adminId, role: 'admin' }, read)).rows,
        ).toEqual(expected)
        expect((await run(asC(), read)).rows).toEqual([])
      },
    )

    it.each(Object.keys(kinds) as Kind[])(
      "lets the version's creator add a %s in the same transaction",
      async (kind) => {
        const { type, program: p, add } = kinds[kind]
        const result = await run(
          asA(),
          newVersion(p(), type),
          add(p(), newest(p())),
        )
        expect(result).toEqual({ rows: [{ added: kind === 'day' ? 2 : 1 }] })
      },
    )

    // Each clause of the INSERT policy, alone in the way — for each kind.
    const refusals: [string, (kind: Kind) => SQL[]][] = [
      // created_at = now(): a version from an earlier transaction is
      // finished — even its own creator can't add to it (each shared
      // program's first version was created by A, with the program).
      [
        'to a version from an earlier transaction',
        (kind) => {
          const { program: p, add } = kinds[kind]
          return [add(p(), p().schedules[0].id)]
        },
      ],
      // created_by = the current user: someone else's new version.
      [
        "to someone else's new version",
        (kind) => {
          const { type, program: p, add } = kinds[kind]
          return [
            newVersion(p(), type),
            actAs({ userId: adminId, role: 'admin' }),
            add(p(), newest(p())),
          ]
        },
      ],
      // Admin or care team: an account holding both the admin role and
      // the patient's own (contrived, but each clause needs a case where
      // only it refuses) creates a version as admin, then adds to it as
      // the patient — who can SEE the version, created it, in this
      // transaction, but is neither an admin nor on a care team now.
      [
        "by the version's creator, now acting as the program's patient",
        (kind) => {
          const { type, program: p, add } = kinds[kind]
          return [
            actAs({ userId: patientId, role: 'admin' }),
            newVersion(p(), type, patientId),
            actAs(asPatient()),
            add(p(), newest(p())),
          ]
        },
      ],
    ]
    it.each(
      refusals.flatMap(([label, statements]) =>
        (Object.keys(kinds) as Kind[]).map(
          (kind) => [`a ${kind} added ${label}`, kind, statements] as const,
        ),
      ),
    )('refuses %s', async (_label, kind, statements) => {
      expect(await run(asA(), ...statements(kind))).toEqual({
        error: { code: '42501' },
      })
    })

    // The control for the last case: the same steps, still acting as
    // admin, succeed — so the refusal above comes from the role switch,
    // not from the setup (the version's own INSERT, say).
    it.each(Object.keys(kinds) as Kind[])(
      'lets that account add a %s while still acting as admin',
      async (kind) => {
        const { type, program: p, add } = kinds[kind]
        const result = await run(
          asA(),
          actAs({ userId: patientId, role: 'admin' }),
          newVersion(p(), type, patientId),
          add(p(), newest(p())),
        )
        expect(result).toEqual({ rows: [{ added: kind === 'day' ? 2 : 1 }] })
      },
    )

    // No UPDATE or DELETE policy: nothing reachable, for anyone — zero
    // rows, no error. (A replaced version's children go by cascade, which
    // isn't subject to row-level security: see "takes a replaced
    // version's days with it".)
    it.each([
      [
        'edited',
        () => sql`UPDATE program_schedule_days SET workout_id = workout_id
            WHERE assigned_program_id = ${program.id} RETURNING weekday`,
      ],
      [
        'deleted',
        () => sql`DELETE FROM program_schedule_days
            WHERE assigned_program_id = ${program.id} RETURNING weekday`,
      ],
    ])('never lets a day be %s on its own', async (_label, statement) => {
      expect(await run(asA(), statement())).toEqual({ rows: [] })
      expect(
        await run({ userId: adminId, role: 'admin' }, statement()),
      ).toEqual({ rows: [] })
    })

    it('never lets a rotation position be edited or deleted on its own', async () => {
      const perWeek = sharedPerWeek
      for (const statement of [
        sql`UPDATE program_schedule_rotation SET position = position
            WHERE assigned_program_id = ${perWeek.id} RETURNING position`,
        sql`DELETE FROM program_schedule_rotation
            WHERE assigned_program_id = ${perWeek.id} RETURNING position`,
      ]) {
        expect(await run(asA(), statement)).toEqual({ rows: [] })
      }
      // …while they can be read: the zero rows above are the policies'.
      expect(
        (
          await run(
            asA(),
            sql`SELECT position FROM program_schedule_rotation WHERE assigned_program_id = ${perWeek.id}`,
          )
        ).rows,
      ).toEqual([{ position: 0 }])
    })
  })
})