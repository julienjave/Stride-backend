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
import { MessagingEvents } from '../src/messaging/messaging-events'
import { encryptMfaSecret } from '../src/auth/mfa-secret-crypto'
import { WRONG_PASSWORD_MESSAGE } from '../src/common/current-password'
import {
  MFA_CODE_REQUIRED_MESSAGE,
  STEP_UP_SIGNED_OUT_MESSAGE,
} from '../src/mfa/step-up.service'
import { INVALID_RECOVERY_CODE_MESSAGE } from '../src/mfa/second-factor'
import { SAME_EMAIL_MESSAGE } from '../src/email-change/email-change.service'
import { newMfaSecret } from '../src/mfa/totp'

// Failed step-ups (Phase 6, privacy and security pass 2 — decided with the
// person 2026-10-23, decisions §16). A change that could hand the account to
// someone else asks for the current password again (and a two-factor code
// when MFA is on). What these tests hold the code to:
//   - each WRONG proof is recorded: ONE STEP_UP_FAILED entry, with which
//     change was tried, why it failed and the failures in a row — written
//     although the refused change itself rolled back;
//   - the refusal the client sees is unchanged (the same 400, same words);
//   - the failures are counted per account, back to 0 when a step-up
//     passes; a refusal that isn't a wrong proof is neither counted nor
//     recorded;
//   - the 5th in a row signs THAT session out (401, its socket closed, the
//     owner emailed); the account's other sessions stay; the count restarts.
describe('Failed step-ups (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let outbox: InMemoryEmailTransport

  const agent = () => request.agent(app.getHttpServer())
  type Agent = ReturnType<typeof agent>
  let admin: Agent
  let adminId: number
  let clinicId: number
  const stamp = Date.now()
  let counter = 0

  // --- Accounts -------------------------------------------------------------

  function signIn(who: Agent, email: string) {
    return who.post('/auth/login').send({ email, password: 'password123' })
  }

  // A fresh, activated patient — each test its own — signed in on one agent.
  async function newPerson() {
    counter += 1
    const email = `su-${counter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Pat',
      lastName: 'Ient',
      dateOfBirth: '1980-02-03',
      clinicId,
    })
    expect(res.status).toBe(201)
    const id = await activateAccount(sessionPool, email)
    const signedIn = agent()
    expect((await signIn(signedIn, email)).status).toBe(201)
    return { id, email, signedIn }
  }

  // Two-factor sign-in ON, as the owner (exempt from row security): what
  // turning it on through the app stores, without the codes the app's way
  // needs. These tests only send WRONG second factors, so the secret is
  // never used to compute one.
  async function withMfaOn(userId: number) {
    await sessionPool.query(
      'UPDATE users SET mfa_enabled = true, mfa_secret = $2 WHERE id = $1',
      [userId, encryptMfaSecret(newMfaSecret())],
    )
  }

  // --- Reading as the owner (no row security) -------------------------------

  async function failuresOf(userId: number) {
    const { rows } = await sessionPool.query<{ step_up_failures: number }>(
      'SELECT step_up_failures FROM users WHERE id = $1',
      [userId],
    )
    return rows[0].step_up_failures
  }

  interface AuditRow {
    performed_by: number
    target_user_id: number
    entity_type: string
    entity_id: number
    details: Record<string, unknown>
  }

  // Every STEP_UP_FAILED entry an account made, oldest first.
  async function failureEntries(performedBy: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT performed_by, target_user_id, entity_type,
              entity_id::int AS entity_id, details
         FROM audit_logs
        WHERE performed_by = $1 AND action = 'STEP_UP_FAILED'
        ORDER BY id`,
      [performedBy],
    )
    return rows
  }

  // The account's session ids — sorted here (the database's order depends on
  // its collation; see password-change.e2e-spec.ts).
  async function sessionsOf(userId: number) {
    const { rows } = await sessionPool.query<{ sid: string }>(
      `SELECT sid FROM session
        WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
      [String(userId)],
    )
    return rows.map((row) => row.sid).sort()
  }

  // The sockets closed while `send` runs (MessagingEvents.disconnectSession
  // is how every sign-out closes one).
  async function closingSockets(send: () => PromiseLike<request.Response>) {
    const disconnect = jest.spyOn(app.get(MessagingEvents), 'disconnectSession')
    try {
      const res = await send()
      return { res, closed: disconnect.mock.calls.map(([sid]) => sid).sort() }
    } finally {
      disconnect.mockRestore()
    }
  }

  // An entry as these tests expect it: about the account itself.
  function entry(userId: number, details: Record<string, unknown>) {
    return {
      performed_by: userId,
      target_user_id: userId,
      entity_type: 'users',
      entity_id: userId,
      details,
    }
  }

  beforeAll(async () => {
    outbox = new InMemoryEmailTransport()
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue(outbox)
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
    // The session table outlives the TRUNCATE, and user ids restart: an
    // earlier suite's sessions would belong to this suite's accounts.
    await sessionPool.query('DELETE FROM session')

    admin = agent()
    const adminEmail = `su-admin-${stamp}@example.com`
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Step-up Clinic',
      clinicEmail: `su-clinic-${stamp}@example.com`,
      email: adminEmail,
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicId = bootstrap.body.clinicId as number
    const me = await admin.get('/auth/me')
    adminId = me.body.id as number
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // === Recorded ===============================================================

  // Every route with a step-up records its failures, naming itself — the
  // refusal the client gets is the one it always got.
  it('records a failure on every route that asks for a step-up, the refusal unchanged', async () => {
    const pat = await newPerson()
    const casey = await newPerson()
    await withMfaOn(casey.id)
    const target = await newPerson()
    await withMfaOn(target.id)

    const password = await pat.signedIn
      .post('/auth/password')
      .send({ currentPassword: 'wrong', newPassword: 'a-new-password' })
    const email = await pat.signedIn
      .post('/auth/email-change')
      .send({ newEmail: `new-${stamp}@example.com`, currentPassword: 'wrong' })
    const setup = await pat.signedIn
      .post('/auth/mfa/setup')
      .send({ currentPassword: 'wrong' })
    for (const res of [password, email, setup]) {
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
    }
    expect(await failureEntries(pat.id)).toEqual([
      entry(pat.id, {
        purpose: 'password_change',
        reason: 'wrong_password',
        consecutiveFailures: 1,
      }),
      entry(pat.id, {
        purpose: 'email_change',
        reason: 'wrong_password',
        consecutiveFailures: 2,
      }),
      entry(pat.id, {
        purpose: 'mfa_setup',
        reason: 'wrong_password',
        consecutiveFailures: 3,
      }),
    ])
    expect(await failuresOf(pat.id)).toBe(3)

    // With MFA on: the right password, a wrong second factor — the reason is
    // the second factor's own.
    const disable = await casey.signedIn
      .post('/auth/mfa/disable')
      .send({ currentPassword: 'password123', code: 'zzzzz-zzzzz' })
    const codes = await casey.signedIn
      .post('/auth/mfa/recovery-codes')
      .send({ currentPassword: 'password123', code: 'yyyyy-yyyyy' })
    for (const res of [disable, codes]) {
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([INVALID_RECOVERY_CODE_MESSAGE])
    }
    expect(await failureEntries(casey.id)).toEqual([
      entry(casey.id, {
        purpose: 'mfa_disable',
        reason: 'wrong_recovery_code',
        consecutiveFailures: 1,
      }),
      entry(casey.id, {
        purpose: 'recovery_codes',
        reason: 'wrong_recovery_code',
        consecutiveFailures: 2,
      }),
    ])

    // An admin's reset of someone else's MFA: the ADMIN's step-up, so the
    // failure is the admin's — the target's count is untouched.
    const reset = await admin
      .post(`/users/${target.id}/mfa/reset`)
      .send({ currentPassword: 'wrong' })
    expect(reset.status).toBe(400)
    expect(reset.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
    expect(await failureEntries(adminId)).toEqual([
      entry(adminId, {
        purpose: 'mfa_reset',
        reason: 'wrong_password',
        consecutiveFailures: 1,
      }),
    ])
    expect(await failuresOf(target.id)).toBe(0)
    expect(await failureEntries(target.id)).toEqual([])
    // Back to 0 for the admin, for the tests below (a passing step-up).
    expect(
      (
        await admin
          .post('/auth/mfa/setup')
          .send({ currentPassword: 'password123' })
      ).status,
    ).toBe(201)
    expect(await failuresOf(adminId)).toBe(0)
  })

  // === Counted ================================================================

  it('puts the count back to 0 when a step-up passes', async () => {
    const pat = await newPerson()
    for (let i = 0; i < 3; i += 1) {
      await pat.signedIn
        .post('/auth/mfa/setup')
        .send({ currentPassword: 'wrong' })
    }
    expect(await failuresOf(pat.id)).toBe(3)

    const passed = await pat.signedIn
      .post('/auth/password')
      .send({ currentPassword: 'password123', newPassword: 'a-new-password' })

    expect(passed.status).toBe(204)
    expect(await failuresOf(pat.id)).toBe(0)
    // The next failure starts a new run.
    await pat.signedIn
      .post('/auth/mfa/setup')
      .send({ currentPassword: 'wrong' })
    expect((await failureEntries(pat.id)).at(-1)?.details).toEqual({
      purpose: 'mfa_setup',
      reason: 'wrong_password',
      consecutiveFailures: 1,
    })
  })

  // The step-up passes INSIDE a change that is then refused for another
  // reason (the address is already the account's): the whole transaction
  // rolls back, the reset with it — and nothing was guessed, so nothing is
  // recorded either.
  it('keeps the count when the change is refused after its step-up passed', async () => {
    const pat = await newPerson()
    await pat.signedIn
      .post('/auth/mfa/setup')
      .send({ currentPassword: 'wrong' })

    const res = await pat.signedIn
      .post('/auth/email-change')
      .send({ newEmail: pat.email, currentPassword: 'password123' })

    expect(res.status).toBe(400)
    expect(res.body.message).toEqual([SAME_EMAIL_MESSAGE])
    expect(await failuresOf(pat.id)).toBe(1)
    expect(await failureEntries(pat.id)).toHaveLength(1)
  })

  // Not a failed PROOF: an MFA account that sent no code guessed nothing.
  it('neither records nor counts a missing two-factor code', async () => {
    const casey = await newPerson()
    await withMfaOn(casey.id)

    const res = await casey.signedIn
      .post('/auth/password')
      .send({ currentPassword: 'password123', newPassword: 'a-new-password' })

    expect(res.status).toBe(400)
    expect(res.body.message).toEqual([MFA_CODE_REQUIRED_MESSAGE])
    expect(await failuresOf(casey.id)).toBe(0)
    expect(await failureEntries(casey.id)).toEqual([])
  })

  // The count can't go below 0 (users_step_up_failures_not_negative): a
  // slip that decremented instead of resetting would fail loudly. Tried as
  // the owner — no route writes anything but +1 or 0.
  it('refuses a negative count', async () => {
    const pat = await newPerson()
    await expect(
      sessionPool.query(
        'UPDATE users SET step_up_failures = -1 WHERE id = $1',
        [pat.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'users_step_up_failures_not_negative',
    })
  })

  // === Signed out at 5 ========================================================

  // Four failures are refused as usual; the 5th ends THIS session: a 401
  // saying why, the session's row gone (the same cookie is no longer signed
  // in), its socket closed, the owner told — and the account's other
  // session, on another device, still signed in.
  it('signs the session out at the 5th failure in a row, and only that session', async () => {
    const pat = await newPerson()
    const otherDevice = agent()
    expect((await signIn(otherDevice, pat.email)).status).toBe(201)
    const before = await sessionsOf(pat.id)
    expect(before).toHaveLength(2)
    const sentBefore = outbox.sentTo(pat.email).length

    for (let i = 1; i <= 4; i += 1) {
      const res = await pat.signedIn
        .post('/auth/password')
        .send({ currentPassword: 'wrong', newPassword: 'a-new-password' })
      expect(res.status).toBe(400)
    }
    expect(await sessionsOf(pat.id)).toEqual(before)

    const { res, closed } = await closingSockets(() =>
      pat.signedIn
        .post('/auth/password')
        .send({ currentPassword: 'wrong', newPassword: 'a-new-password' }),
    )

    expect(res.status).toBe(401)
    expect(res.body.message).toEqual([STEP_UP_SIGNED_OUT_MESSAGE])
    const after = await sessionsOf(pat.id)
    expect(after).toHaveLength(1)
    const [ended] = before.filter((sid) => !after.includes(sid))
    expect(closed).toEqual([ended])
    expect((await pat.signedIn.get('/auth/me')).status).toBe(401)
    expect((await otherDevice.get('/auth/me')).status).toBe(200)

    expect(await failuresOf(pat.id)).toBe(0)
    const entries = await failureEntries(pat.id)
    expect(entries).toHaveLength(5)
    expect(entries.map((row) => row.details.consecutiveFailures)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(entries[4]).toEqual(
      entry(pat.id, {
        purpose: 'password_change',
        reason: 'wrong_password',
        consecutiveFailures: 5,
        signedOut: true,
      }),
    )
    const sent = outbox.sentTo(pat.email).slice(sentBefore)
    expect(sent.map((email) => email.subject)).toEqual([
      'Your Stride account was signed out on one device',
    ])
  })

  // Failures count across the routes and across sessions of the account —
  // the counter is the account's — and the session that hits the limit is
  // the one signed out.
  it("counts every session's failures, and signs out the one that reaches 5", async () => {
    const pat = await newPerson()
    const otherDevice = agent()
    expect((await signIn(otherDevice, pat.email)).status).toBe(201)

    for (let i = 0; i < 4; i += 1) {
      await otherDevice
        .post('/auth/mfa/setup')
        .send({ currentPassword: 'wrong' })
    }
    const res = await pat.signedIn
      .post('/auth/email-change')
      .send({ newEmail: `x-${stamp}@example.com`, currentPassword: 'wrong' })

    expect(res.status).toBe(401)
    expect((await pat.signedIn.get('/auth/me')).status).toBe(401)
    expect((await otherDevice.get('/auth/me')).status).toBe(200)
  })
})
