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
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
//
// The 15-minute deletion window itself (MessagingService.DELETE_WINDOW_MS)
// is NOT re-verified here — there's no way to fast-forward a real sentAt
// through the API without inserting rows directly via Drizzle, which these
// e2e conventions deliberately avoid. That branch already has full
// unit-test coverage in messaging.service.spec.ts.
describe('Messaging (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const adminAgent = () => request.agent(app.getHttpServer())
  const practitionerAAgent = () => request.agent(app.getHttpServer())
  const practitionerBAgent = () => request.agent(app.getHttpServer())
  const patientAAgent = () => request.agent(app.getHttpServer())
  const patientBAgent = () => request.agent(app.getHttpServer())

  let admin: ReturnType<typeof adminAgent>
  let practitionerA: ReturnType<typeof practitionerAAgent>
  let practitionerB: ReturnType<typeof practitionerBAgent>
  let patientA: ReturnType<typeof patientAAgent>
  let patientB: ReturnType<typeof patientBAgent>
  let patientAId: number

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

    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = adminAgent()
    practitionerA = practitionerAAgent()
    practitionerB = practitionerBAgent()
    patientA = patientAAgent()
    patientB = patientBAgent()

    const stamp = Date.now()

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Messaging E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Messaging',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    const clinicId = clinicRes.body.clinicId

    await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
      clinicId,
    })
    await practitionerA.post('/auth/login').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
    })

    // practitionerB manages no one — no clinic membership at all.
    await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
    })
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    })

    const patientARes = await admin.post('/users').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Patient',
      lastName: 'A',
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    patientAId = patientARes.body.id
    await patientA.post('/auth/login').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
    })

    await patientB.post('/auth/register').send({
      email: `patient-b-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Patient',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
    })
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  it('rejects starting a conversation with someone outside a clinical relationship', async () => {
    const patientBId = (await patientB.get('/auth/me')).body.id
    const res = await practitionerA
      .post('/conversations')
      .send({ userId: patientBId })
    expect(res.status).toBe(403)
  })

  it('rejects an admin from starting a conversation — only practitioners and patients may', async () => {
    const res = await admin.post('/conversations').send({ userId: patientAId })
    expect(res.status).toBe(403)
  })

  it('is idempotent: a second createConversation between the same pair returns the existing one', async () => {
    const first = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    expect(first.status).toBe(201)

    const second = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    expect(second.status).toBe(201)
    expect(second.body.id).toBe(first.body.id)
  })

  it('lets both participants exchange messages, but rejects a non-participant', async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    const sendRes = await practitionerA
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'Hello from the practitioner' })
    expect(sendRes.status).toBe(201)

    const replyRes = await patientA
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'Hello back' })
    expect(replyRes.status).toBe(201)

    const messagesForPatient = await patientA.get(
      `/conversations/${conversationId}/messages`,
    )
    expect(messagesForPatient.status).toBe(200)
    expect(messagesForPatient.body).toHaveLength(2)

    const nonParticipantRead = await practitionerB.get(
      `/conversations/${conversationId}/messages`,
    )
    expect(nonParticipantRead.status).toBe(403)

    const nonParticipantSend = await practitionerB
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'Should not work' })
    expect(nonParticipantSend.status).toBe(403)
  })

  it("marks the other participant's unread messages as read, never the reader's own", async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    await practitionerA
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'Unread by patient' })

    const markRes = await patientA.patch(
      `/conversations/${conversationId}/read`,
    )
    expect(markRes.status).toBe(200)

    const messages = await patientA.get(
      `/conversations/${conversationId}/messages`,
    )
    const fromPractitioner = messages.body.find(
      (m: any) => m.messageBody === 'Unread by patient',
    )
    expect(fromPractitioner.readAt).not.toBeNull()
  })

  it("archiving only ever affects the archiving participant's own view, never the other's", async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    const archiveRes = await practitionerA.patch(
      `/conversations/${conversationId}/archive`,
    )
    expect(archiveRes.status).toBe(200)
    expect(archiveRes.body.practitionerArchivedAt).not.toBeNull()
    expect(archiveRes.body.patientArchivedAt).toBeNull()

    const patientsView = await patientA.get('/conversations')
    const sameConversation = patientsView.body.find(
      (c: any) => c.id === conversationId,
    )
    expect(sameConversation.patientArchivedAt).toBeNull()

    const unarchiveRes = await practitionerA.patch(
      `/conversations/${conversationId}/unarchive`,
    )
    expect(unarchiveRes.status).toBe(200)
    expect(unarchiveRes.body.practitionerArchivedAt).toBeNull()
  })

  it('deleteMessage: rejects a non-sender, then succeeds for the sender while the message is still unread', async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    const sendRes = await practitionerA
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'Oops, typo' })
    const messageId = sendRes.body.id

    const nonSenderDelete = await patientA.delete(
      `/conversations/${conversationId}/messages/${messageId}`,
    )
    expect(nonSenderDelete.status).toBe(403)

    const senderDelete = await practitionerA.delete(
      `/conversations/${conversationId}/messages/${messageId}`,
    )
    expect(senderDelete.status).toBe(200)
    expect(senderDelete.body.messageBody).toBe('[message deleted]')
  })

  it('rejects an admin from archiving or unarchiving a conversation — participant-only action', async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    const archiveRes = await admin.patch(
      `/conversations/${conversationId}/archive`,
    )
    expect(archiveRes.status).toBe(403)

    const unarchiveRes = await admin.patch(
      `/conversations/${conversationId}/unarchive`,
    )
    expect(unarchiveRes.status).toBe(403)
  })

  // Regression coverage: the admin founding this whole test file has no
  // clinical relationship to practitionerA/patientA's conversation at all
  // — assertParticipant() alone used to wave that through anyway (the
  // same bypass archive/unarchive above are already guarded against),
  // letting an admin write a message into, or mark-as-read, a
  // conversation between two people they've never treated or been
  // treated by.
  it('rejects an admin from sending a message or marking a conversation as read — participant-only actions', async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    const sendRes = await admin
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'An admin should not be able to say this' })
    expect(sendRes.status).toBe(403)

    const readRes = await admin.patch(`/conversations/${conversationId}/read`)
    expect(readRes.status).toBe(403)

    // Confirms the rejection was real, not just a status code: no message
    // from the admin actually landed in the conversation.
    const messages = await practitionerA.get(
      `/conversations/${conversationId}/messages`,
    )
    expect(
      messages.body.some(
        (m: any) => m.messageBody === 'An admin should not be able to say this',
      ),
    ).toBe(false)
  })

  it('deleteMessage: rejects deleting a message that has already been read', async () => {
    const convoRes = await practitionerA
      .post('/conversations')
      .send({ userId: patientAId })
    const conversationId = convoRes.body.id

    const sendRes = await practitionerA
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: 'Already going to be read' })
    const messageId = sendRes.body.id

    await patientA.patch(`/conversations/${conversationId}/read`)

    const deleteRes = await practitionerA.delete(
      `/conversations/${conversationId}/messages/${messageId}`,
    )
    expect(deleteRes.status).toBe(403)
  })
})
