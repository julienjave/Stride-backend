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
import { MessageNoticesService } from '../src/messaging/message-notices.service'
import { activateAccount } from './support/accounts'
import { getAppDatabaseUrl, getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// The new-message emails (roadmap Phase 6.5) — against the REAL claim
// function (migration 0075), its locks and the conversation guard, with the
// app's own role. The sweep runs only when a test calls it (the timer is
// started by main.ts alone), and every email lands in memory.
//
// The claim looks at the WHOLE database, so earlier tests' conversations can
// be claimed by a later sweep: every assertion reads the outbox for ONE
// address (a fresh patient or practitioner per test), never a total.
describe('New-message emails (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let appPool: Pool
  let clinicId: number
  let stamp: number
  let accountCounter = 0
  let notices: MessageNoticesService
  const outbox = new InMemoryEmailTransport()

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  let practitionerA: Agent
  let practitionerAId: number
  let practitionerC: Agent
  let practitionerCId: number

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
      clinicName: 'Notices E2E Clinic',
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
    notices = app.get(MessageNoticesService)
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

  // The audit entries about one row, oldest first (as the owner: audit_logs
  // is admin-only under row security). entity_id is a bigint, which
  // node-postgres returns as a STRING (a bigint can exceed JavaScript's safe
  // integers, so the driver doesn't guess) — cast for a plain number.
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

  // --- Helpers of this suite -----------------------------------------------------------------------------

  const emailOf = (id: number) =>
    sessionPool
      .query<{ email: string }>('SELECT email FROM users WHERE id = $1', [id])
      .then((r) => r.rows[0].email)

  // Ages every message of a conversation by `minutes` — as the owner (the
  // message guard exempts it): the 15 minutes pass without waiting.
  async function age(conversationId: number, minutes: number) {
    await sessionPool.query(
      `UPDATE messages SET sent_at = sent_at - make_interval(mins => $2)
       WHERE conversation_id = $1`,
      [conversationId, minutes],
    )
  }

  // The new-message emails sent to an address — creating an account also
  // sends it an invitation, which isn't counted.
  const noticesTo = (address: string) =>
    outbox
      .sentTo(address)
      .filter((email) =>
        /(sent you a message|new messages) on Stride$/.test(email.subject),
      )

  async function markers(conversationId: number) {
    const { rows } = await sessionPool.query<{
      practitioner: boolean
      patient: boolean
    }>(
      `SELECT practitioner_notified_at IS NOT NULL AS practitioner,
              patient_notified_at IS NOT NULL AS patient
       FROM conversations WHERE id = $1`,
      [conversationId],
    )
    return rows[0]
  }

  // --- 1. When an email goes out --------------------------------------------------------------------------

  it('emails the recipient once a message has waited 15 minutes — not before, and never its text', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Your scan results are in — the knee is fine')

    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(0)
    await age(id, 14)
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(0)

    await age(id, 2)
    await notices.sweep()
    const [email] = noticesTo(to)
    expect(email.subject).toBe('Alex Chen sent you a message on Stride')
    expect(email.text).toContain('Alex Chen sent you a message on Stride.')
    expect(email.text).toContain('/patient/messages')
    expect(email.text).not.toContain('knee')
    expect(email.html).not.toContain('knee')
    // The sender isn't emailed about their own message.
    expect(noticesTo(await emailOf(practitionerAId))).toEqual([])
  })

  it('sends ONE email per conversation until it is read — then the next message may email again', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'First')
    await age(id, 20)
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(1)
    expect(await markers(id)).toStrictEqual({
      practitioner: false,
      patient: true,
    })

    // More messages, more sweeps, still unread: nothing more.
    await send(practitionerA, id, 'Second')
    await age(id, 20)
    await notices.sweep()
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(1)

    // Read: the marker goes; a later message emails again.
    const read = await patient.agent.patch(`/conversations/${id}/read`)
    expect(read.status).toBe(200)
    expect(await markers(id)).toStrictEqual({
      practitioner: false,
      patient: false,
    })
    await send(practitionerA, id, 'Third')
    await age(id, 20)
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(2)
  })

  it('emails the practitioner too, and lists several patients in ONE email', async () => {
    const { agent: practitioner, id: practitionerId } = await newPractitioner(
      'Nora',
      'Quinn',
      clinicId,
    )
    const to = await emailOf(practitionerId)
    const first = await newPatient([practitioner])
    const second = await newPatient([practitioner])
    const one = await start(first.agent, practitionerId)
    const two = await start(second.agent, practitionerId)
    await send(first.agent, one, 'Hello')
    await send(second.agent, two, 'Hi')
    await age(one, 20)
    await age(two, 20)

    await notices.sweep()
    const sent = noticesTo(to)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('You have new messages on Stride')
    expect(sent[0].text).toContain(
      `Pat ${first.lastName} and Pat ${second.lastName} sent you messages on Stride.`,
    )
    expect(sent[0].text).toContain('/practitioner/messages')
  })

  // --- 2. When none does ------------------------------------------------------------------------------------

  it('sends nothing for a message deleted or already read', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    const gone = await send(practitionerA, id, 'Sent by mistake')
    expect(
      (await practitionerA.delete(`/conversations/${id}/messages/${gone.id}`))
        .status,
    ).toBe(200)
    await age(id, 20)
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(0)

    await send(practitionerA, id, 'Read at once')
    await patient.agent.patch(`/conversations/${id}/read`)
    await age(id, 20)
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(0)
  })

  it('respects the setting — and, turned back on, tells about what still waits', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const off = await patient.agent
      .patch(`/users/${patient.id}`)
      .send({ messageEmailNotices: false })
    expect(off.status).toBe(200)
    expect(off.body.messageEmailNotices).toBe(false)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Hello')
    await age(id, 20)

    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(0)
    // Not marked: nothing was sent.
    expect(await markers(id)).toStrictEqual({
      practitioner: false,
      patient: false,
    })

    await patient.agent
      .patch(`/users/${patient.id}`)
      .send({ messageEmailNotices: true })
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(1)
  })

  it('sends nothing to a deactivated account', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Hello')
    await age(id, 20)
    expect((await admin.delete(`/users/${patient.id}`)).status).toBe(200)
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(0)
    expect(await markers(id)).toStrictEqual({
      practitioner: false,
      patient: false,
    })
  })

  // Each side is judged by what the OTHER side wrote — and only by messages
  // still waiting: a conversation with one side due must not email the
  // other side because of a message it wrote, read, deleted, or got a
  // minute ago. (These made the per-side rules disagree; a conversation
  // holding one kind of message couldn't tell them apart.)
  it("judges each side only by the other side's messages that still wait", async () => {
    const patient = await newPatient()
    const toPatient = await emailOf(patient.id)
    const toPractitioner = await emailOf(practitionerCId)
    await practitionerC.post(`/users/${patient.id}/care-team`).send({})
    const id = await start(practitionerC, patient.id)

    const read = await send(practitionerC, id, 'Read already')
    await patient.agent.patch(`/conversations/${id}/read`)
    const deleted = await send(practitionerC, id, 'Deleted in time')
    await practitionerC.delete(`/conversations/${id}/messages/${deleted.id}`)
    await send(patient.agent, id, 'My own message, waiting for Casey')
    await age(id, 20)
    await send(practitionerC, id, 'Fresh — a minute old')
    expect(read.id).toBeLessThan(deleted.id)

    await notices.sweep()
    // The practitioner: the patient's message has waited — emailed.
    expect(noticesTo(toPractitioner).map((e) => e.subject)).toContain(
      `Pat ${patient.lastName} sent you a message on Stride`,
    )
    // The patient: their own message, a read one, a deleted one and a fresh
    // one — nothing that has waited for them. Not emailed, not marked.
    expect(noticesTo(toPatient)).toHaveLength(0)
    expect(await markers(id)).toStrictEqual({
      practitioner: true,
      patient: false,
    })
  })

  // The mirror: the patient is due, the practitioner's only message from
  // the patient is fresh.
  it("doesn't email the practitioner about a message still inside its 15 minutes", async () => {
    const patient = await newPatient()
    const toPatient = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Waiting for the patient')
    await age(id, 20)
    await send(patient.agent, id, 'Fresh reply')

    await notices.sweep()
    expect(noticesTo(toPatient)).toHaveLength(1)
    expect(await markers(id)).toStrictEqual({
      practitioner: false,
      patient: true,
    })
  })

  // --- 3. Claiming ------------------------------------------------------------------------------------------

  // SKIP LOCKED, deterministically: another transaction holds the
  // conversation's row lock — the sweep neither waits for it nor emails;
  // once it's released, the next sweep does.
  it('skips a conversation locked elsewhere instead of waiting, and claims it next time', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Hello')
    await age(id, 20)

    const holder = await sessionPool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(
        'SELECT id FROM conversations WHERE id = $1 FOR UPDATE',
        [id],
      )
      const started = Date.now()
      await notices.sweep()
      expect(Date.now() - started).toBeLessThan(2000)
      expect(noticesTo(to)).toHaveLength(0)
      await holder.query('COMMIT')
    } finally {
      holder.release()
    }
    await notices.sweep()
    expect(noticesTo(to)).toHaveLength(1)
  })

  it('sends a notice once even when two sweeps run at the same moment', async () => {
    const patient = await newPatient()
    const to = await emailOf(patient.id)
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Hello')
    await age(id, 20)
    await Promise.all([notices.sweep(), notices.sweep(), notices.sweep()])
    expect(noticesTo(to)).toHaveLength(1)
  })

  // --- 4. The database's rules, tried directly ---------------------------------------------------------------

  it('lets a participant clear their marker, but never set one', async () => {
    const patient = await newPatient()
    const id = await start(practitionerA, patient.id)
    await send(practitionerA, id, 'Hello')
    await age(id, 20)
    await notices.sweep()
    expect(await markers(id)).toStrictEqual({
      practitioner: false,
      patient: true,
    })

    // Setting the OTHER side's (silencing the practitioner's emails) is refused.
    const set = await asActor(
      patient.id,
      'patient',
      sql`UPDATE conversations SET practitioner_notified_at = now() WHERE id = ${id}`,
    )
    expect(set).toStrictEqual({
      error: {
        code: '23514',
        constraint: 'conversation_notified_by_sweep_only',
      },
    })
    // Moving one's own set marker is refused too; clearing it is allowed.
    const move = await asActor(
      patient.id,
      'patient',
      sql`UPDATE conversations SET patient_notified_at = now() - interval '1 day' WHERE id = ${id}`,
    )
    expect(move).toStrictEqual({
      error: {
        code: '23514',
        constraint: 'conversation_notified_by_sweep_only',
      },
    })
    const clear = await asActor(
      patient.id,
      'patient',
      sql`UPDATE conversations SET patient_notified_at = NULL WHERE id = ${id} RETURNING id`,
    )
    expect(clear).toStrictEqual({ rows: [{ id }] })
  })

  it('refuses the claim function inside a request (a user context set)', async () => {
    const attempt = await asActor(
      practitionerAId,
      'practitioner',
      sql`SELECT * FROM claim_message_notices(15)`,
    )
    expect(attempt).toStrictEqual({ error: { code: '42501' } })
  })

  it('refuses a delay under one minute', async () => {
    const client = await appPool.connect()
    try {
      await expect(
        client.query('SELECT * FROM claim_message_notices(0)'),
      ).rejects.toMatchObject({
        code: '22023',
      })
    } finally {
      client.release()
    }
  })

  it('answers names and addresses only — no message column at all', async () => {
    const { rows } = await sessionPool.query<{ name: string }>(
      `SELECT unnest(proargnames) AS name FROM pg_proc WHERE proname = 'claim_message_notices'`,
    )
    expect(rows.map((r) => r.name)).toEqual([
      'min_age_minutes',
      'conversation_id',
      'recipient_id',
      'recipient_side',
      'recipient_email',
      'recipient_first_name',
      'sender_first_name',
      'sender_last_name',
    ])
  })

  // --- 5. The setting ----------------------------------------------------------------------------------------

  it('is on by default, and only the person changes it', async () => {
    const patient = await newPatient()
    const me = await patient.agent.get('/auth/me')
    expect(me.body.messageEmailNotices).toBe(true)

    const byAdmin = await admin
      .patch(`/users/${patient.id}`)
      .send({ messageEmailNotices: false })
    expect(byAdmin.status).toBe(403)
    expect(byAdmin.body.message).toEqual([
      'Only the user themselves can change their message email setting',
    ])
    const notBoolean = await patient.agent
      .patch(`/users/${patient.id}`)
      .send({ messageEmailNotices: 'no' })
    expect(notBoolean.status).toBe(400)
    const nulled = await patient.agent
      .patch(`/users/${patient.id}`)
      .send({ messageEmailNotices: null })
    expect(nulled.status).toBe(400)
  })
})
