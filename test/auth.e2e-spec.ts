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
import { sql } from 'drizzle-orm'
import { OTP } from 'otplib'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
describe('Auth (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  const otp = new OTP({ strategy: 'totp' })

  // register-clinic only ever succeeds ONCE per (truncated) database — the
  // founding admin is bootstrapped a single time here and reused across
  // every test below, rather than each test trying (and failing) to create
  // its own.
  const admin = () => request.agent(app.getHttpServer())
  let adminAgent: ReturnType<typeof admin>

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

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
    const db = app.get<DrizzleDb>(DRIZZLE)
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
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Auth',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
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
  const patientAgent = () => request.agent(app.getHttpServer())
  const dualRoleAgent = () => request.agent(app.getHttpServer())
  const mfaAgent = () => request.agent(app.getHttpServer())

  it('refuses a second register-clinic once a founding admin already exists', async () => {
    const stamp = Date.now()
    const res = await request(app.getHttpServer())
      .post('/auth/register-clinic')
      .send({
        clinicName: 'Another Clinic',
        clinicEmail: `clinic2-${stamp}@example.com`,
        email: `admin2-${stamp}@example.com`,
        password: 'password123',
        firstName: 'Second',
        lastName: 'Admin',
      })
    expect(res.status).toBe(403)
  })

  it('rejects /auth/me without a session', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me')
    expect(res.status).toBe(401)
  })

  it('auto-selects the active role on login when the account has exactly one', async () => {
    const patient = patientAgent()
    const stamp = Date.now()

    const registerRes = await patient.post('/auth/register').send({
      email: `single-role-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Single',
      lastName: 'Role',
      dateOfBirth: '1990-01-01',
    })
    expect(registerRes.status).toBe(201)
    // /auth/register already logs the caller in via req.login() — confirm
    // that session is real before logging out and testing login separately.
    const meAfterRegister = await patient.get('/auth/me')
    expect(meAfterRegister.status).toBe(200)
    await patient.post('/auth/logout')

    const loginRes = await patient.post('/auth/login').send({
      email: `single-role-${stamp}@example.com`,
      password: 'password123',
    })
    expect(loginRes.status).toBe(201)
    expect(loginRes.body.activeRole).toBe('patient')
  })

  it('requires an explicit role choice for an account with more than one role, and rejects a role it does not hold', async () => {
    const dualRole = dualRoleAgent()
    const stamp = Date.now()

    const createRes = await adminAgent.post('/users').send({
      email: `dual-role-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Dual',
      lastName: 'Role',
      dateOfBirth: '1990-01-01',
    })
    expect(createRes.status).toBe(201)
    const dualRoleUserId = createRes.body.id

    const grantRes = await adminAgent
      .post(`/users/${dualRoleUserId}/roles`)
      .send({
        role: 'practitioner',
        licenseNumber: `PT-DUAL-${stamp}`,
      })
    expect(grantRes.status).toBe(201)

    const noRoleLogin = await dualRole.post('/auth/login').send({
      email: `dual-role-${stamp}@example.com`,
      password: 'password123',
    })
    expect(noRoleLogin.status).toBe(400)

    const wrongRoleLogin = await dualRole.post('/auth/login').send({
      email: `dual-role-${stamp}@example.com`,
      password: 'password123',
      role: 'admin',
    })
    expect(wrongRoleLogin.status).toBe(403)

    const correctRoleLogin = await dualRole.post('/auth/login').send({
      email: `dual-role-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
    })
    expect(correctRoleLogin.status).toBe(201)
    expect(correctRoleLogin.body.activeRole).toBe('patient')

    const switchOk = await dualRole
      .post('/auth/switch-role')
      .send({ role: 'practitioner' })
    expect(switchOk.status).toBe(201)
    expect(switchOk.body.activeRole).toBe('practitioner')

    const switchDenied = await dualRole
      .post('/auth/switch-role')
      .send({ role: 'admin' })
    expect(switchDenied.status).toBe(403)
  })

  it('walks the full two-step MFA login flow using the same session throughout', async () => {
    const mfa = mfaAgent()
    const stamp = Date.now()

    const registerRes = await mfa.post('/auth/register').send({
      email: `mfa-${stamp}@example.com`,
      password: 'password123',
      firstName: 'MFA',
      lastName: 'User',
      dateOfBirth: '1990-01-01',
    })
    expect(registerRes.status).toBe(201)

    const setupRes = await mfa.post('/auth/mfa/setup')
    expect(setupRes.status).toBe(201)
    const { secret } = setupRes.body
    expect(typeof secret).toBe('string')

    const enableCode = await otp.generate({ secret })
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
      .send({ email: `mfa-${stamp}@example.com` })
    expect(forgotRes.status).toBe(204)

    await mfa.post('/auth/logout')

    const loginRes = await mfa.post('/auth/login').send({
      email: `mfa-${stamp}@example.com`,
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

    const verifyCode = await otp.generate({ secret })
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

    // The SAME agent/session that was MFA-pending a moment ago is now fully
    // authenticated — no separate login round trip was needed.
    const meAfterVerify = await mfa.get('/auth/me')
    expect(meAfterVerify.status).toBe(200)
    expect(meAfterVerify.body.email).toBe(`mfa-${stamp}@example.com`)
    expect(meAfterVerify.body).not.toHaveProperty('passwordHash')
    expect(meAfterVerify.body).not.toHaveProperty('mfaSecret')
    expect(meAfterVerify.body).not.toHaveProperty('passwordResetTokenHash')
    expect(meAfterVerify.body).not.toHaveProperty('passwordResetTokenExpiresAt')

    // switch-role re-runs req.login() with a freshly deserialized user too
    // — same leak shape, same fix, same regression risk.
    const switchRes = await mfa
      .post('/auth/switch-role')
      .send({ role: 'patient' })
    expect(switchRes.status).toBe(201)
    expect(switchRes.body).not.toHaveProperty('mfaSecret')
    expect(switchRes.body).not.toHaveProperty('passwordResetTokenHash')
    expect(switchRes.body).not.toHaveProperty('passwordResetTokenExpiresAt')
  })

  it('forgot-password always responds 204, whether or not the email exists — no account enumeration', async () => {
    const stamp = Date.now()
    const agent = request(app.getHttpServer())

    const knownRes = await agent
      .post('/auth/forgot-password')
      .send({ email: `single-role-${stamp}-unknown@example.com` })
    expect(knownRes.status).toBe(204)

    const unknownRes = await agent
      .post('/auth/forgot-password')
      .send({ email: `definitely-does-not-exist-${stamp}@example.com` })
    expect(unknownRes.status).toBe(204)
  })

  it('rejects a reset-password attempt with a token that was never issued', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'newpassword123' })
    expect(res.status).toBe(400)
  })
})
