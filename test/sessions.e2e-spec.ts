// Same reason this exists in main.ts and scripts/seed-exercises.ts — Jest,
// like ts-node, never auto-loads .env. AppModule's DrizzleModule needs
// POSTGRES_* in process.env the moment Test.createTestingModule() below
// tries to construct it, so this has to be the very first thing that runs.
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
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getAppDatabaseUrl, getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { addDays, isoWeekday, utcToday } from '../src/common/calendar-date'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
//
// A session's life (Phase 4 step 1, decided with the person 2026-10-15):
//   start (POST /sessions) → in_progress → completed (…/complete) or
//   incomplete (…/stop); skip (POST /sessions/skip) → skipped. Only an open
//   session changes; the three others are final. Each write is audited as
//   ONE complete entry. The rules hold twice: in the service, and in the
//   database (migration 0037's CHECKs and indexes, 0038's triggers) — the
//   last sections test the database's half on its own.
//
// This file starts about 30 sessions and assigns about 25 programs — more
// than the 60-a-minute limit per route allowed in a run, which is why the
// limits are off in the e2e suites since 2026-10-15
// (test/support/e2e-env.ts; proven by test/rate-limits.e2e-spec.ts).
describe('Sessions (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let appPool: Pool
  let db: DrizzleDb

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitionerA: ReturnType<typeof agent>
  let practitionerB: ReturnType<typeof agent>
  let patientA: ReturnType<typeof agent>
  let patientB: ReturnType<typeof agent>
  let patientAId: number
  let practitionerAId: number
  let adminId: number
  let exerciseId: number

  const today = utcToday()

  // --- Response and row shapes ----------------------------------------------

  interface SessionBody {
    id: number
    assignedProgramId: number
    workoutId: number
    patientId: number
    localDate: string
    countsFor: string | null
    status: string
    startedAt: string | null
    completedAt: string | null
    endedAt: string | null
    endReason: string | null
    endNote: string | null
    painBefore: number | null
    painAfter: number | null
    mobilityAfter: number | null
    totalDurationInSeconds: number | null
    sessionFeedback: string | null
    exercises: {
      id: number
      completed: boolean
      difficultyRating: number | null
    }[]
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
  const bodyOf = <T>(res: request.Response) => res.body as T

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Every invitation email lands in memory — tests never send real
      // email, whatever EMAIL_TRANSPORT says in .env.
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
    // The APP's role, on a connection this file controls: to hold a lock
    // the way a concurrent request would (the race test below).
    appPool = new Pool({ connectionString: getAppDatabaseUrl() })
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

    // A hard safety check, not just a naming convention to remember —
    // refuses to proceed at all unless genuinely connected to the
    // dedicated test database. Without this, accidentally running e2e
    // tests via the wrong npm script (plain `test:e2e` instead of
    // `test:e2e:fresh`) would TRUNCATE the real dev database with no
    // warning, since nothing else in this file would notice the difference.
    db = app.get<DrizzleDb>(DRIZZLE)
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    )
    const currentDatabase = rows[0].current_database
    if (currentDatabase !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test". ` +
          'Did you run this via `npm run test:e2e:fresh` (not plain `test:e2e`)?',
      )
    }

    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = agent()
    practitionerA = agent()
    practitionerB = agent()
    patientA = agent()
    patientB = agent()

    const stamp = Date.now()

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Sessions E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Sessions',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    const clinicId = clinicRes.body.clinicId

    const { rows: adminRows } = await sessionPool.query<{ id: number }>(
      'SELECT id FROM users WHERE email = $1',
      [`admin-${stamp}@example.com`],
    )
    adminId = adminRows[0].id

    const practitionerARes = await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
      clinicId,
    })
    practitionerAId = bodyOf<{ id: number }>(practitionerARes).id
    await activateAccount(sessionPool, `practitioner-a-${stamp}@example.com`)
    await practitionerA.post('/auth/login').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
    })

    await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
    })
    await activateAccount(sessionPool, `practitioner-b-${stamp}@example.com`)
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    })

    const patientARes = await admin.post('/users').send({
      email: `patient-a-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Patient',
      lastName: 'A',
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    await activateAccount(sessionPool, `patient-a-${stamp}@example.com`)
    patientAId = patientARes.body.id
    await patientA.post('/auth/login').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
    })

    // Since the care team (decisions §3), sharing a clinic no longer makes a
    // practitioner "manage" a patient — being on the patient's care team does.
    // practitionerA joins through the real endpoint (an empty body = "join").
    const joinRes = await practitionerA
      .post(`/users/${patientAId}/care-team`)
      .send({})
    expect(joinRes.status).toBe(201)

    // A second patient, in no clinic and on nobody's care team.
    await admin.post('/users').send({
      email: `patient-b-${stamp}@example.com`,
      firstName: 'Patient',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
      role: 'patient',
    })
    await activateAccount(sessionPool, `patient-b-${stamp}@example.com`)
    await patientB.post('/auth/login').send({
      email: `patient-b-${stamp}@example.com`,
      password: 'password123',
    })

    const exerciseRes = await practitionerA.post('/exercises').send({
      name: 'Sessions E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    exerciseId = exerciseRes.body.id
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
    await appPool.end()
  })

  // --- Helpers ----------------------------------------------------------------

  // Every day of the week scheduled, one workout (an inline list of
  // exercises makes one): today is always a scheduled day.
  const EVERY_DAY = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      workoutIndex: 0,
    })),
  }
  // Every day BUT today: today is a free day.
  const EVERY_DAY_BUT_TODAY = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7]
      .filter((weekday) => weekday !== isoWeekday(today))
      .map((weekday) => ({ weekday, workoutIndex: 0 })),
  }
  const THREE_A_WEEK = { type: 'times_per_week', timesPerWeek: 3 }

  // A fresh program for patient A — each test that writes sessions gets its
  // own, so one open session per program never ties tests together. Started
  // a week ago, so earlier days are inside it.
  async function newProgram(schedule: object = EVERY_DAY) {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Sessions E2E Program',
      startDate: addDays(today, -7),
      schedule,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    expect(res.status).toBe(201)
    return res.body as { id: number; workouts: { id: number }[] }
  }

  async function start(programId: number, body: object = {}) {
    return patientA
      .post('/sessions')
      .send({ assignedProgramId: programId, localDate: today, ...body })
  }

  // An OPEN session of an EARLIER day, as only the owner can write it now
  // (the API files a session under today): its day is over. With its
  // checklist row, copied the way the dev seed copies one.
  async function plantOpenSession(
    program: { id: number; workouts: { id: number }[] },
    daysAgo: number,
  ) {
    const {
      rows: [s],
    } = await sessionPool.query<{ id: number }>(
      `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
         scheduled_date, local_date, status, started_at)
       VALUES ($1, $2, $3, now() - make_interval(days => $4),
               ($5::date - $4::int), 'in_progress', now() - make_interval(days => $4))
       RETURNING id`,
      [program.id, program.workouts[0].id, patientAId, daysAgo, today],
    )
    await sessionPool.query(
      `INSERT INTO session_exercises
         (session_id, assigned_program_exercise_id, name, sets, reps,
          duration_in_seconds, weight, weight_unit, notes, primary_muscles,
          secondary_muscles, equipment, instructions, completed, sort_order)
       SELECT $1, pe.id, pe.name, pe.sets, pe.reps, pe.duration_in_seconds,
              pe.weight, pe.weight_unit, pe.notes, pe.primary_muscles,
              pe.secondary_muscles, pe.equipment, pe.instructions, false, 0
       FROM assigned_program_exercises pe WHERE pe.assigned_program_id = $2`,
      [s.id, program.id],
    )
    // A bigint arrives from pg as a string; the API answers numbers.
    return Number(s.id)
  }

  // Runs `send` while another connection holds an UNCOMMITTED write (as the
  // owner, or as the patient on the app's role), so the request's statement
  // must WAIT for it — still unanswered after 300 ms — then commits and
  // returns the request's answer. Deterministic, unlike two requests sent at
  // once and hoped to overlap (the second often starts after the first has
  // committed, and then an earlier check answers instead of the database).
  async function whileHolding(
    pool: Pool,
    statement: string,
    params: unknown[],
    send: () => PromiseLike<request.Response>,
  ) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (pool === appPool) {
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'patient', true)",
          [String(patientAId)],
        )
      }
      await client.query(statement, params)
      let answered = false
      const pending = Promise.resolve(send()).then((res) => {
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

  // The session's row, read as the owner.
  async function storedSession(id: number) {
    const { rows } = await sessionPool.query<Record<string, unknown>>(
      'SELECT * FROM sessions WHERE id = $1',
      [id],
    )
    return rows[0]
  }

  // The database's clock — the one the moments are written with (two
  // clocks drift: the lesson of 2026-10-12).
  async function databaseNow() {
    const { rows } = await sessionPool.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    )
    return rows[0].now
  }

  // What audit_logs holds for one session, read as the owner. The generic
  // interceptor writes AFTER the response, fire-and-forget: the pause gives
  // a duplicate the chance to appear — otherwise "no generic entry" could
  // pass just by being early.
  async function auditTrail(sessionId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, details FROM audit_logs
       WHERE entity_type = 'sessions' AND entity_id = $1 ORDER BY id`,
      [sessionId],
    )
    return rows
  }

  // A Postgres error's code and constraint, through Drizzle's wrapper.
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
  // As the APP's role, with the patient's context set the way
  // withRlsContext sets it. The statement's row count, or the error that
  // stopped it. Always rolled back.
  async function asActor(userId: number, role: string, statement: SQL) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${String(userId)}, true),
                     set_config('app.current_role', ${role}, true)`,
        )
        const result = await tx.execute(statement)
        throw new RolledBack(result.rowCount ?? 0)
      })
    } catch (error) {
      if (error instanceof RolledBack) return { rowCount: error.rowCount }
      return { error: pgError(error) }
    }
    throw new Error('unreachable: asActor() always rolls back')
  }
  const asPatientA = (statement: SQL) =>
    asActor(patientAId, 'patient', statement)
  // As the tables' OWNER (no row-level security; the triggers exempt it —
  // never a CHECK). Always rolled back.
  async function asOwner(statement: string, params: unknown[] = []) {
    const client = await sessionPool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(statement, params)
      return { rowCount: result.rowCount }
    } catch (error) {
      return pgError(error)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  // A program shared by the tests whose requests are all REFUSED before
  // anything is written — so they needn't each assign one.
  let refusalsOnly: { id: number; workouts: { id: number }[] }
  beforeAll(async () => {
    refusalsOnly = await newProgram()
  })

  // --- 1. Who may do what -------------------------------------------------------

  describe('access', () => {
    // 404, not 403: assigned_programs' RLS SELECT policy makes patientA's
    // program invisible to patientB's session before SessionsService.create()
    // ever reaches its own patientId-ownership check.
    it('rejects a patient starting or skipping a session of a program that is not their own', async () => {
      const program = refusalsOnly
      const started = await patientB
        .post('/sessions')
        .send({ assignedProgramId: program.id, localDate: today })
      expect(started.status).toBe(404)
      const skipped = await patientB.post('/sessions/skip').send({
        assignedProgramId: program.id,
        localDate: today,
        reason: 'illness',
      })
      expect(skipped.status).toBe(404)
    })

    it("rejects a practitioner or admin starting or skipping a session at all — the routes are the patient's", async () => {
      const program = refusalsOnly
      // The ROLE guard's own words: the service would refuse them too ("your
      // own assigned programs"), so only the message tells that the route
      // itself is the patient's (a mutation removing the guard survived a
      // status-only check).
      for (const staff of [practitionerA, admin]) {
        const started = await staff
          .post('/sessions')
          .send({ assignedProgramId: program.id, localDate: today })
        const skipped = await staff.post('/sessions/skip').send({
          assignedProgramId: program.id,
          localDate: today,
          reason: 'illness',
        })
        for (const res of [started, skipped]) {
          expect(res.status).toBe(403)
          expect(bodyOf<ErrorBody>(res).message).toEqual([
            'You do not have permission to access this resource',
          ])
        }
      }
    })

    it('lets a managing practitioner and an admin VIEW a session, but never WRITE to it', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))

      expect((await practitionerA.get(`/sessions/${started.id}`)).status).toBe(
        200,
      )
      expect((await admin.get(`/sessions/${started.id}`)).status).toBe(200)

      const rowId = started.exercises[0].id
      for (const staff of [practitionerA, admin]) {
        const writes = [
          staff.post(`/sessions/${started.id}/complete`).send({}),
          staff.post(`/sessions/${started.id}/stop`).send({ reason: 'other' }),
          staff.patch(`/sessions/${started.id}`).send({ painBefore: 1 }),
          staff
            .patch(`/sessions/${started.id}/exercises/${rowId}`)
            .send({ completed: true }),
        ]
        for (const res of await Promise.all(writes)) {
          expect(res.status).toBe(403)
        }
      }
      // Nothing changed.
      expect(await storedSession(started.id)).toMatchObject({
        status: 'in_progress',
        pain_before: null,
      })
    })

    // 404, not 403: sessions' RLS SELECT policy makes patientA's session
    // invisible to both an unrelated patient and a non-managing
    // practitioner before SessionsService.assertCanView() ever runs.
    it('rejects a non-managing practitioner and an unrelated patient from viewing the session at all', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))

      expect((await practitionerB.get(`/sessions/${started.id}`)).status).toBe(
        404,
      )
      expect((await patientB.get(`/sessions/${started.id}`)).status).toBe(404)
      // …nor end it: the same 404 (it can't be found).
      const stop = await patientB
        .post(`/sessions/${started.id}/stop`)
        .send({ reason: 'other' })
      expect(stop.status).toBe(404)
    })

    it('rejects updating a checklist row through the wrong session (IDOR check)', async () => {
      const programA = await newProgram()
      const programB = await newProgram()
      const sessionA = bodyOf<SessionBody>(await start(programA.id))
      const sessionB = bodyOf<SessionBody>(await start(programB.id))

      const res = await patientA
        .patch(`/sessions/${sessionA.id}/exercises/${sessionB.exercises[0].id}`)
        .send({ completed: true })
      expect(res.status).toBe(404)
    })
  })

  // --- 2. Starting --------------------------------------------------------------

  describe('starting', () => {
    it("creates the session OPEN, started by the database's clock, with its checklist and the pain check-in", async () => {
      const program = await newProgram()
      const before = await databaseNow()
      const res = await start(program.id, { painBefore: 4 })
      const after = await databaseNow()

      expect(res.status).toBe(201)
      const body = bodyOf<SessionBody>(res)
      expect(body).toMatchObject({
        status: 'in_progress',
        localDate: today,
        painBefore: 4,
        completedAt: null,
        endedAt: null,
        endReason: null,
      })
      expect(body.exercises).toHaveLength(1)
      expect(body.exercises[0].completed).toBe(false)
      const startedAt = new Date(body.startedAt!)
      expect(startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(startedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    // The patient's own day (decisions §5, point 4), stored as sent. The day
    // AFTER UTC's is used on purpose: it's someone's today (east of UTC, late
    // in the evening), and a server filling in its own date would get it
    // wrong — so this proves the value really comes from the request.
    it("stores the patient's local date, as sent", async () => {
      const program = await newProgram()
      const tomorrowInUtc = addDays(today, 1)
      const res = await start(program.id, { localDate: tomorrowInUtc })
      expect(res.status).toBe(201)
      expect(bodyOf<SessionBody>(res).localDate).toBe(tomorrowInUtc)
      // Read back as text: node-postgres turns a `date` into a JavaScript
      // Date at local midnight, which would compare as another day.
      const { rows } = await sessionPool.query<{ day: string }>(
        'SELECT local_date::text AS day FROM sessions WHERE id = $1',
        [bodyOf<SessionBody>(res).id],
      )
      expect(rows[0].day).toBe(tomorrowInUtc)
    })

    it('refuses a session without a local date, or with one that is nobody’s today', async () => {
      const program = refusalsOnly
      const missing = await patientA
        .post('/sessions')
        .send({ assignedProgramId: program.id })
      expect(missing.status).toBe(400)
      expect(bodyOf<ErrorBody>(missing).message).toContain(
        'localDate must be a date written as YYYY-MM-DD',
      )

      const twoDaysAgo = await start(program.id, {
        localDate: addDays(today, -2),
      })
      expect(twoDaysAgo.status).toBe(400)
      expect(bodyOf<ErrorBody>(twoDaysAgo).message).toEqual([
        "localDate must be today's date in the patient's time zone",
      ])
    })

    // The row's moment is the server's now (2026-10-15): the client can no
    // longer choose it — like any unknown field, a 400.
    it('refuses a scheduledDate from the client', async () => {
      const program = refusalsOnly
      const res = await start(program.id, {
        scheduledDate: '2019-01-01T00:00:00Z',
      })
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'property scheduledDate should not exist',
      ])
    })

    // One open session per program: a second start TODAY is refused — the
    // first stays open — and the patient is told what to do.
    it('refuses a second start today while one is open, leaving it open', async () => {
      const program = await newProgram()
      const first = bodyOf<SessionBody>(await start(program.id))

      const second = await start(program.id)
      expect(second.status).toBe(409)
      expect(bodyOf<ErrorBody>(second).message).toEqual([
        'A session of this program is already in progress today: finish it or stop it first',
      ])
      expect((await storedSession(first.id)).status).toBe('in_progress')
      const { rows } = await sessionPool.query(
        'SELECT 1 FROM sessions WHERE assigned_program_id = $1',
        [program.id],
      )
      expect(rows).toHaveLength(1)
    })

    // Two starts at the same moment: the first one's session is written but
    // not committed when the second arrives, so the second finds nothing
    // open — only the index can refuse it. Its insert waits for the first,
    // then fails (23505): the same 409, never a second open session.
    it('refuses a start racing another one, once the other commits', async () => {
      const program = await newProgram()
      const { waited, res } = await whileHolding(
        sessionPool,
        `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
           scheduled_date, local_date, status, started_at)
         VALUES ($1, $2, $3, now(), $4, 'in_progress', now())`,
        [program.id, program.workouts[0].id, patientAId, today],
        () => start(program.id),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'A session of this program is already in progress today: finish it or stop it first',
      ])
    })

    // An open session of an EARLIER day can no longer be completed; starting
    // a new one closes it — incomplete, "not finished in time", ended now —
    // in the patient's name, with its own audit entry.
    it('closes an unfinished session of an earlier day, and records it', async () => {
      const program = await newProgram()
      const old = await plantOpenSession(program, 3)
      const before = await databaseNow()

      const res = await start(program.id)
      expect(res.status).toBe(201)

      const closed = await storedSession(old)
      expect(closed).toMatchObject({
        status: 'incomplete',
        end_reason: 'not_finished_in_time',
        end_note: null,
        completed_at: null,
      })
      expect((closed.ended_at as Date).getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      )
      const trail = await auditTrail(old)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({
        action: 'SESSION_STOPPED',
        performed_by: patientAId,
        target_user_id: patientAId,
        details: {
          session: {
            status: 'incomplete',
            endReason: 'not_finished_in_time',
          },
          exercises: [{ name: 'Sessions E2E Squat', completed: false }],
        },
      })
    })

    // Only an OPEN one is closed: a finished session of an earlier day stays
    // exactly as it ended (rewriting it would be refused anyway — final).
    it('leaves finished sessions of earlier days as they are', async () => {
      const program = await newProgram()
      const old = await plantOpenSession(program, 3)
      await patientA.post(`/sessions/${old}/stop`).send({ reason: 'pain' })
      const before = await storedSession(old)

      expect((await start(program.id)).status).toBe(201)
      expect(await storedSession(old)).toEqual(before)
    })

    // Another program's open session is not this program's business.
    it("leaves another program's open session alone", async () => {
      const other = await newProgram()
      const otherOld = await plantOpenSession(other, 3)
      const program = await newProgram()

      expect((await start(program.id)).status).toBe(201)
      expect((await storedSession(otherOld)).status).toBe('in_progress')
    })

    it('records ONE entry for the start — what the session is and what it was given — and no generic one', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(
        await start(program.id, { painBefore: 2 }),
      )

      const trail = await auditTrail(started.id)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({
        action: 'SESSION_STARTED',
        performed_by: patientAId,
        target_user_id: patientAId,
        details: {
          session: {
            assignedProgramId: program.id,
            workoutId: program.workouts[0].id,
            localDate: today,
            status: 'in_progress',
            painBefore: 2,
          },
          exercises: [{ name: 'Sessions E2E Squat' }],
        },
      })
    })
  })

  // --- 3. Completing ------------------------------------------------------------

  describe('completing', () => {
    it('completes with the check-out, at the database’s moment, and records the final record', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      await patientA
        .patch(`/sessions/${started.id}/exercises/${started.exercises[0].id}`)
        .send({ completed: true, difficultyRating: 6 })
      const before = await databaseNow()

      const res = await patientA.post(`/sessions/${started.id}/complete`).send({
        painAfter: 2,
        mobilityAfter: 8,
        totalDurationInSeconds: 0,
        sessionFeedback: 'Felt good',
      })
      const after = await databaseNow()

      expect(res.status).toBe(200)
      const body = bodyOf<SessionBody>(res)
      expect(body).toMatchObject({
        status: 'completed',
        painAfter: 2,
        mobilityAfter: 8,
        totalDurationInSeconds: 0,
        sessionFeedback: 'Felt good',
        endedAt: null,
        endReason: null,
      })
      // The whole session, with its checklist (every session write answers
      // it — what the screen caches).
      expect(body.exercises).toHaveLength(1)
      const completedAt = new Date(body.completedAt!).getTime()
      expect(completedAt).toBeGreaterThanOrEqual(before.getTime())
      expect(completedAt).toBeLessThanOrEqual(after.getTime())

      const trail = await auditTrail(started.id)
      expect(trail.map((entry) => entry.action)).toEqual([
        'SESSION_STARTED',
        'SESSION_EXERCISE_UPDATED',
        'SESSION_COMPLETED',
      ])
      expect(trail[2]).toMatchObject({
        performed_by: patientAId,
        target_user_id: patientAId,
        details: {
          session: {
            status: 'completed',
            painAfter: 2,
            mobilityAfter: 8,
            sessionFeedback: 'Felt good',
          },
          exercises: [
            {
              exerciseRowId: started.exercises[0].id,
              name: 'Sessions E2E Squat',
              completed: true,
              difficultyRating: 6,
            },
          ],
        },
      })
    })

    it('stores nothing for a check-out not given', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const res = await patientA
        .post(`/sessions/${started.id}/complete`)
        .send({})
      expect(res.status).toBe(200)
      expect(bodyOf<SessionBody>(res)).toMatchObject({
        painAfter: null,
        mobilityAfter: null,
        totalDurationInSeconds: null,
        sessionFeedback: null,
      })
    })

    // A completed session is FINAL: no status change, no new value, no tick
    // — each a 409, and nothing stored changes.
    it('keeps a completed session final', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      await patientA
        .post(`/sessions/${started.id}/complete`)
        .send({ painAfter: 3 })
      const stored = await storedSession(started.id)

      const attempts = [
        await patientA.post(`/sessions/${started.id}/complete`).send({}),
        await patientA
          .post(`/sessions/${started.id}/stop`)
          .send({ reason: 'other' }),
        await patientA.patch(`/sessions/${started.id}`).send({ painBefore: 5 }),
        await patientA
          .patch(`/sessions/${started.id}/exercises/${started.exercises[0].id}`)
          .send({ completed: true }),
      ]
      for (const res of attempts) {
        expect(res.status).toBe(409)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'This session is finished, so it can no longer change',
        ])
      }
      expect(await storedSession(started.id)).toEqual(stored)
      const { rows } = await sessionPool.query(
        'SELECT completed FROM session_exercises WHERE session_id = $1',
        [started.id],
      )
      expect(rows).toEqual([{ completed: false }])
    })

    // Two Finish taps at once: the first completion is written (by the
    // patient, on the app's role) and not committed when the second arrives.
    // The service LOCKS the session before reading it (FOR UPDATE), so the
    // second waits, then reads it completed: the ordinary 409. (Without the
    // lock it would read it open, and its UPDATE would reach the database's
    // guard instead — a 500.)
    it('takes a second Finish after the first, answering 409', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const { waited, res } = await whileHolding(
        appPool,
        "UPDATE sessions SET status = 'completed', completed_at = now() WHERE id = $1",
        [started.id],
        () => patientA.post(`/sessions/${started.id}/complete`).send({}),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'This session is finished, so it can no longer change',
      ])
    })

    // Its own day only: a session started on an earlier day can't be
    // completed (that would turn a missed day into "done" after the fact) —
    // but it can be stopped.
    it('refuses completing a session of an earlier day, and lets it be stopped', async () => {
      const program = await newProgram()
      const old = await plantOpenSession(program, 3)
      const day = addDays(today, -3)

      const complete = await patientA.post(`/sessions/${old}/complete`).send({})
      expect(complete.status).toBe(409)
      expect(bodyOf<ErrorBody>(complete).message).toEqual([
        `This session was started on ${day} and can only be completed on that day: stop it instead`,
      ])
      expect((await storedSession(old)).status).toBe('in_progress')

      const stop = await patientA
        .post(`/sessions/${old}/stop`)
        .send({ reason: 'no_time' })
      expect(stop.status).toBe(200)
      expect(bodyOf<SessionBody>(stop).status).toBe('incomplete')
    })

    // The edges: UTC's day before and day after are still someone's today,
    // so a session filed under either can still be completed (the same slack
    // as starting) — by the service AND the database's guard.
    it.each([
      ['yesterday', 1],
      ['tomorrow', -1],
    ])(
      "completes a session of UTC's %s — someone's today",
      async (_label, daysAgo) => {
        const program = await newProgram()
        const id = await plantOpenSession(program, daysAgo)
        const res = await patientA.post(`/sessions/${id}/complete`).send({})
        expect(res.status).toBe(200)
      },
    )

    it('refuses a duration longer than the time since the start, changing nothing', async () => {
      const program = await newProgram()
      // Started 3 days ago by the owner — but filed under today, so only the
      // duration rule can refuse.
      const started = bodyOf<SessionBody>(await start(program.id))
      await sessionPool.query(
        "UPDATE sessions SET started_at = now() - interval '10 minutes' WHERE id = $1",
        [started.id],
      )

      const tooLong = await patientA
        .post(`/sessions/${started.id}/complete`)
        .send({ totalDurationInSeconds: 3600 })
      expect(tooLong.status).toBe(400)
      expect(bodyOf<ErrorBody>(tooLong).message[0]).toMatch(
        /^totalDurationInSeconds can't be longer than the time since the session started \(60\d seconds\)$/,
      )
      expect((await storedSession(started.id)).status).toBe('in_progress')

      const fits = await patientA
        .post(`/sessions/${started.id}/complete`)
        .send({ totalDurationInSeconds: 590 })
      expect(fits.status).toBe(200)
    })

    it('refuses out-of-range check-out values', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const res = await patientA
        .post(`/sessions/${started.id}/complete`)
        .send({ painAfter: 11, mobilityAfter: -1 })
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'painAfter must not be greater than 10',
        'mobilityAfter must not be less than 0',
      ])
    })
  })

  // --- 4. Stopping --------------------------------------------------------------

  describe('stopping', () => {
    it('stops with the patient’s reason, note and how they feel, and records it', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const before = await databaseNow()

      const res = await patientA.post(`/sessions/${started.id}/stop`).send({
        reason: 'pain',
        note: 'Knee hurt on the third set',
        painAfter: 7,
        mobilityAfter: 3,
      })
      expect(res.status).toBe(200)
      const body = bodyOf<SessionBody>(res)
      expect(body).toMatchObject({
        status: 'incomplete',
        endReason: 'pain',
        endNote: 'Knee hurt on the third set',
        painAfter: 7,
        mobilityAfter: 3,
        completedAt: null,
      })
      expect(new Date(body.endedAt!).getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      )
      const trail = await auditTrail(started.id)
      expect(trail.at(-1)).toMatchObject({
        action: 'SESSION_STOPPED',
        performed_by: patientAId,
        details: { session: { endReason: 'pain', painAfter: 7 } },
      })
    })

    // The check-out is optional — they may stop for another reason.
    it('stops with a reason alone', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const res = await patientA
        .post(`/sessions/${started.id}/stop`)
        .send({ reason: 'no_time' })
      expect(res.status).toBe(200)
      expect(bodyOf<SessionBody>(res)).toMatchObject({
        endReason: 'no_time',
        endNote: null,
        painAfter: null,
        mobilityAfter: null,
      })
    })

    // A reason is required, and the app's own are not the patient's to send.
    it("refuses no reason, and the app's own reasons", async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      for (const body of [
        {},
        { reason: 'not_finished_in_time' },
        { reason: 'program_closed' },
      ]) {
        const res = await patientA
          .post(`/sessions/${started.id}/stop`)
          .send(body)
        expect(res.status).toBe(400)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'reason must be one of: pain, illness, no_time, other',
        ])
      }
      expect((await storedSession(started.id)).status).toBe('in_progress')
    })
  })

  // --- 5. Skipping --------------------------------------------------------------

  describe('skipping', () => {
    function skip(programId: number, body: object = {}) {
      return patientA.post('/sessions/skip').send({
        assignedProgramId: programId,
        localDate: today,
        reason: 'illness',
        ...body,
      })
    }

    it("skips today's scheduled session — no start, no checklist, its reason — and records it", async () => {
      const program = await newProgram()
      const before = await databaseNow()

      const res = await skip(program.id, { note: 'Flu' })
      expect(res.status).toBe(201)
      const body = bodyOf<SessionBody>(res)
      expect(body).toMatchObject({
        status: 'skipped',
        workoutId: program.workouts[0].id,
        localDate: today,
        startedAt: null,
        completedAt: null,
        endReason: 'illness',
        endNote: 'Flu',
        painBefore: null,
        exercises: [],
      })
      expect(new Date(body.endedAt!).getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      )
      const trail = await auditTrail(body.id)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({
        action: 'SESSION_SKIPPED',
        performed_by: patientAId,
        target_user_id: patientAId,
        details: {
          session: { status: 'skipped', endReason: 'illness', endNote: 'Flu' },
        },
      })
    })

    it('records the pain that made the patient skip — only when pain is the reason', async () => {
      const forPain = await skip((await newProgram()).id, {
        reason: 'pain',
        painBefore: 8,
      })
      expect(forPain.status).toBe(201)
      expect(bodyOf<SessionBody>(forPain).painBefore).toBe(8)

      const program = await newProgram()
      const notPain = await skip(program.id, { painBefore: 8 })
      expect(notPain.status).toBe(400)
      expect(bodyOf<ErrorBody>(notPain).message).toEqual([
        'A pain level is recorded with a skip only when pain is the reason',
      ])
      const { rows } = await sessionPool.query(
        'SELECT 1 FROM sessions WHERE assigned_program_id = $1',
        [program.id],
      )
      expect(rows).toEqual([])
    })

    it.each([
      [
        'a weekly count',
        THREE_A_WEEK,
        'This program has no set days: nothing is due on a given day, so there is nothing to skip',
      ],
      [
        'a free day',
        EVERY_DAY_BUT_TODAY,
        'Nothing is scheduled today, so there is nothing to skip',
      ],
    ])('refuses a skip under %s', async (_label, schedule, message) => {
      const program = await newProgram(schedule)
      const res = await skip(program.id)
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([message])
    })

    // A skip says "nothing today" — no longer true once something was
    // started, done or skipped. Starting AFTER a skip is fine (the patient
    // feels better): the skip stays a record, the session counts as usual.
    it('refuses a second skip, or a skip of a day already started; allows a start after a skip', async () => {
      const program = await newProgram()
      expect((await skip(program.id)).status).toBe(201)

      const again = await skip(program.id)
      expect(again.status).toBe(409)
      expect(bodyOf<ErrorBody>(again).message).toEqual([
        'Today already has a session for this program, so it can no longer be skipped',
      ])

      expect((await start(program.id)).status).toBe(201)

      const other = await newProgram()
      expect((await start(other.id)).status).toBe(201)
      expect((await skip(other.id)).status).toBe(409)
    })

    // Two skips at the same moment: the first is written, not committed, so
    // the second's "does today have a session?" finds nothing — only the
    // index can refuse it, once the first commits.
    it('refuses a skip racing another one, once the other commits', async () => {
      const program = await newProgram()
      const { waited, res } = await whileHolding(
        sessionPool,
        `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
           scheduled_date, local_date, status, ended_at, end_reason)
         VALUES ($1, $2, $3, now(), $4, 'skipped', now(), 'other')`,
        [program.id, program.workouts[0].id, patientAId, today],
        () => skip(program.id),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'Today already has a session for this program, so it can no longer be skipped',
      ])
    })

    it('refuses a skip on a closed program', async () => {
      const program = await newProgram()
      // Closed with no session: archived — closed all the same.
      const cancelled = await practitionerA
        .post(`/assigned-programs/${program.id}/cancel`)
        .send({ today })
      expect(cancelled.status).toBe(200)
      const res = await skip(program.id)
      expect(res.status).toBe(409)
    })
  })

  // --- 6. The pain check-in, while open ------------------------------------------

  describe('correcting the pain check-in', () => {
    it('changes it, records from → to, and writes nothing for a value it already had', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))

      const set = await patientA
        .patch(`/sessions/${started.id}`)
        .send({ painBefore: 3 })
      expect(set.status).toBe(200)
      expect(bodyOf<SessionBody>(set).painBefore).toBe(3)
      expect(bodyOf<SessionBody>(set).exercises).toHaveLength(1)

      const same = await patientA
        .patch(`/sessions/${started.id}`)
        .send({ painBefore: 3 })
      expect(same.status).toBe(200)

      const cleared = await patientA
        .patch(`/sessions/${started.id}`)
        .send({ painBefore: null })
      expect(bodyOf<SessionBody>(cleared).painBefore).toBeNull()

      const updates = (await auditTrail(started.id)).filter(
        (entry) => entry.action === 'SESSION_UPDATED',
      )
      expect(updates.map((entry) => entry.details)).toEqual([
        { changes: { painBefore: { from: null, to: 3 } } },
        { changes: { painBefore: { from: 3, to: null } } },
      ])
    })

    // The status no longer changes through this PATCH (the null trap of
    // 2026-10-14 is gone with the field): any status is an unknown field.
    it('refuses a status — statuses change through their own routes', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      for (const status of ['completed', 'pending', null]) {
        const res = await patientA
          .patch(`/sessions/${started.id}`)
          .send({ status })
        expect(res.status).toBe(400)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'property status should not exist',
        ])
      }
      expect((await storedSession(started.id)).status).toBe('in_progress')
    })
  })

  // --- 7. The checklist ---------------------------------------------------------

  describe('the checklist', () => {
    it('ticks a row, honouring the difficultyRating bounds, answering the whole session', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const rowId = started.exercises[0].id

      const ticked = await patientA
        .patch(`/sessions/${started.id}/exercises/${rowId}`)
        .send({ completed: true, difficultyRating: 7 })
      expect(ticked.status).toBe(200)
      expect(bodyOf<SessionBody>(ticked)).toMatchObject({
        id: started.id,
        status: 'in_progress',
        exercises: [{ id: rowId, completed: true, difficultyRating: 7 }],
      })

      const outOfRange = await patientA
        .patch(`/sessions/${started.id}/exercises/${rowId}`)
        .send({ difficultyRating: 11 })
      expect(outOfRange.status).toBe(400)
    })

    it('records each real change from → to, with the row’s name — and nothing for a re-sent value', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const rowId = started.exercises[0].id

      await patientA
        .patch(`/sessions/${started.id}/exercises/${rowId}`)
        .send({ completed: true })
      await patientA
        .patch(`/sessions/${started.id}/exercises/${rowId}`)
        .send({ completed: true })

      const ticks = (await auditTrail(started.id)).filter(
        (entry) => entry.action === 'SESSION_EXERCISE_UPDATED',
      )
      expect(ticks.map((entry) => entry.details)).toEqual([
        {
          exerciseRowId: rowId,
          name: 'Sessions E2E Squat',
          changes: { completed: { from: false, to: true } },
        },
      ])
    })

    // The null trap (is-present.ts), found live 2026-10-14: `completed` is
    // a NOT NULL column. A 400, and nothing changes.
    it("refuses null for an exercise's completed, changing nothing", async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const rowId = started.exercises[0].id

      const res = await patientA
        .patch(`/sessions/${started.id}/exercises/${rowId}`)
        .send({ completed: null })
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'completed must be a boolean value',
      ])
      const readBack = bodyOf<SessionBody>(
        await patientA.get(`/sessions/${started.id}`),
      )
      expect(readBack.exercises[0].completed).toBe(false)
    })

    // THE RACE, made deterministic: a tick sent while the session is being
    // completed. Another connection (the app's role, as the patient)
    // completes the session and HOLDS the transaction open. The tick's own
    // check reads the session still open (the completion isn't committed),
    // so only the database can refuse it: the trigger's FOR SHARE waits for
    // the completion — the request is still unanswered after 300 ms — then
    // reads the session again, completed, and refuses. The filter answers
    // the service's 409, and the finished checklist is unchanged. (Without
    // FOR SHARE, the trigger would read its snapshot — open — and the tick
    // would land after the completion.)
    it('refuses a tick that races a Finish, once the Finish commits', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const rowId = started.exercises[0].id
      const client = await appPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'patient', true)",
          [String(patientAId)],
        )
        await client.query(
          "UPDATE sessions SET status = 'completed', completed_at = now() WHERE id = $1",
          [started.id],
        )
        let answered = false
        const pending = patientA
          .patch(`/sessions/${started.id}/exercises/${rowId}`)
          .send({ completed: true })
          .then((res) => {
            answered = true
            return res
          })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(answered).toBe(false)
        await client.query('COMMIT')

        const res = await pending
        expect(res.status).toBe(409)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'This session is finished, so it can no longer change',
        ])
        const { rows } = await sessionPool.query(
          'SELECT completed FROM session_exercises WHERE id = $1',
          [rowId],
        )
        expect(rows).toEqual([{ completed: false }])
      } finally {
        client.release()
      }
    })
  })

  // --- 8. The database's half: the shape of a row (0037) -------------------------
  //
  // As the OWNER, whom no trigger guards — the CHECKs hold for everyone. Each
  // statement changes ONE thing on a valid row, so the named constraint is
  // the one refusing it; each has a neighbour that passes.

  describe('the shape of a session row (CHECKs, as the owner)', () => {
    let openId: number
    let completedId: number
    let skippedId: number
    beforeAll(async () => {
      const program = await newProgram()
      openId = bodyOf<SessionBody>(await start(program.id)).id
      const done = await newProgram()
      completedId = bodyOf<SessionBody>(await start(done.id)).id
      await patientA.post(`/sessions/${completedId}/complete`).send({})
      const skipped = await newProgram()
      skippedId = bodyOf<SessionBody>(
        await patientA.post('/sessions/skip').send({
          assignedProgramId: skipped.id,
          localDate: today,
          reason: 'illness',
        }),
      ).id
    })

    it.each([
      // Which moments a status has.
      [
        'an open session without a start',
        'started_at = NULL',
        'open',
        'sessions_status_moments',
      ],
      [
        'an open session with an end',
        'ended_at = now()',
        'open',
        'sessions_status_moments',
      ],
      [
        'a completed session without its moment',
        'completed_at = NULL',
        'completed',
        'sessions_status_moments',
      ],
      [
        'a skip with a start',
        'started_at = now()',
        'skipped',
        'sessions_status_moments',
      ],
      [
        'a skip without an end',
        'ended_at = NULL',
        'skipped',
        'sessions_status_moments',
      ],
      // A reason exactly when not completed; a skip's is the patient's.
      [
        'an open session with a reason',
        "end_reason = 'pain'",
        'open',
        'sessions_end_reason_matches_status',
      ],
      [
        'a skip without a reason',
        'end_reason = NULL',
        'skipped',
        'sessions_end_reason_matches_status',
      ],
      [
        'a skip with the app’s reason',
        "end_reason = 'program_closed'",
        'skipped',
        'sessions_end_reason_matches_status',
      ],
      [
        'a note without a reason',
        "end_note = 'x'",
        'completed',
        'sessions_end_note_needs_reason',
      ],
      // The check-out belongs to a session that was done.
      [
        'pain after on an open session',
        'pain_after = 1',
        'open',
        'sessions_check_out_when_ended',
      ],
      [
        'mobility on a skip',
        'mobility_after = 1',
        'skipped',
        'sessions_check_out_when_ended',
      ],
      // A skip did nothing.
      [
        'a duration on a skip',
        'total_duration_in_seconds = 1',
        'skipped',
        'sessions_skip_records_no_work',
      ],
      [
        'feedback on a skip',
        "session_feedback = 'x'",
        'skipped',
        'sessions_skip_records_no_work',
      ],
      [
        'a pain level on a skip not for pain',
        'pain_before = 3',
        'skipped',
        'sessions_skip_records_no_work',
      ],
      // The 0–10 scales.
      [
        'pain before 11',
        'pain_before = 11',
        'open',
        'sessions_pain_before_range',
      ],
      [
        'pain after -1',
        'pain_after = -1',
        'completed',
        'sessions_pain_after_range',
      ],
      [
        'mobility 11',
        'mobility_after = 11',
        'completed',
        'sessions_mobility_after_range',
      ],
    ])('refuses %s', async (_label, assignment, which, constraint) => {
      const id = { open: openId, completed: completedId, skipped: skippedId }[
        which as 'open' | 'completed' | 'skipped'
      ]
      expect(
        await asOwner(`UPDATE sessions SET ${assignment} WHERE id = $1`, [id]),
      ).toEqual({ code: '23514', constraint })
    })

    it.each([
      ['pain before 0 and 10 on an open session', 'pain_before = 10', 'open'],
      [
        'the check-out on a completed session',
        'pain_after = 0, mobility_after = 10',
        'completed',
      ],
      [
        'a pain level on a skip FOR pain',
        "end_reason = 'pain', pain_before = 9",
        'skipped',
      ],
      ['a note with a reason', "end_note = 'x'", 'skipped'],
    ])('accepts %s', async (_label, assignment, which) => {
      const id = { open: openId, completed: completedId, skipped: skippedId }[
        which as 'open' | 'completed' | 'skipped'
      ]
      expect(
        await asOwner(`UPDATE sessions SET ${assignment} WHERE id = $1`, [id]),
      ).toEqual({ rowCount: 1 })
    })

    it('allows one open session per program, and one skip per program per day (the indexes)', async () => {
      const program = await newProgram()
      const open = bodyOf<SessionBody>(await start(program.id))
      expect(
        await asOwner(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
             scheduled_date, local_date, status, started_at)
           SELECT assigned_program_id, workout_id, patient_id, now(),
                  local_date - 1, 'in_progress', now()
           FROM sessions WHERE id = $1`,
          [open.id],
        ),
      ).toEqual({ code: '23505', constraint: 'sessions_one_open_per_program' })
      expect(
        await asOwner(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
             scheduled_date, local_date, status, ended_at, end_reason)
           SELECT assigned_program_id, workout_id, patient_id, now(),
                  local_date, 'skipped', now(), 'other'
           FROM sessions WHERE id = $1`,
          [skippedId],
        ),
      ).toEqual({ code: '23505', constraint: 'sessions_one_skip_per_day' })
      // The neighbours: a skip of another day; a finished session beside
      // the open one.
      expect(
        await asOwner(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
             scheduled_date, local_date, status, ended_at, end_reason)
           SELECT assigned_program_id, workout_id, patient_id, now(),
                  local_date - 1, 'skipped', now(), 'other'
           FROM sessions WHERE id = $1`,
          [skippedId],
        ),
      ).toEqual({ rowCount: 1 })
      expect(
        await asOwner(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
             scheduled_date, local_date, status, started_at, ended_at, end_reason)
           SELECT assigned_program_id, workout_id, patient_id, now(),
                  local_date - 1, 'incomplete', now(), now(), 'other'
           FROM sessions WHERE id = $1`,
          [open.id],
        ),
      ).toEqual({ rowCount: 1 })
    })
  })

  // --- 9. The database's half: which changes (0038) -------------------------------
  //
  // As the APP's role, as the session's own patient — whom the UPDATE policy
  // lets through, so a refusal is the trigger's. Each case has a neighbour
  // that the same actor may do.

  describe('the session guards (triggers, as the app)', () => {
    let program: { id: number; workouts: { id: number }[] }
    let openId: number
    let openRowId: number
    let completedId: number
    let completedRowId: number
    beforeAll(async () => {
      program = await newProgram()
      const open = bodyOf<SessionBody>(await start(program.id))
      openId = open.id
      openRowId = open.exercises[0].id
      const done = await newProgram()
      const completed = bodyOf<SessionBody>(await start(done.id))
      completedId = completed.id
      completedRowId = completed.exercises[0].id
      await patientA.post(`/sessions/${completedId}/complete`).send({})
    })

    const refused = (constraint: string) => ({
      error: { code: '23514', constraint },
    })

    it.each([
      ['its pain values', sql`pain_after = 1`],
      ['its feedback', sql`session_feedback = 'x'`],
      [
        'its status, back to open',
        sql`status = 'in_progress', completed_at = NULL`,
      ],
    ])(
      'refuses changing a finished session: %s',
      async (_label, assignment) => {
        expect(
          await asPatientA(
            sql`UPDATE sessions SET ${assignment} WHERE id = ${completedId}`,
          ),
        ).toEqual(refused('session_finished'))
      },
    )

    it.each([
      ['its day', sql`local_date = local_date - 1`],
      ['the day it counts for', sql`counts_for = local_date + 1`],
      ['its start', sql`started_at = started_at - interval '1 hour'`],
      [
        'its creation moment',
        sql`scheduled_date = scheduled_date - interval '1 hour'`,
      ],
      ['its workout', sql`workout_id = workout_id + 1000000`],
      ['its program', sql`assigned_program_id = assigned_program_id + 1000000`],
      ['its patient', sql`patient_id = patient_id + 1000000`],
    ])(
      'refuses changing what an open session is: %s',
      async (_label, assignment) => {
        expect(
          await asPatientA(
            sql`UPDATE sessions SET ${assignment} WHERE id = ${openId}`,
          ),
        ).toEqual(refused('session_identity_fixed'))
      },
    )

    it('refuses a moment that is not the database’s now', async () => {
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'completed', completed_at = now() - interval '1 hour' WHERE id = ${openId}`,
        ),
      ).toEqual(refused('session_moment_server_set'))
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'incomplete', ended_at = now() - interval '1 hour', end_reason = 'other' WHERE id = ${openId}`,
        ),
      ).toEqual(refused('session_moment_server_set'))
    })

    // The neighbours: what the service itself writes passes the trigger.
    it('accepts completing, stopping and correcting an open session of today', async () => {
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'completed', completed_at = now(), pain_after = 2 WHERE id = ${openId}`,
        ),
      ).toEqual({ rowCount: 1 })
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'incomplete', ended_at = now(), end_reason = 'pain' WHERE id = ${openId}`,
        ),
      ).toEqual({ rowCount: 1 })
      expect(
        await asPatientA(
          sql`UPDATE sessions SET pain_before = 5 WHERE id = ${openId}`,
        ),
      ).toEqual({ rowCount: 1 })
    })

    // At the boundaries: two days back is over everywhere, two days ahead
    // hasn't begun anywhere.
    it('refuses completing a session of a day that is over everywhere — and allows stopping it', async () => {
      const old = await plantOpenSession(await newProgram(), 2)
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'completed', completed_at = now() WHERE id = ${old}`,
        ),
      ).toEqual(refused('session_completed_on_its_day'))
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'incomplete', ended_at = now(), end_reason = 'other' WHERE id = ${old}`,
        ),
      ).toEqual({ rowCount: 1 })
      // A day ahead is just as impossible as a day behind.
      const ahead = await plantOpenSession(await newProgram(), -2)
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'completed', completed_at = now() WHERE id = ${ahead}`,
        ),
      ).toEqual(refused('session_completed_on_its_day'))
    })

    it("refuses writing a finished session's checklist — and allows an open one's", async () => {
      expect(
        await asPatientA(
          sql`UPDATE session_exercises SET completed = true WHERE id = ${completedRowId}`,
        ),
      ).toEqual(refused('session_exercise_session_finished'))
      expect(
        await asPatientA(
          sql`UPDATE session_exercises SET completed = true WHERE id = ${openRowId}`,
        ),
      ).toEqual({ rowCount: 1 })
    })

    it("refuses adding a row to a finished session's checklist — and allows it for an open one", async () => {
      const insertInto = (sessionId: number) =>
        sql`INSERT INTO session_exercises
              (session_id, assigned_program_exercise_id, name, primary_muscles,
               secondary_muscles, equipment, instructions, completed, sort_order)
            SELECT ${sessionId}, assigned_program_exercise_id, name, primary_muscles,
                   secondary_muscles, equipment, instructions, false, 9
            FROM session_exercises WHERE id = ${openRowId}`
      expect(await asPatientA(insertInto(completedId))).toEqual(
        refused('session_exercise_session_finished'),
      )
      expect(await asPatientA(insertInto(openId))).toEqual({ rowCount: 1 })
    })

    // The OWNER is exempt — the seed writes finished history, and test
    // set-ups move rows.
    it('exempts the owner', async () => {
      expect(
        await asOwner('UPDATE sessions SET pain_after = 1 WHERE id = $1', [
          completedId,
        ]),
      ).toEqual({ rowCount: 1 })
      expect(
        await asOwner(
          'UPDATE session_exercises SET completed = true WHERE id = $1',
          [completedRowId],
        ),
      ).toEqual({ rowCount: 1 })
    })
  })

  // --- 10. The audit convention, route by route ------------------------------------

  // Every session write is @AuditedByService(): the service's ONE entry, and
  // no generic "METHOD /url" entry from the interceptor beside it. Each route
  // is called once here; the pause lets a fire-and-forget duplicate appear.
  it('writes no generic audit entry for any session route', async () => {
    const program = await newProgram()
    const started = bodyOf<SessionBody>(await start(program.id))
    await patientA.patch(`/sessions/${started.id}`).send({ painBefore: 1 })
    await patientA
      .patch(`/sessions/${started.id}/exercises/${started.exercises[0].id}`)
      .send({ completed: true })
    await patientA.post(`/sessions/${started.id}/complete`).send({})
    const second = await newProgram()
    const other = bodyOf<SessionBody>(await start(second.id))
    await patientA.post(`/sessions/${other.id}/stop`).send({ reason: 'other' })
    await patientA.post('/sessions/skip').send({
      assignedProgramId: (await newProgram()).id,
      localDate: today,
      reason: 'illness',
    })

    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<{ action: string }>(
      `SELECT action FROM audit_logs
       WHERE action LIKE 'POST /sessions%' OR action LIKE 'PATCH /sessions%'`,
    )
    expect(rows).toEqual([])
  })

  // --- 11. Reading a program's sessions (step 1b) -----------------------------------

  // Planted as the owner on chosen days, in an order the answer must NOT
  // follow: every status, two on one day. Read by section 12 too: its open
  // session must outlive another program's closing.
  let ids: Record<string, number>

  describe("reading a program's sessions", () => {
    let program: { id: number; workouts: { id: number }[] }
    beforeAll(async () => {
      program = await newProgram()
      // Each status's own moments: open = started; completed = started +
      // completed; stopped = started + ended + a reason; skipped = ended + a
      // reason, never started (the sessions_status_moments CHECK).
      const MOMENTS = {
        in_progress: 'now(), NULL, NULL, NULL',
        completed: 'now(), now(), NULL, NULL',
        incomplete: "now(), NULL, now(), 'pain'",
        skipped: "NULL, NULL, now(), 'illness'",
      }
      const plant = async (daysAgo: number, status: keyof typeof MOMENTS) => {
        const {
          rows: [row],
        } = await sessionPool.query<{ id: number }>(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
             scheduled_date, local_date, status,
             started_at, completed_at, ended_at, end_reason)
           VALUES ($1, $2, $3, now(), ($4::date - $5::int), $6, ${MOMENTS[status]})
           RETURNING id`,
          [
            program.id,
            program.workouts[0].id,
            patientAId,
            today,
            daysAgo,
            status,
          ],
        )
        // A bigint id arrives from pg as a string; the API answers numbers.
        return Number(row.id)
      }
      ids = {
        stopped: await plant(3, 'incomplete'),
        completed5: await plant(5, 'completed'),
        skipped: await plant(3, 'skipped'),
        open: await plant(0, 'in_progress'),
      }
    })

    // Newest first: by the patient's day, then by creation within a day;
    // every status; the rows only — no checklist.
    it('lists every session, newest first, without checklists', async () => {
      const res = await patientA.get(
        `/assigned-programs/${program.id}/sessions`,
      )
      expect(res.status).toBe(200)
      const rows = bodyOf<SessionBody[]>(res)
      expect(rows.map((row) => row.id)).toEqual([
        ids.open,
        ids.skipped,
        ids.stopped,
        ids.completed5,
      ])
      expect(rows.map((row) => row.status)).toEqual([
        'in_progress',
        'skipped',
        'incomplete',
        'completed',
      ])
      expect(rows[2]).toMatchObject({ endReason: 'pain' })
      expect(rows.every((row) => !('exercises' in row))).toBe(true)
    })

    // Both ends included; either may be left out.
    it('keeps the days within from and to, both included', async () => {
      const day = (n: number) => addDays(today, -n)
      const list = async (query: string) =>
        bodyOf<SessionBody[]>(
          await patientA.get(
            `/assigned-programs/${program.id}/sessions?${query}`,
          ),
        ).map((row) => row.id)
      expect(await list(`from=${day(3)}&to=${day(3)}`)).toEqual([
        ids.skipped,
        ids.stopped,
      ])
      expect(await list(`from=${day(3)}`)).toEqual([
        ids.open,
        ids.skipped,
        ids.stopped,
      ])
      expect(await list(`to=${day(4)}`)).toEqual([ids.completed5])
      expect(await list(`from=${day(2)}&to=${day(1)}`)).toEqual([])
    })

    it('refuses a range that ends before it starts, and a date that is not one', async () => {
      const backwards = await patientA.get(
        `/assigned-programs/${program.id}/sessions?from=${today}&to=${addDays(today, -1)}`,
      )
      expect(backwards.status).toBe(400)
      expect(bodyOf<ErrorBody>(backwards).message).toEqual([
        'from must be on or before to',
      ])
      const notADate = await patientA.get(
        `/assigned-programs/${program.id}/sessions?from=2026-13-01`,
      )
      expect(notADate.status).toBe(400)
    })

    // The people who may view the program: the patient, the care team, an
    // admin. Anyone else: not found (row security hides the program) — never
    // an empty list.
    it('answers the patient, the care team and an admin — and nobody else', async () => {
      for (const reader of [patientA, practitionerA, admin]) {
        const res = await reader.get(
          `/assigned-programs/${program.id}/sessions`,
        )
        expect(res.status).toBe(200)
        expect(bodyOf<unknown[]>(res)).toHaveLength(4)
      }
      for (const outsider of [practitionerB, patientB]) {
        const res = await outsider.get(
          `/assigned-programs/${program.id}/sessions`,
        )
        expect(res.status).toBe(404)
      }
    })

    // The same sessions in the summary: skips and stops are LABELS on their
    // day — oldest first — counted in totals.skipped / totals.incomplete,
    // never as done; the completed one is done; the open one isn't counted.
    it("labels the summary's days with their skips and stops", async () => {
      const res = await practitionerA.get(
        `/assigned-programs/${program.id}/summary?today=${today}`,
      )
      expect(res.status).toBe(200)
      const summary = bodyOf<{
        days: { date: string; state: string; attempts: unknown[] }[]
        totals: Record<string, number>
        otherAttempts: unknown[]
      }>(res)
      const dayOf = (n: number) =>
        summary.days.find((d) => d.date === addDays(today, -n))
      expect(dayOf(3)).toMatchObject({
        state: 'missed',
        attempts: [
          { sessionId: ids.stopped, status: 'incomplete', endReason: 'pain' },
          { sessionId: ids.skipped, status: 'skipped', endReason: 'illness' },
        ],
      })
      expect(dayOf(5)).toMatchObject({ state: 'done', attempts: [] })
      expect(dayOf(0)).toMatchObject({ attempts: [] })
      expect(summary.totals).toMatchObject({
        done: 1,
        skipped: 1,
        incomplete: 1,
      })
      expect(summary.otherAttempts).toEqual([])
    })

    // GET /sessions (every session the caller could see, unfiltered) is gone.
    it('has no GET /sessions any more', async () => {
      expect((await patientA.get('/sessions')).status).toBe(404)
    })
  })

  // --- 12. Closing a program closes its open sessions (step 1b) -----------------------

  describe('closing a program', () => {
    // Only its OPEN session: the one completed today keeps how it ended,
    // and another program's open session is left alone.
    it('closes its open session — incomplete, program_closed — recorded, and final', async () => {
      const program = await newProgram()
      const done = bodyOf<SessionBody>(await start(program.id))
      await patientA.post(`/sessions/${done.id}/complete`).send({})
      const doneBefore = await storedSession(done.id)
      // Open since yesterday, half done: its entry must keep what was done.
      const openId = await plantOpenSession(program, 1)
      await sessionPool.query(
        'UPDATE session_exercises SET completed = true WHERE session_id = $1',
        [openId],
      )
      const { rows: checklist } = await sessionPool.query<{ id: number }>(
        'SELECT id FROM session_exercises WHERE session_id = $1',
        [openId],
      )

      const preview = await practitionerA.get(
        `/assigned-programs/${program.id}/closing?today=${today}`,
      )
      expect(bodyOf<{ openSessions: number }>(preview).openSessions).toBe(1)

      const before = await databaseNow()
      const res = await practitionerA
        .post(`/assigned-programs/${program.id}/cancel`)
        .send({ today })
      expect(res.status).toBe(200)

      const closed = await storedSession(openId)
      expect(closed).toMatchObject({
        status: 'incomplete',
        end_reason: 'program_closed',
        completed_at: null,
      })
      expect((closed.ended_at as Date).getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      )
      expect(await storedSession(done.id)).toEqual(doneBefore)
      expect((await storedSession(ids.open)).status).toBe('in_progress')

      // Its own entry, in the practitioner's name; the program's lists it.
      const trail = await auditTrail(openId)
      expect(trail.at(-1)).toMatchObject({
        action: 'SESSION_STOPPED',
        performed_by: practitionerAId,
        target_user_id: patientAId,
        details: {
          session: { status: 'incomplete', endReason: 'program_closed' },
          exercises: [
            { exerciseRowId: Number(checklist[0].id), completed: true },
          ],
        },
      })
      const { rows } = await sessionPool.query<AuditRow>(
        `SELECT action, performed_by, target_user_id, details FROM audit_logs
         WHERE entity_type = 'assigned-programs' AND entity_id = $1
           AND action = 'ASSIGNED_PROGRAM_CANCELLED'`,
        [program.id],
      )
      expect(rows[0].details).toMatchObject({ closedSessionIds: [openId] })

      // Final: the patient can no longer tick it.
      const tick = await patientA
        .patch(`/sessions/${openId}/exercises/${checklist[0].id}`)
        .send({ completed: false })
      expect(tick.status).toBe(409)
    })

    // The race: the patient's Finish is written, not committed, when the
    // practitioner closes the program. Closing's UPDATE waits for the
    // session's row, then re-checks `status = 'in_progress'` — the session
    // finished meanwhile stays COMPLETED, and the program lists no session
    // it closed.
    it('leaves a session completed during the closing as completed', async () => {
      const program = await newProgram()
      const started = bodyOf<SessionBody>(await start(program.id))
      const { waited, res } = await whileHolding(
        appPool,
        "UPDATE sessions SET status = 'completed', completed_at = now() WHERE id = $1",
        [started.id],
        () =>
          practitionerA
            .post(`/assigned-programs/${program.id}/cancel`)
            .send({ today }),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(200)
      expect((await storedSession(started.id)).status).toBe('completed')
      const { rows } = await sessionPool.query<AuditRow>(
        `SELECT details FROM audit_logs
         WHERE entity_type = 'assigned-programs' AND entity_id = $1
           AND action = 'ASSIGNED_PROGRAM_CANCELLED'`,
        [program.id],
      )
      expect(rows[0].details).toMatchObject({ closedSessionIds: [] })
    })
  })

  // --- 13. The care team's one exception (0039, as the app) ---------------------------
  //
  // The care team and admins may UPDATE a session row (a new policy) — and
  // the guard lets them make exactly one change: close an open session of a
  // CLOSED program. Each case has a neighbour that passes.

  describe('the care team closing a session (policy + guard, as the app)', () => {
    let closedProgramSession: number
    let finishedSession: number
    let openProgramSession: number
    beforeAll(async () => {
      // A program cancelled with nothing open, then an open session planted
      // in it by the owner (whom the closed-program guard exempts) — the
      // state close() is in between its two UPDATEs.
      const closed = await newProgram()
      const done = bodyOf<SessionBody>(await start(closed.id))
      await patientA.post(`/sessions/${done.id}/complete`).send({})
      finishedSession = done.id
      await practitionerA
        .post(`/assigned-programs/${closed.id}/cancel`)
        .send({ today })
      closedProgramSession = await plantOpenSession(closed, 1)
      const open = await newProgram()
      openProgramSession = await plantOpenSession(open, 1)
    })

    const close = (id: number) =>
      sql`UPDATE sessions SET status = 'incomplete', ended_at = now(), end_reason = 'program_closed' WHERE id = ${id}`
    const refused = (constraint: string) => ({
      error: { code: '23514', constraint },
    })

    it('lets the care team and an admin close an open session of a closed program', async () => {
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          close(closedProgramSession),
        ),
      ).toEqual({ rowCount: 1 })
      expect(
        await asActor(adminId, 'admin', close(closedProgramSession)),
      ).toEqual({
        rowCount: 1,
      })
    })

    // Archived (what cancelling before any session does) counts as closed
    // too. No session can be open in one through the app, so the owner
    // archives the open program for this test only, and puts it back.
    it('lets the care team close an open session of an archived program', async () => {
      const archive = (on: boolean) =>
        sessionPool.query(
          'UPDATE assigned_programs SET is_archived = $1 WHERE id = (SELECT assigned_program_id FROM sessions WHERE id = $2)',
          [on, openProgramSession],
        )
      await archive(true)
      try {
        expect(
          await asActor(
            practitionerAId,
            'practitioner',
            close(openProgramSession),
          ),
        ).toEqual({ rowCount: 1 })
      } finally {
        await archive(false)
      }
    })

    it('refuses it while the program is still open', async () => {
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          close(openProgramSession),
        ),
      ).toEqual(refused('session_staff_close_only'))
    })

    // The one allowed change, plus or minus one thing.
    it.each([
      [
        'another reason',
        sql`status = 'incomplete', ended_at = now(), end_reason = 'other'`,
      ],
      ['another status', sql`status = 'completed', completed_at = now()`],
      [
        'another status, with the right reason',
        sql`status = 'skipped', ended_at = now(), end_reason = 'program_closed'`,
      ],
      [
        'a moment of its own',
        sql`status = 'incomplete', ended_at = now() - interval '1 hour', end_reason = 'program_closed'`,
      ],
      [
        'anything else as well',
        sql`status = 'incomplete', ended_at = now(), end_reason = 'program_closed', pain_after = 3`,
      ],
      ['anything else alone', sql`pain_before = 3`],
    ])('refuses any other change: %s', async (_label, change) => {
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`UPDATE sessions SET ${change} WHERE id = ${closedProgramSession}`,
        ),
      ).toEqual(refused('session_staff_close_only'))
    })

    // Only an OPEN session: a finished one keeps how it ended, even in a
    // closed program (the guard's own answer — before any CHECK's).
    it('refuses to close a session that already ended', async () => {
      expect(
        await asActor(practitionerAId, 'practitioner', close(finishedSession)),
      ).toEqual(refused('session_staff_close_only'))
    })

    // Outside the care team the new policy doesn't apply: the row isn't even
    // seen by the UPDATE (0 rows, no error).
    it("doesn't let a practitioner outside the care team touch it", async () => {
      const { rows } = await sessionPool.query<{ id: number }>(
        'SELECT id FROM users WHERE id <> ALL($1) AND id IN (SELECT user_id FROM user_roles WHERE role = $2)',
        [[practitionerAId], 'practitioner'],
      )
      expect(
        await asActor(rows[0].id, 'practitioner', close(closedProgramSession)),
      ).toEqual({ rowCount: 0 })
    })

    // `program_closed` means the program closed it: never the patient's own.
    it('refuses program_closed from the patient', async () => {
      expect(await asPatientA(close(openProgramSession))).toEqual(
        refused('session_program_closed_reason'),
      )
      expect(
        await asPatientA(
          sql`UPDATE sessions SET status = 'incomplete', ended_at = now(), end_reason = 'pain' WHERE id = ${openProgramSession}`,
        ),
      ).toEqual({ rowCount: 1 })
    })
  })
})
