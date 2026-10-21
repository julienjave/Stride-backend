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
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { addDays, utcToday } from '../src/common/calendar-date'

// The audit review, Phase 6 — step 2 (decided with the person 2026-10-21):
// READS of a patient's programs, sessions and alerts by SOMEONE ELSE (their
// practitioner, an admin) are recorded —
//   - one entry per patient shown (a list showing two patients: two);
//   - written before the answer: if it can't be written, the data isn't
//     served;
//   - nothing for the patient reading their own data, nor for a refused read.
describe('Clinical reads audit trail (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitioner: ReturnType<typeof agent>
  let outsider: ReturnType<typeof agent> // same clinic, on no care team
  let patientX: ReturnType<typeof agent>
  let adminId: number
  let practitionerId: number
  let xId: number
  let yId: number
  let xProgram: { id: number; workouts: { id: number }[] }
  let yProgram: { id: number }
  let xSessionId: number
  let xOlderSessionId: number
  const stamp = Date.now()
  const today = utcToday()

  interface Entry {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  // The last entry's id: each test reads only what ITS requests wrote.
  async function mark() {
    const { rows } = await sessionPool.query<{ id: string | null }>(
      'SELECT max(id) AS id FROM audit_logs',
    )
    return Number(rows[0].id ?? 0)
  }
  // The entries written since `from`, oldest first (as the owner).
  async function since(from: number) {
    const { rows } = await sessionPool.query<Entry>(
      `SELECT action, performed_by, target_user_id, entity_type,
              entity_id::int, details
         FROM audit_logs WHERE id > $1 ORDER BY id`,
      [from],
    )
    return rows
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
    // Same session setup as main.ts (see users.e2e-spec.ts for why).
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

    // Refuse to run anywhere but the test database (see users.e2e-spec.ts).
    const db = app.get<DrizzleDb>(DRIZZLE)
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
    practitioner = agent()
    outsider = agent()
    patientX = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Reads Audit Clinic',
      clinicEmail: `ra-clinic-${stamp}@example.com`,
      email: `ra-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Reads',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    const clinicId = bootstrap.body.clinicId as number
    adminId = (await admin.get('/auth/me')).body.id as number

    const login = async (who: ReturnType<typeof agent>, email: string) => {
      await activateAccount(sessionPool, email)
      const res = await who
        .post('/auth/login')
        .send({ email, password: 'password123' })
      expect(res.status).toBe(201)
    }
    for (const [who, label] of [
      [practitioner, 'p'],
      [outsider, 'o'],
    ] as const) {
      const email = `ra-${label}-${stamp}@example.com`
      const created = await admin.post('/users').send({
        email,
        role: 'practitioner',
        firstName: 'Reads',
        lastName: label.toUpperCase(),
        licenseNumber: `RA-${label}-${stamp}`,
        clinicId,
      })
      expect(created.status).toBe(201)
      await login(who, email)
      if (who === practitioner) practitionerId = created.body.id as number
    }

    // Two patients, created by the practitioner (who so joins their care
    // teams). X signs in; Y doesn't need to.
    const newPatient = async (label: string) => {
      const res = await practitioner.post('/users').send({
        email: `ra-${label}-${stamp}@example.com`,
        role: 'patient',
        firstName: 'Patient',
        lastName: label.toUpperCase(),
        dateOfBirth: '1990-01-01',
        clinicId,
      })
      expect(res.status).toBe(201)
      return res.body.id as number
    }
    xId = await newPatient('x')
    yId = await newPatient('y')
    await login(patientX, `ra-x-${stamp}@example.com`)

    const exercise = await practitioner.post('/exercises').send({
      name: 'Reads Audit Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    expect(exercise.status).toBe(201)
    const everyDay = {
      type: 'weekdays',
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        workoutIndex: 0,
      })),
    }
    const assign = async (patientId: number, startsDaysAgo: number) => {
      const res = await practitioner.post('/assigned-programs').send({
        patientId,
        title: 'Reads Audit Program',
        startDate: addDays(today, -startsDaysAgo),
        schedule: everyDay,
        exercises: [{ exerciseId: exercise.body.id as number, sortOrder: 0 }],
      })
      expect(res.status).toBe(201)
      return res.body as { id: number; workouts: { id: number }[] }
    }
    xProgram = await assign(xId, 3)
    yProgram = await assign(yId, 0)

    // Two sessions of X's, yesterday and the day before, both finished in
    // pain (8): two To-do alerts about ONE patient — which must still be
    // ONE entry. Planted as the owner (the API files a session under
    // today); a completed session has a start and a completion (the CHECKs
    // of 0037).
    const plant = async (daysAgo: number) => {
      const moment = `($4::date - $5::int) + time '18:00'`
      const planted = await sessionPool.query<{ id: string }>(
        `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
           scheduled_date, local_date, status, started_at, completed_at,
           pain_before, pain_after)
         VALUES ($1, $2, $3, ${moment}, $4::date - $5::int, 'completed',
                 ${moment}, ${moment} + interval '30 minutes', 2, 8)
         RETURNING id`,
        [xProgram.id, xProgram.workouts[0].id, xId, today, daysAgo],
      )
      return Number(planted.rows[0].id)
    }
    xSessionId = await plant(1)
    xOlderSessionId = await plant(2)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // === PROGRAMS =============================================================

  it("records a practitioner's program list once per patient shown", async () => {
    const from = await mark()
    const res = await practitioner.get('/assigned-programs')
    expect(res.status).toBe(200)

    expect(await since(from)).toEqual(
      [
        [xId, xProgram.id],
        [yId, yProgram.id],
      ].map(([patient, program]) => ({
        action: 'PROGRAMS_VIEWED',
        performed_by: practitionerId,
        target_user_id: patient,
        entity_type: 'assigned-programs',
        entity_id: null,
        details: { programIds: [program] },
      })),
    )
  })

  it('records each read of one program — the program, its summary, its sessions, its closing preview', async () => {
    const from = await mark()
    const responses = [
      await practitioner.get(`/assigned-programs/${xProgram.id}`),
      await practitioner.get(
        `/assigned-programs/${xProgram.id}/summary?today=${today}`,
      ),
      await practitioner.get(`/assigned-programs/${xProgram.id}/sessions`),
      await practitioner.get(
        `/assigned-programs/${xProgram.id}/closing?today=${today}`,
      ),
    ]
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200])

    const about = (action: string, details: unknown = null) => ({
      action,
      performed_by: practitionerId,
      target_user_id: xId,
      entity_type: 'assigned-programs',
      entity_id: xProgram.id,
      details,
    })
    expect(await since(from)).toEqual([
      about('PROGRAM_VIEWED'),
      about('PROGRAM_SUMMARY_VIEWED'),
      // Newest first, as the list shows them.
      about('PROGRAM_SESSIONS_VIEWED', {
        sessionIds: [xSessionId, xOlderSessionId],
      }),
      about('PROGRAM_CLOSING_PREVIEWED'),
    ])
  })

  it("records an admin's reads too", async () => {
    const from = await mark()
    const responses = [
      await admin.get(`/assigned-programs?patientId=${yId}`),
      await admin.get(`/sessions/${xSessionId}`),
    ]
    expect(responses.map((res) => res.status)).toEqual([200, 200])

    expect(
      (await since(from)).map((e) => [
        e.action,
        e.performed_by,
        e.target_user_id,
      ]),
    ).toEqual([
      ['PROGRAMS_VIEWED', adminId, yId],
      ['SESSION_VIEWED', adminId, xId],
    ])
  })

  // === SESSIONS =============================================================

  it("records a practitioner's read of a session", async () => {
    const from = await mark()
    const res = await practitioner.get(`/sessions/${xSessionId}`)
    expect(res.status).toBe(200)

    expect(await since(from)).toEqual([
      {
        action: 'SESSION_VIEWED',
        performed_by: practitionerId,
        target_user_id: xId,
        entity_type: 'sessions',
        entity_id: xSessionId,
        details: null,
      },
    ])
  })

  // === ALERTS ===============================================================

  it('records the To-do once per patient it shows, naming what it shows', async () => {
    const from = await mark()
    const res = await practitioner.get(`/alerts?today=${today}`)
    expect(res.status).toBe(200)
    const shown = res.body as {
      kind: string
      patient: { id: number }
      program: { id: number }
      session?: { id: number }
    }[]
    // The fixture works as intended: X raises both painful sessions (and
    // perhaps attendance), Y — whose program starts today — nothing.
    expect(shown.map((alert) => alert.patient.id)).not.toContain(yId)
    expect(shown.map((alert) => alert.session?.id)).toEqual(
      expect.arrayContaining([xSessionId, xOlderSessionId]),
    )

    expect(await since(from)).toEqual([
      {
        action: 'ALERTS_VIEWED',
        performed_by: practitionerId,
        target_user_id: xId,
        entity_type: 'alerts',
        entity_id: null,
        details: {
          programIds: shown
            .filter((alert) => alert.kind === 'attendance')
            .map((alert) => alert.program.id),
          // Newest first, as the To-do shows them.
          sessionIds: [xSessionId, xOlderSessionId],
        },
      },
    ])
  })

  // === NOTHING RECORDED =====================================================

  it('records nothing when the patient reads their own data', async () => {
    const from = await mark()
    const responses = [
      await patientX.get('/assigned-programs'),
      await patientX.get(`/assigned-programs/${xProgram.id}`),
      await patientX.get(
        `/assigned-programs/${xProgram.id}/summary?today=${today}`,
      ),
      await patientX.get(`/assigned-programs/${xProgram.id}/sessions`),
      await patientX.get(`/sessions/${xSessionId}`),
    ]
    expect(responses.map((res) => res.status)).toEqual([
      200, 200, 200, 200, 200,
    ])
    expect(await since(from)).toEqual([])
  })

  it('records nothing for a refused read, nor for an empty list', async () => {
    const from = await mark()
    const responses = [
      await outsider.get(`/assigned-programs/${xProgram.id}`),
      await outsider.get(`/sessions/${xSessionId}`),
      // On no care team: an empty list — nobody's data was shown.
      await outsider.get('/assigned-programs'),
      await outsider.get(`/alerts?today=${today}`),
    ]
    // 404, not 403: row security hides the program and the session from
    // someone off the care team — answered like ones that don't exist.
    expect(responses.map((res) => res.status)).toEqual([404, 404, 200, 200])
    expect(responses[2].body).toEqual([])
    expect(await since(from)).toEqual([])
  })

  // === NO ANSWER WITHOUT ITS TRACE ==========================================

  // A trigger planted for the test refuses EVERY read entry: no audited
  // read may then serve its data — each request fails instead. (A read
  // whose entry were written without being awaited would answer 200 here.)
  it('does not serve the data when its entry cannot be written', async () => {
    await sessionPool.query(`
      CREATE FUNCTION ra_refuse_reads() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'audit insert refused (test)';
        END $$;
      CREATE TRIGGER ra_refuse_reads
        BEFORE INSERT ON audit_logs
        FOR EACH ROW WHEN (NEW.action ~ '_(PRE)?VIEWED$')
        EXECUTE FUNCTION ra_refuse_reads();
    `)
    try {
      const responses = [
        await practitioner.get('/assigned-programs'),
        await practitioner.get(`/assigned-programs/${xProgram.id}`),
        await practitioner.get(
          `/assigned-programs/${xProgram.id}/summary?today=${today}`,
        ),
        await practitioner.get(`/assigned-programs/${xProgram.id}/sessions`),
        await practitioner.get(
          `/assigned-programs/${xProgram.id}/closing?today=${today}`,
        ),
        await practitioner.get(`/sessions/${xSessionId}`),
        await practitioner.get(`/alerts?today=${today}`),
      ]
      expect(responses.map((res) => res.status)).toEqual(
        Array.from({ length: 7 }, () => 500),
      )
      expect(responses[5].body).not.toHaveProperty('painAfter')
    } finally {
      await sessionPool.query(`
        DROP TRIGGER ra_refuse_reads ON audit_logs;
        DROP FUNCTION ra_refuse_reads();
      `)
    }
  })
})
