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
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { auditLogs } from '../src/database/schema'
import { withRlsContext } from '../src/database/rls-context'
import { UserRole } from '../src/users/dto/create-user.dto'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
describe('Auth (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb
  const otp = new OTP({ strategy: 'totp' })

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
  let clinicId: number
  // Resend's unverified-sandbox mode rejects any recipient outside its own
  // fixed test addresses outright (422, "Please use our testing email
  // address instead of domains like example.com") — confirmed directly by
  // running the audit test below before this fix, not assumed. delivered@
  // resend.dev is the one account this file registers that's actually safe
  // to send to; the audit-log test reuses it (see mfaAccountId) rather than
  // registering its own @example.com account, which doc 28 already
  // diagnosed as the same root cause for a different test.
  const resendSafeEmail = 'delivered@resend.dev'
  let mfaAccountId: number

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
    clinicId = clinicRes.body.clinicId
    // Regression coverage for the actual gap this fix closes: adminProfiles
    // is written inside registerClinic()'s own transaction but was never
    // read back into its response — registerClinic() bypasses
    // UsersService.create()/findOne() entirely (see AuthService's own
    // comment on why), so it needed its own explicit attachProfile() call.
    expect(clinicRes.body.adminProfile).toEqual({
      position: 'Clinic Director',
    })
    expect(clinicRes.body).not.toHaveProperty('practitionerProfile')
    expect(clinicRes.body).not.toHaveProperty('patientProfile')
    // phone/address moved from patient_profiles onto users itself —
    // registerClinic()'s own raw `users` insert (bypassing
    // UsersService.create()) needs the same fields threaded through
    // separately, since it never goes through create() at all.
    expect(clinicRes.body.phone).toBe('555-0100')
    expect(clinicRes.body.addressLine1).toBe('1 Founding Admin Way')
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

  // registerClinic()'s clinicAddressLine1 (and friends) are fields on the
  // CLINIC row, distinct from the founding admin's own addressLine1
  // (asserted separately in beforeAll) — they land on two different
  // tables via two different inserts inside the same transaction, so
  // this confirms clinicAddressLine1 actually reached
  // `clinics.address_line1`, not silently dropped or conflated with the
  // admin's own address fields of the same request body.
  it("persists the clinic's own address, separately from the founding admin's address", async () => {
    const res = await adminAgent.get(`/clinics/${clinicId}`)
    expect(res.status).toBe(200)
    expect(res.body.addressLine1).toBe('10 Founding Clinic Ave')
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
      phone: '555-0101',
      addressLine1: '1 Patient Lane',
      addressCity: 'Springfield',
      addressPostalCode: '62704',
      addressCountry: 'US',
    })
    expect(registerRes.status).toBe(201)
    // Regression coverage: patient_profiles.dateOfBirth is written by
    // UsersService.create() (which AuthService.register() calls directly)
    // but was never attached to the response — not even here, on the
    // account's own creation.
    expect(registerRes.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
    expect(registerRes.body).not.toHaveProperty('practitionerProfile')
    expect(registerRes.body).not.toHaveProperty('adminProfile')
    // phone/address now live on `users` itself (moved off patient_profiles),
    // so they're common to every role — round-tripped here through the
    // public registration path.
    expect(registerRes.body.phone).toBe('555-0101')
    expect(registerRes.body.addressLine1).toBe('1 Patient Lane')
    // /auth/register already logs the caller in via req.login() — confirm
    // that session is real before logging out and testing login separately.
    const meAfterRegister = await patient.get('/auth/me')
    expect(meAfterRegister.status).toBe(200)
    expect(meAfterRegister.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
    expect(meAfterRegister.body.phone).toBe('555-0101')
    expect(meAfterRegister.body.addressLine1).toBe('1 Patient Lane')
    await patient.post('/auth/logout')

    const loginRes = await patient.post('/auth/login').send({
      email: `single-role-${stamp}@example.com`,
      password: 'password123',
    })
    expect(loginRes.status).toBe(201)
    expect(loginRes.body.activeRole).toBe('patient')
    // Regression coverage: validateUser() (POST /auth/login) builds its own
    // response by hand rather than through findOne()/create(), so it needed
    // its own explicit attachProfile() call — same gap, different call site.
    expect(loginRes.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })
    expect(loginRes.body.phone).toBe('555-0101')
    expect(loginRes.body.addressLine1).toBe('1 Patient Lane')
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
    // grantRole()'s response was never a user object in the first place
    // (just the account's roles, as a bare array) — nothing to attach
    // profile data to here, unlike every other route below. Documenting
    // that deliberately, not silently: it's the one route this fix does
    // NOT touch.
    expect(grantRes.body).toEqual(
      expect.arrayContaining(['patient', 'practitioner']),
    )

    const noRoleLogin = await dualRole.post('/auth/login').send({
      email: `dual-role-${stamp}@example.com`,
      password: 'password123',
    })
    expect(noRoleLogin.status).toBe(400)
    // Regression coverage for the actual gap this fix closes: the 400 body
    // now carries the account's actual roles, so the frontend can build a
    // role picker instead of just knowing "pick one" with no idea which.
    expect(noRoleLogin.body.roles).toEqual(
      expect.arrayContaining(['patient', 'practitioner']),
    )
    expect(noRoleLogin.body.roles).toHaveLength(2)

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
    // This account holds BOTH roles — profile nesting is keyed off which
    // roles the account actually HOLDS, not which one is currently active,
    // so both show up here even though activeRole is 'patient'.
    expect(correctRoleLogin.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
    expect(correctRoleLogin.body.practitionerProfile).toEqual({
      licenseNumber: `PT-DUAL-${stamp}`,
      specialties: [],
      bio: null,
    })

    const switchOk = await dualRole
      .post('/auth/switch-role')
      .send({ role: 'practitioner' })
    expect(switchOk.status).toBe(201)
    expect(switchOk.body.activeRole).toBe('practitioner')
    // Same point from the other side: switching activeRole to practitioner
    // doesn't make the patientProfile disappear — the account still holds
    // that role too.
    expect(switchOk.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })
    expect(switchOk.body.practitionerProfile).toEqual({
      licenseNumber: `PT-DUAL-${stamp}`,
      specialties: [],
      bio: null,
    })

    const switchDenied = await dualRole
      .post('/auth/switch-role')
      .send({ role: 'admin' })
    expect(switchDenied.status).toBe(403)
  })

  it('walks the full two-step MFA login flow using the same session throughout', async () => {
    const mfa = mfaAgent()
    // Resend's unverified-sandbox mode only delivers to the address the
    // Resend account itself was signed up with, so a random timestamped
    // address here would only work for whoever's personal Resend account
    // happens to be configured — non-portable to a teammate, CI, or a
    // future run. delivered@resend.dev is Resend's own dedicated test
    // address for exactly this: always succeeds, no account-specific
    // restriction (documented in Resend's own examples). See docs/journal/17.
    const mfaEmail = resendSafeEmail

    const registerRes = await mfa.post('/auth/register').send({
      email: mfaEmail,
      password: 'password123',
      firstName: 'MFA',
      lastName: 'User',
      dateOfBirth: '1990-01-01',
    })
    expect(registerRes.status).toBe(201)
    // The audit-log test below reuses this same account rather than
    // registering its own — see the comment on resendSafeEmail.
    mfaAccountId = registerRes.body.id

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
    // 15s, not Jest's 5s default: this test's forgot-password call above is
    // a real, awaited round trip to the live Resend API (see docs/journal/17)
    // — normal latency plus margin, independent of the delivered@resend.dev
    // switch above, since that fixes deliverability, not network variance.
  }, 15000)

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

  // Regression coverage for the fire-and-forget change to the email send in
  // forgotPassword(): the token hash / DB UPDATE / audit log write all stay
  // awaited exactly as before — only the Resend call itself was made
  // non-blocking. So this row must be readable the INSTANT the 204 comes
  // back, with no wait/poll/retry, or the fire-and-forget change would have
  // silently reordered work that's supposed to happen before the response.
  //
  // Reuses the MFA test's already-registered delivered@resend.dev account
  // (mfaAccountId) instead of registering a fresh @example.com one, which
  // is what this test originally did — Resend's sandbox rejects any
  // @example.com recipient outright (422), the same root cause doc 28
  // diagnosed and fixed for the MFA-flow test specifically, just never
  // applied here. That account already has ONE PASSWORD_RESET_REQUESTED
  // entry from the MFA test's own forgot-password call, so this orders by
  // the newest row (desc(auditLogs.id)) rather than findFirst()'s
  // unspecified order, to actually grab the entry this request just wrote.
  it('writes a PASSWORD_RESET_REQUESTED audit entry that is already present by the time the response returns', async () => {
    const userId = mfaAccountId
    expect(typeof userId).toBe('number')

    const before = Date.now()
    const forgotRes = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: resendSafeEmail })
    expect(forgotRes.status).toBe(204)
    const after = Date.now()

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
    // A real timestamp, not a placeholder — bounded by the request's own
    // start/end, with a small margin for clock skew between the test
    // process and the database.
    //
    // That margin assumes host/container clock parity, which doesn't
    // always hold: Docker Desktop's WSL2 VM clock can drift several
    // seconds ahead of the host (observed directly — `SELECT now()`
    // in-container vs. `Date.now()` on the host — while diagnosing a flake
    // in this exact test), which would reopen this assertion if the drift
    // exceeds 2s. `wsl --shutdown` resyncs it; not run as part of this fix
    // — host-level infrastructure, out of scope here. See DEPLOYMENT.md
    // Part 1.
    const createdAtMs = entry!.createdAt.getTime()
    expect(createdAtMs).toBeGreaterThanOrEqual(before - 2000)
    expect(createdAtMs).toBeLessThanOrEqual(after + 2000)
  })

  it('rejects a reset-password attempt with a token that was never issued', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'newpassword123' })
    expect(res.status).toBe(400)
  })
})