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
//   1. creating a program stores its first schedule version;
//   2. adding a version "from day D" replaces the versions from D on, and
//      keeps the ones before;
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
  let emptyTemplateId: number
  let archivedTemplateId: number

  const today = utcToday()
  const MWF = { type: 'weekdays', weekdays: [1, 3, 5] }
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
    emptyTemplateId = await template('Empty Template', false)
    archivedTemplateId = await template('Archived Template', true)
    const archived = await practitionerA.delete(
      `/programs/${archivedTemplateId}`,
    )
    expect(archived.status).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // A program for the patient from the usual template. `startsIn` days from
  // today (negative = started in the past).
  async function createProgram(
    options: {
      startsIn?: number
      endsIn?: number
      schedule?: object
    } = {},
  ) {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnTemplateId: templateId,
      title: 'Schedules E2E Program',
      startDate: addDays(today, options.startsIn ?? -20),
      ...(options.endsIn !== undefined
        ? { endDate: addDays(today, options.endsIn) }
        : {}),
      schedule: options.schedule ?? MWF,
    })
    expect(res.status).toBe(201)
    return res.body as {
      id: number
      startDate: string
      schedules: ScheduleVersion[]
    }
  }

  interface ScheduleVersion {
    id: number
    assignedProgramId: number
    type: string
    weekdays: number[] | null
    timesPerWeek: number | null
    effectiveFrom: string
    createdBy: number
    createdAt: string
  }

  // Versions as [effectiveFrom, what] pairs — readable in a failing test.
  function summary(versions: ScheduleVersion[]) {
    return versions.map((v) => [
      v.effectiveFrom,
      v.type === 'weekdays' ? v.weekdays : v.timesPerWeek,
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
        schedule: { type: 'weekdays', weekdays: [5, 3, 1] },
      })
      expect(res.status).toBe(201)

      // Read back separately: what the database holds, not just what the
      // create response said.
      const readBack = await practitionerA.get(
        `/assigned-programs/${res.body.id}`,
      )
      expect(readBack.body.schedules).toHaveLength(1)
      const [version] = readBack.body.schedules as ScheduleVersion[]
      expect(version).toEqual({
        id: expect.any(Number),
        assignedProgramId: res.body.id,
        type: 'weekdays',
        weekdays: [1, 3, 5],
        timesPerWeek: null,
        effectiveFrom: addDays(today, 3),
        createdBy: practitionerAId,
        createdAt: expect.any(String),
      })
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
        type: 'weekdays',
        weekdays: [2, 4],
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
        type: 'weekdays',
        weekdays: [2],
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
        type: 'weekdays',
        weekdays: [6, 7],
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
        type: 'weekdays',
        weekdays: [2],
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
        type: 'weekdays',
        weekdays: [1, 1],
        effectiveFrom: today,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        "All weekdays's elements must be unique",
      ])
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

    let programId: number
    beforeAll(async () => {
      programId = (await createProgram()).id
    })

    const insertVersion = `
      INSERT INTO program_schedules
        (assigned_program_id, type, weekdays, times_per_week, effective_from, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)`

    it.each([
      [
        'weekdays type with only a count',
        ['weekdays', null, 3],
        'program_schedules_fields_match_type',
      ],
      [
        'times-per-week type with weekdays as well',
        ['times_per_week', [1], 3],
        'program_schedules_fields_match_type',
      ],
      [
        'days out of order',
        ['weekdays', [3, 1], null],
        'program_schedules_weekdays_valid',
      ],
      [
        'the same day twice',
        ['weekdays', [1, 1], null],
        'program_schedules_weekdays_valid',
      ],
      ['day 0', ['weekdays', [0], null], 'program_schedules_weekdays_valid'],
      [
        'an empty set of days',
        ['weekdays', [], null],
        'program_schedules_weekdays_valid',
      ],
      [
        '8 times a week',
        ['times_per_week', null, 8],
        'program_schedules_times_per_week_range',
      ],
    ])(
      'refuses %s',
      async (_label, [type, weekdays, timesPerWeek], constraint) => {
        expect(
          await asOwner(insertVersion, [
            programId,
            type,
            weekdays,
            timesPerWeek,
            addDays(today, 40),
            practitionerAId,
          ]),
        ).toEqual({ code: '23514', constraint })
      },
    )

    // The control case: the same statement with a valid row succeeds, so
    // the refusals above are about their values, not the statement.
    it('accepts a valid version', async () => {
      expect(
        await asOwner(insertVersion, [
          programId,
          'weekdays',
          [1, 3, 5],
          null,
          addDays(today, 40),
          practitionerAId,
        ]),
      ).toEqual({})
    })

    it('refuses two versions of one program on the same day', async () => {
      const program = await createProgram()
      expect(
        await asOwner(insertVersion, [
          program.id,
          'times_per_week',
          null,
          2,
          program.startDate,
          practitionerAId,
        ]),
      ).toEqual({
        code: '23505',
        constraint: 'program_schedules_program_effective_from_unique',
      })
    })

    it('refuses a program that ends before it starts', async () => {
      expect(
        await asOwner(
          'UPDATE assigned_programs SET end_date = start_date - 1 WHERE id = $1',
          [programId],
        ),
      ).toEqual({
        code: '23514',
        constraint: 'assigned_programs_ends_after_start',
      })
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
    const asC = (): Actor => ({ userId: practitionerCId, role: 'practitioner' })
    const asPatient = (): Actor => ({ userId: patientId, role: 'patient' })

    // A program started 30 days ago: its first version is well in the past.
    let program: { id: number; startDate: string }
    beforeAll(async () => {
      program = await createProgram({ startsIn: -30 })
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
  })
})