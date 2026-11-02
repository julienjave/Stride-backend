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
import {
  InMemoryEmailTransport,
  findLink,
} from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { MessagingEvents } from '../src/messaging/messaging-events'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
describe('Users (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  // Kept, not just created inline: the invitation tests read what was sent.
  const outbox = new InMemoryEmailTransport()

  const adminAgent = () => request.agent(app.getHttpServer())
  const practitionerAAgent = () => request.agent(app.getHttpServer())
  const practitionerBAgent = () => request.agent(app.getHttpServer())
  const patient1Agent = () => request.agent(app.getHttpServer())
  const patient2Agent = () => request.agent(app.getHttpServer())

  let admin: ReturnType<typeof adminAgent>
  let practitionerA: ReturnType<typeof practitionerAAgent>
  let practitionerB: ReturnType<typeof practitionerBAgent>
  let patient1: ReturnType<typeof patient1Agent>
  let patient2: ReturnType<typeof patient2Agent>
  let clinicXId: number
  let adminId: number
  let clinicYId: number
  let patient1Id: number
  let patient2Id: number
  let patient2Email: string
  let practitionerAId: number
  let practitionerAEmail: string
  let practitionerAProfile: {
    licenseNumber: string
    specialties: string[]
    bio: string | null
  }
  let practitionerBId: number
  let practitionerBLicense: string

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Every invitation email lands in memory — tests never send real
      // email, whatever EMAIL_TRANSPORT says in .env.
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
    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    // --- Shared scaffolding for every test below ---
    admin = adminAgent()
    practitionerA = practitionerAAgent()
    practitionerB = practitionerBAgent()
    patient1 = patient1Agent()
    patient2 = patient2Agent()

    const stamp = Date.now()

    const clinicXRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Users E2E Clinic X',
      clinicEmail: `clinicx-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Users',
      lastName: 'Admin',
    })
    if (clinicXRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicXRes.body)}`,
      )
    }
    clinicXId = clinicXRes.body.clinicId
    adminId = clinicXRes.body.id

    const clinicYRes = await admin.post('/clinics').send({
      name: 'Users E2E Clinic Y',
      email: `clinicy-${stamp}@example.com`,
    })
    expect(clinicYRes.status).toBe(201)
    clinicYId = clinicYRes.body.id

    const practitionerARes = await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
      specialties: ['sports rehab'],
      bio: 'Specializes in post-op rehab.',
      phone: '555-0200',
      addressLine1: '1 Practitioner Ave',
      addressCity: 'Springfield',
      addressPostalCode: '62704',
      addressCountry: 'US',
      clinicId: clinicXId,
    })
    await activateAccount(sessionPool, `practitioner-a-${stamp}@example.com`)
    expect(practitionerARes.status).toBe(201)
    // Regression coverage for the gap this fix closes: practitioner_profiles
    // is written by UsersService.create() but was never attached to its own
    // response — not even here, on the account's own creation. bio was a
    // completely dead column (no DTO field, never read back) until now.
    expect(practitionerARes.body.practitionerProfile).toEqual({
      licenseNumber: `PT-A-${stamp}`,
      specialties: ['sports rehab'],
      bio: 'Specializes in post-op rehab.',
    })
    // phone/address moved from patient_profiles onto users itself — now
    // common to every role, including a practitioner.
    expect(practitionerARes.body.phone).toBe('555-0200')
    expect(practitionerARes.body.addressLine1).toBe('1 Practitioner Ave')
    practitionerAId = practitionerARes.body.id
    practitionerAEmail = `practitioner-a-${stamp}@example.com`
    practitionerAProfile = practitionerARes.body.practitionerProfile
    await practitionerA.post('/auth/login').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
    })

    const practitionerBRes = await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
      clinicId: clinicYId,
    })
    await activateAccount(sessionPool, `practitioner-b-${stamp}@example.com`)
    expect(practitionerBRes.status).toBe(201)
    practitionerBId = practitionerBRes.body.id
    practitionerBLicense = `PT-B-${stamp}`
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    })

    const patient1Res = await admin.post('/users').send({
      email: `patient1-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Patient',
      lastName: 'One',
      dateOfBirth: '1990-01-01',
      phone: '555-0300',
      addressLine1: '1 Patient One Street',
      addressCity: 'Springfield',
      addressPostalCode: '62704',
      addressCountry: 'US',
      clinicId: clinicXId,
    })
    await activateAccount(sessionPool, `patient1-${stamp}@example.com`)
    expect(patient1Res.status).toBe(201)
    patient1Id = patient1Res.body.id
    expect(patient1Res.body.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
    expect(patient1Res.body).not.toHaveProperty('practitionerProfile')
    expect(patient1Res.body).not.toHaveProperty('adminProfile')
    // phone/address are common to every role now — a patient gets them too,
    // read straight off `users` rather than the old patient_profiles columns.
    expect(patient1Res.body.phone).toBe('555-0300')
    expect(patient1Res.body.addressLine1).toBe('1 Patient One Street')
    await patient1.post('/auth/login').send({
      email: `patient1-${stamp}@example.com`,
      password: 'password123',
    })

    // Since the care team (decisions §3), sharing a clinic no longer makes a
    // practitioner "manage" a patient — being on the patient's care team does.
    // practitionerA joins through the real endpoint (an empty body = "join").
    const joinRes = await practitionerA
      .post(`/users/${patient1Id}/care-team`)
      .send({})
    expect(joinRes.status).toBe(201)

    patient2Email = `patient2-${stamp}@example.com`
    const patient2Res = await admin.post('/users').send({
      email: patient2Email,
      role: 'patient',
      firstName: 'Patient',
      lastName: 'Two',
      dateOfBirth: '1990-01-01',
      clinicId: clinicYId,
    })
    await activateAccount(sessionPool, patient2Email)
    expect(patient2Res.status).toBe(201)
    patient2Id = patient2Res.body.id
    await patient2.post('/auth/login').send({
      email: patient2Email,
      password: 'password123',
    })
  })

  afterAll(async () => {
    await app.close()
    // app.close() only closes what Nest's own DI container manages.
    // sessionPool was created manually, outside that container, so it needs
    // to be closed explicitly too.
    await sessionPool.end()
  })

  it('lets a patient view and update their own profile', async () => {
    const viewRes = await patient1.get(`/users/${patient1Id}`)
    expect(viewRes.status).toBe(200)

    const updateRes = await patient1
      .patch(`/users/${patient1Id}`)
      .send({ firstName: 'Updated' })
    expect(updateRes.status).toBe(200)
    expect(updateRes.body.firstName).toBe('Updated')
    // Regression coverage: PATCH /users/:id goes through the same
    // toPublic()+roles+attachProfile() pattern as GET — profile data
    // (unaffected by this edit, which only touches firstName) should still
    // be present in the response.
    expect(updateRes.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    // phone/address are plain `users` columns now (moved off
    // patient_profiles), so they fall through UpdateUserDto's own
    // `rest`/`userFields` destructuring with no role-gating at all — every
    // role can update them the same way.
    const contactUpdateRes = await patient1
      .patch(`/users/${patient1Id}`)
      .send({ phone: '555-9999', addressLine1: '99 Updated Ave' })
    expect(contactUpdateRes.status).toBe(200)
    expect(contactUpdateRes.body.phone).toBe('555-9999')
    expect(contactUpdateRes.body.addressLine1).toBe('99 Updated Ave')
  })

  it('lets an admin update anyone', async () => {
    const res = await admin
      .patch(`/users/${patient1Id}`)
      .send({ firstName: 'AdminEdited' })
    expect(res.status).toBe(200)
    expect(res.body.firstName).toBe('AdminEdited')
  })

  it('lets a managing practitioner (on the care team) update the patient', async () => {
    const res = await practitionerA
      .patch(`/users/${patient1Id}`)
      .send({ firstName: 'PractitionerEdited' })
    expect(res.status).toBe(200)
    expect(res.body.firstName).toBe('PractitionerEdited')
  })

  it('rejects a non-managing practitioner (no shared clinic) from updating the patient', async () => {
    const res = await practitionerB
      .patch(`/users/${patient1Id}`)
      .send({ firstName: 'ShouldNotWork' })
    expect(res.status).toBe(403)
  })

  it('rejects one patient viewing or updating a profile that is not theirs', async () => {
    const viewRes = await patient2.get(`/users/${patient1Id}`)
    expect(viewRes.status).toBe(403)

    const updateRes = await patient2
      .patch(`/users/${patient1Id}`)
      .send({ firstName: 'Hijacked' })
    expect(updateRes.status).toBe(403)
  })

  it('scopes GET /users to only care-team patients for a practitioner, and to everyone for an admin — and attaches roles + profile data to both branches', async () => {
    const forPractitionerA = await practitionerA.get('/users')
    expect(forPractitionerA.status).toBe(200)
    const idsForA = forPractitionerA.body.map((u: any) => u.id)
    expect(idsForA).toContain(patient1Id)
    expect(idsForA).not.toContain(patient2Id)
    // Regression coverage: findPatientsForPractitioner() (this branch of
    // GET /users) previously attached neither roles nor profile data at
    // all, unlike every single-user fetch.
    const patient1InList = forPractitionerA.body.find(
      (u: any) => u.id === patient1Id,
    )
    expect(patient1InList.roles).toEqual(['patient'])
    expect(patient1InList.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    const forAdmin = await admin.get('/users')
    expect(forAdmin.status).toBe(200)
    const idsForAdmin = forAdmin.body.map((u: any) => u.id)
    expect(idsForAdmin).toEqual(
      expect.arrayContaining([patient1Id, patient2Id]),
    )
    // Same regression coverage, findAll() branch — plus a practitioner in
    // the same list, to prove role-appropriate nesting (not just patients).
    const patient1InAdminList = forAdmin.body.find(
      (u: any) => u.id === patient1Id,
    )
    expect(patient1InAdminList.roles).toEqual(['patient'])
    expect(patient1InAdminList.patientProfile).toEqual({
      dateOfBirth: '1990-01-01',
    })
    const practitionerAInAdminList = forAdmin.body.find(
      (u: any) => u.email === practitionerAEmail,
    )
    expect(practitionerAInAdminList.roles).toEqual(['practitioner'])
    expect(practitionerAInAdminList.practitionerProfile).toEqual(
      practitionerAProfile,
    )
  })

  it('rejects a plain patient from listing users at all', async () => {
    const res = await patient1.get('/users')
    expect(res.status).toBe(403)
  })

  it('lets a user deactivate their own account (self soft-delete)', async () => {
    const stamp = Date.now()
    const selfCreate = await admin.post('/users').send({
      email: `self-delete-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Self',
      lastName: 'Delete',
      dateOfBirth: '1990-01-01',
    })
    await activateAccount(sessionPool, `self-delete-${stamp}@example.com`)
    expect(selfCreate.status).toBe(201)
    const selfAgent = request.agent(app.getHttpServer())
    await selfAgent.post('/auth/login').send({
      email: `self-delete-${stamp}@example.com`,
      password: 'password123',
    })

    const deleteRes = await selfAgent.delete(`/users/${selfCreate.body.id}`)
    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.isActive).toBe(false)
    // Regression coverage: DELETE /users/:id (soft-delete) goes through the
    // same attachProfile() pattern as GET/PATCH.
    expect(deleteRes.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })
  })

  // Deactivating signs the account out everywhere — its sessions deleted in
  // the deactivation's transaction, their messaging sockets closed (a socket
  // is checked once, at its handshake, so a deactivated person's open tab
  // would otherwise keep receiving messages; found 2026-10-22). The sessions
  // are read just before: the session table outlives each suite's TRUNCATE,
  // and earlier suites' sessions can carry this account's id too — every one
  // of them must go.
  it('signs a deactivated account out everywhere, closing its sockets', async () => {
    const email = `signed-out-${Date.now()}@example.com`
    const create = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Signed',
      lastName: 'Out',
      dateOfBirth: '1990-01-01',
    })
    expect(create.status).toBe(201)
    const id = create.body.id as number
    await activateAccount(sessionPool, email)
    const phone = request.agent(app.getHttpServer())
    const laptop = request.agent(app.getHttpServer())
    for (const device of [phone, laptop]) {
      const login = await device
        .post('/auth/login')
        .send({ email, password: 'password123' })
      expect(login.status).toBe(201)
    }
    const sessionsOf = async () =>
      (
        await sessionPool.query<{ sid: string }>(
          `SELECT sid FROM session
            WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
          [String(id)],
        )
      ).rows.map((row) => row.sid)
    const before = await sessionsOf()
    expect(before.length).toBeGreaterThanOrEqual(2)
    const disconnect = jest.spyOn(app.get(MessagingEvents), 'disconnectSession')

    const res = await admin.delete(`/users/${id}`)
    const closed = disconnect.mock.calls.map(([sid]) => sid)
    disconnect.mockRestore()

    expect(res.status).toBe(200)
    expect(res.body.isActive).toBe(false)
    expect(await sessionsOf()).toEqual([])
    expect(closed.sort()).toEqual([...before].sort())
    expect((await phone.get('/auth/me')).status).toBe(401)
    expect((await laptop.get('/auth/me')).status).toBe(401)
    const { rows } = await sessionPool.query<{
      details: Record<string, unknown>
    }>(
      `SELECT details FROM audit_logs
        WHERE action = 'USER_DEACTIVATED' AND target_user_id = $1`,
      [id],
    )
    expect(rows).toEqual([
      {
        details: {
          changes: { isActive: { from: true, to: false } },
          signedOutSessions: before.length,
          // A patient's links are never ended by a deactivation.
          endedCareTeamLinkIds: [],
        },
      },
    ])
  })

  it('lets a managing practitioner deactivate one of their own patients', async () => {
    const stamp = Date.now()
    // Created BY practitionerA: a practitioner who creates a patient is put
    // on their care team automatically (UsersService.create()), which is
    // what makes them "one of their own patients" here.
    const create = await practitionerA.post('/users').send({
      email: `managed-delete-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Managed',
      lastName: 'Delete',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    })
    expect(create.status).toBe(201)

    const deleteRes = await practitionerA.delete(`/users/${create.body.id}`)
    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.isActive).toBe(false)
  })

  it('rejects a non-managing practitioner from deactivating a patient they do not manage', async () => {
    const stamp = Date.now()
    const create = await admin.post('/users').send({
      email: `unmanaged-delete-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Unmanaged',
      lastName: 'Delete',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    })
    expect(create.status).toBe(201)

    const deleteRes = await practitionerB.delete(`/users/${create.body.id}`)
    expect(deleteRes.status).toBe(403)
  })

  // --- Accounts are created by invitation (design decisions §3) ---

  // No password in the request, none stored, and an invitation emailed at
  // once — the person chooses their own password by accepting it
  // (test/invitations.e2e-spec.ts tests that half).
  it('creates an account without a password, and sends it a pending invitation', async () => {
    const email = `invited-${Date.now()}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Invited',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    })
    expect(res.status).toBe(201)
    expect(res.body.invitation).toMatchObject({
      status: 'pending',
      emailSent: true,
    })
    expect(res.body).not.toHaveProperty('passwordHash')

    const { rows } = await sessionPool.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [res.body.id],
    )
    expect(rows[0].password_hash).toBeNull()

    const sent = outbox.lastSentTo(email)
    expect(sent.subject).toBe("You're invited to Stride")
    expect(
      findLink(sent, '/accept-invitation').searchParams.get('token'),
    ).toMatch(/^[0-9a-f]{64}$/)

    const history = await admin.get(`/users/${res.body.id}/invitations`)
    expect(history.body).toHaveLength(1)
    expect(history.body[0]).toMatchObject({
      id: res.body.invitation.id,
      status: 'pending',
      invitedBy: { id: adminId },
    })
  })

  // An old client still sending a password fails loudly (the global
  // ValidationPipe forbids unknown fields) instead of having it silently
  // ignored — someone would otherwise believe they had set it.
  it('refuses a password in the request', async () => {
    const res = await admin.post('/users').send({
      email: `with-password-${Date.now()}@example.com`,
      password: 'password123',
      role: 'admin',
      firstName: 'With',
      lastName: 'Password',
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('property password should not exist')
  })

  // Against the REAL row-level security: the invitations insert policy
  // lets a practitioner invite only a patient whose care team they're on.
  // UsersService.create() links the creator to the care team BEFORE it
  // creates the invitation, in the same transaction — reversed, the policy
  // would refuse the INSERT and this creation would fail.
  it('records the practitioner who creates a patient as the inviter', async () => {
    const email = `invited-by-practitioner-${Date.now()}@example.com`
    const res = await practitionerA.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Invited',
      lastName: 'ByPractitioner',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    })
    expect(res.status).toBe(201)
    expect(res.body.invitation.status).toBe('pending')

    const history = await practitionerA.get(`/users/${res.body.id}/invitations`)
    expect(history.body[0].invitedBy.id).toBe(practitionerAId)
    expect(outbox.sentTo(email)).toHaveLength(1)
  })

  it('rejects a practitioner creating anything other than a patient account', async () => {
    const stamp = Date.now()
    const res = await practitionerA.post('/users').send({
      email: `should-not-be-created-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Should',
      lastName: 'NotWork',
      licenseNumber: `PT-X-${stamp}`,
    })
    expect(res.status).toBe(403)
  })

  it('rejects a practitioner creating a patient in a clinic they do not belong to', async () => {
    const stamp = Date.now()
    const res = await practitionerA.post('/users').send({
      email: `cross-clinic-patient-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Cross',
      lastName: 'Clinic',
      dateOfBirth: '1990-01-01',
      clinicId: clinicYId,
    })
    expect(res.status).toBe(403)
  })

  it('lets a practitioner create a patient in their own clinic', async () => {
    const stamp = Date.now()
    const res = await practitionerA.post('/users').send({
      email: `own-clinic-patient-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Own',
      lastName: 'Clinic',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    })
    expect(res.status).toBe(201)
  })

  it('lets an admin create a patient in any clinic, exempt from the clinic-ownership check', async () => {
    const stamp = Date.now()
    const res = await admin.post('/users').send({
      email: `admin-cross-clinic-patient-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Admin',
      lastName: 'CrossClinic',
      dateOfBirth: '1990-01-01',
      clinicId: clinicYId,
    })
    expect(res.status).toBe(201)
  })

  it('scopes GET /users/:id: rejects an unrelated practitioner, allows the managing practitioner, self, and admin — all three see the same profile data', async () => {
    const unrelated = await practitionerB.get(`/users/${patient1Id}`)
    expect(unrelated.status).toBe(403)

    // Regression coverage for the actual gap this fix closes: whoever
    // already passes the existing self/admin/managing-practitioner check
    // gets the same profile fields — no new, finer-grained rule.
    const managing = await practitionerA.get(`/users/${patient1Id}`)
    expect(managing.status).toBe(200)
    expect(managing.body.id).toBe(patient1Id)
    expect(managing.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    const self = await patient1.get(`/users/${patient1Id}`)
    expect(self.status).toBe(200)
    expect(self.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    const adminView = await admin.get(`/users/${patient1Id}`)
    expect(adminView.status).toBe(200)
    expect(adminView.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    // A practitioner viewing themself sees their own practitionerProfile,
    // never a patientProfile they don't have.
    const practitionerSelf = await practitionerA.get(
      `/users/${practitionerAId}`,
    )
    expect(practitionerSelf.status).toBe(200)
    expect(practitionerSelf.body.practitionerProfile).toEqual(
      practitionerAProfile,
    )
    expect(practitionerSelf.body).not.toHaveProperty('patientProfile')
  })

  // No route to POST /users/:id/roles was exercised anywhere in this suite
  // before — real gap, closed here specifically because grantRole()'s own
  // userRoles INSERT changed as part of the user_roles RLS pass (routed
  // through withRlsContext with the acting admin's real session now, not a
  // plain db.transaction() with no RLS context at all — see the migration
  // comment on user_roles_insert for why the old shape would have failed
  // outright under FORCE ROW LEVEL SECURITY).
  it('lets an admin grant an additional role, rejects a non-admin attempting the same, and the granted role is real (not just echoed)', async () => {
    const stamp = Date.now()

    const forbidden = await practitionerA
      .post(`/users/${patient2Id}/roles`)
      .send({ role: 'practitioner', licenseNumber: `PT-GRANT-${stamp}` })
    expect(forbidden.status).toBe(403)

    const granted = await admin
      .post(`/users/${patient2Id}/roles`)
      .send({ role: 'practitioner', licenseNumber: `PT-GRANT-${stamp}` })
    expect(granted.status).toBe(201)
    expect(granted.body).toEqual(
      expect.arrayContaining(['patient', 'practitioner']),
    )

    // Proves the INSERT genuinely committed under user_roles' real RLS
    // policy, not just that the HTTP response looked right — patient2's
    // ALREADY-authenticated session (no fresh login, deliberately: the
    // point is that an existing session sees the new role) can now switch
    // to the newly-granted role.
    // switchRole() only allows switching to a role deserializeUser()'s own
    // fresh reload (UsersService.findOne() -> getRolesForUser(), a genuinely
    // separate connection from grantRole()'s own transaction) actually
    // finds — this exercises exactly the read-after-commit path the
    // getRolesForUser(userId, tx) fix above was about, from the other side.
    const switched = await patient2
      .post('/auth/switch-role')
      .send({ role: 'practitioner' })
    expect(switched.status).toBe(201)
    expect(switched.body.activeRole).toBe('practitioner')

    const duplicate = await admin
      .post(`/users/${patient2Id}/roles`)
      .send({ role: 'practitioner', licenseNumber: `PT-GRANT-DUP-${stamp}` })
    expect(duplicate.status).toBe(409)
  })

  // Real gap this fix closes: licenseNumber/specialties, dateOfBirth, and
  // position were writable at account creation (create(), grantRole()) but
  // had no update path at all — UpdateUserDto only ever had firstName/
  // lastName. Reuses the identical isSelf||isAdmin||isManagingPractitioner
  // check already covered above; the coverage below is specifically about
  // the profile-field extension itself, plus the extra constraint that
  // field applicability is scoped to the TARGET's actual held role(s), not
  // the caller's. Placed last in the file deliberately: several of these
  // mutate patient1Id's dateOfBirth and practitionerAId's specialties, both
  // asserted as their ORIGINAL values by several earlier tests above.
  describe('profile-field updates (licenseNumber/specialties, dateOfBirth, position)', () => {
    // Set by the licenseNumber self-update test below, then read by the bio
    // self-update test right after it — both mutate practitionerAId's row in
    // sequence, so the bio test needs the license value as it stands AFTER
    // that update, not practitionerAProfile's original creation-time value.
    let practitionerACurrentLicense: string

    it('lets a patient self-update their own dateOfBirth', async () => {
      const res = await patient1
        .patch(`/users/${patient1Id}`)
        .send({ dateOfBirth: '1991-02-02' })
      expect(res.status).toBe(200)
      expect(res.body.patientProfile).toEqual({ dateOfBirth: '1991-02-02' })
    })

    it("lets an admin update any user's profile field — a practitioner's specialties here", async () => {
      const res = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ specialties: ['sports rehab', 'geriatrics'] })
      expect(res.status).toBe(200)
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: practitionerAProfile.licenseNumber,
        specialties: ['sports rehab', 'geriatrics'],
        bio: practitionerAProfile.bio,
      })
    })

    // licenseNumber became admin-only (design decisions §4): a professional
    // credential, set or verified by an admin — no longer self-editable.
    it('refuses a practitioner changing their own licenseNumber, and changes nothing — not even the other field sent with it', async () => {
      const res = await practitionerA.patch(`/users/${practitionerAId}`).send({
        licenseNumber: `PT-A-SELF-${Date.now()}`,
        specialties: ['should not apply'],
      })
      expect(res.status).toBe(403)

      // Read back with a separate GET: the response to a refused request
      // proves nothing about what's stored.
      const readBack = await admin.get(`/users/${practitionerAId}`)
      expect(readBack.body.practitionerProfile).toEqual({
        licenseNumber: practitionerAProfile.licenseNumber,
        specialties: ['sports rehab', 'geriatrics'],
        bio: practitionerAProfile.bio,
      })
    })

    it('still lets a practitioner self-update their other practitionerProfile fields — specialties here', async () => {
      const res = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ specialties: ['sports rehab'] })
      expect(res.status).toBe(200)
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: practitionerAProfile.licenseNumber,
        specialties: ['sports rehab'],
        bio: practitionerAProfile.bio,
      })
    })

    it("lets an admin change a practitioner's licenseNumber", async () => {
      const newLicense = `PT-A-UPDATED-${Date.now()}`
      const res = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ licenseNumber: newLicense })
      expect(res.status).toBe(200)
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: newLicense,
        specialties: ['sports rehab'],
        bio: practitionerAProfile.bio,
      })
      practitionerACurrentLicense = newLicense
    })

    // licenseNumber is UNIQUE in the database. A collision used to surface
    // as a 500 (unhandled Postgres error 23505); it's now a 409.
    it('returns 409 — not 500 — when an admin sets a license number another practitioner already holds, and keeps the old one', async () => {
      const res = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ licenseNumber: practitionerBLicense })
      expect(res.status).toBe(409)

      const readBack = await admin.get(`/users/${practitionerAId}`)
      expect(readBack.body.practitionerProfile.licenseNumber).toBe(
        practitionerACurrentLicense,
      )
    })

    // bio was a completely dead column before this fix: a real column on
    // practitioner_profiles with no DTO field anywhere and never attached to
    // any response. This proves it now round-trips through PATCH the same
    // way licenseNumber/specialties already did.
    it('lets a practitioner self-update their own bio, and reads it back', async () => {
      const res = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ bio: 'Updated bio after a PATCH.' })
      expect(res.status).toBe(200)
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: practitionerACurrentLicense,
        specialties: ['sports rehab'],
        bio: 'Updated bio after a PATCH.',
      })
    })

    it("lets a managing practitioner update a managed patient's patientProfile field", async () => {
      const res = await practitionerA
        .patch(`/users/${patient1Id}`)
        .send({ dateOfBirth: '1992-03-03' })
      expect(res.status).toBe(200)
      expect(res.body.patientProfile).toEqual({ dateOfBirth: '1992-03-03' })
    })

    it('rejects one patient updating a profile field on a user that is not theirs', async () => {
      const res = await patient2
        .patch(`/users/${patient1Id}`)
        .send({ dateOfBirth: '2000-01-01' })
      expect(res.status).toBe(403)
    })

    it('rejects a non-managing practitioner from updating a profile field on a patient they do not manage', async () => {
      const res = await practitionerB
        .patch(`/users/${patient1Id}`)
        .send({ dateOfBirth: '2000-01-01' })
      expect(res.status).toBe(403)
    })

    it("rejects a practitioner from updating another practitioner's profile", async () => {
      const res = await practitionerA
        .patch(`/users/${practitionerBId}`)
        .send({ specialties: ['hijacked'] })
      expect(res.status).toBe(403)
    })

    // The top-level isSelf||isAdmin||isManagingPractitioner check is not the
    // only gate: which profile fields even apply depends on the TARGET's
    // actual held role(s). An admin passes the check above unconditionally,
    // but still can't write a field the target has no profile for.
    it('rejects a profile field that does not apply to the target — even for an admin caller', async () => {
      const licenseOnPatient = await admin
        .patch(`/users/${patient1Id}`)
        .send({ licenseNumber: 'PT-SHOULD-FAIL' })
      expect(licenseOnPatient.status).toBe(400)

      // bio is gated the same way as licenseNumber/specialties — a
      // practitioner-profile field, rejected for a target with no
      // practitioner role at all, even for an admin caller.
      const bioOnPatient = await admin
        .patch(`/users/${patient1Id}`)
        .send({ bio: 'Should Fail' })
      expect(bioOnPatient.status).toBe(400)

      const positionOnPractitioner = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ position: 'Should Fail' })
      expect(positionOnPractitioner.status).toBe(400)

      const dateOfBirthOnPractitioner = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ dateOfBirth: '1990-01-01' })
      expect(dateOfBirthOnPractitioner.status).toBe(400)
    })

    // Required (NOT NULL) columns can be left out of a PATCH, but not
    // cleared. An explicit null used to slip past @IsOptional() and reach
    // Postgres, which answered with a 500; it's now a 400 from validation.
    it('rejects clearing a required field (null or empty) with a 400', async () => {
      const nullFirstName = await admin
        .patch(`/users/${patient1Id}`)
        .send({ firstName: null })
      expect(nullFirstName.status).toBe(400)

      const emptyLastName = await admin
        .patch(`/users/${patient1Id}`)
        .send({ lastName: '' })
      expect(emptyLastName.status).toBe(400)

      const nullDateOfBirth = await admin
        .patch(`/users/${patient1Id}`)
        .send({ dateOfBirth: null })
      expect(nullDateOfBirth.status).toBe(400)

      const nullSpecialties = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ specialties: null })
      expect(nullSpecialties.status).toBe(400)
    })

    // ...while nullable columns CAN be cleared — this is how the profile
    // page removes a value.
    it('lets a user clear an optional field with null, and reads it back as null', async () => {
      const res = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ bio: null, phone: null })
      expect(res.status).toBe(200)

      const readBack = await admin.get(`/users/${practitionerAId}`)
      expect(readBack.body.phone).toBeNull()
      expect(readBack.body.practitionerProfile.bio).toBeNull()
    })
  })

  // The same unique constraint guards the two other places a license
  // number is written: creating a practitioner, and granting the
  // practitioner role. Both used to answer a duplicate with a 500.
  describe('duplicate licenseNumber on create and grant-role', () => {
    it('returns 409 when creating a practitioner with a taken license — and leaves no half-created account behind', async () => {
      const email = `dup-license-${Date.now()}@example.com`
      const body = {
        email,
        role: 'practitioner',
        firstName: 'Dup',
        lastName: 'License',
        licenseNumber: practitionerBLicense,
        clinicId: clinicXId,
      }

      const duplicate = await admin.post('/users').send(body)
      expect(duplicate.status).toBe(409)

      // The users row is inserted BEFORE the profile row, in the same
      // transaction. If the rollback didn't happen, this email would now be
      // taken and the retry would be a 409 for the EMAIL instead.
      const retry = await admin
        .post('/users')
        .send({ ...body, licenseNumber: `PT-DUP-RETRY-${Date.now()}` })
      expect(retry.status).toBe(201)
    })

    it('returns 409 when granting the practitioner role with a taken license — and the role is not granted', async () => {
      const res = await admin
        .post(`/users/${patient1Id}/roles`)
        .send({ role: 'practitioner', licenseNumber: practitionerBLicense })
      expect(res.status).toBe(409)

      const readBack = await admin.get(`/users/${patient1Id}`)
      expect(readBack.body.roles).toEqual(['patient'])
    })
  })

  // The weight-unit preference (a users column, NOT NULL DEFAULT 'kg').
  // Uses patient2, whom no earlier test successfully edits. In order:
  // default, then refused changes (which must leave the default in place),
  // then the one allowed change.
  describe('preferredWeightUnit', () => {
    it("defaults to 'kg' for an account that never set it — on /users/:id and /auth/me", async () => {
      const userRes = await patient2.get(`/users/${patient2Id}`)
      expect(userRes.body.preferredWeightUnit).toBe('kg')

      // /auth/me is where the frontend actually reads it from.
      const meRes = await patient2.get('/auth/me')
      expect(meRes.body.preferredWeightUnit).toBe('kg')
    })

    it("refuses an admin changing someone else's preference, and changes nothing", async () => {
      const res = await admin
        .patch(`/users/${patient2Id}`)
        .send({ preferredWeightUnit: 'lbs' })
      expect(res.status).toBe(403)

      const readBack = await admin.get(`/users/${patient2Id}`)
      expect(readBack.body.preferredWeightUnit).toBe('kg')
    })

    // null: the column is NOT NULL — before the DTO rule this would have
    // reached Postgres and come back as a 500.
    it.each([null, 'stone'])('rejects %j with a 400', async (value) => {
      const res = await patient2
        .patch(`/users/${patient2Id}`)
        .send({ preferredWeightUnit: value })
      expect(res.status).toBe(400)
    })

    it('lets a user change their own preference, and /auth/me reflects it', async () => {
      const res = await patient2
        .patch(`/users/${patient2Id}`)
        .send({ preferredWeightUnit: 'lbs' })
      expect(res.status).toBe(200)
      expect(res.body.preferredWeightUnit).toBe('lbs')

      // A separate read: the session's user is rebuilt from the database on
      // every request, so the next /auth/me must already carry the change.
      const meRes = await patient2.get('/auth/me')
      expect(meRes.body.preferredWeightUnit).toBe('lbs')
    })
  })

  // "Easier-to-read font" (decisions §39): a users column, NOT NULL DEFAULT
  // false, on the ACCOUNT so it follows the person and not the device. The
  // frontend reads it from /auth/me AND from the sign-in answer (it caches
  // that answer as the current user), so both are checked. patient2 again,
  // in order: default, refusals, the one allowed change.
  describe('readableFont', () => {
    it('is off for an account that never set it — on /auth/me', async () => {
      const meRes = await patient2.get('/auth/me')
      expect(meRes.body.readableFont).toBe(false)
    })

    it("refuses an admin changing someone else's setting, and changes nothing", async () => {
      const res = await admin
        .patch(`/users/${patient2Id}`)
        .send({ readableFont: true })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([
        'Only the user themselves can change their font setting',
      ])

      const meRes = await patient2.get('/auth/me')
      expect(meRes.body.readableFont).toBe(false)
    })

    // null: the column is NOT NULL (a 500 without the DTO rule).
    it.each([null, 'yes', 1])('rejects %j with a 400', async (value) => {
      const res = await patient2
        .patch(`/users/${patient2Id}`)
        .send({ readableFont: value })
      expect(res.status).toBe(400)
    })

    it('lets a user turn it on, records it once, and every sign-in answer carries it', async () => {
      const res = await patient2
        .patch(`/users/${patient2Id}`)
        .send({ readableFont: true })
      expect(res.status).toBe(200)
      expect(res.body.readableFont).toBe(true)

      // The account's own audit trail, like any change to the account.
      const entries = await sessionPool.query<{ details: unknown }>(
        `SELECT details FROM audit_logs
          WHERE action = 'USER_UPDATED' AND target_user_id = $1
            AND details->'changes' ? 'readableFont'`,
        [patient2Id],
      )
      expect(entries.rows.map((row) => row.details)).toEqual([
        { changes: { readableFont: { from: false, to: true } } },
      ])

      expect((await patient2.get('/auth/me')).body.readableFont).toBe(true)

      // A sign-in on ANOTHER device gets the setting at once — the reason it
      // lives on the account. (`role`: patient2 was granted a second role
      // earlier in this file, so the sign-in must say which.)
      const otherDevice = request.agent(app.getHttpServer())
      const login = await otherDevice.post('/auth/login').send({
        email: patient2Email,
        password: 'password123',
        role: 'patient',
      })
      expect(login.status).toBe(201)
      expect(login.body.readableFont).toBe(true)
    })

    // Decisions §41: the setting is the person's own. patient2's is ON by
    // now (the test above), so a leak would show a real value. Every answer
    // ABOUT patient2 to someone else — one user, the list, an admin's edit —
    // must leave it out; patient2's own answers keep it (above).
    it('never shows the setting to anyone else', async () => {
      const one = await admin.get(`/users/${patient2Id}`)
      expect(one.status).toBe(200)
      expect(one.body).not.toHaveProperty('readableFont')

      // The whole list (GET /users answers an array of every account).
      const list = await admin.get('/users')
      expect(list.status).toBe(200)
      const row = (list.body as Record<string, unknown>[]).find(
        (u) => u.id === patient2Id,
      )
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('readableFont')

      // An admin's edit answers with the public shape. The same first name
      // is sent back, so nothing about patient2 actually changes.
      const edit = await admin
        .patch(`/users/${patient2Id}`)
        .send({ firstName: one.body.firstName as string })
      expect(edit.status).toBe(200)
      expect(edit.body).not.toHaveProperty('readableFont')

      // …and the owner still has it.
      expect((await patient2.get('/auth/me')).body.readableFont).toBe(true)
    })
  })

  // Avatars (POST/DELETE /users/:id/avatar). These go all the way to the
  // real RustFS, so besides status codes they check the thing a user would
  // notice: does the returned avatarUrl actually load the image, and does
  // an old one stop loading once it's replaced or removed? Uses patient1
  // (managed by practitionerA, not by practitionerB) and patient2.
  describe('avatars', () => {
    // A stand-in for real image bytes — the upload filter only checks the
    // declared Content-Type, never the content (same as in
    // exercises.e2e-spec.ts).
    const fakeImage = (label: string) => Buffer.from(`fake-avatar-${label}`)

    // Loads a presigned URL the way a browser's <img> would: a plain GET,
    // no cookie, straight to storage. Returns the status and the body.
    const loadImage = async (url: string) => {
      const response = await fetch(url)
      return {
        status: response.status,
        body: Buffer.from(await response.arrayBuffer()),
      }
    }

    // Carried between the tests below, which run in order.
    let firstAvatarUrl: string
    let secondAvatarUrl: string

    it('starts as avatarUrl: null, with no raw avatarPath anywhere', async () => {
      const meRes = await patient1.get('/auth/me')
      expect(meRes.body.avatarUrl).toBeNull()
      expect(meRes.body).not.toHaveProperty('avatarPath')

      const userRes = await admin.get(`/users/${patient1Id}`)
      expect(userRes.body.avatarUrl).toBeNull()
      expect(userRes.body).not.toHaveProperty('avatarPath')
    })

    it('lets a user upload their own avatar, and the returned avatarUrl really serves the image', async () => {
      const res = await patient1
        .post(`/users/${patient1Id}/avatar`)
        .attach('file', fakeImage('first'), {
          filename: 'me.png',
          contentType: 'image/png',
        })
      expect(res.status).toBe(201)
      expect(res.body).not.toHaveProperty('avatarPath')
      expect(typeof res.body.avatarUrl).toBe('string')
      firstAvatarUrl = res.body.avatarUrl

      const image = await loadImage(firstAvatarUrl)
      expect(image.status).toBe(200)
      expect(image.body.toString()).toBe('fake-avatar-first')

      // /auth/me is where the header reads it from.
      const meRes = await patient1.get('/auth/me')
      expect(typeof meRes.body.avatarUrl).toBe('string')
      expect(meRes.body).not.toHaveProperty('avatarPath')
    })

    it('deletes the old file when the avatar is replaced', async () => {
      const res = await patient1
        .post(`/users/${patient1Id}/avatar`)
        .attach('file', fakeImage('second'), {
          filename: 'me.png',
          contentType: 'image/png',
        })
      expect(res.status).toBe(201)
      secondAvatarUrl = res.body.avatarUrl
      expect(secondAvatarUrl).not.toBe(firstAvatarUrl)

      const newImage = await loadImage(secondAvatarUrl)
      expect(newImage.status).toBe(200)
      expect(newImage.body.toString()).toBe('fake-avatar-second')

      // The first URL's signature is still valid (24 hours), so a 404 here
      // can only mean one thing: the file itself is gone from storage.
      const oldImage = await loadImage(firstAvatarUrl)
      expect(oldImage.status).toBe(404)
    })

    it('rejects a file that is not an image with a 400', async () => {
      const res = await patient1
        .post(`/users/${patient1Id}/avatar`)
        .attach('file', Buffer.from('not an image'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
      expect(res.status).toBe(400)
    })

    it("refuses a managing practitioner uploading or removing their patient's avatar, and changes nothing", async () => {
      const uploadRes = await practitionerA
        .post(`/users/${patient1Id}/avatar`)
        .attach('file', fakeImage('intruder'), {
          filename: 'x.png',
          contentType: 'image/png',
        })
      expect(uploadRes.status).toBe(403)

      const removeRes = await practitionerA.delete(
        `/users/${patient1Id}/avatar`,
      )
      expect(removeRes.status).toBe(403)

      // Still the second photo, still in storage.
      const image = await loadImage(secondAvatarUrl)
      expect(image.status).toBe(200)
      expect(image.body.toString()).toBe('fake-avatar-second')
    })

    it("refuses another patient removing someone else's avatar", async () => {
      const res = await patient2.delete(`/users/${patient1Id}/avatar`)
      expect(res.status).toBe(403)
    })

    it("lets an admin remove someone's avatar: avatarUrl becomes null and the file is gone", async () => {
      const res = await admin.delete(`/users/${patient1Id}/avatar`)
      expect(res.status).toBe(200)
      expect(res.body.avatarUrl).toBeNull()
      expect(res.body).not.toHaveProperty('avatarPath')

      const image = await loadImage(secondAvatarUrl)
      expect(image.status).toBe(404)

      const meRes = await patient1.get('/auth/me')
      expect(meRes.body.avatarUrl).toBeNull()
    })

    it('treats removing an avatar that is already gone as a success (idempotent)', async () => {
      const res = await patient1.delete(`/users/${patient1Id}/avatar`)
      expect(res.status).toBe(200)
      expect(res.body.avatarUrl).toBeNull()
    })

    it("lets an admin set someone else's avatar, and that user remove it themselves", async () => {
      const uploadRes = await admin
        .post(`/users/${patient2Id}/avatar`)
        .attach('file', fakeImage('by-admin'), {
          filename: 'p2.png',
          contentType: 'image/png',
        })
      expect(uploadRes.status).toBe(201)
      const url = uploadRes.body.avatarUrl
      expect((await loadImage(url)).status).toBe(200)

      const removeRes = await patient2.delete(`/users/${patient2Id}/avatar`)
      expect(removeRes.status).toBe(200)
      expect(removeRes.body.avatarUrl).toBeNull()
      expect((await loadImage(url)).status).toBe(404)
    })

    it('returns 404 for an avatar route on a user that does not exist', async () => {
      const res = await admin.delete('/users/999999/avatar')
      expect(res.status).toBe(404)
    })
  })
})
