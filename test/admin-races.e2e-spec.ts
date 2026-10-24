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
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// Two admin writes that used to READ before inserting (Phase 6, privacy and
// security pass 2 — decisions §16): granting a role ("already has it?") and
// adding a clinic member ("already a member?"). Two requests at once could
// both read "no"; the second then hit the UNIQUE constraint as a 500. Now
// the constraint alone decides, and its refusal is the 409.
//
// "At once" made deterministic (whileHolding, as in sessions.e2e-spec.ts):
// another connection holds an UNCOMMITTED insert of the same row. The
// request can't see it — a read first would say "no" — and its own INSERT
// waits on the unique index until that transaction ends. The commit then
// makes the request's insert a duplicate. `waited` proves the request really
// was held there, so the test can't pass without the race happening.
describe('Admin write races (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let clinicId: number
  const stamp = Date.now()
  let counter = 0

  // A fresh patient (pending invitation — enough to be granted a role or
  // added to a clinic), its id.
  async function newPatient() {
    counter += 1
    const res = await admin.post('/users').send({
      email: `race-${counter}-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Pat',
      lastName: 'Ient',
      dateOfBirth: '1980-02-03',
      clinicId,
    })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  // An uncommitted write held open on another connection while `send` runs;
  // committed after 300 ms.
  async function whileHolding(
    statement: string,
    params: unknown[],
    send: () => PromiseLike<request.Response>,
  ) {
    const client = await sessionPool.connect()
    try {
      await client.query('BEGIN')
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

  async function countRows(statement: string, params: unknown[]) {
    const { rows } = await sessionPool.query<{ n: number }>(statement, params)
    return rows[0].n
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
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Race Clinic',
      clinicEmail: `race-clinic-${stamp}@example.com`,
      email: `race-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicId = bootstrap.body.clinicId as number
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  it('answers 409, not 500, to a role granted at the same moment by someone else', async () => {
    const patientId = await newPatient()

    const { waited, res } = await whileHolding(
      "INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')",
      [patientId],
      () => admin.post(`/users/${patientId}/roles`).send({ role: 'admin' }),
    )

    expect(waited).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body.message).toEqual(['User already has the "admin" role'])
    // One role row (the other transaction's), no profile and no entry from
    // the refused request.
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND role = 'admin'",
        [patientId],
      ),
    ).toBe(1)
    expect(
      await countRows(
        'SELECT count(*)::int AS n FROM admin_profiles WHERE user_id = $1',
        [patientId],
      ),
    ).toBe(0)
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_user_id = $1 AND action = 'USER_ROLE_GRANTED'",
        [patientId],
      ),
    ).toBe(0)
  })

  // The plain case still answers the same 409 — now from the constraint.
  it('refuses a role the account already has', async () => {
    const patientId = await newPatient()

    const res = await admin
      .post(`/users/${patientId}/roles`)
      .send({ role: 'patient', dateOfBirth: '1980-02-03' })

    expect(res.status).toBe(409)
    expect(res.body.message).toEqual(['User already has the "patient" role'])
  })

  it('answers 409, not 500, to a member added at the same moment by someone else', async () => {
    const patientId = await newPatient()
    const second = await admin.post('/clinics').send({
      name: 'Second Clinic',
      email: `race-second-${stamp}@example.com`,
    })
    expect(second.status).toBe(201)
    const secondId = second.body.id as number

    const { waited, res } = await whileHolding(
      'INSERT INTO user_clinics (user_id, clinic_id) VALUES ($1, $2)',
      [patientId, secondId],
      () =>
        admin.post(`/clinics/${secondId}/members`).send({ userId: patientId }),
    )

    expect(waited).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body.message).toEqual([
      'This user already belongs to this clinic',
    ])
    expect(
      await countRows(
        'SELECT count(*)::int AS n FROM user_clinics WHERE user_id = $1 AND clinic_id = $2',
        [patientId, secondId],
      ),
    ).toBe(1)
    expect(
      await countRows(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_user_id = $1 AND action = 'CLINIC_MEMBER_ADDED'",
        [patientId],
      ),
    ).toBe(0)
  })

  it('refuses a member the clinic already has', async () => {
    const patientId = await newPatient()

    const res = await admin
      .post(`/clinics/${clinicId}/members`)
      .send({ userId: patientId })

    expect(res.status).toBe(409)
    expect(res.body.message).toEqual([
      'This user already belongs to this clinic',
    ])
  })
})
