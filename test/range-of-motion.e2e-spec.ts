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

// Practitioner-measured range of motion (Phase 7, 2026-10-31) — against a
// REAL Postgres, under the app's own role, so every answer below has gone
// through the row security policies, the constraints and the triggers of
// migrations 0076 / 0077, not only the service.
//
// Layout (the medical file suite's): who may do what; recording; the date;
// the link to a note; amending (incl. a deterministic race); a care-team link
// that ends, and a deactivated patient; the database's own rules, tried
// directly; the audit trail — reads included.
describe('RangeOfMotion (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let appPool: Pool
  let clinicId: number
  let stamp: number
  let accountCounter = 0

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  // practitionerA: on the care team of every patient newPatient() makes.
  let practitionerA: Agent
  let practitionerAId: number
  // practitionerC: a colleague of the same clinic, joined where a test says.
  let practitionerC: Agent
  let practitionerCId: number
  // outsider: a practitioner in no clinic — on nobody's care team.
  let outsider: Agent
  let outsiderId: number

  const today = utcToday()

  const GUARD_MESSAGE = 'You do not have permission to access this resource'
  const NOT_ON_TEAM_WRITE =
    'You can only record range of motion for a patient on your care team'
  const NOT_ON_TEAM_READ =
    "You do not have permission to view this patient's range of motion"
  const FUTURE = "The measurement date can't be in the future"
  const DUPLICATE =
    'Each movement can be measured once per side and mode in an assessment'
  const NOTE_UNKNOWN = "The note to link isn't in this patient's medical file"
  const AMENDS_UNKNOWN =
    "The assessment to amend isn't in this patient's record"
  const ALREADY_AMENDED =
    'This assessment has already been amended — amend its latest version instead'

  // The one measurement most tests need.
  const KNEE = {
    movement: 'knee_flexion',
    side: 'right',
    mode: 'active',
    degrees: 95,
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

    // Refuses to run anywhere but the dedicated test database: the TRUNCATE
    // below would otherwise empty the dev database.
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

    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = request.agent(app.getHttpServer())
    stamp = Date.now()
    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Range of Motion E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Rom',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    clinicId = clinicRes.body.clinicId
    ;({ agent: practitionerA, id: practitionerAId } = await newPractitioner(
      'Alex',
      'Chen',
      clinicId,
    ))
    ;({ agent: practitionerC, id: practitionerCId } = await newPractitioner(
      'Casey',
      'Ruiz',
      clinicId,
    ))
    ;({ agent: outsider, id: outsiderId } = await newPractitioner(
      'Out',
      'Sider',
      undefined,
    ))
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
    await appPool.end()
  })

  // === HELPERS ===============================================================

  async function newPractitioner(
    firstName: string,
    lastName: string,
    clinic: number | undefined,
  ) {
    const email = `pr-${++accountCounter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'practitioner',
      firstName,
      lastName,
      licenseNumber: `PT-${accountCounter}-${stamp}`,
      ...(clinic ? { clinicId: clinic } : {}),
    })
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, email)
    const agent = request.agent(app.getHttpServer())
    expect(
      (await agent.post('/auth/login').send({ email, password: 'password123' }))
        .status,
    ).toBe(201)
    return { agent, id: res.body.id as number }
  }

  // A new patient of the clinic, signed in, with `team` on their care team.
  async function newPatient(team: Agent[] = [practitionerA]) {
    const email = `pa-${++accountCounter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Pat',
      lastName: `Number${accountCounter}`,
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, email)
    const agent = request.agent(app.getHttpServer())
    expect(
      (await agent.post('/auth/login').send({ email, password: 'password123' }))
        .status,
    ).toBe(201)
    const id = res.body.id as number
    for (const member of team) {
      expect(
        (await member.post(`/users/${id}/care-team`).send({})).status,
      ).toBe(201)
    }
    return { agent, id }
  }

  function record(by: Agent, body: Record<string, unknown>) {
    return by.post('/range-of-motion').send({
      measuredOn: today,
      measurements: [KNEE],
      ...body,
    })
  }

  // An assessment by `by`, through the API — its id.
  async function addAssessment(
    by: Agent,
    patientId: number,
    body: Record<string, unknown> = {},
  ): Promise<number> {
    const res = await record(by, { patientId, ...body })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  async function addNote(by: Agent, patientId: number): Promise<number> {
    const res = await by.post('/medical-files').send({
      patientId,
      entryType: 'progress_note',
      objective: 'Measured today.',
    })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  // Rows as stored (the owner's connection: no row security).
  async function stored(patientId: number) {
    const { rows } = await sessionPool.query<{
      assessments: number
      measurements: number
    }>(
      `SELECT count(DISTINCT a.id)::int AS assessments, count(m.id)::int AS measurements
       FROM rom_assessments a LEFT JOIN rom_measurements m ON m.assessment_id = a.id
       WHERE a.patient_id = $1`,
      [patientId],
    )
    return rows[0]
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  // Every audit entry about one patient's range of motion, oldest first —
  // and any generic entry for these routes, which must never exist.
  async function auditAbout(patientId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type, entity_id::int AS entity_id, details
       FROM audit_logs
       WHERE (target_user_id = $1 AND entity_type = 'rom_assessments')
          OR action LIKE '% /range-of-motion%'
       ORDER BY id`,
      [patientId],
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
    constructor(readonly rows: Record<string, unknown>[]) {
      super('rolled back on purpose')
    }
  }
  // Statements as the APP's role, with a user's context set the way
  // withRlsContext sets it, IN ONE TRANSACTION: the last one's rows, or the
  // error that stopped them. Always rolled back — so a deferred check (which
  // runs at COMMIT) never runs here; `committing` below is for those.
  async function asActor(userId: number, role: string, ...statements: SQL[]) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${String(userId)}, true),
                     set_config('app.current_role', ${role}, true)`,
        )
        let result: { rows: Record<string, unknown>[] } = { rows: [] }
        for (const statement of statements) result = await tx.execute(statement)
        throw new RolledBack(result.rows)
      })
    } catch (error) {
      if (error instanceof RolledBack) return { rows: error.rows }
      return { error: pgError(error) }
    }
    throw new Error('unreachable: asActor() always rolls back')
  }

  // The same, COMMITTED (a raw client of the app's pool): the error of the
  // statements or of the COMMIT itself, or null when it all went through.
  async function committing(
    userId: number,
    role: string,
    statements: [string, unknown[]][],
  ) {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', $2, true)",
        [String(userId), role],
      )
      for (const [text, params] of statements) await client.query(text, params)
      await client.query('COMMIT')
      return null
    } catch (error) {
      await client.query('ROLLBACK')
      return pgError(error)
    } finally {
      client.release()
    }
  }

  // A deterministic race (the medical file suite's helper): another
  // connection holds an UNCOMMITTED write while the request is sent; the
  // request must still be unanswered 300 ms later, then the write commits.
  async function whileHolding(
    userId: number,
    statements: [string, unknown[]][],
    send: () => PromiseLike<request.Response>,
  ) {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'practitioner', true)",
        [String(userId)],
      )
      for (const [text, params] of statements) await client.query(text, params)
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

  // === 1. WHO MAY DO WHAT ====================================================

  describe('access', () => {
    it('refuses an admin on every route, with the role guard’s message', async () => {
      const patient = await newPatient()
      const id = await addAssessment(practitionerA, patient.id)
      const attempts = [
        admin.get('/range-of-motion/movements'),
        admin.get('/range-of-motion').query({ patientId: patient.id }),
        admin.get(`/range-of-motion/${id}`),
        record(admin, { patientId: patient.id }),
      ]
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403)
        expect(res.body.message).toEqual([GUARD_MESSAGE])
      }
      expect(await stored(patient.id)).toEqual({
        assessments: 1,
        measurements: 1,
      })
    })

    it('refuses a patient recording, with the role guard’s message', async () => {
      const patient = await newPatient()
      const res = await record(patient.agent, { patientId: patient.id })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([GUARD_MESSAGE])
      expect(await stored(patient.id)).toEqual({
        assessments: 0,
        measurements: 0,
      })
    })

    it('refuses a practitioner off the care team recording — the policy decides', async () => {
      const patient = await newPatient()
      const res = await record(outsider, { patientId: patient.id })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([NOT_ON_TEAM_WRITE])
      expect(await stored(patient.id)).toEqual({
        assessments: 0,
        measurements: 0,
      })
    })

    it('refuses a practitioner off the care team reading — 403 for the list, 404 for one', async () => {
      const patient = await newPatient()
      const id = await addAssessment(practitionerA, patient.id)
      const list = await outsider
        .get('/range-of-motion')
        .query({ patientId: patient.id })
      expect(list.status).toBe(403)
      expect(list.body.message).toEqual([NOT_ON_TEAM_READ])
      const one = await outsider.get(`/range-of-motion/${id}`)
      expect(one.status).toBe(404)
      expect(one.body.message).toEqual([
        `Range-of-motion assessment ${id} not found`,
      ])
    })

    it("lets a patient read their own record, and nobody else's", async () => {
      const patient = await newPatient()
      const other = await newPatient()
      const mine = await addAssessment(practitionerA, patient.id)
      const theirs = await addAssessment(practitionerA, other.id)

      const list = await patient.agent.get('/range-of-motion')
      expect(list.status).toBe(200)
      expect((list.body as { id: number }[]).map((a) => a.id)).toEqual([mine])
      expect((await patient.agent.get(`/range-of-motion/${mine}`)).status).toBe(
        200,
      )
      expect(
        (await patient.agent.get(`/range-of-motion/${theirs}`)).status,
      ).toBe(404)
      const someoneElse = await patient.agent
        .get('/range-of-motion')
        .query({ patientId: other.id })
      expect(someoneElse.status).toBe(403)
      expect(someoneElse.body.message).toEqual([
        'You can only view your own range of motion',
      ])
      // Their own id, sent explicitly, is fine.
      expect(
        (
          await patient.agent
            .get('/range-of-motion')
            .query({ patientId: patient.id })
        ).status,
      ).toBe(200)
    })

    it('needs an integer patientId from a practitioner', async () => {
      const missing = await practitionerA.get('/range-of-motion')
      expect(missing.status).toBe(400)
      expect(missing.body.message).toEqual(['patientId is required'])
      expect(
        (
          await practitionerA
            .get('/range-of-motion')
            .query({ patientId: 'abc' })
        ).status,
      ).toBe(400)
    })

    it('has no route to change or remove an assessment', async () => {
      const patient = await newPatient()
      const id = await addAssessment(practitionerA, patient.id)
      for (const res of [
        await practitionerA.patch(`/range-of-motion/${id}`).send({}),
        await practitionerA.put(`/range-of-motion/${id}`).send({}),
        await practitionerA.delete(`/range-of-motion/${id}`),
      ]) {
        expect(res.status).toBe(404)
      }
    })
  })

  // === 2. THE CATALOGUE ======================================================

  describe('GET /range-of-motion/movements', () => {
    it('serves the catalogue to practitioners and patients — joints in examination order', async () => {
      const patient = await newPatient()
      for (const agent of [practitionerA, patient.agent]) {
        const res = await agent.get('/range-of-motion/movements')
        expect(res.status).toBe(200)
        const joints = res.body.joints as {
          joint: string
          movements: Record<string, unknown>[]
        }[]
        expect(joints.map((joint) => joint.joint)).toEqual([
          'cervical_spine',
          'shoulder',
          'elbow',
          'forearm',
          'wrist',
          'thoracolumbar_spine',
          'hip',
          'knee',
          'ankle',
        ])
        expect(
          joints.reduce((count, joint) => count + joint.movements.length, 0),
        ).toBe(33)
        expect(
          joints.find((joint) => joint.joint === 'knee')?.movements,
        ).toStrictEqual([
          {
            movement: 'knee_flexion',
            label: 'Flexion',
            name: 'Knee flexion',
            sided: true,
            typicalDegrees: 135,
            lowestDegrees: -90,
            highestDegrees: 200,
          },
          {
            movement: 'knee_extension',
            label: 'Extension',
            name: 'Knee extension',
            sided: true,
            typicalDegrees: 0,
            lowestDegrees: -90,
            highestDegrees: 20,
          },
        ])
      }
    })
  })

  // === 3. RECORDING ==========================================================

  describe('recording an assessment', () => {
    it('stores it and answers it in full — measurements in examination order', async () => {
      const patient = await newPatient()
      // Sent in a jumbled order: passive before active, right before left,
      // the knee before the neck.
      const res = await record(practitionerA, {
        patientId: patient.id,
        measuredOn: addDays(today, -3),
        measurements: [
          { ...KNEE, mode: 'passive', degrees: 100 },
          KNEE,
          { ...KNEE, side: 'left', degrees: 130, note: 'pain at end range' },
          {
            movement: 'cervical_rotation',
            side: 'left',
            mode: 'active',
            degrees: 60,
          },
          { movement: 'cervical_flexion', mode: 'active', degrees: 40 },
          {
            movement: 'knee_extension',
            side: 'right',
            mode: 'active',
            degrees: -5,
          },
        ],
      })
      expect(res.status).toBe(201)
      const body = res.body as {
        id: number
        createdAt: string
        measurements: { id: number }[]
      }
      const ids = body.measurements.map((measurement) => measurement.id)
      expect(body).toStrictEqual({
        id: body.id,
        patientId: patient.id,
        measuredOn: addDays(today, -3),
        createdAt: body.createdAt,
        author: { id: practitionerAId, firstName: 'Alex', lastName: 'Chen' },
        medicalFileEntryId: null,
        amendsId: null,
        amendmentReason: null,
        amendedById: null,
        measurements: [
          {
            id: ids[0],
            movement: 'cervical_flexion',
            side: null,
            mode: 'active',
            degrees: 40,
            note: null,
          },
          {
            id: ids[1],
            movement: 'cervical_rotation',
            side: 'left',
            mode: 'active',
            degrees: 60,
            note: null,
          },
          {
            id: ids[2],
            movement: 'knee_flexion',
            side: 'left',
            mode: 'active',
            degrees: 130,
            note: 'pain at end range',
          },
          {
            id: ids[3],
            movement: 'knee_flexion',
            side: 'right',
            mode: 'active',
            degrees: 95,
            note: null,
          },
          {
            id: ids[4],
            movement: 'knee_flexion',
            side: 'right',
            mode: 'passive',
            degrees: 100,
            note: null,
          },
          {
            id: ids[5],
            movement: 'knee_extension',
            side: 'right',
            mode: 'active',
            degrees: -5,
            note: null,
          },
        ],
      })
      // Recorded now, by the database's clock.
      expect(Math.abs(Date.parse(body.createdAt) - Date.now())).toBeLessThan(
        60_000,
      )
      expect(await stored(patient.id)).toEqual({
        assessments: 1,
        measurements: 6,
      })
    })

    it('lists a record newest measured first — not newest recorded', async () => {
      const patient = await newPatient()
      // Recorded in this order, measured in the other.
      const measuredLater = await addAssessment(practitionerA, patient.id, {
        measuredOn: addDays(today, -1),
      })
      const measuredEarlier = await addAssessment(practitionerA, patient.id, {
        measuredOn: addDays(today, -10),
      })
      const measuredToday = await addAssessment(practitionerA, patient.id)
      const list = await practitionerA
        .get('/range-of-motion')
        .query({ patientId: patient.id })
      expect((list.body as { id: number }[]).map((a) => a.id)).toEqual([
        measuredToday,
        measuredLater,
        measuredEarlier,
      ])
    })

    it('refuses a measurement twice in one assessment — and stores nothing', async () => {
      const patient = await newPatient()
      for (const twice of [
        [KNEE, { ...KNEE, degrees: 100 }],
        // A movement with no side: NULL sides clash too (NULLS NOT DISTINCT).
        [
          { movement: 'cervical_flexion', mode: 'active', degrees: 40 },
          { movement: 'cervical_flexion', mode: 'active', degrees: 42 },
        ],
      ]) {
        const res = await record(practitionerA, {
          patientId: patient.id,
          measurements: twice,
        })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual([DUPLICATE])
      }
      // The assessment was inserted first — and rolled back with its values.
      expect(await stored(patient.id)).toEqual({
        assessments: 0,
        measurements: 0,
      })
      // The same movement on the other side, or passive, is another value.
      expect(
        (
          await record(practitionerA, {
            patientId: patient.id,
            measurements: [
              KNEE,
              { ...KNEE, side: 'left' },
              { ...KNEE, mode: 'passive' },
            ],
          })
        ).status,
      ).toBe(201)
    })

    // Each refusal names the measurement it is about (class-validator's
    // nested path, then our sentence).
    it.each<[string, Record<string, unknown>, string]>([
      [
        'a sided movement without a side',
        { side: undefined },
        'measurements.0.Knee flexion needs a side: left or right',
      ],
      [
        'a side that is not one',
        { side: 'middle' },
        'measurements.0.side must be one of: left, right',
      ],
      [
        'a movement with no side given one',
        { movement: 'cervical_flexion', side: 'left' },
        'measurements.0.Neck flexion has no side',
      ],
      [
        'degrees below the lowest',
        { degrees: -91 },
        'measurements.0.Knee flexion must be between -90° and 200°',
      ],
      [
        'degrees above the highest',
        { movement: 'knee_extension', degrees: 21 },
        'measurements.0.Knee extension must be between -90° and 20°',
      ],
      [
        'degrees that are not whole',
        { degrees: 95.5 },
        'measurements.0.degrees must be an integer number',
      ],
      [
        'an unknown movement',
        { movement: 'knee_twist' },
        `measurements.0.movement must be one of the following values: `,
      ],
      [
        'an unknown mode',
        { mode: 'assisted' },
        'measurements.0.mode must be one of the following values: active, passive',
      ],
      [
        'a blank note',
        { note: '  \t' },
        "measurements.0.A measurement's note can't be blank",
      ],
      [
        'an over-long note',
        { note: 'x'.repeat(201) },
        "measurements.0.A measurement's note can be at most 200 characters",
      ],
    ])('refuses %s (the DTO)', async (_label, change, message) => {
      const patient = await newPatient()
      const res = await record(practitionerA, {
        patientId: patient.id,
        measurements: [{ ...KNEE, ...change }],
      })
      expect(res.status).toBe(400)
      expect((res.body.message as string[]).join('\n')).toContain(message)
      expect(await stored(patient.id)).toEqual({
        assessments: 0,
        measurements: 0,
      })
    })

    it('accepts the bounds themselves, and a 200-character note', async () => {
      const patient = await newPatient()
      const res = await record(practitionerA, {
        patientId: patient.id,
        measurements: [
          { ...KNEE, degrees: -90, note: 'x'.repeat(200) },
          { ...KNEE, side: 'left', degrees: 200 },
          {
            movement: 'knee_extension',
            side: 'right',
            mode: 'active',
            degrees: 20,
          },
        ],
      })
      expect(res.status).toBe(201)
    })

    it('refuses no measurement, or more than 60', async () => {
      const patient = await newPatient()
      const none = await record(practitionerA, {
        patientId: patient.id,
        measurements: [],
      })
      expect(none.status).toBe(400)
      expect(none.body.message).toEqual([
        'An assessment needs at least one measurement',
      ])
      const many = await record(practitionerA, {
        patientId: patient.id,
        measurements: Array.from({ length: 61 }, () => KNEE),
      })
      expect(many.status).toBe(400)
      expect(many.body.message).toEqual([
        'An assessment can hold at most 60 measurements',
      ])
    })

    it('refuses a client-chosen moment or author (unknown fields)', async () => {
      const patient = await newPatient()
      const res = await record(practitionerA, {
        patientId: patient.id,
        createdAt: '2020-01-01T00:00:00Z',
        createdBy: practitionerCId,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'property createdAt should not exist',
        'property createdBy should not exist',
      ])
    })
  })

  // === 4. THE DAY MEASURED ===================================================

  describe('the day measured', () => {
    // "Today somewhere": UTC's tomorrow is already today east of UTC (the
    // + 1 of rom_assessments_measured_by_recording). The day after isn't
    // today anywhere.
    it('accepts a day that is today somewhere, refuses one that is today nowhere', async () => {
      const patient = await newPatient()
      expect(
        (
          await record(practitionerA, {
            patientId: patient.id,
            measuredOn: addDays(today, 1),
          })
        ).status,
      ).toBe(201)
      const res = await record(practitionerA, {
        patientId: patient.id,
        measuredOn: addDays(today, 2),
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([FUTURE])
      expect((await stored(patient.id)).assessments).toBe(1)
    })

    it('accepts a past day — measurements typed in later', async () => {
      const patient = await newPatient()
      expect(
        (
          await record(practitionerA, {
            patientId: patient.id,
            measuredOn: '2026-01-15',
          })
        ).status,
      ).toBe(201)
    })

    it('needs a real calendar day', async () => {
      const patient = await newPatient()
      for (const measuredOn of [
        '2026-02-30',
        '2026-10-31T10:00:00Z',
        'yesterday',
      ]) {
        const res = await record(practitionerA, {
          patientId: patient.id,
          measuredOn,
        })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual([
          'measuredOn must be a date written as YYYY-MM-DD',
        ])
      }
    })
  })

  // === 5. THE LINK TO A NOTE =================================================

  describe('linking the visit note', () => {
    it("links a note of the patient's file", async () => {
      const patient = await newPatient()
      const note = await addNote(practitionerA, patient.id)
      const res = await record(practitionerA, {
        patientId: patient.id,
        medicalFileEntryId: note,
      })
      expect(res.status).toBe(201)
      expect(res.body.medicalFileEntryId).toBe(note)
    })

    it("refuses another patient's note, or one that doesn't exist — the composite key", async () => {
      const patient = await newPatient()
      const other = await newPatient()
      const theirs = await addNote(practitionerA, other.id)
      for (const medicalFileEntryId of [theirs, 999_999]) {
        const res = await record(practitionerA, {
          patientId: patient.id,
          medicalFileEntryId,
        })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual([NOTE_UNKNOWN])
      }
      expect((await stored(patient.id)).assessments).toBe(0)
    })
  })

  // === 6. AMENDING ===========================================================

  describe('amending an assessment', () => {
    it('stores the correction, and marks the original as amended', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const original = await addAssessment(practitionerA, patient.id)
      // A colleague corrects it — a complete new version, its own values.
      const res = await record(practitionerC, {
        patientId: patient.id,
        amendsId: original,
        amendmentReason: 'Right knee flexion was misread',
        measurements: [{ ...KNEE, degrees: 98 }],
      })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        amendsId: original,
        amendmentReason: 'Right knee flexion was misread',
        amendedById: null,
        author: { id: practitionerCId },
      })
      const old = await practitionerA.get(`/range-of-motion/${original}`)
      expect(old.body.amendedById).toBe(res.body.id)
      // The original keeps its own value: nothing was changed.
      expect(old.body.measurements[0].degrees).toBe(95)
    })

    it('refuses a second amendment of the same version (409), and lets the chain grow from its end', async () => {
      const patient = await newPatient()
      const original = await addAssessment(practitionerA, patient.id)
      const first = await addAssessment(practitionerA, patient.id, {
        amendsId: original,
        amendmentReason: 'First',
      })
      const again = await record(practitionerA, {
        patientId: patient.id,
        amendsId: original,
        amendmentReason: 'Again',
      })
      expect(again.status).toBe(409)
      expect(again.body.message).toEqual([ALREADY_AMENDED])
      expect(
        (
          await record(practitionerA, {
            patientId: patient.id,
            amendsId: first,
            amendmentReason: 'Second',
          })
        ).status,
      ).toBe(201)
    })

    it("refuses amending another patient's assessment, or one that doesn't exist", async () => {
      const patient = await newPatient()
      const other = await newPatient()
      const theirs = await addAssessment(practitionerA, other.id)
      for (const amendsId of [theirs, 999_999]) {
        const res = await record(practitionerA, {
          patientId: patient.id,
          amendsId,
          amendmentReason: 'Typo',
        })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual([AMENDS_UNKNOWN])
      }
    })

    it('needs a reason with amendsId, and none without (the shared rule)', async () => {
      const patient = await newPatient()
      const original = await addAssessment(practitionerA, patient.id)
      const noReason = await record(practitionerA, {
        patientId: patient.id,
        amendsId: original,
      })
      expect(noReason.status).toBe(400)
      expect(noReason.body.message).toEqual(['An amendment needs a reason'])
      const stray = await record(practitionerA, {
        patientId: patient.id,
        amendmentReason: 'Why?',
      })
      expect(stray.status).toBe(400)
      expect(stray.body.message).toEqual([
        'Only an amendment (an assessment with amendsId) has an amendment reason',
      ])
    })

    // Two practitioners amending the same assessment at the same moment: the
    // colleague's amendment (with its measurement — it must be complete to
    // commit) is written but NOT committed when Alex's arrives. Alex's insert
    // waits on the unique index, then — once the other commits — is refused.
    it('lets only one of two simultaneous amendments win', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const original = await addAssessment(practitionerA, patient.id)
      const { waited, res } = await whileHolding(
        practitionerCId,
        [
          [
            `INSERT INTO rom_assessments (patient_id, created_by, measured_on, amends_id, amendment_reason)
             VALUES ($1, $2, $3, $4, 'Casey''s correction')`,
            [patient.id, practitionerCId, today, original],
          ],
          [
            `INSERT INTO rom_measurements (assessment_id, movement, side, mode, degrees)
             SELECT id, 'knee_flexion', 'right', 'active', 97 FROM rom_assessments WHERE amends_id = $1`,
            [original],
          ],
        ],
        () =>
          record(practitionerA, {
            patientId: patient.id,
            amendsId: original,
            amendmentReason: "Alex's correction",
          }),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([ALREADY_AMENDED])
      expect(await stored(patient.id)).toEqual({
        assessments: 2,
        measurements: 2,
      })
    })
  })

  // === 7. WHEN THE CARE TEAM CHANGES =========================================

  describe('the care team and the account', () => {
    it('a practitioner who leaves loses the record; the patient keeps it, by name', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const byCasey = await addAssessment(practitionerC, patient.id)
      expect(
        (
          await admin
            .post(`/users/${patient.id}/care-team/${practitionerCId}/end`)
            .send({})
        ).status,
      ).toBe(201)

      expect(
        (
          await practitionerC
            .get('/range-of-motion')
            .query({ patientId: patient.id })
        ).status,
      ).toBe(403)
      expect(
        (await practitionerC.get(`/range-of-motion/${byCasey}`)).status,
      ).toBe(404)
      const write = await record(practitionerC, { patientId: patient.id })
      expect(write.status).toBe(403)
      expect(write.body.message).toEqual([NOT_ON_TEAM_WRITE])

      const mine = await patient.agent.get(`/range-of-motion/${byCasey}`)
      expect(mine.status).toBe(200)
      expect(mine.body.author).toEqual({
        id: practitionerCId,
        firstName: 'Casey',
        lastName: 'Ruiz',
      })
    })

    // Decisions §22: deactivating blocks a sign-in, it isn't a discharge —
    // the care team may still write to the RECORD (a note, a measurement),
    // as for the medical file.
    it('still records for a deactivated patient', async () => {
      const patient = await newPatient()
      expect((await admin.delete(`/users/${patient.id}`)).status).toBe(200)
      expect(
        (await record(practitionerA, { patientId: patient.id })).status,
      ).toBe(201)
    })
  })

  // === 8. THE DATABASE'S OWN RULES ===========================================

  // Tried directly as the app's role, without the API — what holds for ANY
  // query, including one a future route might get wrong.
  describe('the database', () => {
    let patientId: number
    let assessmentId: number

    beforeAll(async () => {
      patientId = (await newPatient()).id
      assessmentId = await addAssessment(practitionerA, patientId)
    })

    // An assessment recorded IN the statement's own transaction, then a
    // measurement for it (the newest of this patient's — the one just
    // inserted): the measurements' policy lets exactly that through.
    const newAssessment = () =>
      sql`INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES (${patientId}, ${practitionerAId}, ${today})`
    const measurementOfNew = (values: SQL) =>
      sql`INSERT INTO rom_measurements (assessment_id, movement, side, mode, degrees, note)
          SELECT max(id), ${values} FROM rom_assessments WHERE patient_id = ${patientId}`

    it('hides every assessment and measurement from an admin — 0 rows', async () => {
      const adminRow = await sessionPool.query<{ id: number }>(
        `SELECT id FROM users WHERE email = $1`,
        [`admin-${stamp}@example.com`],
      )
      for (const table of [sql`rom_assessments`, sql`rom_measurements`]) {
        const res = await asActor(
          adminRow.rows[0].id,
          'admin',
          sql`SELECT count(*)::int AS n FROM ${table}`,
        )
        expect(res).toStrictEqual({ rows: [{ n: 0 }] })
      }
    })

    it('refuses an assessment by a patient, or recorded as someone else', async () => {
      const asPatient = await asActor(
        patientId,
        'patient',
        sql`INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES (${patientId}, ${patientId}, ${today})`,
      )
      expect(asPatient).toStrictEqual({ error: { code: '42501' } })
      const forged = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES (${patientId}, ${practitionerCId}, ${today})`,
      )
      expect(forged).toStrictEqual({ error: { code: '42501' } })
    })

    // The assessment's OWN insert policy. Through the API, an outsider is also
    // stopped one step later — the measurements' policy can't see an
    // assessment of a patient off their care team — so the API's 403 can't
    // tell which layer refused (a mutation removing this policy's care-team
    // test survived it). The assessment alone, here, meets only this one.
    it('refuses an assessment off the care team — its own insert policy', async () => {
      const res = await asActor(
        outsiderId,
        'practitioner',
        sql`INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES (${patientId}, ${outsiderId}, ${today})`,
      )
      expect(res).toStrictEqual({ error: { code: '42501' } })
    })

    it('changes and removes nothing — no UPDATE or DELETE policy', async () => {
      for (const statement of [
        sql`UPDATE rom_assessments SET measured_on = '2026-01-01' WHERE id = ${assessmentId} RETURNING id`,
        sql`DELETE FROM rom_assessments WHERE id = ${assessmentId} RETURNING id`,
        sql`UPDATE rom_measurements SET degrees = 120 WHERE assessment_id = ${assessmentId} RETURNING id`,
        sql`DELETE FROM rom_measurements WHERE assessment_id = ${assessmentId} RETURNING id`,
      ]) {
        expect(
          await asActor(practitionerAId, 'practitioner', statement),
        ).toStrictEqual({ rows: [] })
      }
    })

    // The measurements' insert policy: only into an assessment recorded in
    // the SAME transaction, by its author. A committed one is closed.
    it('refuses a measurement added to an assessment already recorded — even by its author', async () => {
      const res = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO rom_measurements (assessment_id, movement, side, mode, degrees)
            VALUES (${assessmentId}, 'knee_flexion', 'left', 'active', 120)`,
      )
      expect(res).toStrictEqual({ error: { code: '42501' } })
    })

    it("refuses a colleague adding to another's assessment in the same transaction", async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const res = await committing(practitionerAId, 'practitioner', [
        [
          `INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES ($1, $2, $3)`,
          [patient.id, practitionerAId, today],
        ],
        // Casey's context, in Alex's transaction: same now(), another author.
        [
          "SELECT set_config('app.current_user_id', $1, true)",
          [String(practitionerCId)],
        ],
        [
          `INSERT INTO rom_measurements (assessment_id, movement, side, mode, degrees)
           SELECT id, 'knee_flexion', 'left', 'active', 120 FROM rom_assessments WHERE patient_id = $1`,
          [patient.id],
        ],
      ])
      expect(res).toStrictEqual({ code: '42501' })
    })

    it('refuses committing an assessment with no measurement — at COMMIT', async () => {
      const patient = await newPatient()
      const res = await committing(practitionerAId, 'practitioner', [
        [
          `INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES ($1, $2, $3)`,
          [patient.id, practitionerAId, today],
        ],
      ])
      expect(res).toStrictEqual({
        code: '23514',
        constraint: 'rom_assessments_has_measurements',
      })
      expect((await stored(patient.id)).assessments).toBe(0)
      // With one, the same transaction commits.
      expect(
        await committing(practitionerAId, 'practitioner', [
          [
            `INSERT INTO rom_assessments (patient_id, created_by, measured_on) VALUES ($1, $2, $3)`,
            [patient.id, practitionerAId, today],
          ],
          [
            `INSERT INTO rom_measurements (assessment_id, movement, side, mode, degrees)
             SELECT id, 'knee_flexion', 'left', 'active', 120 FROM rom_assessments WHERE patient_id = $1`,
            [patient.id],
          ],
        ]),
      ).toBeNull()
    })

    // Inputs the DTO refuses first, so only the CHECKs judge them here.
    it.each<[string, SQL, string]>([
      [
        'a sided movement with no side',
        sql`'knee_flexion'::rom_movement, NULL::rom_side, 'active'::rom_mode, 95, NULL`,
        'rom_measurements_side_matches_movement',
      ],
      [
        'a side on neck flexion',
        sql`'cervical_flexion'::rom_movement, 'left'::rom_side, 'active'::rom_mode, 40, NULL`,
        'rom_measurements_side_matches_movement',
      ],
      [
        'knee extension of 21°',
        sql`'knee_extension'::rom_movement, 'left'::rom_side, 'active'::rom_mode, 21, NULL`,
        'rom_measurements_degrees_plausible',
      ],
      [
        'knee flexion of -91°',
        sql`'knee_flexion'::rom_movement, 'left'::rom_side, 'active'::rom_mode, -91, NULL`,
        'rom_measurements_degrees_plausible',
      ],
      [
        'a blank note',
        sql`'knee_flexion'::rom_movement, 'left'::rom_side, 'active'::rom_mode, 95, ' '`,
        'rom_measurements_note_valid',
      ],
    ])('refuses %s — the CHECK', async (_label, values, constraint) => {
      const res = await asActor(
        practitionerAId,
        'practitioner',
        newAssessment(),
        measurementOfNew(values),
      )
      expect(res).toStrictEqual({ error: { code: '23514', constraint } })
    })

    it('accepts the plausible bounds exactly', async () => {
      const res = await asActor(
        practitionerAId,
        'practitioner',
        newAssessment(),
        measurementOfNew(
          sql`'knee_extension'::rom_movement, 'left'::rom_side, 'active'::rom_mode, 20, NULL`,
        ),
        measurementOfNew(
          sql`'knee_extension'::rom_movement, 'right'::rom_side, 'active'::rom_mode, -90, NULL`,
        ),
        sql`SELECT 1 AS ok`,
      )
      expect(res).toStrictEqual({ rows: [{ ok: 1 }] })
    })

    it("writes the database's own moment, whatever the client sends", async () => {
      const res = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO rom_assessments (patient_id, created_by, measured_on, created_at)
            VALUES (${patientId}, ${practitionerAId}, ${today}, '2020-01-01T00:00:00Z')
            RETURNING created_at = now() AS stamped_now`,
      )
      expect(res).toStrictEqual({ rows: [{ stamped_now: true }] })
    })

    // The CHECK compares with created_at — the database's clock, set by the
    // trigger before the CHECK runs. A forged created_at in the far future
    // can't make a future day acceptable.
    it('refuses a future day even with a forged moment', async () => {
      const res = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO rom_assessments (patient_id, created_by, measured_on, created_at)
            VALUES (${patientId}, ${practitionerAId}, ${addDays(today, 5)}, '2099-01-01T00:00:00Z')`,
      )
      expect(res).toStrictEqual({
        error: {
          code: '23514',
          constraint: 'rom_assessments_measured_by_recording',
        },
      })
    })
  })

  // === 9. THE AUDIT TRAIL ====================================================

  describe('the audit trail', () => {
    it('records an assessment once — the day, the count, the note — and no generic entry', async () => {
      const patient = await newPatient()
      const note = await addNote(practitionerA, patient.id)
      const res = await record(practitionerA, {
        patientId: patient.id,
        medicalFileEntryId: note,
        measurements: [KNEE, { ...KNEE, side: 'left' }],
      })
      expect(res.status).toBe(201)
      expect(await auditAbout(patient.id)).toStrictEqual([
        {
          action: 'ROM_ASSESSMENT_RECORDED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'rom_assessments',
          entity_id: res.body.id,
          details: {
            measuredOn: today,
            createdAt: res.body.createdAt,
            measurementCount: 2,
            medicalFileEntryId: note,
          },
        },
      ])
    })

    it('records an amendment as ROM_ASSESSMENT_AMENDED, naming the original', async () => {
      const patient = await newPatient()
      const original = await addAssessment(practitionerA, patient.id)
      const res = await record(practitionerA, {
        patientId: patient.id,
        amendsId: original,
        amendmentReason: 'Typo',
      })
      const [, amended] = await auditAbout(patient.id)
      expect(amended).toStrictEqual({
        action: 'ROM_ASSESSMENT_AMENDED',
        performed_by: practitionerAId,
        target_user_id: patient.id,
        entity_type: 'rom_assessments',
        entity_id: res.body.id,
        details: {
          measuredOn: today,
          createdAt: res.body.createdAt,
          measurementCount: 1,
          amendsId: original,
        },
      })
    })

    it('records nothing for a refused write', async () => {
      const patient = await newPatient()
      await record(outsider, { patientId: patient.id })
      await record(practitionerA, {
        patientId: patient.id,
        measuredOn: addDays(today, 2),
      })
      await record(practitionerA, {
        patientId: patient.id,
        measurements: [KNEE, KNEE],
      })
      expect(await auditAbout(patient.id)).toStrictEqual([])
    })

    it('records each read — the patient’s own included: the list with its ids, and one assessment', async () => {
      const patient = await newPatient()
      const older = await addAssessment(practitionerA, patient.id, {
        measuredOn: addDays(today, -2),
      })
      const newer = await addAssessment(practitionerA, patient.id)
      await practitionerA
        .get('/range-of-motion')
        .query({ patientId: patient.id })
      await patient.agent.get(`/range-of-motion/${older}`)

      const reads = (await auditAbout(patient.id)).slice(2)
      expect(reads).toStrictEqual([
        {
          action: 'ROM_VIEWED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'rom_assessments',
          entity_id: null,
          details: { assessmentIds: [newer, older] },
        },
        {
          action: 'ROM_ASSESSMENT_VIEWED',
          performed_by: patient.id,
          target_user_id: patient.id,
          entity_type: 'rom_assessments',
          entity_id: older,
          details: null,
        },
      ])
    })

    it('records no read that was refused, and none for the catalogue', async () => {
      const patient = await newPatient()
      const id = await addAssessment(practitionerA, patient.id)
      await outsider.get('/range-of-motion').query({ patientId: patient.id })
      await outsider.get(`/range-of-motion/${id}`)
      await practitionerA.get('/range-of-motion/movements')
      expect(
        (await auditAbout(patient.id)).map((entry) => entry.action),
      ).toEqual(['ROM_ASSESSMENT_RECORDED'])
    })
  })
})
