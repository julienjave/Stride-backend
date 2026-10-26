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
import { ATTENTION_ADMINS_ONLY_MESSAGE } from '../src/users/users.controller'

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
    // "Invitations to send again" (2026-10-25): an open invitation, expired
    // (Ola) or never emailed. Each account below fails exactly ONE of the
    // rule's other conditions with an unsent email — so dropping that
    // condition lists it: Hal's is revoked, Zed's account deactivated, Pia's
    // invitation accepted (and long expired too). Ned's went out: waiting.
    await sessionPool.query(
      'UPDATE invitations SET email_sent_at = NULL WHERE user_id = ANY($1)',
      [[ids.hal, ids.zed, ids.pia]],
    )
    await sessionPool.query(
      `UPDATE invitations SET created_at = now() - interval '8 days',
                              expires_at = now() - interval '1 day'
        WHERE user_id = $1`,
      [ids.pia],
    )

    // Dex is deactivated as the OWNER, not through the API: since
    // 2026-10-25 an API deactivation ends a practitioner's links, so Fay
    // would simply have none — and nothing would prove the statement's
    // `p.is_active` any more. A direct UPDATE stands for an account
    // deactivated before that change (its links never ended), which the
    // metrics must still not count as care.
    await sessionPool.query(
      'UPDATE users SET is_active = false WHERE id = $1',
      [ids.dex],
    )
    // The others through the API, as an admin would.
    for (const key of ['eve', 'zed']) {
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
        // Ola (expired); not Ned (sent, still waiting), Hal (revoked), Zed
        // (deactivated) or Pia (accepted).
        invitationsToSendAgain: {
          total: 1,
          first: [{ id: ids.ola, firstName: 'Ola', lastName: 'Young' }],
        },
      },
    })
  })

  // An invitation whose email couldn't be sent is still valid — counted as
  // waiting — but the person never got the link: listed too.
  it('lists a pending invitation whose email was never sent, and still counts it as waiting', async () => {
    await sessionPool.query(
      'UPDATE invitations SET email_sent_at = NULL WHERE user_id = $1',
      [ids.ned],
    )
    try {
      const res = await admin.get('/admin/metrics')

      expect(res.status).toBe(200)
      expect(res.body.pendingInvitations).toBe(1)
      expect(res.body.needsAttention.invitationsToSendAgain).toStrictEqual({
        total: 2,
        first: [
          { id: ids.ola, firstName: 'Ola', lastName: 'Young' },
          { id: ids.ned, firstName: 'Ned', lastName: 'Zimmer' },
        ],
      })
    } finally {
      await sessionPool.query(
        'UPDATE invitations SET email_sent_at = now() WHERE user_id = $1',
        [ids.ned],
      )
    }
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
      const { rows } = await client.query<{
        pending_invitations: number
        invitations_to_send_again_total: number
      }>(query.sql, query.params)

      expect(rows[0].pending_invitations).toBe(0)
      // ...and so one to send again, with Ola's: the two rules are each
      // other's complement at that instant.
      expect(rows[0].invitations_to_send_again_total).toBe(2)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  // GET /users?attention=… (decisions §17, the follow-up): the same rule as
  // the home's numbers, as a full list in the home's order.
  describe('the users list filtered by attention', () => {
    const idsOf = (res: request.Response) =>
      (res.body as { id: number }[]).map((user) => user.id)

    it('lists every patient without a care team, by last name, then first name', async () => {
      const res = await admin.get('/users?attention=patients-without-care-team')

      expect(res.status).toBe(200)
      expect(idsOf(res)).toEqual([
        ids.gus, // Adams
        ids.fay, // Baker
        ids.joe, // Kent
        ids.kim, // Lee
        ids.hal, // Moreau, Hal
        ids.ivy, // Moreau, Ivy
        ids.ola, // Young
        ids.ned, // Zimmer
      ])
      // The users list's own shape (roles included), never a password hash.
      const first = (res.body as Record<string, unknown>[])[0]
      expect(first.roles).toEqual(['patient'])
      expect(first).not.toHaveProperty('passwordHash')
    })

    it('lists every practitioner without an active clinic', async () => {
      const res = await admin.get(
        '/users?attention=practitioners-without-clinic',
      )

      expect(res.status).toBe(200)
      expect(idsOf(res)).toEqual([ids.rory, ids.quinn])
    })

    it('lists every account with an invitation to send again', async () => {
      const res = await admin.get('/users?attention=invitations-to-send-again')

      expect(res.status).toBe(200)
      expect(idsOf(res)).toEqual([ids.ola])
    })

    // The point of sharing the rule: the home's count and first names are
    // the list's length and its start, for every group.
    it('agrees with the home: as many accounts as its total, starting with its names', async () => {
      const metrics = await admin.get('/admin/metrics')
      const groups = [
        [
          'patients-without-care-team',
          metrics.body.needsAttention.patientsWithoutCareTeam,
        ],
        [
          'practitioners-without-clinic',
          metrics.body.needsAttention.practitionersWithoutClinic,
        ],
        [
          'invitations-to-send-again',
          metrics.body.needsAttention.invitationsToSendAgain,
        ],
      ] as const
      for (const [kind, group] of groups) {
        const list = await admin.get(`/users?attention=${kind}`)
        const listed = idsOf(list)
        expect(listed).toHaveLength((group as { total: number }).total)
        expect(listed.slice(0, 5)).toEqual(
          (group as { first: { id: number }[] }).first.map((a) => a.id),
        )
      }
    })

    it('refuses a value it does not know, naming the ones it does', async () => {
      const res = await admin.get('/users?attention=everyone')

      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'attention must be one of: patients-without-care-team, practitioners-without-clinic, invitations-to-send-again',
      ])
    })

    it('refuses a practitioner: their list means "my patients"', async () => {
      const res = await practitioner.get(
        '/users?attention=patients-without-care-team',
      )

      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([ATTENTION_ADMINS_ONLY_MESSAGE])
    })
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
