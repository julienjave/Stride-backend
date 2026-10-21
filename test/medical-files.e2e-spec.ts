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

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
// Medical files (Phase 6, 2026-10-20) — against a REAL Postgres, under the
// app's own role, so every answer below has gone through the row security
// policies (0019 / 0050), the constraints (0049) and the insert trigger
// (0050), not only the service.
//
// Layout: who may do what; creating; amending (incl. a deterministic race);
// a care-team link that ends; the database's own rules, tried directly; the
// audit trail — reads included.
describe('MedicalFiles (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let appPool: Pool
  let clinicId: number
  let stamp: number
  let accountCounter = 0

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  let adminId: number
  // practitionerA: on the care team of every patient newPatient() makes.
  let practitionerA: Agent
  let practitionerAId: number
  // practitionerC: a colleague of the same clinic, joined where a test says.
  let practitionerC: Agent
  let practitionerCId: number
  // outsider: a practitioner in no clinic — on nobody's care team.
  let outsider: Agent
  let outsiderId: number

  const GUARD_MESSAGE = 'You do not have permission to access this resource'
  const NOT_ON_TEAM_WRITE =
    'You can only add entries to the medical file of a patient on your care team'
  const NOT_ON_TEAM_READ =
    "You do not have permission to view this patient's medical file"
  const NO_SECTION =
    'An entry needs at least one section: Subjective, Objective, Assessment or Plan'
  const UNKNOWN_AMENDED =
    "The entry to amend isn't in this patient's medical file"
  const ALREADY_AMENDED =
    'This entry has already been amended — amend its latest version instead'

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
      clinicName: 'Medical Files E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'MF',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    clinicId = clinicRes.body.clinicId
    const { rows: adminRows } = await sessionPool.query<{ id: number }>(
      'SELECT id FROM users WHERE email = $1',
      [`admin-${stamp}@example.com`],
    )
    adminId = adminRows[0].id
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
    ;({ agent: outsider, id: outsiderId } = await newPractitioner(
      'Out',
      'Sider',
      undefined,
    ))
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
    return { agent, id }
  }

  // An ordinary entry by `by`, through the API.
  async function addEntry(
    by: Agent,
    patientId: number,
    fields: Record<string, unknown> = { plan: 'Review in 2 weeks' },
  ) {
    const res = await by
      .post('/medical-files')
      .send({ patientId, entryType: 'progress_note', ...fields })
    expect(res.status).toBe(201)
    return res.body as { id: number; createdAt: string }
  }

  async function storedCount(patientId: number): Promise<number> {
    const { rows } = await sessionPool.query<{ count: string }>(
      'SELECT count(*) FROM medical_files WHERE patient_id = $1',
      [patientId],
    )
    return Number(rows[0].count)
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  // Every audit entry about one patient's medical file, oldest first (as the owner:
  // audit_logs is admin-only under row security). entity_id is a bigint,
  // which node-postgres returns as a STRING — cast for a plain number. Also
  // the generic interceptor's entries for /medical-files requests (they
  // have no target), which must never exist.
  async function auditAbout(patientId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type, entity_id::int AS entity_id, details
       FROM audit_logs
       WHERE (target_user_id = $1 AND entity_type = 'medical_files')
          OR action LIKE '% /medical-files%'
       ORDER BY id`,
      [patientId],
    )
    return rows
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
  // rolled back, so a test leaves nothing behind.
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
    // Admins read no medical file since Phase 6 (decided 2026-10-20). The
    // guard's own message, not just the status: a status-only test couldn't
    // tell the guard from another 403.
    it('refuses an admin on every route, with the role guard’s message', async () => {
      const patient = await newPatient()
      const entry = await addEntry(practitionerA, patient.id)
      const attempts = [
        admin.get('/medical-files').query({ patientId: patient.id }),
        admin.get(`/medical-files/${entry.id}`),
        admin.post('/medical-files').send({
          patientId: patient.id,
          entryType: 'progress_note',
          plan: 'P',
        }),
      ]
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403)
        expect(res.body.message).toEqual([GUARD_MESSAGE])
      }
      expect(await storedCount(patient.id)).toBe(1)
    })

    it('refuses a patient writing, with the role guard’s message', async () => {
      const patient = await newPatient()
      const res = await patient.agent.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        subjective: 'I feel better',
      })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([GUARD_MESSAGE])
      expect(await storedCount(patient.id)).toBe(0)
    })

    // No pre-check in the service any more: this 403 is the INSERT policy's
    // refusal (42501), translated.
    it('refuses a practitioner off the care team writing — the policy decides', async () => {
      const patient = await newPatient()
      const res = await outsider.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        plan: 'P',
      })
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([NOT_ON_TEAM_WRITE])
      expect(await storedCount(patient.id)).toBe(0)
    })

    it('refuses a practitioner off the care team reading — 403 for the list, 404 for an entry', async () => {
      const patient = await newPatient()
      const entry = await addEntry(practitionerA, patient.id)

      const list = await outsider
        .get('/medical-files')
        .query({ patientId: patient.id })
      expect(list.status).toBe(403)
      expect(list.body.message).toEqual([NOT_ON_TEAM_READ])

      // Row security hides the entry: answered like an id that doesn't
      // exist — whether this patient HAS an entry 7 is clinical information.
      const one = await outsider.get(`/medical-files/${entry.id}`)
      expect(one.status).toBe(404)
      expect(one.body.message).toEqual([
        `Medical file entry ${entry.id} not found`,
      ])
    })

    it("lets a patient read their own file, and nobody else's", async () => {
      const patient = await newPatient()
      const other = await newPatient()
      const mine = await addEntry(practitionerA, patient.id)
      const theirs = await addEntry(practitionerA, other.id)

      const list = await patient.agent.get('/medical-files')
      expect(list.status).toBe(200)
      expect(list.body.map((e: { id: number }) => e.id)).toEqual([mine.id])
      // Their own id may be named; someone else's is refused.
      const named = await patient.agent
        .get('/medical-files')
        .query({ patientId: patient.id })
      expect(named.status).toBe(200)
      expect(named.body).toHaveLength(1)
      const foreign = await patient.agent
        .get('/medical-files')
        .query({ patientId: other.id })
      expect(foreign.status).toBe(403)
      expect(foreign.body.message).toEqual([
        'You can only view your own medical file',
      ])

      expect(
        (await patient.agent.get(`/medical-files/${mine.id}`)).status,
      ).toBe(200)
      expect(
        (await patient.agent.get(`/medical-files/${theirs.id}`)).status,
      ).toBe(404)
    })

    it('needs an integer patientId from a practitioner', async () => {
      const missing = await practitionerA.get('/medical-files')
      expect(missing.status).toBe(400)
      expect(missing.body.message).toEqual(['patientId is required'])

      const notANumber = await practitionerA
        .get('/medical-files')
        .query({ patientId: 'abc' })
      expect(notANumber.status).toBe(400)
      expect(notANumber.body.message).toEqual([
        'Validation failed (numeric string is expected)',
      ])
    })

    it('has no route to change or remove an entry', async () => {
      const patient = await newPatient()
      const entry = await addEntry(practitionerA, patient.id)
      const patch = await practitionerA
        .patch(`/medical-files/${entry.id}`)
        .send({ plan: 'edited' })
      expect(patch.status).toBe(404)
      const remove = await practitionerA.delete(`/medical-files/${entry.id}`)
      expect(remove.status).toBe(404)
    })
  })

  // === 2. CREATING ===========================================================

  describe('creating an entry', () => {
    it('stores a SOAP note and answers it in full', async () => {
      const patient = await newPatient()
      const res = await practitionerA.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'initial_assessment',
        subjective: 'Knee pain on stairs, 6/10',
        objective: 'Flexion 110°, mild effusion',
        assessment: 'Patellofemoral pain',
        plan: 'Quads strengthening, review in 2 weeks',
      })
      expect(res.status).toBe(201)

      const { rows } = await sessionPool.query<{ created_at: Date }>(
        'SELECT created_at FROM medical_files WHERE id = $1',
        [res.body.id],
      )
      expect(res.body).toStrictEqual({
        id: res.body.id,
        patientId: patient.id,
        entryType: 'initial_assessment',
        subjective: 'Knee pain on stairs, 6/10',
        objective: 'Flexion 110°, mild effusion',
        assessment: 'Patellofemoral pain',
        plan: 'Quads strengthening, review in 2 weeks',
        createdAt: rows[0].created_at.toISOString(),
        author: { id: practitionerAId, firstName: 'Alex', lastName: 'Chen' },
        amendsId: null,
        amendmentReason: null,
        amendedById: null,
      })
    })

    it('stores an entry with a single section — the others are null', async () => {
      const patient = await newPatient()
      const entry = await addEntry(practitionerA, patient.id, { plan: 'P' })
      const one = await practitionerA.get(`/medical-files/${entry.id}`)
      expect(one.body).toMatchObject({
        subjective: null,
        objective: null,
        assessment: null,
        plan: 'P',
      })
    })

    // The DTO lets it through on purpose — this 400 is the CHECK's.
    it('refuses an entry with no section — the database decides', async () => {
      const patient = await newPatient()
      const res = await practitionerA.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        subjective: null,
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([NO_SECTION])
      expect(await storedCount(patient.id)).toBe(0)
    })

    it('refuses the old free-form body and a blank section (the DTO)', async () => {
      const patient = await newPatient()
      const old = await practitionerA
        .post('/medical-files')
        .send({ patientId: patient.id, clinicalData: { note: 'intake' } })
      expect(old.status).toBe(400)
      expect(old.body.message).toEqual(
        expect.arrayContaining(['property clinicalData should not exist']),
      )

      const blank = await practitionerA.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        plan: '   ',
      })
      expect(blank.status).toBe(400)
      expect(blank.body.message).toEqual(["Plan can't be blank"])
      expect(await storedCount(patient.id)).toBe(0)
    })

    // Two entries of the same instant (the owner can write that — the seed
    // does write its own moments): the later id comes first, so the order is
    // the same on every read.
    it('orders entries of the same moment by id, newest first', async () => {
      const patient = await newPatient()
      const { rows } = await sessionPool.query<{ id: number }>(
        `INSERT INTO medical_files (patient_id, created_by, entry_type, plan, created_at)
         VALUES ($1, $2, 'progress_note', 'First', '2031-03-04T10:00:00Z'),
                ($1, $2, 'progress_note', 'Second', '2031-03-04T10:00:00Z')
         RETURNING id`,
        [patient.id, practitionerAId],
      )
      const list = await patient.agent.get('/medical-files')
      expect(list.body.map((e: { id: number }) => e.id)).toEqual([
        rows[1].id,
        rows[0].id,
      ])
    })

    it('lists a file newest first, each entry with its author', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const first = await addEntry(practitionerA, patient.id)
      const second = await addEntry(practitionerC, patient.id)

      const list = await practitionerA
        .get('/medical-files')
        .query({ patientId: patient.id })
      expect(list.status).toBe(200)
      expect(
        list.body.map((e: { id: number; author: { firstName: string } }) => [
          e.id,
          e.author.firstName,
        ]),
      ).toEqual([
        [second.id, 'Casey'],
        [first.id, 'Alex'],
      ])
    })
  })

  // === 3. AMENDING ===========================================================

  describe('amending an entry', () => {
    it('stores the amendment, and marks the original as amended', async () => {
      const patient = await newPatient()
      const original = await addEntry(practitionerA, patient.id, {
        objective: 'Left knee flexion 110°',
      })
      const res = await practitionerA.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        objective: 'Right knee flexion 110°',
        amendsId: original.id,
        amendmentReason: 'Wrong knee recorded',
      })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        amendsId: original.id,
        amendmentReason: 'Wrong knee recorded',
        amendedById: null,
      })

      // The original is unchanged — and now says what amends it.
      const list = await patient.agent.get('/medical-files')
      expect(list.body).toHaveLength(2)
      expect(list.body[0]).toMatchObject({
        id: res.body.id,
        amendsId: original.id,
      })
      expect(list.body[1]).toMatchObject({
        id: original.id,
        objective: 'Left knee flexion 110°',
        amendsId: null,
        amendedById: res.body.id,
      })
      const one = await patient.agent.get(`/medical-files/${original.id}`)
      expect(one.body.amendedById).toBe(res.body.id)
    })

    it('lets another care-team member amend, and forms a chain', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const original = await addEntry(practitionerA, patient.id)
      const amend = (amendsId: number, by: Agent) =>
        by.post('/medical-files').send({
          patientId: patient.id,
          entryType: 'progress_note',
          plan: `Corrected ${amendsId}`,
          amendsId,
          amendmentReason: 'Typo',
        })

      const byColleague = await amend(original.id, practitionerC)
      expect(byColleague.status).toBe(201)
      // The original again: corrected already → amend the latest instead.
      const again = await amend(original.id, practitionerA)
      expect(again.status).toBe(409)
      expect(again.body.message).toEqual([ALREADY_AMENDED])
      // The latest version: fine.
      const ofTheAmendment = await amend(byColleague.body.id, practitionerA)
      expect(ofTheAmendment.status).toBe(201)
      expect(await storedCount(patient.id)).toBe(3)
    })

    it("refuses amending another patient's entry, or one that doesn't exist", async () => {
      const patient = await newPatient()
      const other = await newPatient()
      const theirs = await addEntry(practitionerA, other.id)
      for (const amendsId of [theirs.id, 999_999]) {
        const res = await practitionerA.post('/medical-files').send({
          patientId: patient.id,
          entryType: 'progress_note',
          plan: 'P',
          amendsId,
          amendmentReason: 'Why',
        })
        expect(res.status).toBe(400)
        expect(res.body.message).toEqual([UNKNOWN_AMENDED])
      }
      expect(await storedCount(patient.id)).toBe(0)
    })

    // The new row's own id, guessed from the sequence: the foreign key alone
    // would accept it (the row references itself, which exists) — the
    // not-self CHECK is what refuses.
    it('refuses an entry amending itself (its own future id)', async () => {
      const patient = await newPatient()
      const { rows } = await sessionPool.query<{
        last_value: string
        is_called: boolean
      }>('SELECT last_value, is_called FROM medical_files_id_seq')
      const nextId = rows[0].is_called
        ? Number(rows[0].last_value) + 1
        : Number(rows[0].last_value)
      const res = await practitionerA.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        plan: 'P',
        amendsId: nextId,
        amendmentReason: 'Why',
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([UNKNOWN_AMENDED])
      expect(await storedCount(patient.id)).toBe(0)
    })

    // Two practitioners amending the same entry at the same moment: the
    // colleague's amendment is written but NOT committed when Alex's arrives.
    // Alex's INSERT must wait on the unique index (it can't know yet whether
    // the other one will commit), then — once it does — be refused.
    it('lets only one of two simultaneous amendments win', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const original = await addEntry(practitionerA, patient.id)
      const { waited, res } = await whileHolding(
        practitionerCId,
        'practitioner',
        `INSERT INTO medical_files (patient_id, created_by, entry_type, plan, amends_id, amendment_reason)
         VALUES ($1, $2, 'progress_note', 'Casey''s correction', $3, 'Typo')`,
        [patient.id, practitionerCId, original.id],
        () =>
          practitionerA.post('/medical-files').send({
            patientId: patient.id,
            entryType: 'progress_note',
            plan: "Alex's correction",
            amendsId: original.id,
            amendmentReason: 'Typo',
          }),
      )
      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([ALREADY_AMENDED])
      expect(await storedCount(patient.id)).toBe(2)
    })
  })

  // === 4. A CARE-TEAM LINK THAT ENDS =========================================

  describe('when a practitioner leaves the care team', () => {
    it('they lose the file; the patient keeps every entry, by name', async () => {
      const patient = await newPatient([practitionerA, practitionerC])
      const byCasey = await addEntry(practitionerC, patient.id)
      expect(
        (
          await admin
            .post(`/users/${patient.id}/care-team/${practitionerCId}/end`)
            .send({})
        ).status,
      ).toBe(201)

      const list = await practitionerC
        .get('/medical-files')
        .query({ patientId: patient.id })
      expect(list.status).toBe(403)
      expect(
        (await practitionerC.get(`/medical-files/${byCasey.id}`)).status,
      ).toBe(404)
      const write = await practitionerC.post('/medical-files').send({
        patientId: patient.id,
        entryType: 'progress_note',
        plan: 'P',
      })
      expect(write.status).toBe(403)
      expect(write.body.message).toEqual([NOT_ON_TEAM_WRITE])

      const mine = await patient.agent.get(`/medical-files/${byCasey.id}`)
      expect(mine.status).toBe(200)
      expect(mine.body.author).toEqual({
        id: practitionerCId,
        firstName: 'Casey',
        lastName: 'Ruiz',
      })
      // …and the remaining member still reads it.
      expect(
        (await practitionerA.get(`/medical-files/${byCasey.id}`)).status,
      ).toBe(200)
    })
  })

  // === 5. THE DATABASE'S OWN RULES ===========================================

  // Tried directly as the app's role, without the API — what holds for ANY
  // query, including one a future route might get wrong.
  describe('the database', () => {
    let patientId: number
    let otherPatientId: number
    let entryId: number
    let otherEntryId: number

    beforeAll(async () => {
      const patient = await newPatient()
      const other = await newPatient()
      patientId = patient.id
      otherPatientId = other.id
      entryId = (await addEntry(practitionerA, patientId)).id
      otherEntryId = (await addEntry(practitionerA, otherPatientId)).id
    })

    const insert = (fields: SQL) =>
      sql`INSERT INTO medical_files (patient_id, created_by, entry_type, subjective, objective, assessment, plan, amends_id, amendment_reason) VALUES ${fields}`

    it('hides every entry from an admin — 0 rows', async () => {
      const result = await asActor(
        adminId,
        'admin',
        sql`SELECT id FROM medical_files`,
      )
      expect(result).toEqual({ rows: [] })
      // Control: the rows are there.
      expect(await storedCount(patientId)).toBe(1)
    })

    it('shows a patient their own entries only', async () => {
      const result = await asActor(
        patientId,
        'patient',
        sql`SELECT id FROM medical_files ORDER BY id`,
      )
      expect(result).toEqual({ rows: [{ id: entryId }] })
    })

    // The patient branch keys on the ACTIVE role: the same account acting as
    // something else (an admin who is also a patient of the clinic, say)
    // doesn't see its own file through it.
    it('shows the same account nothing when it acts in another role', async () => {
      for (const role of ['admin', 'practitioner']) {
        const result = await asActor(
          patientId,
          role,
          sql`SELECT id FROM medical_files`,
        )
        expect(result).toEqual({ rows: [] })
      }
    })

    it('refuses an INSERT by a patient, as someone else, or off the care team', async () => {
      const values = (createdBy: number, patient: number) =>
        insert(
          sql`(${patient}, ${createdBy}, 'progress_note', NULL, NULL, NULL, 'P', NULL, NULL)`,
        )
      // No RETURNING: it would ask the SELECT policy first and could hide
      // which policy refused (the handoff's lesson).
      for (const [actor, role, statement] of [
        [patientId, 'patient', values(patientId, patientId)],
        [practitionerAId, 'practitioner', values(practitionerCId, patientId)],
        [outsiderId, 'practitioner', values(outsiderId, patientId)],
      ] as const) {
        expect(await asActor(actor, role, statement)).toEqual({
          error: { code: '42501' },
        })
      }
    })

    it('changes and removes nothing — no UPDATE or DELETE policy', async () => {
      const update = await asActor(
        practitionerAId,
        'practitioner',
        sql`UPDATE medical_files SET plan = 'edited' WHERE id = ${entryId} RETURNING id`,
      )
      expect(update).toEqual({ rows: [] })
      const remove = await asActor(
        practitionerAId,
        'practitioner',
        sql`DELETE FROM medical_files WHERE id = ${entryId} RETURNING id`,
      )
      expect(remove).toEqual({ rows: [] })
    })

    it("writes the database's own moment, whatever the client sends", async () => {
      const result = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO medical_files (patient_id, created_by, entry_type, plan, created_at)
            VALUES (${patientId}, ${practitionerAId}, 'progress_note', 'P', '2001-01-01T00:00:00Z')
            RETURNING created_at = now() AS is_now`,
      )
      expect(result).toEqual({ rows: [{ is_now: true }] })
    })

    // The owner is exempt (the dev seed writes a history with past
    // moments) — the trigger's other half.
    it('keeps the moment the OWNER writes', async () => {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query<{ created_at: Date }>(
          `INSERT INTO medical_files (patient_id, created_by, entry_type, plan, created_at)
           VALUES ($1, $2, 'progress_note', 'P', '2001-01-01T00:00:00Z')
           RETURNING created_at`,
          [patientId, practitionerAId],
        )
        expect(rows[0].created_at.toISOString()).toBe(
          '2001-01-01T00:00:00.000Z',
        )
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    it.each([
      [
        'no section at all',
        sql`NULL, NULL, NULL, NULL, NULL, NULL`,
        'medical_files_has_content',
      ],
      [
        'a blank section (a tab)',
        sql`E'\t', NULL, NULL, NULL, NULL, NULL`,
        'medical_files_sections_valid',
      ],
      [
        'a section of 10,001 characters',
        sql`NULL, NULL, NULL, repeat('a', 10001), NULL, NULL`,
        'medical_files_sections_valid',
      ],
      [
        'a reason without an amendment',
        sql`NULL, NULL, NULL, 'P', NULL, 'Why'`,
        'medical_files_amendment_reason_valid',
      ],
    ])('refuses %s', async (_name, rest, constraint) => {
      const result = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO medical_files (patient_id, created_by, entry_type, subjective, objective, assessment, plan, amends_id, amendment_reason)
            VALUES (${patientId}, ${practitionerAId}, 'progress_note', ${rest})`,
      )
      expect(result).toEqual({ error: { code: '23514', constraint } })
    })

    it('refuses an amendment without a reason, or with a blank or over-long one', async () => {
      for (const reason of [sql`NULL`, sql`'  '`, sql`repeat('a', 501)`]) {
        const result = await asActor(
          practitionerAId,
          'practitioner',
          sql`INSERT INTO medical_files (patient_id, created_by, entry_type, plan, amends_id, amendment_reason)
              VALUES (${patientId}, ${practitionerAId}, 'progress_note', 'P', ${entryId}, ${reason})`,
        )
        expect(result).toEqual({
          error: {
            code: '23514',
            constraint: 'medical_files_amendment_reason_valid',
          },
        })
      }
    })

    it('accepts sections of exactly 10,000 characters and a 500-character reason', async () => {
      const result = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO medical_files (patient_id, created_by, entry_type, subjective, objective, assessment, plan, amends_id, amendment_reason)
            VALUES (${patientId}, ${practitionerAId}, 'progress_note', repeat('a', 10000), repeat('b', 10000), repeat('c', 10000), repeat('d', 10000), ${entryId}, repeat('r', 500))
            RETURNING amends_id`,
      )
      expect(result).toEqual({ rows: [{ amends_id: entryId }] })
    })

    // The practitioner is on BOTH patients' care teams here, so the policy
    // allows the row — only the composite foreign key can refuse it.
    it("refuses an amendment pointing at another patient's entry", async () => {
      const result = await asActor(
        practitionerAId,
        'practitioner',
        sql`INSERT INTO medical_files (patient_id, created_by, entry_type, plan, amends_id, amendment_reason)
            VALUES (${patientId}, ${practitionerAId}, 'progress_note', 'P', ${otherEntryId}, 'Why')`,
      )
      expect(result).toEqual({
        error: {
          code: '23503',
          constraint: 'medical_files_amends_same_patient_fk',
        },
      })
    })
  })

  // === 6. THE AUDIT TRAIL ====================================================

  describe('the audit trail', () => {
    it('records a new entry once, in detail — and no generic entry', async () => {
      const patient = await newPatient()
      const entry = await addEntry(practitionerA, patient.id, {
        entryType: 'initial_assessment',
        subjective: 'S',
      })
      const { rows } = await sessionPool.query<{ created_at: Date }>(
        'SELECT created_at FROM medical_files WHERE id = $1',
        [entry.id],
      )
      expect(await auditAbout(patient.id)).toEqual([
        {
          action: 'MEDICAL_FILE_ENTRY_CREATED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'medical_files',
          entity_id: entry.id,
          details: {
            entryType: 'initial_assessment',
            createdAt: rows[0].created_at.toISOString(),
          },
        },
      ])
    })

    it('records an amendment as MEDICAL_FILE_ENTRY_AMENDED, naming the original', async () => {
      const patient = await newPatient()
      const original = await addEntry(practitionerA, patient.id)
      const amendment = await addEntry(practitionerA, patient.id, {
        plan: 'Corrected',
        amendsId: original.id,
        amendmentReason: 'Typo',
      })
      const trail = await auditAbout(patient.id)
      expect(trail).toHaveLength(2)
      expect(trail[1]).toEqual({
        action: 'MEDICAL_FILE_ENTRY_AMENDED',
        performed_by: practitionerAId,
        target_user_id: patient.id,
        entity_type: 'medical_files',
        entity_id: amendment.id,
        details: {
          entryType: 'progress_note',
          createdAt: amendment.createdAt,
          amendsId: original.id,
        },
      })
    })

    it('records nothing for a refused write', async () => {
      const patient = await newPatient()
      const refused = [
        await outsider.post('/medical-files').send({
          patientId: patient.id,
          entryType: 'progress_note',
          plan: 'P',
        }),
        await practitionerA.post('/medical-files').send({
          patientId: patient.id,
          entryType: 'progress_note',
        }),
      ]
      expect(refused.map((res) => res.status)).toEqual([403, 400])
      expect(await auditAbout(patient.id)).toEqual([])
    })

    // HIPAA's concern with a health record is who VIEWED it too — the
    // patient's own look included.
    it('records each read: the list with the entries shown, and one entry', async () => {
      const patient = await newPatient()
      const older = await addEntry(practitionerA, patient.id)
      const newer = await addEntry(practitionerA, patient.id)

      await patient.agent.get('/medical-files').expect(200)
      await practitionerA
        .get('/medical-files')
        .query({ patientId: patient.id })
        .expect(200)
      await practitionerA.get(`/medical-files/${older.id}`).expect(200)

      const reads = (await auditAbout(patient.id)).filter((row) =>
        row.action.endsWith('VIEWED'),
      )
      expect(reads).toEqual([
        {
          action: 'MEDICAL_FILE_VIEWED',
          performed_by: patient.id,
          target_user_id: patient.id,
          entity_type: 'medical_files',
          entity_id: null,
          details: { entryIds: [newer.id, older.id] },
        },
        {
          action: 'MEDICAL_FILE_VIEWED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'medical_files',
          entity_id: null,
          details: { entryIds: [newer.id, older.id] },
        },
        {
          action: 'MEDICAL_FILE_ENTRY_VIEWED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'medical_files',
          entity_id: older.id,
          details: null,
        },
      ])
    })

    it('records no read that was refused', async () => {
      const patient = await newPatient()
      const entry = await addEntry(practitionerA, patient.id)
      await outsider
        .get('/medical-files')
        .query({ patientId: patient.id })
        .expect(403)
      await outsider.get(`/medical-files/${entry.id}`).expect(404)
      const reads = (await auditAbout(patient.id)).filter((row) =>
        row.action.endsWith('VIEWED'),
      )
      expect(reads).toEqual([])
    })
  })
})
