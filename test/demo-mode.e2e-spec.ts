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
import { activateAccount, TEST_PASSWORD } from './support/accounts'
import {
  DEMO_CARD_ACCOUNTS,
  DEMO_MFA_SECRET,
  DEMO_PASSWORD,
} from '../src/demo/demo-accounts'
import { demoLockedMessage } from '../src/demo/demo-lock.guard'

// Demo mode (decisions §46), through the real API and database: the card's
// answer on GET /auth/setup-status, and the four shared accounts LOCKED
// against the changes that would lock other reviewers out — while every
// other account keeps them.
//
// The shared accounts are created here with their published addresses
// (admin@, alex@, pat@ — casey@ isn't needed: the lock is by address, and
// pat@ covers the patient's routes). DEMO_MODE is read on every request, so
// each test sets it on process.env (and the last one switches it off).
describe('Demo mode (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let clinicId: number
  const stamp = Date.now()
  const ids: Record<string, number> = {}
  const emails: Record<string, string> = {}

  const before = {
    mode: process.env.DEMO_MODE,
    resetTime: process.env.DEMO_RESET_TIME,
    resetZone: process.env.DEMO_RESET_TIME_ZONE,
    guide: process.env.DEMO_GUIDE_URL,
  }
  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  // An account through the API as the admin, activated as if its invitation
  // had been accepted. `email` given for the shared accounts.
  async function newUser(
    key: string,
    role: 'practitioner' | 'patient',
    email = `demo-${key}-${stamp}@example.com`,
  ) {
    const res = await admin.post('/users').send({
      email,
      role,
      firstName: key[0].toUpperCase() + key.slice(1),
      lastName: 'Test',
      clinicId,
      ...(role === 'patient'
        ? { dateOfBirth: '1980-02-03', allowPossibleDuplicate: true }
        : { licenseNumber: `DEMO-${key}-${stamp}` }),
    })
    expect(res.status).toBe(201)
    ids[key] = res.body.id as number
    emails[key] = email
    await activateAccount(sessionPool, email)
  }

  async function signedIn(key: string) {
    const who = agent()
    const res = await who
      .post('/auth/login')
      .send({ email: emails[key], password: TEST_PASSWORD })
    expect(res.status).toBe(201)
    return who
  }

  async function count(statement: string, params: unknown[]) {
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

    // The founding admin IS the shared admin@stride.test.
    admin = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Demo Clinic',
      clinicEmail: `demo-clinic-${stamp}@example.com`,
      email: 'admin@stride.test',
      password: TEST_PASSWORD,
      firstName: 'Avery',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicId = bootstrap.body.clinicId as number
    ids.admin = bootstrap.body.user?.id as number
    emails.admin = 'admin@stride.test'

    await newUser('alex', 'practitioner', 'alex@stride.test')
    await newUser('pat', 'patient', 'pat@stride.test')
    await newUser('robin', 'patient')
    await newUser('jo', 'patient')
    await newUser('dup', 'patient')
    await newUser('sam', 'practitioner')
  })

  beforeEach(() => {
    process.env.DEMO_MODE = 'on'
  })

  afterAll(async () => {
    restore('DEMO_MODE', before.mode)
    restore('DEMO_RESET_TIME', before.resetTime)
    restore('DEMO_RESET_TIME_ZONE', before.resetZone)
    restore('DEMO_GUIDE_URL', before.guide)
    await app.close()
    await sessionPool.end()
  })

  describe('the card, on GET /auth/setup-status', () => {
    it('lists the shared accounts, their password, the two-factor key and the texts — to a visitor without a session', async () => {
      process.env.DEMO_RESET_TIME = '04:00'
      process.env.DEMO_RESET_TIME_ZONE = 'America/Toronto'
      process.env.DEMO_GUIDE_URL = 'https://example.com/guide'
      const res = await request(app.getHttpServer()).get('/auth/setup-status')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        setupComplete: true,
        demo: {
          accounts: DEMO_CARD_ACCOUNTS,
          password: DEMO_PASSWORD,
          twoFactorKey: DEMO_MFA_SECRET,
          reset: { time: '04:00', timeZone: 'America/Toronto' },
          guideUrl: 'https://example.com/guide',
        },
      })
    })

    it('publishes nothing outside demo mode', async () => {
      process.env.DEMO_MODE = 'off'
      const res = await request(app.getHttpServer()).get('/auth/setup-status')
      expect(res.body).toEqual({ setupComplete: true, demo: null })
    })
  })

  // The account's OWN changes. Each request is otherwise valid (the right
  // password), so a 403 can only be the lock. Refused BEFORE the step-up: no
  // password checked, so no failed step-up recorded and the counter untouched
  // (5 in a row would sign the session out — decisions §16).
  describe("a shared account's own sign-in details", () => {
    const ownChanges: [string, string, object][] = [
      [
        'password',
        '/auth/password',
        { currentPassword: TEST_PASSWORD, newPassword: 'a-new-password-1' },
      ],
      [
        'email',
        '/auth/email-change',
        {
          newEmail: `elsewhere-${stamp}@example.com`,
          currentPassword: TEST_PASSWORD,
        },
      ],
      ['two_factor', '/auth/mfa/setup', { currentPassword: TEST_PASSWORD }],
      ['two_factor', '/auth/mfa/enable', { code: '123456' }],
      [
        'two_factor',
        '/auth/mfa/disable',
        { currentPassword: TEST_PASSWORD, code: '123456' },
      ],
      [
        'two_factor',
        '/auth/mfa/recovery-codes',
        { currentPassword: TEST_PASSWORD, code: '123456' },
      ],
    ]

    it.each(ownChanges)(
      'refuses %s for pat@ (POST %s), with nothing recorded',
      async (change, path, body) => {
        const pat = await signedIn('pat')
        const hashBefore = (
          await sessionPool.query<{ h: string }>(
            'SELECT password_hash AS h FROM users WHERE id = $1',
            [ids.pat],
          )
        ).rows[0].h

        const res = await pat.post(path).send(body)

        expect(res.status).toBe(403)
        expect(res.body.message).toEqual([
          demoLockedMessage(change as 'password'),
        ])
        const after = (
          await sessionPool.query<{
            h: string
            failures: number
            mfa: boolean
          }>(
            `SELECT password_hash AS h, step_up_failures AS failures, mfa_enabled AS mfa
               FROM users WHERE id = $1`,
            [ids.pat],
          )
        ).rows[0]
        expect(after).toEqual({ h: hashBefore, failures: 0, mfa: false })
        expect(
          await count(
            `SELECT count(*)::int AS n FROM audit_logs
              WHERE performed_by = $1 AND action IN ('STEP_UP_FAILED', 'PASSWORD_CHANGED', 'EMAIL_CHANGE_REQUESTED', 'MFA_SETUP_STARTED')`,
            [ids.pat],
          ),
        ).toBe(0)
      },
    )

    // The admin is a shared account too: its own password is locked.
    it("refuses admin@'s own password change", async () => {
      const res = await admin.post('/auth/password').send({
        currentPassword: TEST_PASSWORD,
        newPassword: 'a-new-password-1',
      })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([demoLockedMessage('password')])
    })

    // Any other account: the same requests do what they always did.
    it('lets any other account change its password and set up two-factor', async () => {
      const robin = await signedIn('robin')
      const setup = await robin
        .post('/auth/mfa/setup')
        .send({ currentPassword: TEST_PASSWORD })
      expect(setup.status).toBe(201)

      const change = await robin.post('/auth/password').send({
        currentPassword: TEST_PASSWORD,
        newPassword: 'a-new-password-1',
      })
      expect(change.status).toBe(204)
    })

    it('lets any other account ask for a new email address', async () => {
      const jo = await signedIn('jo')
      const res = await jo.post('/auth/email-change').send({
        newEmail: `jo-new-${stamp}@example.com`,
        currentPassword: TEST_PASSWORD,
      })
      expect(res.status).toBe(201)
    })
  })

  // Changes made TO an account by someone else: the account in the address.
  describe('changes to a shared account by an admin', () => {
    it('refuses deactivating alex@, and leaves him active', async () => {
      const res = await admin.delete(`/users/${ids.alex}`)
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([demoLockedMessage('deactivate')])
      expect(
        await count(
          'SELECT count(*)::int AS n FROM users WHERE id = $1 AND is_active',
          [ids.alex],
        ),
      ).toBe(1)
    })

    it('lets the admin deactivate any other account', async () => {
      const res = await admin.delete(`/users/${ids.sam}`)
      expect(res.status).toBe(200)
    })

    // A practitioner deactivating themselves: the address is still theirs.
    it('refuses alex@ deactivating his own account', async () => {
      const alex = await signedIn('alex')
      const res = await alex.delete(`/users/${ids.alex}`)
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([demoLockedMessage('deactivate')])
    })

    it("refuses resetting pat@'s two-factor sign-in, before the admin's password is checked", async () => {
      const res = await admin
        .post(`/users/${ids.pat}/mfa/reset`)
        .send({ currentPassword: 'not-the-password' })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([demoLockedMessage('two_factor')])
      expect(
        await count(
          "SELECT count(*)::int AS n FROM audit_logs WHERE performed_by = $1 AND action = 'STEP_UP_FAILED'",
          [ids.admin],
        ),
      ).toBe(0)
    })

    // Another account: the route's own answer (jo has no two-factor sign-in
    // to reset), never the demo's sentence.
    it("leaves another account's two-factor reset to the route", async () => {
      const res = await admin
        .post(`/users/${ids.jo}/mfa/reset`)
        .send({ currentPassword: TEST_PASSWORD })
      expect(res.body.message).not.toEqual([demoLockedMessage('two_factor')])
      expect(res.status).not.toBe(403)
    })

    it('refuses merging pat@ away into another account', async () => {
      const res = await admin
        .post(`/users/${ids.pat}/merge`)
        .send({ intoUserId: ids.dup, currentPassword: TEST_PASSWORD })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([demoLockedMessage('merge')])
    })

    // pat@ as the account KEPT: she can still sign in afterwards.
    it('lets another account be merged INTO pat@', async () => {
      const res = await admin
        .post(`/users/${ids.dup}/merge`)
        .send({ intoUserId: ids.pat, currentPassword: TEST_PASSWORD })
      expect(res.status).toBe(200)
      const pat = await signedIn('pat')
      expect((await pat.get('/auth/me')).status).toBe(200)
    })
  })

  // The lock exists only in demo mode: the same request, switched off, is
  // answered by the route — here its wrong-password 400.
  it("doesn't lock anything outside demo mode", async () => {
    process.env.DEMO_MODE = 'off'
    const pat = await signedIn('pat')
    const res = await pat
      .post('/auth/password')
      .send({ currentPassword: 'not-the-password', newPassword: 'whatever-1' })
    expect(res.status).toBe(400)
    expect(res.body.message).not.toEqual([demoLockedMessage('password')])
  })
})
