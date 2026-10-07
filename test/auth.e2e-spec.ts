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
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
// Signing in: the one-time first setup (register-clinic), sessions, and
// choosing a role at login. MFA and password recovery are in
// auth-recovery.e2e-spec.ts — split (2026-10-07) when public registration
// was removed: the tests that used to get a signed-in account from
// /auth/register now need a login each, and login allows 5 calls a minute
// per app instance. Each file builds its own app, so each gets its own 5.
// This file uses 4.
describe('Auth (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb

  // register-clinic only ever succeeds ONCE per (truncated) database — the
  // founding admin is bootstrapped a single time here and reused across
  // every test below, rather than each test trying (and failing) to create
  // its own.
  const admin = () => request.agent(app.getHttpServer())
  let adminAgent: ReturnType<typeof admin>
  let clinicId: number
  // Every email the app sends during this file (the invitations POST /users
  // sends) lands here instead of leaving the machine.
  const outbox = new InMemoryEmailTransport()

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

    // Created by the admin (public registration was removed), then activated
    // as if the invitation were accepted (test/support/accounts.ts).
    const createRes = await adminAgent.post('/users').send({
      email: `single-role-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Single',
      lastName: 'Role',
      dateOfBirth: '1990-01-01',
      phone: '555-0101',
      addressLine1: '1 Patient Lane',
      addressCity: 'Springfield',
      addressPostalCode: '62704',
      addressCountry: 'US',
    })
    expect(createRes.status).toBe(201)
    // Regression coverage: patient_profiles.dateOfBirth is written by
    // UsersService.create() but was once never attached to the response —
    // not even on the account's own creation.
    expect(createRes.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
    expect(createRes.body).not.toHaveProperty('practitionerProfile')
    expect(createRes.body).not.toHaveProperty('adminProfile')
    // phone/address live on `users` itself (moved off patient_profiles),
    // so they're common to every role.
    expect(createRes.body.phone).toBe('555-0101')
    expect(createRes.body.addressLine1).toBe('1 Patient Lane')
    await activateAccount(sessionPool, `single-role-${stamp}@example.com`)

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
      role: 'patient',
      firstName: 'Dual',
      lastName: 'Role',
      dateOfBirth: '1990-01-01',
    })
    expect(createRes.status).toBe(201)
    await activateAccount(sessionPool, `dual-role-${stamp}@example.com`)
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
})