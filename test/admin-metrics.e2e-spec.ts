import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount, TEST_PASSWORD } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { metricsQuery } from '../src/admin-metrics/admin-metrics.service'

// GET /admin/metrics — the admin home's numbers (Phase 6, decisions §17).
//
// One dataset, built so that each rule in the statement changes the answer
// if it's removed: every account below is there to be counted by one rule
// and left out by its neighbour. The test compares the WHOLE answer with
// toStrictEqual, so a number off by one anywhere, a name too many in a
// list, or a list in another order fails it.
//
// The list is cut at 5 BETWEEN the two Moreaus (5th and 6th by name), and
// Ivy was created before Hal: sorted by last name and id instead of last
// name and FIRST name, Ivy would make the list and Hal wouldn't.
//
// Clinics: Main (active) and Old (deactivated).
// Practitioners: Paula Shaw (Main) · Quinn Ford (Old only) · Rory Diaz (no
//   clinic) · Dex Hale (Main, deactivated) · Eve Cole (no clinic,
//   deactivated).
// Patients (all in Main, except Gus):
//   Pia Quinlan — Paula, a current link              → has a care team
//   Ned Zimmer  — no link (invitation pending)        → needs one
//   Ola Young   — Paula, a link that ENDED yesterday  → needs one
//   Fay Baker   — Dex, current — but Dex is deactivated → needs one
//   Gus Adams   — Paula, current, but no clinic shared any more → needs one
//   Ivy Moreau  — no link                             → needs one
//   Hal Moreau  — Paula, a link STARTING tomorrow     → needs one
//   Kim Lee     — no link                             → needs one
//   Joe Kent    — no link                             → needs one
//   Zed Ward    — no link, deactivated (invitation still open) → not listed
// Invitations: every account is activated (accepted) except Ned (pending),
//   Ola (expired), Hal (revoked) and Zed (pending, account deactivated) —
//   so exactly ONE can still be accepted.
describe('Admin metrics (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitioner: ReturnType<typeof agent>
  const stamp = Date.now()
  const ids: Record<string, number> = {}

  // Creates an account through the API as the admin — the real path, with
  // its invitation — and returns its id. `activate`: as if the invitation
  // had been accepted (test/support/accounts.ts).
  async function newUser(
    key: string,
    firstName: string,
    lastName: string,
    role: 'practitioner' | 'patient',
    clinicId: number,
    activate: boolean,
  ) {
    const email = `metrics-${key}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role,
      firstName,
      lastName,
      clinicId,
      ...(role === 'patient'
        ? { dateOfBirth: '1980-02-03' }
        : { licenseNumber: `LIC-${key}` }),
    })
    expect(res.status).toBe(201)
    ids[key] = res.body.id as number
    if (activate) await activateAccount(sessionPool, email)
    return email
  }

  // A care-team link written as the owner (test set-up, not under test), so
  // its period can be put anywhere in time.
  async function link(
    patient: string,
    practitionerKey: string,
    startedAt: string,
    endsAt: string | null,
  ) {
    await sessionPool.query(
      `INSERT INTO care_team_members (patient_id, practitioner_id, started_at, ends_at, created_by)
       VALUES ($1, $2, ${startedAt}, ${endsAt ?? 'NULL'}, $3)`,
      [ids[patient], ids[practitionerKey], ids.admin],
    )
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
      clinicName: 'Main Clinic',
      clinicEmail: `metrics-main-${stamp}@example.com`,
      email: `metrics-admin-${stamp}@example.com`,
      password: TEST_PASSWORD,
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    const mainId = bootstrap.body.clinicId as number
    ids.admin = bootstrap.body.id as number

    const old = await admin.post('/clinics').send({
      name: 'Old Clinic',
      email: `metrics-old-${stamp}@example.com`,
    })
    expect(old.status).toBe(201)
    const oldId = old.body.id as number

    // Practitioners. Quinn is created before Rory, so their ids are in the
    // opposite order to their names (Diaz < Ford).
    const paulaEmail = await newUser(
      'paula',
      'Paula',
      'Shaw',
      'practitioner',
      mainId,
      true,
    )
    await newUser('quinn', 'Quinn', 'Ford', 'practitioner', oldId, true)
    await newUser('rory', 'Rory', 'Diaz', 'practitioner', mainId, true)
    await newUser('dex', 'Dex', 'Hale', 'practitioner', mainId, true)
    await newUser('eve', 'Eve', 'Cole', 'practitioner', mainId, true)

    // Patients — created in an order that is NOT their name order, so a
    // list sorted by id instead of by name comes out differently.
    await newUser('pia', 'Pia', 'Quinlan', 'patient', mainId, true)
    await newUser('ned', 'Ned', 'Zimmer', 'patient', mainId, false)
    await newUser('ola', 'Ola', 'Young', 'patient', mainId, false)
    await newUser('fay', 'Fay', 'Baker', 'patient', mainId, true)
    await newUser('gus', 'Gus', 'Adams', 'patient', mainId, true)
    await newUser('ivy', 'Ivy', 'Moreau', 'patient', mainId, true)
    await newUser('hal', 'Hal', 'Moreau', 'patient', mainId, false)
    await newUser('kim', 'Kim', 'Lee', 'patient', mainId, true)
    await newUser('joe', 'Joe', 'Kent', 'patient', mainId, true)
    await newUser('zed', 'Zed', 'Ward', 'patient', mainId, false)

    // Care-team links.
    await link('pia', 'paula', 'now()', null)
    await link(
      'ola',
      'paula',
      "now() - interval '10 days'",
      "now() - interval '1 day'",
    )
    await link('fay', 'dex', 'now()', null)
    await link('gus', 'paula', 'now()', null)
    await link('hal', 'paula', "now() + interval '1 day'", null)

    // Memberships changed as the owner, so nothing else follows (the API's
    // member removal would also END Gus's link — here it must stay current
    // and fail only on the shared clinic).
    await sessionPool.query(
      'DELETE FROM user_clinics WHERE user_id = ANY($1)',
      [[ids.gus, ids.rory, ids.eve]],
    )

    // Invitations: Ola's expired, Hal's revoked (the owner again — the
    // timestamps are the state).
    await sessionPool.query(
      `UPDATE invitations SET created_at = now() - interval '8 days',
                              expires_at = now() - interval '1 day'
        WHERE user_id = $1`,
      [ids.ola],
    )
    await sessionPool.query(
      'UPDATE invitations SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1',
      [ids.hal, ids.admin],
    )

    // Deactivations through the API, as an admin would.
    for (const key of ['dex', 'eve', 'zed']) {
      const res = await admin.delete(`/users/${ids[key]}`)
      expect(res.status).toBe(200)
    }
    const closed = await admin.delete(`/clinics/${oldId}`)
    expect(closed.status).toBe(200)

    practitioner = agent()
    const login = await practitioner
      .post('/auth/login')
      .send({ email: paulaEmail, password: TEST_PASSWORD })
    expect(login.status).toBe(201)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  it('counts accounts, clinics and pending invitations, and lists who needs attention', async () => {
    const res = await admin.get('/admin/metrics')

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      accounts: {
        admins: 1,
        practitioners: 3, // Paula, Quinn, Rory
        patients: 9, // Pia … Joe; not Zed
        deactivated: 3, // Dex, Eve, Zed
      },
      clinics: { active: 1, deactivated: 1 },
      pendingInvitations: 1, // Ned
      needsAttention: {
        // 8 in all, the first 5 by last name, then first name: Ivy Moreau,
        // Young and Zimmer are cut — Hal, not Ivy, is the 5th.
        patientsWithoutCareTeam: {
          total: 8,
          first: [
            { id: ids.gus, firstName: 'Gus', lastName: 'Adams' },
            { id: ids.fay, firstName: 'Fay', lastName: 'Baker' },
            { id: ids.joe, firstName: 'Joe', lastName: 'Kent' },
            { id: ids.kim, firstName: 'Kim', lastName: 'Lee' },
            { id: ids.hal, firstName: 'Hal', lastName: 'Moreau' },
          ],
        },
        // Rory (no clinic) and Quinn (a deactivated clinic only); not Eve
        // (deactivated herself).
        practitionersWithoutClinic: {
          total: 2,
          first: [
            { id: ids.rory, firstName: 'Rory', lastName: 'Diaz' },
            { id: ids.quinn, firstName: 'Quinn', lastName: 'Ford' },
          ],
        },
      },
    })
  })

  it('answers empty lists as [], not null', async () => {
    // Everyone placed: Rory and Quinn join Main for the length of this test.
    await sessionPool.query(
      'INSERT INTO user_clinics (user_id, clinic_id) SELECT unnest($1::int[]), id FROM clinics WHERE is_active',
      [[ids.rory, ids.quinn]],
    )
    try {
      const res = await admin.get('/admin/metrics')

      expect(res.status).toBe(200)
      expect(res.body.needsAttention.practitionersWithoutClinic).toStrictEqual({
        total: 0,
        first: [],
      })
    } finally {
      await sessionPool.query(
        'DELETE FROM user_clinics WHERE user_id = ANY($1) AND clinic_id IN (SELECT id FROM clinics WHERE is_active)',
        [[ids.rory, ids.quinn]],
      )
    }
  })

  // invitationStatus() calls an invitation expiring at this very instant
  // EXPIRED (expires_at <= now). A request can't land on that instant, so
  // it is built in ONE transaction, where now() is a single moment: as the
  // owner, Ned's invitation is set to expire "now"; then the same
  // transaction becomes the app's role with the admin's context — what
  // withRlsContext does for a request — and runs the route's own statement.
  // Rolled back: nothing changes for the other tests.
  it('counts an invitation expiring at this very instant as expired, as invitationStatus does', async () => {
    const client = await sessionPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'UPDATE invitations SET expires_at = now() WHERE user_id = $1',
        [ids.ned],
      )
      await client.query(
        `SET LOCAL ROLE ${process.env.POSTGRES_APP_USER ?? 'stride_app'}`,
      )
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'admin', true)",
        [String(ids.admin)],
      )
      const query = new PgDialect().sqlToQuery(metricsQuery())
      const { rows } = await client.query<{ pending_invitations: number }>(
        query.sql,
        query.params,
      )

      expect(rows[0].pending_invitations).toBe(0)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it("refuses a practitioner with the roles guard's message", async () => {
    const res = await practitioner.get('/admin/metrics')

    expect(res.status).toBe(403)
    expect(res.body.message).toEqual([
      'You do not have permission to access this resource',
    ])
  })

  it('refuses a request without a session', async () => {
    const res = await agent().get('/admin/metrics')

    expect(res.status).toBe(401)
    expect(res.body.message).toEqual([
      'You must be logged in to access this resource',
    ])
  })
})
