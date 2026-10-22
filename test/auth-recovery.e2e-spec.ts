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
import { and, desc, eq, sql } from 'drizzle-orm'
import { OTP } from 'otplib'
import * as bcrypt from 'bcrypt'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { auditLogs } from '../src/database/schema'
import { withRlsContext } from '../src/database/rls-context'
import { UserRole } from '../src/users/dto/create-user.dto'
import {
  InMemoryEmailTransport,
  findLink,
} from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { MessagingEvents } from '../src/messaging/messaging-events'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
// MFA and password recovery: the two-step MFA login, forgot-password and
// reset-password. Split from auth.e2e-spec.ts (2026-10-07), back when the
// e2e suites ran under the login and forgot-password limits. Since
// 2026-10-15 the limits are OFF in the e2e suites (test/support/e2e-env.ts)
// and proven by test/rate-limits.e2e-spec.ts.
describe('Auth — MFA and password recovery (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb
  const otp = new OTP({ strategy: 'totp' })

  // A TOTP code for `secret` that is still valid when the server checks it.
  // A code belongs to one 30-second window, and the server accepts only the
  // CURRENT window (epochTolerance 0 — auth.controller.ts). A code generated
  // in a window's last moments can expire before the request arrives: the
  // server then answers 401, at random, about once in a hundred runs on a
  // busy machine (found 2026-10-12: one failure in a full e2e run, passing
  // alone). So when fewer than 5 seconds of the window are left, wait for
  // the next window first — then the code has at least 5 seconds to live,
  // far more than a request takes. (Loosening the server's window instead
  // would weaken MFA to suit a test.)
  async function freshCode(secret: string): Promise<string> {
    const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30)
    if (secondsLeft < 5) {
      await new Promise((resolve) =>
        setTimeout(resolve, secondsLeft * 1000 + 100),
      )
    }
    return otp.generate({ secret })
  }

  // register-clinic only ever succeeds ONCE per (truncated) database — the
  // founding admin is bootstrapped a single time here and reused across
  // every test below, rather than each test trying (and failing) to create
  // its own.
  const admin = () => request.agent(app.getHttpServer())
  let adminAgent: ReturnType<typeof admin>
  // audit_logs' own RLS policy (see 0002_audit_logs_rls.sql) only allows
  // SELECT when app.current_role = 'admin' — the founding admin's id below
  // is what a direct audit_logs read in a test has to authenticate as,
  // the same way AuditController's real /audit-logs route does.
  let adminId: number
  // Every email the app sends during this file lands here instead of
  // leaving the machine (see test/support/in-memory-email-transport.ts).
  // This replaced live calls to Resend, whose sandbox only delivered to its
  // own test address (delivered@resend.dev) — which is why this file used
  // to route every forgot-password call through that one account, and why
  // no test could ever read a reset link and follow it.
  const outbox = new InMemoryEmailTransport()
  // The MFA test creates this account; the audit-log test reuses it
  // (mfaAccountId) because it needs an account with a known id.
  const mfaAccountEmail = 'mfa-user@example.com'
  let mfaAccountId: number

  beforeAll(async () => {
    // overrideProvider() swaps what Nest injects under EMAIL_TRANSPORT,
    // wherever it's asked for inside AppModule — EmailModule's factory
    // (and so EMAIL_TRANSPORT / RESEND_API_KEY) is never consulted.
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

    // Same session setup as main.ts — an e2e test needs the REAL middleware
    // stack, not just the DI-wired providers, since guards/sessions live in
    // middleware that main.ts sets up manually, outside AppModule itself.
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

    // Resets this test's starting state, so this file can run any number of
    // times in a row and always begin from a genuinely empty database.
    // CASCADE truncates every table with a foreign key pointing at
    // users/clinics regardless of that FK's own ON DELETE rule — safe ONLY
    // because this is the dedicated, disposable stride_test database,
    // confirmed by the check just above.
    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    adminAgent = admin()
    const stamp = Date.now()
    const clinicRes = await adminAgent.post('/auth/register-clinic').send({
      clinicName: 'Auth E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      clinicAddressLine1: '10 Founding Clinic Ave',
      clinicAddressCity: 'Springfield',
      clinicAddressPostalCode: '62704',
      clinicAddressCountry: 'US',
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Auth',
      lastName: 'Admin',
      phone: '555-0100',
      addressLine1: '1 Founding Admin Way',
      addressCity: 'Springfield',
      addressPostalCode: '62704',
      addressCountry: 'US',
      position: 'Clinic Director',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    adminId = clinicRes.body.id
  })

  afterAll(async () => {
    await app.close()
    // app.close() only closes what Nest's own DI container manages.
    // sessionPool was created manually, outside that container, so it needs
    // to be closed explicitly too.
    await sessionPool.end()
  })

  // request.agent() is supertest's built-in cookie jar — every call made
  // through the SAME agent automatically remembers and resends whatever
  // session cookie the server issued.
  const mfaAgent = () => request.agent(app.getHttpServer())
  // 20 s, not Jest's default 5: freshCode may wait about 5 s, twice, for a
  // fresh MFA window, on top of the requests.
  it('walks the full two-step MFA login flow using the same session throughout', async () => {
    const mfa = mfaAgent()
    const mfaEmail = mfaAccountEmail

    // Created by the admin (public registration was removed), activated as
    // if the invitation were accepted, then signed in — the session MFA is
    // set up on, which /auth/register used to provide.
    const createRes = await adminAgent.post('/users').send({
      email: mfaEmail,
      role: 'patient',
      firstName: 'MFA',
      lastName: 'User',
      dateOfBirth: '1990-01-01',
    })
    expect(createRes.status).toBe(201)
    // The audit-log test below reuses this same account rather than
    // creating its own — see the comment on mfaAccountEmail.
    mfaAccountId = createRes.body.id
    await activateAccount(sessionPool, mfaEmail)
    const firstLogin = await mfa
      .post('/auth/login')
      .send({ email: mfaEmail, password: 'password123' })
    expect(firstLogin.status).toBe(201)

    const setupRes = await mfa.post('/auth/mfa/setup')
    expect(setupRes.status).toBe(201)
    const { secret } = setupRes.body
    expect(typeof secret).toBe('string')

    const enableCode = await freshCode(secret)
    const enableRes = await mfa
      .post('/auth/mfa/enable')
      .send({ code: enableCode })
    expect(enableRes.status).toBe(204)

    // Also leaves this account with a genuinely pending password-reset
    // token — forgot-password doesn't touch the current session, only
    // generates and stores a token — so the me/mfa-verify assertions below
    // exercise both leak-prone fields at once (mfaSecret from the enabled
    // MFA, passwordResetTokenHash/Expiry from this).
    const forgotRes = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: mfaEmail })
    expect(forgotRes.status).toBe(204)

    await mfa.post('/auth/logout')

    const loginRes = await mfa.post('/auth/login').send({
      email: mfaEmail,
      password: 'password123',
    })
    expect(loginRes.status).toBe(201)
    expect(loginRes.body).toEqual({ mfaRequired: true })

    // Still MFA-pending, not yet authenticated — the session exists (it's
    // what carries mfaPending across these two requests) but isAuthenticated()
    // must stay false until MFA actually succeeds.
    const meWhilePending = await mfa.get('/auth/me')
    expect(meWhilePending.status).toBe(401)

    const wrongCodeRes = await mfa
      .post('/auth/mfa/verify')
      .send({ code: '000000' })
    expect(wrongCodeRes.status).toBe(401)

    const verifyCode = await freshCode(secret)
    const verifyRes = await mfa
      .post('/auth/mfa/verify')
      .send({ code: verifyCode })
    expect(verifyRes.status).toBe(201)
    // Regression coverage: this response body used to be built from
    // UsersService.findOne(), which only stripped passwordHash — leaking
    // the encrypted mfaSecret and the pending reset token's hash/expiry
    // into the very login response right after completing MFA.
    expect(verifyRes.body).not.toHaveProperty('mfaSecret')
    expect(verifyRes.body).not.toHaveProperty('passwordResetTokenHash')
    expect(verifyRes.body).not.toHaveProperty('passwordResetTokenExpiresAt')
    // Regression coverage: mfa/verify's response comes straight from
    // findOne() (via req.login(authenticatedUser)) — this is the funnel
    // fix, exercised end to end through the full two-step MFA path.
    expect(verifyRes.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })

    // The SAME agent/session that was MFA-pending a moment ago is now fully
    // authenticated — no separate login round trip was needed.
    const meAfterVerify = await mfa.get('/auth/me')
    expect(meAfterVerify.status).toBe(200)
    expect(meAfterVerify.body.email).toBe(mfaEmail)
    expect(meAfterVerify.body).not.toHaveProperty('passwordHash')
    expect(meAfterVerify.body).not.toHaveProperty('mfaSecret')
    expect(meAfterVerify.body).not.toHaveProperty('passwordResetTokenHash')
    expect(meAfterVerify.body).not.toHaveProperty('passwordResetTokenExpiresAt')
    expect(meAfterVerify.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })

    // switch-role re-runs req.login() with a freshly deserialized user too
    // — same leak shape, same fix, same regression risk.
    const switchRes = await mfa
      .post('/auth/switch-role')
      .send({ role: 'patient' })
    expect(switchRes.status).toBe(201)
    expect(switchRes.body).not.toHaveProperty('mfaSecret')
    expect(switchRes.body).not.toHaveProperty('passwordResetTokenHash')
    expect(switchRes.body).not.toHaveProperty('passwordResetTokenExpiresAt')
    expect(switchRes.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
  }, 20_000)

  it('forgot-password always responds 204, whether or not the email exists — no account enumeration', async () => {
    const stamp = Date.now()
    const agent = request(app.getHttpServer())

    const firstEmail = `single-role-${stamp}-unknown@example.com`
    const knownRes = await agent
      .post('/auth/forgot-password')
      .send({ email: firstEmail })
    expect(knownRes.status).toBe(204)

    const secondEmail = `definitely-does-not-exist-${stamp}@example.com`
    const unknownRes = await agent
      .post('/auth/forgot-password')
      .send({ email: secondEmail })
    expect(unknownRes.status).toBe(204)

    // The other half of "no enumeration": the identical 204 must not be
    // hiding a difference in what actually happened. No account, no email.
    expect(outbox.sentTo(firstEmail)).toHaveLength(0)
    expect(outbox.sentTo(secondEmail)).toHaveLength(0)
  })

  // Regression coverage for the fire-and-forget change to the email send in
  // forgotPassword(): the token hash / DB UPDATE / audit log write all stay
  // awaited exactly as before — only the Resend call itself was made
  // non-blocking. So this row must be readable the INSTANT the 204 comes
  // back, with no wait/poll/retry, or the fire-and-forget change would have
  // silently reordered work that's supposed to happen before the response.
  //
  // Reuses the MFA test's already-registered account (mfaAccountId) — a
  // workaround from when emails really went to Resend, whose sandbox
  // rejected @example.com recipients; kept because it costs nothing and
  // spares a registration. That account already has ONE PASSWORD_RESET_REQUESTED
  // entry from the MFA test's own forgot-password call, so this orders by
  // the newest row (desc(auditLogs.id)) rather than findFirst()'s
  // unspecified order, to actually grab the entry this request just wrote.
  // The database's clock now, in milliseconds — clock_timestamp(), the real
  // time at this statement (now() is the time its transaction started; the
  // same here, as each query is its own transaction, but clock_timestamp()
  // says what is meant).
  async function databaseNow(): Promise<number> {
    const { rows } = await sessionPool.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    )
    return rows[0].now.getTime()
  }

  it('writes a PASSWORD_RESET_REQUESTED audit entry that is already present by the time the response returns', async () => {
    const userId = mfaAccountId
    expect(typeof userId).toBe('number')

    const before = await databaseNow()
    const forgotRes = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: mfaAccountEmail })
    expect(forgotRes.status).toBe(204)
    const after = await databaseNow()

    // audit_logs has its own RLS SELECT policy requiring
    // app.current_role = 'admin' (0002_audit_logs_rls.sql) — the founding
    // admin's id/role from beforeAll is what authenticates this read, same
    // as the real /audit-logs route would for an admin caller.
    const entry = await withRlsContext(
      db,
      { id: adminId, activeRole: UserRole.ADMIN },
      (tx) =>
        tx.query.auditLogs.findFirst({
          where: and(
            eq(auditLogs.performedBy, userId),
            eq(auditLogs.action, 'PASSWORD_RESET_REQUESTED'),
          ),
          orderBy: desc(auditLogs.id),
        }),
    )

    expect(entry).toBeDefined()
    expect(entry?.performedBy).toBe(userId)
    expect(entry?.entityType).toBe('users')
    expect(entry?.entityId).toBe(userId)
    expect(entry?.createdAt).toBeInstanceOf(Date)
    // A real timestamp, not a placeholder — between the request's own start
    // and end. Both bounds are read from the DATABASE's clock, the one that
    // wrote createdAt (its `now()` default), so no margin is needed: the
    // three readings come from one clock, in order.
    //
    // Until 2026-10-12 the bounds were Date.now() — the test process's
    // clock — with 2 s of margin each way. That compared two clocks: with
    // Postgres in Docker Desktop, the WSL2 VM's clock can drift seconds
    // ahead of the host's (`wsl --shutdown` resyncs it), and the test failed
    // at random (seen: an entry stamped 2.36 s after the test's "after").
    // Widening the margin would only move the line; one clock removes it.
    //
    // (Milliseconds: getTime() drops microseconds from all three readings
    // alike — rounding down keeps their order, so the bounds still hold.)
    const createdAtMs = entry!.createdAt.getTime()
    expect(createdAtMs).toBeGreaterThanOrEqual(before)
    expect(createdAtMs).toBeLessThanOrEqual(after)
  })

  // The whole reset flow, the way a user lives it: ask for a reset, open
  // the email, follow its link, choose a new password. Impossible to test
  // while emails went to Resend — nothing could read the link back.
  //
  // Proves the new password took effect by checking the stored hash, not by
  // logging in — written when this file's logins used the route's whole
  // allowance (the limits are off in the e2e suites since 2026-10-15); the
  // stored hash stays the more direct proof.
  it('emails a working reset link that sets the new password, ends existing sessions, and only works once', async () => {
    const email = 'reset-flow@example.com'
    const oldPassword = 'password123'
    const newPassword = 'new-password-456'

    // Created by the admin, activated, signed in: this agent holds the live
    // session the reset must end.
    const user = request.agent(app.getHttpServer())
    const createRes = await adminAgent.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Reset',
      lastName: 'Flow',
      dateOfBirth: '1990-01-01',
    })
    expect(createRes.status).toBe(201)
    await activateAccount(sessionPool, email, oldPassword)
    const login = await user
      .post('/auth/login')
      .send({ email, password: oldPassword })
    expect(login.status).toBe(201)
    expect((await user.get('/auth/me')).status).toBe(200)

    const forgotRes = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
    expect(forgotRes.status).toBe(204)

    // Exactly one email, to this address, with the reset subject. Already
    // in the outbox although forgotPassword() doesn't await its send — see
    // InMemoryEmailTransport.send().
    // The account also got its invitation email when it was created, so
    // count the RESET emails: exactly one.
    const resetEmails = outbox
      .sentTo(email)
      .filter((sent) => sent.subject === 'Reset your Stride password')
    expect(resetEmails).toHaveLength(1)
    const resetEmail = outbox.lastSentTo(email)
    expect(resetEmail.subject).toBe('Reset your Stride password')

    // The link points at the frontend's reset page, carries the raw token
    // (64 hex characters = the 32 random bytes from forgotPassword()), and
    // the HTML body links to exactly the same URL as the text body.
    const link = findLink(resetEmail, '/reset-password')
    expect(link.origin).toBe(
      new URL(process.env.FRONTEND_URL ?? 'http://localhost:5173').origin,
    )
    const token = link.searchParams.get('token')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(resetEmail.html).toContain(`href="${link.href}"`)

    // The sessions the reset must end — and, with them, their messaging
    // sockets (a socket is authenticated once, at its handshake: without
    // closing it, a signed-out device keeps receiving messages). At least
    // this agent's; maybe more: the session table is never emptied between
    // suites, and each suite restarts user ids, so earlier suites' sessions
    // can carry this account's id (12 of them in one full run). Whatever
    // their number, every one the reset deletes must have its socket closed.
    const { rows: before } = await sessionPool.query<{ sid: string }>(
      `SELECT sid FROM session
        WHERE (sess::jsonb)->'passport'->'user'->>'id' =
              (SELECT id::text FROM users WHERE email = $1)`,
      [email],
    )
    expect(before.length).toBeGreaterThan(0)
    const disconnect = jest.spyOn(app.get(MessagingEvents), 'disconnectSession')

    const resetRes = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword })
    const closed = disconnect.mock.calls.map(([sid]) => sid)
    disconnect.mockRestore()
    expect(resetRes.status).toBe(204)
    expect(closed.sort()).toEqual(before.map((row) => row.sid).sort())

    // Read as the owner connection (sessionPool), which isn't subject to
    // RLS — this checks the stored row itself, not what any route shows.
    const { rows } = await sessionPool.query<{
      password_hash: string
      password_reset_token_hash: string | null
    }>(
      'SELECT password_hash, password_reset_token_hash FROM users WHERE email = $1',
      [email],
    )
    expect(await bcrypt.compare(newPassword, rows[0].password_hash)).toBe(true)
    expect(await bcrypt.compare(oldPassword, rows[0].password_hash)).toBe(false)
    expect(rows[0].password_reset_token_hash).toBeNull()

    // The session that existed before the reset is gone (see
    // destroyAllSessionsForUser in resetPassword()).
    expect((await user.get('/auth/me')).status).toBe(401)

    // Single use: the token was cleared on success, so the same link now
    // fails — with the same message as a token that never existed.
    const reuseRes = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword: 'another-password-789' })
    expect(reuseRes.status).toBe(400)
    expect(reuseRes.body.message).toEqual([
      'This password reset link is invalid or has expired',
    ])
  })

  // The reset page's pre-check (2026-10-21): a real link, checked without
  // being used; then refused once it is used, replaced or expired — the
  // reset's own words each time.
  describe('reset-password/check', () => {
    const check = (token: unknown) =>
      request(app.getHttpServer())
        .post('/auth/reset-password/check')
        .send({ token })
    const DEAD = ['This password reset link is invalid or has expired']

    // A fresh account, activated, with a reset requested: its token.
    async function resetLinkFor(email: string): Promise<string> {
      const created = await adminAgent.post('/users').send({
        email,
        role: 'patient',
        firstName: 'Check',
        lastName: 'Link',
        dateOfBirth: '1990-01-01',
      })
      expect(created.status).toBe(201)
      await activateAccount(sessionPool, email, 'password123')
      return requestLink(email)
    }
    async function requestLink(email: string): Promise<string> {
      const forgot = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email })
      expect(forgot.status).toBe(204)
      const token = findLink(
        outbox.lastSentTo(email),
        '/reset-password',
      ).searchParams.get('token')
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      return token as string
    }

    it("answers the account's email and the link's expiry, without using the link", async () => {
      const email = 'check-ok@example.com'
      const token = await resetLinkFor(email)
      const { rows } = await sessionPool.query<{ expires: Date }>(
        'SELECT password_reset_token_expires_at AS expires FROM users WHERE email = $1',
        [email],
      )

      const first = await check(token)
      expect(first.status).toBe(200)
      expect(first.body).toStrictEqual({
        email,
        expiresAt: rows[0].expires.toISOString(),
      })
      // Asked twice: still usable — a check never consumes the link…
      expect((await check(token)).status).toBe(200)
      // …and the reset still works with it.
      const reset = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, newPassword: 'checked-then-reset-1' })
      expect(reset.status).toBe(204)

      // Used: dead.
      const after = await check(token)
      expect(after.status).toBe(400)
      expect(after.body.message).toEqual(DEAD)
    })

    it('refuses a link replaced by a newer request', async () => {
      const email = 'check-replaced@example.com'
      const older = await resetLinkFor(email)
      const newer = await requestLink(email)
      expect((await check(older)).body.message).toEqual(DEAD)
      expect((await check(newer)).status).toBe(200)
    })

    it('refuses an expired link', async () => {
      const email = 'check-expired@example.com'
      const token = await resetLinkFor(email)
      // Backdated with NODE's clock, not the database's now(): the app
      // decides "expired" with `new Date()` (findUserByResetToken), and two
      // clocks drift — a Postgres container a second ahead of the host
      // (seen under WSL2, 2026-10-22) left `now() - 1 second` still in
      // Node's future, and the link alive.
      await sessionPool.query(
        'UPDATE users SET password_reset_token_expires_at = $1 WHERE email = $2',
        [new Date(Date.now() - 1000), email],
      )
      const res = await check(token)
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual(DEAD)
    })

    it('refuses a token never issued, and a body without a token', async () => {
      const unknown = await check('f'.repeat(64))
      expect(unknown.status).toBe(400)
      expect(unknown.body.message).toEqual(DEAD)

      const missing = await check(undefined)
      expect(missing.status).toBe(400)
      expect(missing.body.message).toEqual(
        expect.arrayContaining(['token must be a string']),
      )
    })

    it('writes nothing to the audit log', async () => {
      const email = 'check-audit@example.com'
      const token = await resetLinkFor(email)
      const count = async () =>
        Number(
          (
            await sessionPool.query<{ n: string }>(
              'SELECT count(*) AS n FROM audit_logs',
            )
          ).rows[0].n,
        )
      const before = await count()
      expect((await check(token)).status).toBe(200)
      expect(await count()).toBe(before)
    })
  })

  it('rejects a reset-password attempt with a token that was never issued', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'newpassword123' })
    expect(res.status).toBe(400)
    expect(res.body.message).toEqual([
      'This password reset link is invalid or has expired',
    ])
  })
})
