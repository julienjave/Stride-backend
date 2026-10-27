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
import { sql, type SQL } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getAppDatabaseUrl, getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// Messaging over REST (Phase 5) — against a REAL Postgres, under the app's
// own role, so every answer below has gone through the row security
// policies and the guard triggers of migration 0048, not only the service.
// The live half (sockets, events) is test/messaging-gateway.e2e-spec.ts.
//
// Layout: who may do what; sending; a care-team link that ends (read-only);
// reading a thread (pages, deleted messages); "read"; deleting; archiving;
// the list; the database's own rules, tried directly; the audit trail.
//
// A conversation is ONE per practitioner–patient pair (a UNIQUE pair), so a
// test that needs a fresh conversation gets a fresh patient (newPatient).
// Rate limits are off in the e2e suites (test/support/e2e-env.ts), so the
// logins cost nothing.
describe('Messaging (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let appPool: Pool
  let clinicId: number
  let stamp: number
  let accountCounter = 0

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  // practitionerA: the care team's member in most tests.
  let practitionerA: Agent
  let practitionerAId: number
  // practitionerC: a second member, whose link the read-only tests end.
  let practitionerC: Agent
  let practitionerCId: number
  // outsider: a practitioner in no clinic — on nobody's care team.
  let outsider: Agent

  const GUARD_MESSAGE = 'You do not have permission to access this resource'

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Every invitation email lands in memory — tests never send real
      // email, whatever EMAIL_TRANSPORT says in .env.
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

    sessionPool = new Pool({ connectionString: getDatabaseUrl() })
    appPool = new Pool({ connectionString: getAppDatabaseUrl() })
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
    // refuses to proceed unless connected to the dedicated test database:
    // the TRUNCATE below would otherwise empty the dev database.
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

    // The owner connection: TRUNCATE needs a privilege the app's role is
    // deliberately never granted.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = request.agent(app.getHttpServer())
    stamp = Date.now()
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
    clinicId = clinicRes.body.clinicId
    ;({ agent: practitionerA, id: practitionerAId } = await newPractitioner(
      'Alex',
      'Chen',
      clinicId,
    ))
    ;({ agent: practitionerC, id: practitionerCId } = await newPractitioner(
      'Casey',
      'Ruiz',
      clinicId,
    ))
    ;({ agent: outsider } = await newPractitioner('Out', 'Sider', undefined))
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
    await appPool.end()
  })

  // === HELPERS ===============================================================

  async function newPractitioner(
    firstName: string,
    lastName: string,
    clinic: number | undefined,
  ) {
    const email = `pr-${++accountCounter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'practitioner',
      firstName,
      lastName,
      licenseNumber: `PT-${accountCounter}-${stamp}`,
      ...(clinic ? { clinicId: clinic } : {}),
    })
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, email)
    const agent = request.agent(app.getHttpServer())
    expect(
      (await agent.post('/auth/login').send({ email, password: 'password123' }))
        .status,
    ).toBe(201)
    return { agent, id: res.body.id as number }
  }

  // A new patient of the clinic, signed in, with `team` joined to their
  // care team (an empty body = "join").
  async function newPatient(team: Agent[] = [practitionerA]) {
    const email = `pa-${++accountCounter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Pat',
      lastName: `Number${accountCounter}`,
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, email)
    const agent = request.agent(app.getHttpServer())
    expect(
      (await agent.post('/auth/login').send({ email, password: 'password123' }))
        .status,
    ).toBe(201)
    const id = res.body.id as number
    for (const member of team) {
      expect(
        (await member.post(`/users/${id}/care-team`).send({})).status,
      ).toBe(201)
    }
    return { agent, id, lastName: `Number${accountCounter}` }
  }

  async function start(by: Agent, otherId: number): Promise<number> {
    const res = await by.post('/conversations').send({ userId: otherId })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  async function send(by: Agent, conversationId: number, text: string) {
    const res = await by
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: text })
    expect(res.status).toBe(201)
    return res.body as { id: number; sentAt: string }
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  // The audit entries about one row, oldest first (as the owner: audit_logs
  // is admin-only under row security). entity_id is a bigint, which
  // node-postgres returns as a STRING (a bigint can exceed JavaScript's safe
  // integers, so the driver doesn't guess) — cast for a plain number.
  async function auditFor(entityType: string, entityId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type, entity_id::int AS entity_id, details
       FROM audit_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`,
      [entityType, entityId],
    )
    return rows
  }

  async function storedMessage(id: number) {
    const { rows } = await sessionPool.query<{
      message_body: string
      read_at: Date | null
      deleted_at: Date | null
      sent_at: Date
    }>('SELECT * FROM messages WHERE id = $1', [id])
    return rows[0]
  }

  // A Postgres error's code and constraint, through Drizzle's wrapper.
  function pgError(error: unknown): { code?: string; constraint?: string } {
    let current: unknown = error
    for (let depth = 0; depth < 5; depth++) {
      if (typeof current !== 'object' || current === null) return {}
      const fields = current as {
        code?: unknown
        constraint?: unknown
        cause?: unknown
      }
      if (typeof fields.code === 'string') {
        return {
          code: fields.code,
          ...(typeof fields.constraint === 'string'
            ? { constraint: fields.constraint }
            : {}),
        }
      }
      current = fields.cause
    }
    return {}
  }

  class RolledBack extends Error {
    constructor(readonly rows: Record<string, unknown>[]) {
      super('rolled back on purpose')
    }
  }
  // A statement as the APP's role, with a user's context set the way
  // withRlsContext sets it: its rows, or the error that stopped it. Always
  // rolled back.
  async function asActor(userId: number, role: string, statement: SQL) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${String(userId)}, true),
                     set_config('app.current_role', ${role}, true)`,
        )
        const result = await tx.execute(statement)
        throw new RolledBack(result.rows)
      })
    } catch (error) {
      if (error instanceof RolledBack) return { rows: error.rows }
      return { error: pgError(error) }
    }
    throw new Error('unreachable: asActor() always rolls back')
  }

  // A statement as the tables' OWNER (no row security; the triggers exempt
  // it — never a CHECK). Always rolled back.
  async function asOwner(statement: string, params: unknown[] = []) {
    const client = await sessionPool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(statement, params)
      return { rowCount: result.rowCount }
    } catch (error) {
      return { error: pgError(error) }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  // A deterministic race (the sessions suite's helper): another connection
  // — the app's role, as `userId` — holds an UNCOMMITTED write while the
  // request is sent; the request must still be unanswered 300 ms later
  // (`waited`), then the write commits and the request answers.
  async function whileHolding(
    userId: number,
    role: string,
    statement: string,
    params: unknown[],
    send: () => PromiseLike<request.Response>,
  ) {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', $2, true)",
        [String(userId), role],
      )
      await client.query(statement, params)
      let answered = false
      const pending = Promise.resolve(send()).then((res) => {
        answered = true
        return res
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const waited = !answered
      await client.query('COMMIT')
      return { waited, res: await pending }
    } finally {
      client.release()
    }
  }

  // === 1. WHO MAY DO WHAT ====================================================

  describe('access', () => {
    // Admins have no messaging since Phase 5 (decided 2026-10-20). The
    // guard's own message, not just the status: the service refuses admins
    // too (sideOf), and a status-only test couldn't tell which layer
    // answered.
    it('refuses an admin on every route, with the role guard’s message', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const attempts = [
        admin.get('/conversations'),
        admin.get(`/conversations/${id}`),
        admin.get(`/conversations/${id}/messages`),
        admin.post('/conversations').send({ userId: patient.id }),
        admin
          .post(`/conversations/${id}/messages`)
          .send({ messageBody: 'An admin should not say this' }),
        admin.patch(`/conversations/${id}/read`),
        admin.patch(`/conversations/${id}/archive`),
        admin.delete(`/conversations/${id}/messages/1`),
      ]
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403)
        expect(res.body.message).toEqual([GUARD_MESSAGE])
      }
    })

    it('refuses to start a conversation without a care-team link, from either side', async () => {
      const patient = await newPatient([practitionerA])
      const fromOutsider = await outsider
        .post('/conversations')
        .send({ userId: patient.id })
      expect(fromOutsider.status).toBe(403)
      expect(fromOutsider.body.message).toEqual([
        'You can only start a conversation with someone you share a care team with',
      ])
      // practitionerC shares the clinic but isn't on THIS patient's team —
      // the directory-vs-clinical split (decisions §3).
      const fromPatient = await patient.agent
        .post('/conversations')
        .send({ userId: practitionerCId })
      expect(fromPatient.status).toBe(403)
    })

    it('starts a conversation once: the same one from either side, one audit entry', async () => {
      const patient = await newPatient()
      const first = await practitionerA
        .post('/conversations')
        .send({ userId: patient.id })
      expect(first.status).toBe(201)
      expect(first.body).toStrictEqual({
        id: first.body.id,
        otherParticipant: {
          id: patient.id,
          firstName: 'Pat',
          lastName: patient.lastName,
          avatarUrl: null,
        },
        lastMessage: null,
        unreadCount: 0,
        archivedAt: null,
        canSend: true,
        readOnlyReason: null,
        createdAt: first.body.createdAt,
      })

      const again = await practitionerA
        .post('/conversations')
        .send({ userId: patient.id })
      expect(again.status).toBe(201)
      expect(again.body.id).toBe(first.body.id)

      // From the patient's side: the same conversation, the other person
      // named from THEIR point of view.
      const fromPatient = await patient.agent
        .post('/conversations')
        .send({ userId: practitionerAId })
      expect(fromPatient.body.id).toBe(first.body.id)
      expect(fromPatient.body.otherParticipant).toEqual({
        id: practitionerAId,
        firstName: 'Alex',
        lastName: 'Chen',
        avatarUrl: null,
      })

      const trail = await auditFor('conversations', first.body.id)
      expect(trail).toEqual([
        {
          action: 'CONVERSATION_STARTED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'conversations',
          entity_id: first.body.id,
          details: { practitionerId: practitionerAId, patientId: patient.id },
        },
      ])
    })

    // Two "Message" taps at once: one conversation, two 201s — the UNIQUE
    // pair decides (ON CONFLICT DO NOTHING), where a "look, then insert"
    // used to let the second insert fail with a 500.
    it('creates one conversation when two starts race', async () => {
      const patient = await newPatient()
      const [a, b] = await Promise.all([
        practitionerA.post('/conversations').send({ userId: patient.id }),
        patient.agent.post('/conversations').send({ userId: practitionerAId }),
      ])
      expect([a.status, b.status]).toEqual([201, 201])
      expect(a.body.id).toBe(b.body.id)
      const { rows } = await sessionPool.query(
        'SELECT id FROM conversations WHERE patient_id = $1',
        [patient.id],
      )
      expect(rows).toHaveLength(1)
    })

    // Row security answers first: a conversation I'm not in is invisible —
    // "not found", like one that doesn't exist.
    it('answers 404 to someone outside the conversation, on every route', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Hello')
      const other = await newPatient()
      for (const res of await Promise.all([
        outsider.get(`/conversations/${id}`),
        outsider.get(`/conversations/${id}/messages`),
        outsider
          .post(`/conversations/${id}/messages`)
          .send({ messageBody: 'x' }),
        other.agent.patch(`/conversations/${id}/read`),
        other.agent.patch(`/conversations/${id}/archive`),
        other.agent.delete(`/conversations/${id}/messages/${message.id}`),
      ])) {
        expect(res.status).toBe(404)
        expect(res.body.message).toEqual([`Conversation ${id} not found`])
      }
      // And nothing was marked read by the outsider's attempt.
      expect((await storedMessage(message.id)).read_at).toBeNull()
    })

    // The database's half, as the app's own role: an admin context reads no
    // conversation and no message (0048 took the admin branch out of
    // conversations_select; messages_select follows the conversation). The
    // practitioner, same statements, sees them — the neighbour that proves
    // the statements could find the rows.
    it('hides conversations and messages from an admin at the database level', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      await send(practitionerA, id, 'Clinical content')
      const adminId = (await admin.get('/auth/me')).body.id as number
      const countBoth = sql`SELECT
        (SELECT count(*) FROM conversations WHERE id = ${id})::int AS conversations,
        (SELECT count(*) FROM messages WHERE conversation_id = ${id})::int AS messages`
      expect(await asActor(adminId, 'admin', countBoth)).toEqual({
        rows: [{ conversations: 0, messages: 0 }],
      })
      expect(await asActor(practitionerAId, 'practitioner', countBoth)).toEqual(
        {
          rows: [{ conversations: 1, messages: 1 }],
        },
      )
    })
  })

  // === 2. SENDING ============================================================

  describe('sending', () => {
    it('lets both participants write, and answers each message as served', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const res = await practitionerA
        .post(`/conversations/${id}/messages`)
        .send({ messageBody: 'How did the squats feel?' })
      expect(res.status).toBe(201)
      expect(res.body).toStrictEqual({
        id: res.body.id,
        conversationId: id,
        senderId: practitionerAId,
        messageBody: 'How did the squats feel?',
        sentAt: res.body.sentAt,
        readAt: null,
        deletedAt: null,
      })
      const reply = await send(patient.agent, id, 'A bit sore on the left')
      const thread = await patient.agent.get(`/conversations/${id}/messages`)
      expect(thread.body.messages.map((m: { id: number }) => m.id)).toEqual([
        res.body.id,
        reply.id,
      ])
    })

    // ONE entry per message, pointing at it — the text isn't copied (the row
    // is the record: fixed, never removed).
    it('writes one MESSAGE_SENT entry per message, without the text', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(patient.agent, id, 'Private detail')
      expect(await auditFor('messages', message.id)).toEqual([
        {
          action: 'MESSAGE_SENT',
          performed_by: patient.id,
          target_user_id: patient.id,
          entity_type: 'messages',
          entity_id: message.id,
          details: { conversationId: id, sentAt: message.sentAt },
        },
      ])
    })

    it.each([
      ['blank', '   \n\t', ["A message can't be blank"]],
      [
        'too long',
        'a'.repeat(5001),
        ['A message can be at most 5000 characters'],
      ],
    ])(
      'refuses a %s message with a 400, writing nothing',
      async (_n, body, message) => {
        const patient = await newPatient()
        const id = await start(practitionerA, patient.id)
        const res = await practitionerA
          .post(`/conversations/${id}/messages`)
          .send({ messageBody: body })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual(message)
        const { rows } = await sessionPool.query(
          'SELECT id FROM messages WHERE conversation_id = $1',
          [id],
        )
        expect(rows).toHaveLength(0)
      },
    )
  })

  // === 3. A CARE-TEAM LINK THAT ENDS: READ-ONLY ===============================

  describe('after a care-team link ends', () => {
    // practitionerC is on the patient's team with practitionerA; the admin
    // ends C's link. C's conversation stays readable by both, read-only;
    // A's stays writable — the neighbour.
    async function endedLink() {
      const patient = await newPatient([practitionerA, practitionerC])
      const withC = await start(practitionerC, patient.id)
      const fromC = await send(practitionerC, withC, 'Before the end')
      const withA = await start(practitionerA, patient.id)
      const ended = await admin
        .post(`/users/${patient.id}/care-team/${practitionerCId}/end`)
        .send({})
      expect(ended.status).toBe(201)
      return { patient, withC, withA, fromC }
    }

    it('keeps the history readable by both, says canSend false, and refuses new messages from both sides', async () => {
      const { patient, withC, withA, fromC } = await endedLink()

      for (const agent of [practitionerC, patient.agent]) {
        const summary = await agent.get(`/conversations/${withC}`)
        expect(summary.status).toBe(200)
        expect(summary.body.canSend).toBe(false)
        const thread = await agent.get(`/conversations/${withC}/messages`)
        expect(thread.status).toBe(200)
        expect(thread.body.messages.map((m: { id: number }) => m.id)).toEqual([
          fromC.id,
        ])
        const refused = await agent
          .post(`/conversations/${withC}/messages`)
          .send({ messageBody: 'After the end' })
        expect(refused.status).toBe(403)
        expect(refused.body.message).toEqual([
          "You're no longer on a care team together, so this conversation is read-only",
        ])
      }
      expect(
        (await patient.agent.get(`/conversations/${withA}`)).body.canSend,
      ).toBe(true)
      await send(patient.agent, withA, 'Still fine with Alex')
    })

    // The policy alone, as the app's role: the patient passes the SELECT
    // (sees the conversation) but the INSERT is refused — the "actor who
    // passes SELECT but must fail the write". No RETURNING: it would ask
    // the SELECT policy too, and could hide which policy refused.
    it('refuses the INSERT at the database level once the link has ended', async () => {
      const { patient, withC, withA } = await endedLink()
      const sees = await asActor(
        patient.id,
        'patient',
        sql`SELECT count(*)::int AS n FROM conversations WHERE id = ${withC}`,
      )
      expect(sees).toEqual({ rows: [{ n: 1 }] })
      const insertInto = (conversationId: number) =>
        sql`INSERT INTO messages (conversation_id, sender_id, message_body)
            VALUES (${conversationId}, ${patient.id}, 'Direct')`
      expect(await asActor(patient.id, 'patient', insertInto(withC))).toEqual({
        error: { code: '42501' },
      })
      expect(await asActor(patient.id, 'patient', insertInto(withA))).toEqual({
        rows: [],
      })
    })

    it('does not reopen the conversation through "start", and allows writing again once back on the team', async () => {
      const { patient, withC } = await endedLink()
      const restart = await practitionerC
        .post('/conversations')
        .send({ userId: patient.id })
      expect(restart.status).toBe(403)

      expect(
        (await practitionerC.post(`/users/${patient.id}/care-team`).send({}))
          .status,
      ).toBe(201)
      expect(
        (await practitionerC.get(`/conversations/${withC}`)).body.canSend,
      ).toBe(true)
      await send(practitionerC, withC, 'Back on the team')
    })

    it('still lets each participant archive their own view', async () => {
      const { withC } = await endedLink()
      const res = await practitionerC.patch(`/conversations/${withC}/archive`)
      expect(res.status).toBe(200)
      expect(res.body.archivedAt).not.toBeNull()
    })
  })

  // === 4. READING A THREAD ===================================================

  describe('reading a thread', () => {
    it('serves pages oldest first, older pages with ?before=, and says when there is more', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const sent: number[] = []
      for (const text of ['one', 'two', 'three', 'four', 'five']) {
        sent.push((await send(practitionerA, id, text)).id)
      }
      const newest = await patient.agent.get(
        `/conversations/${id}/messages?limit=2`,
      )
      expect(newest.status).toBe(200)
      expect(newest.body.hasMore).toBe(true)
      expect(newest.body.messages.map((m: { id: number }) => m.id)).toEqual(
        sent.slice(3),
      )

      const older = await patient.agent.get(
        `/conversations/${id}/messages?limit=2&before=${sent[3]}`,
      )
      expect(older.body.messages.map((m: { id: number }) => m.id)).toEqual(
        sent.slice(1, 3),
      )
      expect(older.body.hasMore).toBe(true)

      const oldest = await patient.agent.get(
        `/conversations/${id}/messages?limit=2&before=${sent[1]}`,
      )
      expect(oldest.body).toStrictEqual({
        messages: [expect.objectContaining({ id: sent[0] })],
        hasMore: false,
      })

      // Without parameters: everything (fewer than 50), no more.
      const all = await patient.agent.get(`/conversations/${id}/messages`)
      expect(all.body.messages).toHaveLength(5)
      expect(all.body.hasMore).toBe(false)
    })

    // The default page size, 50: 51 messages (inserted as the owner — the
    // API path is covered above) leave the oldest one for the next page.
    it('serves 50 messages by default', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      await sessionPool.query(
        `INSERT INTO messages (conversation_id, sender_id, message_body)
         SELECT $1, $2, 'Message ' || n FROM generate_series(1, 51) AS n`,
        [id, practitionerAId],
      )
      const page = await patient.agent.get(`/conversations/${id}/messages`)
      expect(page.body.messages).toHaveLength(50)
      expect(page.body.messages[0].messageBody).toBe('Message 2')
      expect(page.body.hasMore).toBe(true)
    })

    it.each([
      ['limit=101', 'limit must not be greater than 100'],
      ['before=abc', 'before must be an integer number'],
      ['before=0', 'before must be a positive number'],
    ])('refuses ?%s with a 400', async (query, message) => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const res = await patient.agent.get(
        `/conversations/${id}/messages?${query}`,
      )
      expect(res.status).toBe(400)
      expect(res.body.message).toContain(message)
    })

    // The bug Phase 5 found: the delete's own answer hid the text, but the
    // history served it again. Now the text is gone everywhere — the
    // recipient's thread, the sender's, and both lists' preview — while
    // the row keeps it (a soft delete).
    it('serves a deleted message without its text to both sides, in the thread and in the list', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Wrong patient, sorry')
      expect(
        (
          await practitionerA.delete(
            `/conversations/${id}/messages/${message.id}`,
          )
        ).status,
      ).toBe(200)

      for (const agent of [patient.agent, practitionerA]) {
        const thread = await agent.get(`/conversations/${id}/messages`)
        expect(thread.body.messages[0]).toMatchObject({
          id: message.id,
          messageBody: null,
        })
        expect(thread.body.messages[0].deletedAt).not.toBeNull()
        const list = await agent.get('/conversations')
        const row = list.body.find((c: { id: number }) => c.id === id)
        expect(row.lastMessage.messageBody).toBeNull()
        // Never read, but deleted: nothing left to read, so not "unread"
        // for the recipient (the patient — the loop's first agent).
        expect(row.unreadCount).toBe(0)
      }
      expect((await storedMessage(message.id)).message_body).toBe(
        'Wrong patient, sorry',
      )
    })
  })

  // === 5. "READ" =============================================================

  describe('marking as read', () => {
    it("marks the other person's unread messages — not my own, not a deleted one — and answers which", async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const first = await send(practitionerA, id, 'First')
      const deleted = await send(practitionerA, id, 'Deleted')
      await practitionerA.delete(`/conversations/${id}/messages/${deleted.id}`)
      const second = await send(practitionerA, id, 'Second')
      const own = await send(patient.agent, id, 'Mine')

      const res = await patient.agent.patch(`/conversations/${id}/read`)
      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual({
        conversationId: id,
        readAt: res.body.readAt,
        messageIds: [first.id, second.id],
      })
      expect(res.body.readAt).not.toBeNull()
      expect((await storedMessage(first.id)).read_at).not.toBeNull()
      expect((await storedMessage(own.id)).read_at).toBeNull()
      expect((await storedMessage(deleted.id)).read_at).toBeNull()

      expect(await auditFor('conversations', id)).toContainEqual({
        action: 'CONVERSATION_READ',
        performed_by: patient.id,
        target_user_id: patient.id,
        entity_type: 'conversations',
        entity_id: id,
        details: { messageIds: [first.id, second.id], readAt: res.body.readAt },
      })
    })

    it('changes nothing the second time: an empty answer, no second entry', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      await send(practitionerA, id, 'Once')
      await patient.agent.patch(`/conversations/${id}/read`)
      const again = await patient.agent.patch(`/conversations/${id}/read`)
      expect(again.body).toStrictEqual({
        conversationId: id,
        readAt: null,
        messageIds: [],
      })
      const reads = (await auditFor('conversations', id)).filter(
        (entry) => entry.action === 'CONVERSATION_READ',
      )
      expect(reads).toHaveLength(1)
    })
  })

  // === 6. DELETING ===========================================================

  describe('deleting a message', () => {
    // A message's age set as the owner (exempt from the guard), so the
    // window's edges can be tried for real against the service AND the
    // trigger — both take the database's now().
    async function ageMessage(id: number, interval: string) {
      await sessionPool.query(
        `UPDATE messages SET sent_at = now() - $2::interval WHERE id = $1`,
        [id, interval],
      )
    }

    it('deletes my unread message within the window, once: one entry, the same answer again', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Typo')
      const res = await practitionerA.delete(
        `/conversations/${id}/messages/${message.id}`,
      )
      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual({
        id: message.id,
        conversationId: id,
        senderId: practitionerAId,
        messageBody: null,
        sentAt: message.sentAt,
        readAt: null,
        deletedAt: res.body.deletedAt,
      })
      const again = await practitionerA.delete(
        `/conversations/${id}/messages/${message.id}`,
      )
      expect(again.status).toBe(200)
      expect(again.body).toStrictEqual(res.body)
      // Still the same answer once the 15 minutes have passed: an already
      // deleted message isn't judged by the window again.
      await ageMessage(message.id, '1 hour')
      const later = await practitionerA.delete(
        `/conversations/${id}/messages/${message.id}`,
      )
      expect(later.status).toBe(200)
      expect(later.body.messageBody).toBeNull()
      expect(await auditFor('messages', message.id)).toEqual([
        expect.objectContaining({ action: 'MESSAGE_SENT' }),
        {
          action: 'MESSAGE_DELETED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'messages',
          entity_id: message.id,
          details: {
            conversationId: id,
            sentAt: message.sentAt,
            deletedAt: res.body.deletedAt,
          },
        },
      ])
    })

    it("refuses someone else's message (403), a read one (409), and an unknown one (404)", async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Read soon')

      const notMine = await patient.agent.delete(
        `/conversations/${id}/messages/${message.id}`,
      )
      expect(notMine.status).toBe(403)
      expect(notMine.body.message).toEqual([
        'You can only delete your own messages',
      ])

      await patient.agent.patch(`/conversations/${id}/read`)
      const read = await practitionerA.delete(
        `/conversations/${id}/messages/${message.id}`,
      )
      expect(read.status).toBe(409)
      expect(read.body.message).toEqual([
        'This message has already been read, so it can no longer be deleted',
      ])

      // A message of ANOTHER conversation, named under this one.
      const other = await newPatient()
      const otherId = await start(practitionerA, other.id)
      const elsewhere = await send(practitionerA, otherId, 'Elsewhere')
      const unknown = await practitionerA.delete(
        `/conversations/${id}/messages/${elsewhere.id}`,
      )
      expect(unknown.status).toBe(404)
      expect(unknown.body.message).toEqual([
        `Message ${elsewhere.id} not found in this conversation`,
      ])
    })

    it('allows it at 14 minutes 58 seconds and refuses it past 15 minutes', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const young = await send(practitionerA, id, 'Young')
      const old = await send(practitionerA, id, 'Old')
      await ageMessage(young.id, '14 minutes 58 seconds')
      await ageMessage(old.id, '15 minutes 1 second')
      expect(
        (
          await practitionerA.delete(
            `/conversations/${id}/messages/${young.id}`,
          )
        ).status,
      ).toBe(200)
      const refused = await practitionerA.delete(
        `/conversations/${id}/messages/${old.id}`,
      )
      expect(refused.status).toBe(409)
      expect(refused.body.message).toEqual([
        'This message can no longer be deleted: the 15 minutes have passed',
      ])
      expect((await storedMessage(old.id)).deleted_at).toBeNull()
    })

    // The race: the recipient's "read" is uncommitted when the delete
    // arrives. The delete must WAIT for it (the row's lock), then see the
    // message read and refuse — never delete a message the other person has
    // just seen.
    it('waits for a read in progress, then refuses with "already read"', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Racing')
      const { waited, res } = await whileHolding(
        patient.id,
        'patient',
        'UPDATE messages SET read_at = now() WHERE id = $1',
        [message.id],
        () =>
          practitionerA.delete(`/conversations/${id}/messages/${message.id}`),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([
        'This message has already been read, so it can no longer be deleted',
      ])
      expect((await storedMessage(message.id)).deleted_at).toBeNull()
    })
  })

  describe('two deletes at once', () => {
    // The sender's other tab deletes the same message first (uncommitted):
    // this request waits for it, finds the message deleted, and answers it
    // — 200, not "already read" — writing nothing of its own (no second
    // MESSAGE_DELETED: the held delete is a direct statement, so the trail
    // must hold the MESSAGE_SENT entry only).
    it('answers the deleted message, writing nothing, when another delete wins', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Twice')
      const { waited, res } = await whileHolding(
        practitionerAId,
        'practitioner',
        'UPDATE messages SET deleted_at = now() WHERE id = $1',
        [message.id],
        () =>
          practitionerA.delete(`/conversations/${id}/messages/${message.id}`),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(200)
      expect(res.body.messageBody).toBeNull()
      expect(
        (await auditFor('messages', message.id)).map((e) => e.action),
      ).toEqual(['MESSAGE_SENT'])
    })
  })

  // === 7. ARCHIVING ==========================================================

  describe('archiving', () => {
    it('archives only my view, once (idempotent), and unarchives — each change audited', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      await send(practitionerA, id, 'Hello')

      const archived = await practitionerA.patch(`/conversations/${id}/archive`)
      expect(archived.status).toBe(200)
      expect(archived.body.archivedAt).not.toBeNull()
      const theirs = await patient.agent.get(`/conversations/${id}`)
      expect(theirs.body.archivedAt).toBeNull()

      const again = await practitionerA.patch(`/conversations/${id}/archive`)
      expect(again.body.archivedAt).toBe(archived.body.archivedAt)

      const back = await practitionerA.patch(`/conversations/${id}/unarchive`)
      expect(back.body.archivedAt).toBeNull()

      const changes = (await auditFor('conversations', id))
        .filter((e) => e.action.startsWith('CONVERSATION_'))
        .filter((e) => e.action !== 'CONVERSATION_STARTED')
      expect(changes).toEqual([
        expect.objectContaining({
          action: 'CONVERSATION_ARCHIVED',
          performed_by: practitionerAId,
          details: {
            side: 'practitioner',
            archivedAt: archived.body.archivedAt,
          },
        }),
        expect.objectContaining({
          action: 'CONVERSATION_UNARCHIVED',
          details: { side: 'practitioner', archivedAt: null },
        }),
      ])
    })

    // Decided 2026-10-20: a new message brings the conversation back for
    // BOTH — nothing clinical sits unseen in an archive.
    it('brings an archived conversation back for both participants when a message arrives', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      await send(practitionerA, id, 'Hello')
      await practitionerA.patch(`/conversations/${id}/archive`)
      await patient.agent.patch(`/conversations/${id}/archive`)

      const message = await send(patient.agent, id, 'One more question')
      expect(
        (await practitionerA.get(`/conversations/${id}`)).body.archivedAt,
      ).toBeNull()
      expect(
        (await patient.agent.get(`/conversations/${id}`)).body.archivedAt,
      ).toBeNull()
      expect((await auditFor('messages', message.id))[0].details).toEqual({
        conversationId: id,
        sentAt: message.sentAt,
        unarchivedFor: ['practitioner', 'patient'],
      })
    })
  })

  // === 8. THE LIST ===========================================================

  describe('the conversation list', () => {
    it('lists my conversations with messages, newest activity first, with unread counts — not an empty one', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const withA = await start(practitionerA, patient.id)
      const withC = await start(practitionerC, patient.id)
      // An empty conversation the patient opened with nobody writing.
      const p2 = await newPatient([practitionerA])
      const empty = await start(p2.agent, practitionerAId)

      await send(practitionerA, withA, 'Older')
      await send(practitionerC, withC, 'Newer')
      await send(practitionerC, withC, 'Newest')

      const list = await patient.agent.get('/conversations')
      expect(list.status).toBe(200)
      expect(
        list.body.map((c: { id: number; unreadCount: number }) => [
          c.id,
          c.unreadCount,
        ]),
      ).toEqual([
        [withC, 2],
        [withA, 1],
      ])
      expect(list.body[0].lastMessage.messageBody).toBe('Newest')

      // The empty one: not in either list, but opened directly it's there.
      const aList = await practitionerA.get('/conversations')
      expect(aList.body.map((c: { id: number }) => c.id)).not.toContain(empty)
      expect((await p2.agent.get('/conversations')).body).toEqual([])
      expect((await p2.agent.get(`/conversations/${empty}`)).status).toBe(200)

      // A sender's own messages never count as unread for them.
      const cRow = (await practitionerC.get('/conversations')).body.find(
        (c: { id: number }) => c.id === withC,
      )
      expect(cRow.unreadCount).toBe(0)
    })
  })

  // === 9. THE DATABASE'S OWN RULES (0047 / 0048) ==============================

  describe('the database rules, tried directly', () => {
    // The text CHECKs hold even for the owner (a CHECK exempts nobody) — the
    // proof that the database refuses on its own, apart from the DTO.
    it.each([
      ['blank', '   ', 'messages_body_not_blank'],
      ['tab only', '\t', 'messages_body_not_blank'],
      ['5001 characters', 'a'.repeat(5001), 'messages_body_max_length'],
    ])(
      'refuses a %s message even from the owner',
      async (_n, body, constraint) => {
        const patient = await newPatient()
        const id = await start(practitionerA, patient.id)
        expect(
          await asOwner(
            'INSERT INTO messages (conversation_id, sender_id, message_body) VALUES ($1, $2, $3)',
            [id, practitionerAId, body],
          ),
        ).toEqual({ error: { code: '23514', constraint } })
      },
    )

    it('writes the database’s own moment, whatever sent_at the app sends, and refuses a message born read', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const stored = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO messages (conversation_id, sender_id, message_body, sent_at)
            VALUES (${id}, ${practitionerAId}, 'Backdated?', '2000-01-01T00:00:00Z')
            RETURNING sent_at > now() - interval '1 minute' AS is_now`,
      )
      expect(stored).toEqual({ rows: [{ is_now: true }] })
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`INSERT INTO messages (conversation_id, sender_id, message_body, read_at)
              VALUES (${id}, ${practitionerAId}, 'Read already?', now())`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'message_starts_unread' },
      })
    })

    // The OWNER is exempt from the guards (never from a CHECK): the dev seed
    // writes a demo history this way — past moments, some already read.
    it('lets the owner write a past message, already read, as given', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const { rows } = await sessionPool.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_id, message_body, sent_at, read_at)
         VALUES ($1, $2, 'From the past', '2031-03-03T09:00:00Z', '2031-03-03T09:30:00Z')
         RETURNING id`,
        [id, practitionerAId],
      )
      const stored = await storedMessage(Number(rows[0].id))
      expect(stored.sent_at.toISOString()).toBe('2031-03-03T09:00:00.000Z')
      expect(stored.read_at?.toISOString()).toBe('2031-03-03T09:30:00.000Z')
    })

    // Each change, as the app's role, by someone the UPDATE policy lets
    // through (a participant) — so the trigger is what refuses.
    it('allows only the two changes a message has: read by the recipient, deleted by the sender in time', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'Original')
      const asSender = (statement: SQL) =>
        asActor(practitionerAId, 'practitioner', statement)
      const asRecipient = (statement: SQL) =>
        asActor(patient.id, 'patient', statement)
      const refusedAs = (constraint: string) => ({
        error: { code: '23514', constraint },
      })

      // The text is fixed — for the sender too.
      expect(
        await asSender(
          sql`UPDATE messages SET message_body = 'Edited' WHERE id = ${message.id}`,
        ),
      ).toEqual(refusedAs('message_content_fixed'))
      // "Read": by the recipient, at now() — not by the sender, not
      // backdated.
      expect(
        await asSender(
          sql`UPDATE messages SET read_at = now() WHERE id = ${message.id}`,
        ),
      ).toEqual(refusedAs('message_read_by_recipient'))
      expect(
        await asRecipient(
          sql`UPDATE messages SET read_at = now() - interval '1 day' WHERE id = ${message.id}`,
        ),
      ).toEqual(refusedAs('message_read_by_recipient'))
      expect(
        await asRecipient(
          sql`UPDATE messages SET read_at = now() WHERE id = ${message.id} RETURNING id::int`,
        ),
      ).toEqual({ rows: [{ id: message.id }] })
      // "Deleted": by the sender — not by the recipient.
      expect(
        await asRecipient(
          sql`UPDATE messages SET deleted_at = now() WHERE id = ${message.id}`,
        ),
      ).toEqual(refusedAs('message_delete_window'))
      expect(
        await asSender(
          sql`UPDATE messages SET deleted_at = now() WHERE id = ${message.id} RETURNING id::int`,
        ),
      ).toEqual({ rows: [{ id: message.id }] })
    })

    it('refuses a deletion once read, or past 15 minutes, and "un-reading" a message', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const read = await send(practitionerA, id, 'Read')
      const old = await send(practitionerA, id, 'Old')
      await sessionPool.query(
        'UPDATE messages SET read_at = now() WHERE id = $1',
        [read.id],
      )
      await sessionPool.query(
        `UPDATE messages SET sent_at = now() - interval '15 minutes 1 second' WHERE id = $1`,
        [old.id],
      )
      const refused = {
        error: { code: '23514', constraint: 'message_delete_window' },
      }
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`UPDATE messages SET deleted_at = now() WHERE id = ${read.id}`,
        ),
      ).toEqual(refused)
      expect(
        await asActor(
          practitionerAId,
          'practitioner',
          sql`UPDATE messages SET deleted_at = now() WHERE id = ${old.id}`,
        ),
      ).toEqual(refused)
      expect(
        await asActor(
          patient.id,
          'patient',
          sql`UPDATE messages SET read_at = NULL WHERE id = ${read.id}`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'message_read_by_recipient' },
      })
      // Re-stamping "read" with a LATER now() (this transaction's): read is
      // set once.
      expect(
        await asActor(
          patient.id,
          'patient',
          sql`UPDATE messages SET read_at = now() WHERE id = ${read.id}`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'message_read_by_recipient' },
      })
    })

    it('refuses reading a deleted message, a backdated deletion, re-deleting, and a message born deleted', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const deleted = await send(practitionerA, id, 'Deleted')
      const fresh = await send(practitionerA, id, 'Fresh')
      await sessionPool.query(
        'UPDATE messages SET deleted_at = now() WHERE id = $1',
        [deleted.id],
      )
      const asSender = (statement: SQL) =>
        asActor(practitionerAId, 'practitioner', statement)
      expect(
        await asActor(
          patient.id,
          'patient',
          sql`UPDATE messages SET read_at = now() WHERE id = ${deleted.id}`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'message_read_by_recipient' },
      })
      const deleteWindow = {
        error: { code: '23514', constraint: 'message_delete_window' },
      }
      expect(
        await asSender(
          sql`UPDATE messages SET deleted_at = now() - interval '1 hour' WHERE id = ${fresh.id}`,
        ),
      ).toEqual(deleteWindow)
      expect(
        await asSender(
          sql`UPDATE messages SET deleted_at = now() WHERE id = ${deleted.id}`,
        ),
      ).toEqual(deleteWindow)
      expect(
        await asSender(
          sql`INSERT INTO messages (conversation_id, sender_id, message_body, deleted_at)
              VALUES (${id}, ${practitionerAId}, 'Deleted already?', now())`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'message_starts_unread' },
      })
    })

    // The trigger's edge, exactly: `now() - sent_at > interval '15
    // minutes'` must still ALLOW a deletion at 15:00.000000. Real requests
    // never land on the exact microsecond, so it's built in ONE transaction,
    // where now() is a single instant: as the owner (exempt from the guard),
    // the message is aged by exactly 15 minutes; then SET LOCAL ROLE
    // switches to the app's role — row security and the guard apply from
    // there — and the sender deletes it. (A `>=` in the trigger refuses it.)
    it('allows a deletion at exactly 15 minutes at the database too', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      const message = await send(practitionerA, id, 'On the edge')
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE messages SET sent_at = now() - interval '15 minutes' WHERE id = $1`,
          [message.id],
        )
        await client.query(
          `SET LOCAL ROLE ${client.escapeIdentifier(process.env.POSTGRES_APP_USER ?? 'stride_app')}`,
        )
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'practitioner', true)",
          [String(practitionerAId)],
        )
        const deleted = await client.query(
          'UPDATE messages SET deleted_at = now() WHERE id = $1',
          [message.id],
        )
        expect(deleted.rowCount).toBe(1)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    // The hole 0048 closed: the UPDATE policy only checked that the patient
    // stayed in the conversation, so they could re-point it at another
    // practitioner. Archiving — the one update the app makes — still works.
    it('refuses changing who a conversation is between, but not archiving', async () => {
      const patient = await newPatient()
      const id = await start(practitionerA, patient.id)
      expect(
        await asActor(
          patient.id,
          'patient',
          sql`UPDATE conversations SET practitioner_id = ${practitionerCId} WHERE id = ${id}`,
        ),
      ).toEqual({
        error: { code: '23514', constraint: 'conversation_participants_fixed' },
      })
      expect(
        await asActor(
          patient.id,
          'patient',
          sql`UPDATE conversations SET patient_archived_at = now() WHERE id = ${id} RETURNING id`,
        ),
      ).toEqual({ rows: [{ id }] })
    })
  })

  // === 10. THE AUDIT TRAIL ===================================================

  // The routes are @AuditedByService(): the service's complete entry, and
  // NO generic "METHOD /url" entry from the interceptor beside it. Run last,
  // after every write above.
  it('leaves no generic interceptor entry for any messaging route', async () => {
    const { rows } = await sessionPool.query(
      `SELECT action FROM audit_logs WHERE action LIKE '% /conversations%'`,
    )
    expect(rows).toEqual([])
  })
})
