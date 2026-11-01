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
import { addDays, utcToday } from '../src/common/calendar-date'

// The practitioner home's To-do (decided 2026-10-19): GET /alerts and
// POST /sessions/:id/review, against the real database — its row-level
// security, the review trigger (migration 0044) and the schedule module the
// alerts reuse. The care-team rule is checked at BOTH layers: the route
// (a practitioner on no care team gets an empty list) and the policies
// (the same practitioner, as the app's role, sees no review and can't
// write one).
describe('Alerts and session reviews (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let appPool: Pool
  let db: DrizzleDb

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  // A and C: on every patient's care team below. B: same clinic, on no
  // care team — directory access only.
  let practitionerA: ReturnType<typeof agent>
  let practitionerB: ReturnType<typeof agent>
  let practitionerC: ReturnType<typeof agent>
  let patient: ReturnType<typeof agent>
  let adminId: number
  let practitionerAId: number
  let practitionerBId: number
  let practitionerCId: number
  let clinicId: number
  let exerciseId: number
  let loggedInPatientId: number
  const stamp = Date.now()

  const today = utcToday()

  interface ErrorBody {
    message: string[]
  }
  interface AlertBody {
    kind: string
    patient: { id: number }
    program: { id: number; title: string }
    session?: { id: number }
    reasons?: string[]
  }
  interface ReviewBody {
    practitioner: { id: number; firstName: string; lastName: string }
    reviewedAt: string
  }
  const bodyOf = <T>(res: request.Response) => res.body as T

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
    // The APP's role, on a connection this file controls: to hold an
    // uncommitted review the way a concurrent request would (the race).
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

    // Never against anything but the test database (see sessions.e2e-spec).
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

    admin = agent()
    practitionerA = agent()
    practitionerB = agent()
    practitionerC = agent()
    patient = agent()

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Alerts E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Alerts',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    clinicId = clinicRes.body.clinicId
    const { rows: adminRows } = await sessionPool.query<{ id: number }>(
      'SELECT id FROM users WHERE email = $1',
      [`admin-${stamp}@example.com`],
    )
    adminId = adminRows[0].id

    const practitioner = async (
      letter: string,
      who: ReturnType<typeof agent>,
    ) => {
      const email = `practitioner-${letter}-${stamp}@example.com`
      const res = await admin.post('/users').send({
        email,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: letter.toUpperCase(),
        licenseNumber: `PT-${letter}-${stamp}`,
        clinicId,
      })
      await activateAccount(sessionPool, email)
      await who.post('/auth/login').send({ email, password: 'password123' })
      return bodyOf<{ id: number }>(res).id
    }
    practitionerAId = await practitioner('a', practitionerA)
    practitionerBId = await practitioner('b', practitionerB)
    practitionerCId = await practitioner('c', practitionerC)

    // The patient who logs in (the patient's side of every refusal).
    loggedInPatientId = await newPatient('Logged')
    await activateAccount(sessionPool, `patient-logged-${stamp}@example.com`)
    await patient.post('/auth/login').send({
      email: `patient-logged-${stamp}@example.com`,
      password: 'password123',
    })

    const exerciseRes = await practitionerA.post('/exercises').send({
      name: 'Alerts E2E Squat',
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

  // A patient of the clinic, on A's and C's care teams (A creates them and
  // so joins; A then adds C) — never B's.
  async function newPatient(lastName: string) {
    const res = await practitionerA.post('/users').send({
      email: `patient-${lastName.toLowerCase()}-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Patient',
      lastName,
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    expect(res.status).toBe(201)
    const id = bodyOf<{ id: number }>(res).id
    const added = await practitionerA
      .post(`/users/${id}/care-team`)
      .send({ practitionerId: practitionerCId })
    expect(added.status).toBe(201)
    return id
  }

  // Every day of the week scheduled: every past day is judged by the next
  // morning (a day's make-up window closes when the next scheduled day
  // comes), so N days without a session are N misses in a row.
  const EVERY_DAY = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      workoutIndex: 0,
    })),
  }

  async function newProgram(
    patientId: number,
    startsDaysAgo: number,
    title = 'Alerts E2E Program',
  ) {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      title,
      startDate: addDays(today, -startsDaysAgo),
      schedule: EVERY_DAY,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    expect(res.status).toBe(201)
    return res.body as {
      id: number
      patientId: number
      workouts: { id: number }[]
    }
  }

  // A session on an earlier day, as only the owner can write it (the API
  // files a session under today), with its one checklist row rated and
  // commented as given. Its shape follows the CHECKs of 0037: a completed
  // session has a start and a completion, a stopped / skipped one an end
  // and a reason; a skip has no checklist.
  async function plantSession(
    program: { id: number; patientId: number; workouts: { id: number }[] },
    daysAgo: number,
    fields: {
      status?: 'completed' | 'incomplete' | 'skipped' | 'in_progress'
      endReason?: string
      painBefore?: number
      painAfter?: number
      sessionFeedback?: string
      endNote?: string
      difficulty?: number
      exerciseNote?: string
    } = {},
  ) {
    const status = fields.status ?? 'completed'
    const moment = `($5::date - $4::int) + time '18:00'`
    const {
      rows: [s],
    } = await sessionPool.query<{ id: string }>(
      `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
         scheduled_date, local_date, status, started_at, completed_at,
         ended_at, end_reason, end_note, pain_before, pain_after,
         session_feedback)
       VALUES ($1, $2, $3, ${moment}, ($5::date - $4::int), $6::session_status,
               CASE WHEN $6::text <> 'skipped' THEN ${moment} END,
               CASE WHEN $6::text = 'completed' THEN ${moment} + interval '30 minutes' END,
               CASE WHEN $6::text IN ('incomplete', 'skipped') THEN ${moment} + interval '10 minutes' END,
               $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        program.id,
        program.workouts[0].id,
        program.patientId,
        daysAgo,
        today,
        status,
        fields.endReason ?? null,
        fields.endNote ?? null,
        fields.painBefore ?? null,
        fields.painAfter ?? null,
        fields.sessionFeedback ?? null,
      ],
    )
    if (status !== 'skipped') {
      await sessionPool.query(
        `INSERT INTO session_exercises
           (session_id, assigned_program_exercise_id, name, sets, reps,
            duration_in_seconds, weight, weight_unit, notes, primary_muscles,
            secondary_muscles, equipment, instructions, completed, sort_order,
            difficulty_rating, feedback)
         SELECT $1, pe.id, pe.name, pe.sets, pe.reps, pe.duration_in_seconds,
                pe.weight, pe.weight_unit, pe.notes, pe.primary_muscles,
                pe.secondary_muscles, pe.equipment, pe.instructions, true, 0,
                $3, $4
         FROM assigned_program_exercises pe WHERE pe.assigned_program_id = $2`,
        [
          s.id,
          program.id,
          fields.difficulty ?? null,
          fields.exerciseNote ?? null,
        ],
      )
    }
    // A bigint arrives from pg as a string; the API answers numbers.
    return Number(s.id)
  }

  const alertsOf = async (who: ReturnType<typeof agent>) => {
    const res = await who.get(`/alerts?today=${today}`)
    expect(res.status).toBe(200)
    return bodyOf<AlertBody[]>(res)
  }
  const forProgram = (alerts: AlertBody[], programId: number) =>
    alerts.filter((alert) => alert.program.id === programId)

  // The review rows of a session, as the owner.
  async function storedReviews(sessionId: number) {
    const { rows } = await sessionPool.query<{
      practitioner_id: number
      reviewed_at: Date
    }>(
      'SELECT practitioner_id, reviewed_at FROM session_reviews WHERE session_id = $1 ORDER BY id',
      [sessionId],
    )
    return rows
  }

  // The audit entries of a session's reviews, as the owner. The generic
  // interceptor writes AFTER the response: the pause gives a duplicate the
  // chance to appear.
  async function reviewAudit(sessionId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<{
      action: string
      performed_by: number
      target_user_id: number
      entity_type: string
      details: Record<string, unknown>
    }>(
      `SELECT action, performed_by, target_user_id, entity_type, details
       FROM audit_logs
       WHERE action = 'SESSION_REVIEWED' AND (details->>'sessionId')::bigint = $1
       ORDER BY id`,
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
    constructor(
      readonly rowCount: number,
      readonly rows: unknown[],
    ) {
      super('rolled back on purpose')
    }
  }
  // As the APP's role, with a context set the way withRlsContext sets it.
  // The statement's row count and rows, or the error that stopped it.
  // Always rolled back.
  async function asActor(userId: number, role: string, statement: SQL) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${String(userId)}, true),
                     set_config('app.current_role', ${role}, true)`,
        )
        const result = await tx.execute(statement)
        throw new RolledBack(result.rowCount ?? 0, result.rows)
      })
    } catch (error) {
      if (error instanceof RolledBack) {
        return { rowCount: error.rowCount, rows: error.rows }
      }
      return { error: pgError(error) }
    }
    throw new Error('unreachable: asActor() always rolls back')
  }

  // --- GET /alerts: who may ask ------------------------------------------------

  describe('GET /alerts — access', () => {
    it("refuses a patient and an admin with the role guard's own message", async () => {
      for (const who of [patient, admin]) {
        const res = await who.get(`/alerts?today=${today}`)
        expect(res.status).toBe(403)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'You do not have permission to access this resource',
        ])
      }
    })

    it('requires today, as a date that is today somewhere', async () => {
      const missing = await practitionerA.get('/alerts')
      expect(missing.status).toBe(400)
      expect(bodyOf<ErrorBody>(missing).message).toEqual([
        'today must be a date written as YYYY-MM-DD',
      ])
      const tooFar = await practitionerA.get(
        `/alerts?today=${addDays(today, 3)}`,
      )
      expect(tooFar.status).toBe(400)
      expect(bodyOf<ErrorBody>(tooFar).message).toEqual([
        "today must be today's date in your time zone",
      ])
    })
  })

  // --- Attendance ---------------------------------------------------------------

  describe('attendance alerts', () => {
    it('reports misses in a row and inactivity, with the patient and the program', async () => {
      const patientId = await newPatient('Absent')
      const program = await newProgram(patientId, 8, 'Absent program')
      const alerts = forProgram(await alertsOf(practitionerA), program.id)
      expect(alerts).toStrictEqual([
        {
          kind: 'attendance',
          patient: {
            id: patientId,
            firstName: 'Patient',
            lastName: 'Absent',
            avatarUrl: null,
          },
          program: { id: program.id, title: 'Absent program' },
          // Eight scheduled days, all missed; eight days without a session.
          missedInARow: { days: 8, weeks: 0, since: addDays(today, -8) },
          inactive: { days: 8, lastSessionDate: null },
        },
      ])
    })

    it('clears itself once the patient acts: a skip yesterday ends the inactivity, a session the run', async () => {
      const patientId = await newPatient('Returning')
      const program = await newProgram(patientId, 8)
      await plantSession(program, 1, {
        status: 'skipped',
        endReason: 'no_time',
      })
      // A skip is contact: no inactivity. The days are still missed — the
      // skip labels yesterday, it doesn't do it.
      expect(
        forProgram(await alertsOf(practitionerA), program.id),
      ).toStrictEqual([
        expect.objectContaining({
          missedInARow: { days: 8, weeks: 0, since: addDays(today, -8) },
          inactive: null,
        }),
      ])
      await plantSession(program, 2)
      // Day -2 done: the run is now yesterday alone — under the threshold.
      expect(forProgram(await alertsOf(practitionerA), program.id)).toEqual([])
    })

    // Cancelled before any session = DELETED (archived): its status stays
    // 'active', so only the archive flag keeps it off the To-do.
    it('says nothing about a deleted program', async () => {
      const patientId = await newPatient('Deleted')
      const program = await newProgram(patientId, 8)
      const res = await practitionerA
        .post(`/assigned-programs/${program.id}/cancel`)
        .send({ today })
      expect(res.status).toBe(200)
      expect(forProgram(await alertsOf(practitionerA), program.id)).toEqual([])
    })

    // One patient, three programs started the same day on the same
    // schedule — so only their OWN rows tell them apart: X has a session
    // yesterday (no alert), Y nothing (an alert), Z is paused from today (no
    // alert). Read together, Y's summary would borrow X's session or Z's
    // pause and stay quiet.
    it('summarises each program from its own schedule and sessions only', async () => {
      const patientId = await newPatient('Three')
      const x = await newProgram(patientId, 8, 'X')
      const y = await newProgram(patientId, 8, 'Y')
      const z = await newProgram(patientId, 8, 'Z')
      await plantSession(x, 1)
      const paused = await practitionerA
        .post(`/assigned-programs/${z.id}/schedules`)
        .send({ type: 'paused', effectiveFrom: today })
      expect(paused.status).toBe(201)
      // Y's facts in full: with X's session mixed in, its inactivity would
      // disappear (X's session doesn't count for Y's workout, so the run of
      // misses alone would not show the mix-up).
      const mine = (await alertsOf(practitionerA)).filter(
        (alert) => alert.patient.id === patientId,
      )
      expect(mine).toStrictEqual([
        expect.objectContaining({
          program: { id: y.id, title: 'Y' },
          missedInARow: { days: 8, weeks: 0, since: addDays(today, -8) },
          inactive: { days: 8, lastSessionDate: null },
        }),
      ])
    })

    it('says nothing about a program that has not started', async () => {
      const patientId = await newPatient('Future')
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        title: 'Future program',
        startDate: addDays(today, 2),
        schedule: EVERY_DAY,
        exercises: [{ exerciseId, sortOrder: 0 }],
      })
      expect(res.status).toBe(201)
      expect(
        forProgram(
          await alertsOf(practitionerA),
          bodyOf<{ id: number }>(res).id,
        ),
      ).toEqual([])
    })
  })

  // --- Sessions to review --------------------------------------------------------

  describe('sessions to review', () => {
    it('lists a finished session with a reason, naming the hard exercise but never the words', async () => {
      const patientId = await newPatient('Sore')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 2, {
        painBefore: 3,
        painAfter: 7,
        difficulty: 9,
        exerciseNote: 'My knee clicked',
      })
      await plantSession(program, 1)
      const sessionAlerts = forProgram(
        await alertsOf(practitionerA),
        program.id,
      ).filter((alert) => alert.kind === 'session')
      expect(sessionAlerts).toStrictEqual([
        {
          kind: 'session',
          patient: {
            id: patientId,
            firstName: 'Patient',
            lastName: 'Sore',
            avatarUrl: null,
          },
          program: { id: program.id, title: 'Alerts E2E Program' },
          session: {
            id,
            localDate: addDays(today, -2),
            status: 'completed',
            endReason: null,
            painBefore: 3,
            painAfter: 7,
          },
          reasons: ['pain_high', 'pain_rise', 'hard_exercise', 'patient_note'],
          hardExercises: [{ name: 'Alerts E2E Squat', rating: 9 }],
        },
      ])
    })

    it('keeps the window to 14 days, today included', async () => {
      const patientId = await newPatient('Window')
      const program = await newProgram(patientId, 20)
      const inside = await plantSession(program, 13, { painAfter: 8 })
      await plantSession(program, 14, { painAfter: 8 })
      const ids = forProgram(await alertsOf(practitionerA), program.id)
        .filter((alert) => alert.kind === 'session')
        .map((alert) => alert.session?.id)
      expect(ids).toEqual([inside])
    })

    it('never lists a session in progress, and lists a stop or skip for pain', async () => {
      const patientId = await newPatient('Stopping')
      const program = await newProgram(patientId, 5)
      await plantSession(program, 0, { status: 'in_progress', painBefore: 9 })
      const stopped = await plantSession(program, 2, {
        status: 'incomplete',
        endReason: 'pain',
      })
      const skipped = await plantSession(program, 1, {
        status: 'skipped',
        endReason: 'pain',
        painBefore: 6,
      })
      const listed = forProgram(await alertsOf(practitionerA), program.id)
        .filter((alert) => alert.kind === 'session')
        .map((alert) => [alert.session?.id, alert.reasons])
      // Newest first.
      expect(listed).toEqual([
        [skipped, ['ended_for_pain']],
        [stopped, ['ended_for_pain']],
      ])
    })

    it('lists a session of a program closed since', async () => {
      const patientId = await newPatient('Closed')
      const program = await newProgram(patientId, 5)
      const id = await plantSession(program, 2, { painAfter: 9 })
      const closed = await practitionerA
        .post(`/assigned-programs/${program.id}/cancel`)
        .send({ today })
      expect(closed.status).toBe(200)
      const listed = forProgram(await alertsOf(practitionerA), program.id)
      // No attendance alert for a closed program; the session stays.
      expect(listed.map((alert) => [alert.kind, alert.session?.id])).toEqual([
        ['session', id],
      ])
    })

    it('orders attendance first (by patient), then sessions newest first', async () => {
      const zed = await newPatient('Zed')
      const amy = await newPatient('Amy')
      // Each program: a session 9 or 10 days ago (high pain), and nothing
      // since — both an attendance alert and a session to review.
      const zedProgram = await newProgram(zed, 20)
      const amyProgram = await newProgram(amy, 20)
      const older = await plantSession(zedProgram, 10, { painAfter: 8 })
      const newer = await plantSession(amyProgram, 9, { painAfter: 8 })
      const mine = (await alertsOf(practitionerA)).filter((alert) =>
        [zed, amy].includes(alert.patient.id),
      )
      expect(
        mine.map((alert) => [
          alert.kind,
          alert.patient.id,
          alert.session?.id ?? null,
        ]),
      ).toEqual([
        ['attendance', amy, null],
        ['attendance', zed, null],
        ['session', amy, newer],
        ['session', zed, older],
      ])
    })
  })

  // --- The care-team rule, at both layers -----------------------------------------

  describe('the care-team rule', () => {
    it('gives a same-clinic practitioner on no care team an empty list, not a 403', async () => {
      const patientId = await newPatient('Private')
      // An attendance alert AND a session to review, for A …
      const program = await newProgram(patientId, 20)
      await plantSession(program, 10, { painAfter: 9 })
      expect(
        forProgram(await alertsOf(practitionerA), program.id).map(
          (alert) => alert.kind,
        ),
      ).toEqual(['attendance', 'session'])
      // … and nothing at all for B, who shares the clinic only.
      expect(await alertsOf(practitionerB)).toEqual([])
    })

    it('hides reviews from anyone off the care team, from the patient and from an admin, at the row level', async () => {
      const patientId = await newPatient('Rowlevel')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1, { painAfter: 9 })
      expect((await practitionerA.post(`/sessions/${id}/review`)).status).toBe(
        200,
      )
      const select = sql`SELECT practitioner_id FROM session_reviews WHERE session_id = ${id}`
      expect(await asActor(practitionerCId, 'practitioner', select)).toEqual({
        rowCount: 1,
        rows: [{ practitioner_id: practitionerAId }],
      })
      // An admin sees none since 0059 (decisions §16).
      expect(await asActor(adminId, 'admin', select)).toEqual({
        rowCount: 0,
        rows: [],
      })
      expect(await asActor(practitionerBId, 'practitioner', select)).toEqual({
        rowCount: 0,
        rows: [],
      })
      expect(await asActor(patientId, 'patient', select)).toEqual({
        rowCount: 0,
        rows: [],
      })
    })

    it('lets a care-team practitioner write a review for themselves only — never in a colleague’s name, never off the team', async () => {
      const patientId = await newPatient('Writer')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1)
      const insert = (practitionerId: number) =>
        sql`INSERT INTO session_reviews (session_id, practitioner_id) VALUES (${id}, ${practitionerId})`
      expect(
        await asActor(practitionerCId, 'practitioner', insert(practitionerCId)),
      ).toMatchObject({ rowCount: 1 })
      // 42501: the row-level security policy refuses the row.
      expect(
        await asActor(practitionerCId, 'practitioner', insert(practitionerAId)),
      ).toEqual({ error: { code: '42501' } })
      expect(
        await asActor(practitionerBId, 'practitioner', insert(practitionerBId)),
      ).toEqual({ error: { code: '42501' } })
      expect(await asActor(adminId, 'admin', insert(adminId))).toEqual({
        error: { code: '42501' },
      })
    })

    it('keeps a review as written: no update, no delete', async () => {
      const patientId = await newPatient('Record')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1)
      expect((await practitionerA.post(`/sessions/${id}/review`)).status).toBe(
        200,
      )
      // No UPDATE or DELETE policy: no row qualifies, so nothing changes.
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`UPDATE session_reviews SET reviewed_at = now() - interval '1 day' WHERE session_id = ${id}`,
        ),
      ).toMatchObject({ rowCount: 0 })
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`DELETE FROM session_reviews WHERE session_id = ${id}`,
        ),
      ).toMatchObject({ rowCount: 0 })
    })
  })

  // --- POST /sessions/:id/review --------------------------------------------------

  describe('POST /sessions/:id/review', () => {
    it("takes the session off the reviewer's To-do only, and shows the review to the team", async () => {
      const patientId = await newPatient('Reviewed')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1, { painAfter: 8 })
      await plantSession(program, 2)
      await plantSession(program, 3)

      const res = await practitionerA.post(`/sessions/${id}/review`)
      expect(res.status).toBe(200)
      // The answer is the session (as GET /sessions/:id), with its reviews.
      expect(res.body).toMatchObject({ id, status: 'completed' })
      const reviews = bodyOf<{ reviews: ReviewBody[] }>(res).reviews
      expect(reviews).toStrictEqual([
        {
          practitioner: {
            id: practitionerAId,
            firstName: 'Practitioner',
            lastName: 'A',
          },
          reviewedAt: expect.any(String),
        },
      ])

      expect(forProgram(await alertsOf(practitionerA), program.id)).toEqual([])
      expect(
        forProgram(await alertsOf(practitionerC), program.id).map(
          (alert) => alert.session?.id,
        ),
      ).toEqual([id])

      const asColleague = await practitionerC.get(`/sessions/${id}`)
      expect(bodyOf<{ reviews: ReviewBody[] }>(asColleague).reviews).toEqual(
        reviews,
      )

      // The colleague reviews too: both listed, oldest first.
      const both = await practitionerC.post(`/sessions/${id}/review`)
      expect(
        bodyOf<{ reviews: ReviewBody[] }>(both).reviews.map(
          (review) => review.practitioner.id,
        ),
      ).toEqual([practitionerAId, practitionerCId])
    })

    it('writes the database clock, whatever a client sends, and ONE audit entry', async () => {
      const patientId = await newPatient('Audited')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1)
      const before = await sessionPool.query<{ now: Date }>(
        'SELECT clock_timestamp() AS now',
      )
      expect((await practitionerA.post(`/sessions/${id}/review`)).status).toBe(
        200,
      )
      const [stored] = await storedReviews(id)
      expect(stored.practitioner_id).toBe(practitionerAId)
      expect(stored.reviewed_at.getTime()).toBeGreaterThanOrEqual(
        before.rows[0].now.getTime(),
      )
      expect(await reviewAudit(id)).toStrictEqual([
        {
          action: 'SESSION_REVIEWED',
          performed_by: practitionerAId,
          target_user_id: patientId,
          entity_type: 'session_reviews',
          details: {
            sessionId: id,
            reviewedAt: stored.reviewed_at.toISOString(),
          },
        },
      ])

      // As the app's role, an explicit moment is overwritten by the trigger.
      const written = await asActor(
        practitionerCId,
        'practitioner',
        sql`INSERT INTO session_reviews (session_id, practitioner_id, reviewed_at)
            VALUES (${id}, ${practitionerCId}, '2000-01-01T00:00:00Z')
            RETURNING reviewed_at`,
      )
      const [{ reviewed_at }] = written.rows as { reviewed_at: string }[]
      expect(new Date(reviewed_at).getFullYear()).toBeGreaterThan(2000)
    })

    it('is idempotent: a second review changes nothing and logs nothing', async () => {
      const patientId = await newPatient('Twice')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1)
      const first = await practitionerA.post(`/sessions/${id}/review`)
      const second = await practitionerA.post(`/sessions/${id}/review`)
      expect(second.status).toBe(200)
      expect(second.body).toEqual(first.body)
      expect(await storedReviews(id)).toHaveLength(1)
      expect(await reviewAudit(id)).toHaveLength(1)
    })

    // Two reviews racing: another connection holds an UNCOMMITTED review by
    // A (the app's role, A's context). The request's insert must wait for
    // it, then find the row there — ON CONFLICT DO NOTHING — and answer 200
    // with nothing written: no 500 from the unique index, no second row, no
    // audit entry (the held insert was raw SQL, so nobody logged it).
    it('answers a review racing another one with the one review', async () => {
      const patientId = await newPatient('Racing')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 1)
      const client = await appPool.connect()
      let waited = false
      let res: request.Response
      try {
        await client.query('BEGIN')
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'practitioner', true)",
          [String(practitionerAId)],
        )
        await client.query(
          'INSERT INTO session_reviews (session_id, practitioner_id) VALUES ($1, $2)',
          [id, practitionerAId],
        )
        let answered = false
        const pending = practitionerA
          .post(`/sessions/${id}/review`)
          .then((r) => {
            answered = true
            return r
          })
        await new Promise((resolve) => setTimeout(resolve, 300))
        waited = !answered
        await client.query('COMMIT')
        res = await pending
      } finally {
        client.release()
      }
      expect(waited).toBe(true)
      expect(res.status).toBe(200)
      expect(bodyOf<{ reviews: ReviewBody[] }>(res).reviews).toHaveLength(1)
      expect(await storedReviews(id)).toHaveLength(1)
      expect(await reviewAudit(id)).toEqual([])
    })

    it('refuses a session still in progress — the service, and the database too', async () => {
      const patientId = await newPatient('Open')
      const program = await newProgram(patientId, 3)
      const id = await plantSession(program, 0, { status: 'in_progress' })
      const res = await practitionerA.post(`/sessions/${id}/review`)
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        "This session is still in progress, so it can't be reviewed yet",
      ])
      expect(await storedReviews(id)).toEqual([])
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`INSERT INTO session_reviews (session_id, practitioner_id) VALUES (${id}, ${practitionerAId})`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'session_review_finished_only' },
      })
    })

    it('refuses the patient and an admin (the role guard), and 404s a practitioner off the care team', async () => {
      const program = await newProgram(loggedInPatientId, 3)
      const id = await plantSession(program, 1)
      for (const who of [patient, admin]) {
        const res = await who.post(`/sessions/${id}/review`)
        expect(res.status).toBe(403)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'You do not have permission to access this resource',
        ])
      }
      const offTeam = await practitionerB.post(`/sessions/${id}/review`)
      expect(offTeam.status).toBe(404)
      expect(await storedReviews(id)).toEqual([])
    })

    it('never shows reviews to the patient: their session has no reviews key', async () => {
      const program = await newProgram(loggedInPatientId, 3)
      const id = await plantSession(program, 1)
      expect((await practitionerA.post(`/sessions/${id}/review`)).status).toBe(
        200,
      )
      const own = await patient.get(`/sessions/${id}`)
      expect(own.status).toBe(200)
      expect(own.body).not.toHaveProperty('reviews')
      // The care team does see it — the review exists (an admin reads no
      // session at all since 2026-10-23: its 403 is in the sessions suite).
      const asCareTeam = await practitionerA.get(`/sessions/${id}`)
      expect(
        bodyOf<{ reviews: ReviewBody[] }>(asCareTeam).reviews,
      ).toHaveLength(1)
    })
  })
  // --- POST /alerts/programs/:programId/review (2026-10-19) ------------------

  describe('reviewing an attendance alert', () => {
    interface ProgramReviewBody {
      missedSince: string | null
      inactiveSince: string | null
      reviewedAt: string
    }
    const reviewProgram = (
      who: ReturnType<typeof agent>,
      programId: number,
      body: object = { today },
    ) => who.post(`/alerts/programs/${programId}/review`).send(body)

    async function programReviews(programId: number) {
      const { rows } = await sessionPool.query<{
        practitioner_id: number
        missed_since: string | null
        inactive_since: string | null
      }>(
        `SELECT practitioner_id, missed_since::text, inactive_since::text
         FROM program_alert_reviews WHERE assigned_program_id = $1 ORDER BY id`,
        [programId],
      )
      return rows
    }
    async function programReviewAudit(programId: number) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const { rows } = await sessionPool.query<{
        performed_by: number
        target_user_id: number
        entity_type: string
        details: Record<string, unknown>
      }>(
        `SELECT performed_by, target_user_id, entity_type, details FROM audit_logs
         WHERE action = 'PROGRAM_ALERT_REVIEWED'
           AND (details->>'programId')::int = $1 ORDER BY id`,
        [programId],
      )
      return rows
    }
    const kindsFor = async (who: ReturnType<typeof agent>, programId: number) =>
      forProgram(await alertsOf(who), programId).map((alert) => alert.kind)

    it("takes the alert off the reviewer's list only, recording the facts the server saw", async () => {
      const patientId = await newPatient('Away')
      const program = await newProgram(patientId, 8)
      const res = await reviewProgram(practitionerA, program.id)
      expect(res.status).toBe(200)
      const start = addDays(today, -8)
      expect(res.body).toStrictEqual({
        missedSince: start,
        inactiveSince: start,
        reviewedAt: expect.any(String),
      })
      expect(await kindsFor(practitionerA, program.id)).toEqual([])
      expect(await kindsFor(practitionerC, program.id)).toEqual(['attendance'])
      expect(await programReviews(program.id)).toStrictEqual([
        {
          practitioner_id: practitionerAId,
          missed_since: start,
          inactive_since: start,
        },
      ])
      expect(await programReviewAudit(program.id)).toStrictEqual([
        {
          performed_by: practitionerAId,
          target_user_id: patientId,
          entity_type: 'program_alert_reviews',
          details: {
            programId: program.id,
            missedSince: start,
            inactiveSince: start,
            today,
          },
        },
      ])
    })

    it('is idempotent: while my review covers the alert, another writes nothing', async () => {
      const patientId = await newPatient('Again')
      const program = await newProgram(patientId, 8)
      const first = await reviewProgram(practitionerA, program.id)
      const second = await reviewProgram(practitionerA, program.id)
      expect(second.status).toBe(200)
      expect(second.body).toEqual(first.body)
      expect(await programReviews(program.id)).toHaveLength(1)
      expect(await programReviewAudit(program.id)).toHaveLength(1)
    })

    it('brings the alert back when a fact the review did not see appears', async () => {
      const patientId = await newPatient('Worse')
      const program = await newProgram(patientId, 8)
      // A skip yesterday: the patient was in touch (no inactivity), but
      // every scheduled day is still missed.
      const skip = await plantSession(program, 1, {
        status: 'skipped',
        endReason: 'no_time',
      })
      const res = await reviewProgram(practitionerA, program.id)
      expect(bodyOf<ProgramReviewBody>(res).inactiveSince).toBeNull()
      expect(await kindsFor(practitionerA, program.id)).toEqual([])
      // Without the skip, eight days without contact: NEW — back on the list.
      await sessionPool.query('DELETE FROM sessions WHERE id = $1', [skip])
      expect(await kindsFor(practitionerA, program.id)).toEqual(['attendance'])
    })

    it('stays reviewed when a fact goes away, and the same facts never need a second review', async () => {
      const patientId = await newPatient('Better')
      const program = await newProgram(patientId, 8)
      await reviewProgram(practitionerA, program.id)
      // A skip yesterday ends the inactivity; the run is the one reviewed.
      await plantSession(program, 1, {
        status: 'skipped',
        endReason: 'illness',
      })
      expect(await kindsFor(practitionerA, program.id)).toEqual([])
      expect((await reviewProgram(practitionerA, program.id)).status).toBe(200)
      expect(await programReviews(program.id)).toHaveLength(1)
    })

    it('brings the alert back 14 days after the review, unchanged', async () => {
      const patientId = await newPatient('Reminder')
      const program = await newProgram(patientId, 8)
      await reviewProgram(practitionerA, program.id)
      // The app's rule is a fixed 14 × 24 = 336 hours. The intervals are
      // written in HOURS on purpose: Postgres subtracts an interval's "days"
      // as CALENDAR days in the session's time zone, so with a 25-hour day
      // (the clocks going back) in the last two weeks, '13 days 23 hours'
      // lands exactly 336 hours back — and the alert, rightly, comes back
      // a minute early. Hours are always 60 minutes, in every zone.
      await sessionPool.query(
        `UPDATE program_alert_reviews SET reviewed_at = now() - interval '335 hours'
         WHERE assigned_program_id = $1`,
        [program.id],
      )
      expect(await kindsFor(practitionerA, program.id)).toEqual([])
      await sessionPool.query(
        `UPDATE program_alert_reviews SET reviewed_at = now() - interval '336 hours 1 minute'
         WHERE assigned_program_id = $1`,
        [program.id],
      )
      expect(await kindsFor(practitionerA, program.id)).toEqual(['attendance'])
    })

    // Two reviews by A, the NEWER one (by its moment) inserted FIRST — so
    // ordering by time and ordering by id disagree, and only the moment
    // decides which is the latest.
    async function plantTwoReviews(
      programId: number,
      newest: string,
      older: string,
    ) {
      await sessionPool.query(
        `INSERT INTO program_alert_reviews (assigned_program_id, practitioner_id, missed_since, inactive_since)
         VALUES ($1, $2, $3, $3)`,
        [programId, practitionerAId, newest],
      )
      await sessionPool.query(
        `INSERT INTO program_alert_reviews (assigned_program_id, practitioner_id, missed_since, inactive_since)
         VALUES ($1, $2, $3, $3)`,
        [programId, practitionerAId, older],
      )
      // The trigger stamps every insert now(): age the second one by hand.
      await sessionPool.query(
        `UPDATE program_alert_reviews SET reviewed_at = now() - interval '1 day'
         WHERE assigned_program_id = $1 AND missed_since = $2`,
        [programId, older],
      )
    }

    // A colleague's review never stands in for mine — on the list (above)
    // nor in the route: my "Mark as reviewed" writes MY review.
    it("writes my review even when a colleague's covers the same facts", async () => {
      const patientId = await newPatient('Colleague')
      const program = await newProgram(patientId, 8)
      await reviewProgram(practitionerC, program.id)
      expect((await reviewProgram(practitionerA, program.id)).status).toBe(200)
      expect(
        (await programReviews(program.id)).map((r) => r.practitioner_id),
      ).toEqual([practitionerCId, practitionerAId])
    })

    it('reads only my LATEST review, by its moment', async () => {
      const start = addDays(today, -8)
      const other = addDays(today, -20)
      // The newest saw THIS situation: hidden.
      const covered = await newProgram(await newPatient('Covered'), 8)
      await plantTwoReviews(covered.id, start, other)
      expect(await kindsFor(practitionerA, covered.id)).toEqual([])
      // The newest saw ANOTHER situation (an older one saw this): shown.
      const uncovered = await newProgram(await newPatient('Uncovered'), 8)
      await plantTwoReviews(uncovered.id, other, start)
      expect(await kindsFor(practitionerA, uncovered.id)).toEqual([
        'attendance',
      ])
      // The route reads the same latest review: no write for the first,
      // a new review for the second.
      expect((await reviewProgram(practitionerA, covered.id)).status).toBe(200)
      expect(await programReviews(covered.id)).toHaveLength(2)
      expect((await reviewProgram(practitionerA, uncovered.id)).status).toBe(
        200,
      )
      expect(await programReviews(uncovered.id)).toHaveLength(3)
    })

    it('refuses a program with nothing to review, a closed one too', async () => {
      const patientId = await newPatient('Fine')
      const program = await newProgram(patientId, 3)
      await plantSession(program, 1)
      const res = await reviewProgram(practitionerA, program.id)
      expect(res.status).toBe(409)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'Nothing on this program needs reviewing right now',
      ])
      const behind = await newProgram(patientId, 8)
      await plantSession(behind, 6)
      expect(
        (
          await practitionerA
            .post(`/assigned-programs/${behind.id}/cancel`)
            .send({ today })
        ).status,
      ).toBe(200)
      expect((await reviewProgram(practitionerA, behind.id)).status).toBe(409)
      expect(await programReviews(program.id)).toEqual([])
    })

    it('answers 404 off the care team, for a deleted or unknown program', async () => {
      const patientId = await newPatient('Hidden')
      const program = await newProgram(patientId, 8)
      expect((await reviewProgram(practitionerB, program.id)).status).toBe(404)
      const deleted = await newProgram(patientId, 8)
      await practitionerA
        .post(`/assigned-programs/${deleted.id}/cancel`)
        .send({ today })
      expect((await reviewProgram(practitionerA, deleted.id)).status).toBe(404)
      expect((await reviewProgram(practitionerA, 999999)).status).toBe(404)
      expect(await programReviews(program.id)).toEqual([])
    })

    it("refuses the patient and an admin with the guard's message, and checks the body", async () => {
      const program = await newProgram(loggedInPatientId, 8)
      for (const who of [patient, admin]) {
        const res = await reviewProgram(who, program.id)
        expect(res.status).toBe(403)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'You do not have permission to access this resource',
        ])
      }
      const tooFar = await reviewProgram(practitionerA, program.id, {
        today: addDays(today, 3),
      })
      expect(tooFar.status).toBe(400)
      expect(bodyOf<ErrorBody>(tooFar).message).toEqual([
        "today must be today's date in your time zone",
      ])
      const facts = await reviewProgram(practitionerA, program.id, {
        today,
        missedSince: today,
      })
      expect(facts.status).toBe(400)
      expect(bodyOf<ErrorBody>(facts).message).toEqual([
        'property missedSince should not exist',
      ])
      expect(await programReviews(program.id)).toEqual([])
    })

    it('keeps reviews to the care team at the row level, in your own name, written once, at the database clock', async () => {
      const patientId = await newPatient('Rows')
      const program = await newProgram(patientId, 8)
      await reviewProgram(practitionerA, program.id)
      const select = sql`SELECT practitioner_id FROM program_alert_reviews WHERE assigned_program_id = ${program.id}`
      expect(
        await asActor(practitionerCId, 'practitioner', select),
      ).toMatchObject({ rowCount: 1 })
      // An admin sees none since 0059 (decisions §16).
      expect(await asActor(adminId, 'admin', select)).toMatchObject({
        rowCount: 0,
      })
      expect(
        await asActor(practitionerBId, 'practitioner', select),
      ).toMatchObject({ rowCount: 0 })
      expect(await asActor(patientId, 'patient', select)).toMatchObject({
        rowCount: 0,
      })

      // Refusals are tested WITHOUT `RETURNING`: returning the new row
      // also asks the SELECT policy, which would refuse an outsider on its
      // own — and hide whether the INSERT policy did.
      const insert = (practitionerId: number) =>
        sql`INSERT INTO program_alert_reviews (assigned_program_id, practitioner_id, missed_since)
            VALUES (${program.id}, ${practitionerId}, ${today})`
      expect(
        await asActor(practitionerCId, 'practitioner', insert(practitionerCId)),
      ).toMatchObject({ rowCount: 1 })
      expect(
        await asActor(practitionerCId, 'practitioner', insert(practitionerAId)),
      ).toEqual({ error: { code: '42501' } })
      expect(
        await asActor(practitionerBId, 'practitioner', insert(practitionerBId)),
      ).toEqual({ error: { code: '42501' } })
      // The moment is the database's, whatever is sent.
      const own = await asActor(
        practitionerCId,
        'practitioner',
        sql`INSERT INTO program_alert_reviews (assigned_program_id, practitioner_id, missed_since, reviewed_at)
            VALUES (${program.id}, ${practitionerCId}, ${today}, '2000-01-01T00:00:00Z') RETURNING reviewed_at`,
      )
      const [{ reviewed_at }] = own.rows as { reviewed_at: string }[]
      expect(new Date(reviewed_at).getFullYear()).toBeGreaterThan(2000)
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`UPDATE program_alert_reviews SET reviewed_at = now() - interval '20 days' WHERE assigned_program_id = ${program.id}`,
        ),
      ).toMatchObject({ rowCount: 0 })
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`DELETE FROM program_alert_reviews WHERE assigned_program_id = ${program.id}`,
        ),
      ).toMatchObject({ rowCount: 0 })
      // A review with no fact at all is refused by the CHECK.
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`INSERT INTO program_alert_reviews (assigned_program_id, practitioner_id) VALUES (${program.id}, ${practitionerAId})`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'program_alert_reviews_some_fact' },
      })
    })

    // Two reviews racing: another connection, as A, holds the program's
    // lock and an UNCOMMITTED review covering the alert. The request must
    // wait for the lock, then find that review and write nothing — no
    // second row, no audit entry (the held insert was raw SQL).
    it('serializes two reviews on the program lock: the second writes nothing', async () => {
      const patientId = await newPatient('Race')
      const program = await newProgram(patientId, 8)
      const start = addDays(today, -8)
      const client = await appPool.connect()
      let waited = false
      let res: request.Response
      try {
        await client.query('BEGIN')
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'practitioner', true)",
          [String(practitionerAId)],
        )
        await client.query(
          'SELECT id FROM assigned_programs WHERE id = $1 FOR UPDATE',
          [program.id],
        )
        await client.query(
          `INSERT INTO program_alert_reviews (assigned_program_id, practitioner_id, missed_since, inactive_since)
           VALUES ($1, $2, $3, $3)`,
          [program.id, practitionerAId, start],
        )
        let answered = false
        const pending = reviewProgram(practitionerA, program.id).then((r) => {
          answered = true
          return r
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        waited = !answered
        await client.query('COMMIT')
        res = await pending
      } finally {
        client.release()
      }
      expect(waited).toBe(true)
      expect(res.status).toBe(200)
      expect(await programReviews(program.id)).toHaveLength(1)
      expect(await programReviewAudit(program.id)).toEqual([])
    })
  })

  // --- Care-team join notices (decisions §25, the tidy-up's pass 1) -------------

  describe('care-team join notices', () => {
    interface JoinBody {
      kind: 'care_team_join'
      patient: { id: number; firstName: string; lastName: string }
      link: {
        id: number
        practitioner: { id: number; firstName: string; lastName: string }
        addedBy: { id: number; firstName: string; lastName: string } | null
        startedAt: string
        endsAt: string | null
      }
    }
    // The join notices of one practitioner's list, about one patient.
    const joinsOf = async (
      who: ReturnType<typeof agent>,
      patientId: number,
    ) => {
      const res = await who.get(`/alerts?today=${today}`)
      expect(res.status).toBe(200)
      return bodyOf<{ kind: string; patient: { id: number } }[]>(res).filter(
        (alert) =>
          alert.kind === 'care_team_join' && alert.patient.id === patientId,
      ) as JoinBody[]
    }
    // The links of a patient, as the owner, oldest first.
    async function linksOf(patientId: number) {
      const { rows } = await sessionPool.query<{
        id: number
        practitioner_id: number
      }>(
        'SELECT id, practitioner_id FROM care_team_members WHERE patient_id = $1 ORDER BY started_at, id',
        [patientId],
      )
      return rows
    }
    const linkOf = async (patientId: number, practitionerId: number) =>
      (await linksOf(patientId))
        .filter((link) => link.practitioner_id === practitionerId)
        .at(-1)!.id
    async function joinReviews(linkId: number) {
      const { rows } = await sessionPool.query<{
        practitioner_id: number
        reviewed_at: Date
      }>(
        'SELECT practitioner_id, reviewed_at FROM care_team_join_reviews WHERE care_team_member_id = $1 ORDER BY id',
        [linkId],
      )
      return rows
    }
    async function joinReviewAudit(linkId: number) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const { rows } = await sessionPool.query<{
        performed_by: number
        target_user_id: number
        entity_type: string
        entity_id: string
        details: Record<string, unknown>
      }>(
        `SELECT performed_by, target_user_id, entity_type, entity_id, details
         FROM audit_logs
         WHERE action = 'CARE_TEAM_JOIN_REVIEWED' AND (details->>'careTeamLinkId')::int = $1
         ORDER BY id`,
        [linkId],
      )
      return rows
    }

    // D: a fourth practitioner of the clinic, added by the admin below.
    let practitionerD: ReturnType<typeof agent>
    let practitionerDId: number
    // A patient with A (creator) and C (added by A) on the team, then B
    // joining by themselves, then the admin adding D.
    let patientId: number
    // A patient whose care team A isn't on (B creates them) — B's link on them.
    let elsewhereLink: number
    beforeAll(async () => {
      practitionerD = agent()
      const email = `practitioner-d-${stamp}@example.com`
      const res = await admin.post('/users').send({
        email,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'D',
        licenseNumber: `PT-d-${stamp}`,
        clinicId,
      })
      practitionerDId = bodyOf<{ id: number }>(res).id
      await activateAccount(sessionPool, email)
      await practitionerD
        .post('/auth/login')
        .send({ email, password: 'password123' })

      patientId = await newPatient('Joined')
      expect(
        (await practitionerB.post(`/users/${patientId}/care-team`).send({}))
          .status,
      ).toBe(201)
      expect(
        (
          await admin
            .post(`/users/${patientId}/care-team`)
            .send({ practitionerId: practitionerDId })
        ).status,
      ).toBe(201)

      const other = await practitionerB.post('/users').send({
        email: `patient-elsewhere-${stamp}@example.com`,
        role: 'patient',
        firstName: 'Patient',
        lastName: 'Elsewhere',
        dateOfBirth: '1990-01-01',
        clinicId,
      })
      expect(other.status).toBe(201)
      elsewhereLink = await linkOf(
        bodyOf<{ id: number }>(other).id,
        practitionerBId,
      )
    })

    it('tells the members already there — who joined, who added them, when', async () => {
      const bLink = await linkOf(patientId, practitionerBId)
      const dLink = await linkOf(patientId, practitionerDId)
      for (const who of [practitionerA, practitionerC]) {
        const joins = await joinsOf(who, patientId)
        // Newest first: D (added by the admin), then B (joined by themselves).
        expect(joins.map((join) => join.link.id)).toEqual([dLink, bLink])
        expect(joins[0]).toStrictEqual({
          kind: 'care_team_join',
          patient: expect.objectContaining({
            id: patientId,
            firstName: 'Patient',
            lastName: 'Joined',
          }),
          link: {
            id: dLink,
            practitioner: {
              id: practitionerDId,
              firstName: 'Practitioner',
              lastName: 'D',
            },
            addedBy: { id: adminId, firstName: 'Alerts', lastName: 'Admin' },
            startedAt: expect.any(String),
            endsAt: null,
          },
        })
        expect(joins[1].link.practitioner.id).toBe(practitionerBId)
        expect(joins[1].link.addedBy).toBeNull()
      }
    })

    it('comes after every clinical alert in the list', async () => {
      // Its own patient: a join (B) AND a clinical alert (a painful session
      // yesterday), so this test doesn't depend on the blocks above having
      // run — and "Joined" keeps no program (the test below needs that).
      const ordered = await newPatient('Ordered')
      expect(
        (await practitionerB.post(`/users/${ordered}/care-team`).send({}))
          .status,
      ).toBe(201)
      const program = await newProgram(ordered, 3, 'Join order program')
      await plantSession(program, 1, { painBefore: 2, painAfter: 9 })
      const res = await practitionerA.get(`/alerts?today=${today}`)
      const kinds = bodyOf<{ kind: string }[]>(res).map((alert) => alert.kind)
      const firstJoin = kinds.indexOf('care_team_join')
      expect(firstJoin).toBeGreaterThan(0)
      expect(
        kinds.slice(firstJoin).every((kind) => kind === 'care_team_join'),
      ).toBe(true)
    })

    it('tells a newcomer only about those who came after them', async () => {
      // B joined before D: B learns of D only. D, the newest, learns nothing —
      // and never of their own link.
      expect(
        (await joinsOf(practitionerB, patientId)).map(
          (join) => join.link.practitioner.id,
        ),
      ).toEqual([practitionerDId])
      expect(await joinsOf(practitionerD, patientId)).toEqual([])
    })

    it('never tells someone about a colleague they added themselves (A added C)', async () => {
      const ids = (await joinsOf(practitionerA, patientId)).map(
        (join) => join.link.practitioner.id,
      )
      expect(ids).not.toContain(practitionerCId)
    })

    it('records no clinical read for a patient shown only by a join notice', async () => {
      // This patient has no program: only the join notices show them.
      await joinsOf(practitionerA, patientId)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const { rows } = await sessionPool.query(
        `SELECT 1 FROM audit_logs WHERE action = 'ALERTS_VIEWED' AND target_user_id = $1`,
        [patientId],
      )
      expect(rows).toEqual([])
    })

    it('marks a notice reviewed for that practitioner only, once, with one entry', async () => {
      const bLink = await linkOf(patientId, practitionerBId)
      const first = await practitionerA.post(
        `/alerts/care-team-joins/${bLink}/review`,
      )
      expect(first.status).toBe(200)
      const reviewedAt = bodyOf<{ reviewedAt: string }>(first).reviewedAt
      // Again: nothing written, the same review answered.
      const again = await practitionerA.post(
        `/alerts/care-team-joins/${bLink}/review`,
      )
      expect(again.status).toBe(200)
      expect(bodyOf<{ reviewedAt: string }>(again).reviewedAt).toBe(reviewedAt)

      const stored = await joinReviews(bLink)
      expect(stored.map((row) => row.practitioner_id)).toEqual([
        practitionerAId,
      ])
      expect(stored[0].reviewed_at.toISOString()).toBe(reviewedAt)
      const audit = await joinReviewAudit(bLink)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toStrictEqual({
        performed_by: practitionerAId,
        target_user_id: patientId,
        entity_type: 'care_team_join_reviews',
        entity_id: expect.any(String),
        details: { careTeamLinkId: bLink, practitionerId: practitionerBId },
      })

      // Off A's list; still on C's.
      expect(
        (await joinsOf(practitionerA, patientId)).map((join) => join.link.id),
      ).not.toContain(bLink)
      expect(
        (await joinsOf(practitionerC, patientId)).map((join) => join.link.id),
      ).toContain(bLink)
    })

    it("refuses what isn't a notice for the practitioner (409) and what they can't see (404)", async () => {
      const aLink = await linkOf(patientId, practitionerAId)
      const cLink = await linkOf(patientId, practitionerCId)
      // My own link, and one I created: on my patient, but not a notice for me.
      for (const link of [aLink, cLink]) {
        const res = await practitionerA.post(
          `/alerts/care-team-joins/${link}/review`,
        )
        expect(res.status).toBe(409)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'This change to the care team is not in your For review list',
        ])
      }
      // A patient whose team A isn't on: 404, like a link that doesn't exist
      // — an outsider learns nothing.
      for (const link of [elsewhereLink, 999999]) {
        const res = await practitionerA.post(
          `/alerts/care-team-joins/${link}/review`,
        )
        expect(res.status).toBe(404)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          `Care-team link ${link} not found`,
        ])
      }
      expect(await joinReviews(elsewhereLink)).toEqual([])
      // Practitioners only.
      const res = await admin.post(`/alerts/care-team-joins/${cLink}/review`)
      expect(res.status).toBe(403)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        'You do not have permission to access this resource',
      ])
    })

    it('still announces a member who has left since, with when they left', async () => {
      const dLink = await linkOf(patientId, practitionerDId)
      expect(
        (
          await admin
            .post(`/users/${patientId}/care-team/${practitionerDId}/end`)
            .send({})
        ).status,
      ).toBe(201)
      const [notice] = (await joinsOf(practitionerC, patientId)).filter(
        (join) => join.link.id === dLink,
      )
      expect(notice.link.endsAt).not.toBeNull()
    })

    it('counts from my CURRENT link: after I left and rejoined, an earlier newcomer is no news', async () => {
      // A leaves, B joins, A rejoins: A's current link is newer than B's —
      // A's ended first link (older than B's) must not count.
      const id = await newPatient('Rejoined')
      expect(
        (
          await practitionerA
            .post(`/users/${id}/care-team/${practitionerAId}/end`)
            .send({})
        ).status,
      ).toBe(201)
      expect(
        (await practitionerB.post(`/users/${id}/care-team`).send({})).status,
      ).toBe(201)
      expect(
        (await practitionerA.post(`/users/${id}/care-team`).send({})).status,
      ).toBe(201)
      expect(await joinsOf(practitionerA, id)).toEqual([])
      const bLink = await linkOf(id, practitionerBId)
      const res = await practitionerA.post(
        `/alerts/care-team-joins/${bLink}/review`,
      )
      expect(res.status).toBe(409)
      // C, there all along, is told — of B, and of A's return.
      expect(
        (await joinsOf(practitionerC, id)).map(
          (join) => join.link.practitioner.id,
        ),
      ).toEqual([practitionerAId, practitionerBId])
    })

    it('drops a join older than 14 days', async () => {
      // A second patient: A, C, then B — every link moved back as the owner,
      // A's and C's well before B's, so only the 14 days decide.
      const id = await newPatient('Older')
      expect(
        (await practitionerB.post(`/users/${id}/care-team`).send({})).status,
      ).toBe(201)
      await sessionPool.query(
        `UPDATE care_team_members SET started_at = started_at - interval '30 days'
         WHERE patient_id = $1 AND practitioner_id <> $2`,
        [id, practitionerBId],
      )
      const move = (days: number) =>
        sessionPool.query(
          `UPDATE care_team_members SET started_at = now() - make_interval(days => $3)
           WHERE patient_id = $1 AND practitioner_id = $2`,
          [id, practitionerBId, days],
        )
      await move(13)
      expect(await joinsOf(practitionerA, id)).toHaveLength(1)
      await move(15)
      expect(await joinsOf(practitionerA, id)).toEqual([])
      const bLink = await linkOf(id, practitionerBId)
      expect(
        (await practitionerA.post(`/alerts/care-team-joins/${bLink}/review`))
          .status,
      ).toBe(409)
    })

    it('holds at the database: own rows only, for a patient on my team, the moment the server’s', async () => {
      const bLink = await linkOf(patientId, practitionerBId)
      // In C's name, by A: refused (42501), as is a link of a patient A isn't
      // treating — B's own patient from the test above.
      const forC = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO care_team_join_reviews (care_team_member_id, practitioner_id) VALUES (${bLink}, ${practitionerCId})`,
      )
      expect(forC).toStrictEqual({ error: { code: '42501' } })
      const notMine = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO care_team_join_reviews (care_team_member_id, practitioner_id) VALUES (${elsewhereLink}, ${practitionerAId})`,
      )
      expect(notMine).toStrictEqual({ error: { code: '42501' } })
      // C's own: allowed, with the server's moment whatever is sent.
      const own = await asActor(
        practitionerCId,
        'practitioner',
        sql`INSERT INTO care_team_join_reviews (care_team_member_id, practitioner_id, reviewed_at)
            VALUES (${bLink}, ${practitionerCId}, '2000-01-01T00:00:00Z')
            RETURNING reviewed_at > now() - interval '1 minute' AS fresh`,
      )
      expect(own).toStrictEqual({ rowCount: 1, rows: [{ fresh: true }] })
      // A's review (written here as the owner, if the test above hasn't) is
      // A's alone: C, an admin, and A acting as a patient see none of it.
      await sessionPool.query(
        'INSERT INTO care_team_join_reviews (care_team_member_id, practitioner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [bLink, practitionerAId],
      )
      const read = sql`SELECT count(*)::int AS n FROM care_team_join_reviews WHERE care_team_member_id = ${bLink}`
      expect(
        await asActor(practitionerAId, 'practitioner', read),
      ).toStrictEqual({ rowCount: 1, rows: [{ n: 1 }] })
      expect(
        await asActor(practitionerCId, 'practitioner', read),
      ).toStrictEqual({ rowCount: 1, rows: [{ n: 0 }] })
      expect(await asActor(adminId, 'admin', read)).toStrictEqual({
        rowCount: 1,
        rows: [{ n: 0 }],
      })
      expect(await asActor(practitionerAId, 'patient', read)).toStrictEqual({
        rowCount: 1,
        rows: [{ n: 0 }],
      })
      // Written once: no UPDATE, no DELETE.
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`UPDATE care_team_join_reviews SET reviewed_at = now() WHERE care_team_member_id = ${bLink}`,
        ),
      ).toStrictEqual({ rowCount: 0, rows: [] })
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`DELETE FROM care_team_join_reviews WHERE care_team_member_id = ${bLink}`,
        ),
      ).toStrictEqual({ rowCount: 0, rows: [] })
      expect(await joinReviews(bLink)).toHaveLength(1)
    })
  })
})
