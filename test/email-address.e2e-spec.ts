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
import {
  DUPLICATE_EMAIL_MESSAGE,
  normalizeEmail,
} from '../src/common/email-address'
import { USERS_EMAIL_NORMALIZED } from '../src/database/pg-errors'

// Emails are case-insensitive (Phase 6, "Change email", pass 1 — decided with
// the person 2026-10-22). Every email is stored in one spelling — trimmed,
// A–Z lowercased — so:
//   - an email a request brings in is normalised before anything else
//     (@NormalizeEmail() on the DTOs): setting up the first clinic, signing
//     in, asking for a reset link, creating an account;
//   - a taken address is refused with a 409 by the database's UNIQUE
//     constraint itself — whatever the capitals, and also when two requests
//     race (there is no read beforehand any more);
//   - the database refuses any other spelling (CHECK users_email_normalized,
//     migration 0052), and its expression agrees with the app's
//     normalizeEmail() on every input.
describe('Email addresses (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let outbox: InMemoryEmailTransport

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let clinicId: number
  const stamp = Date.now()

  // The founding admin's address, as stored — and as typed at setup.
  const adminEmail = `ea-admin-${stamp}@example.com`
  const adminTyped = `  EA-Admin-${stamp}@Example.COM `

  // --- Reading as the owner (not subject to row security) ------------------

  async function emailsLike(pattern: string) {
    const { rows } = await sessionPool.query<{ email: string }>(
      'SELECT email FROM users WHERE lower(email) LIKE $1 ORDER BY id',
      [pattern],
    )
    return rows.map((row) => row.email)
  }

  async function count(query: string, params: unknown[] = []) {
    const { rows } = await sessionPool.query<{ n: number }>(query, params)
    return Number(rows[0].n)
  }

  // An account planted by the owner, the way a seed or a query typed by hand
  // would — bypassing the API, so its address is exactly what we give.
  async function plantUser(email: string) {
    const { rows } = await sessionPool.query<{ id: number }>(
      `INSERT INTO users (email, first_name, last_name)
       VALUES ($1, 'Planted', 'User') RETURNING id`,
      [email],
    )
    return rows[0].id
  }

  // The database's error code and constraint for a statement, or null.
  async function refusal(statement: string, params: unknown[]) {
    try {
      await sessionPool.query(statement, params)
      return null
    } catch (error) {
      const { code, constraint } = error as {
        code?: string
        constraint?: string
      }
      return { code, constraint }
    }
  }

  // An uncommitted write held open on another connection while `send`
  // runs; it commits after 300 ms. `waited`: the request was still
  // unanswered then — it really met the held row (the same helper as
  // test/sessions.e2e-spec.ts, on the owner's connection).
  async function whileHolding(
    statement: string,
    params: unknown[],
    send: () => PromiseLike<request.Response>,
  ) {
    const client = await sessionPool.connect()
    try {
      await client.query('BEGIN')
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
    // No admin yet: the first block below sets Stride up itself.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- Setting up Stride ---------------------------------------------------

  // Runs first: register-clinic works only while no admin exists.
  describe('the first setup (register-clinic)', () => {
    const setup = (email: string) =>
      agent()
        .post('/auth/register-clinic')
        .send({
          clinicName: 'Email Clinic',
          clinicEmail: `Front.Desk-${stamp}@Example.com`,
          email,
          password: 'password123',
          firstName: 'Ada',
          lastName: 'Admin',
        })

    // An account existing before the setup (a seed, a query by hand) holds
    // the address in its stored spelling; the setup types it with other
    // capitals. The UNIQUE refuses — and the whole transaction is undone:
    // no clinic either.
    it('refuses an address already taken in other capitals, and creates nothing', async () => {
      const plantedId = await plantUser(adminEmail)

      const res = await setup(adminTyped)

      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([DUPLICATE_EMAIL_MESSAGE])
      expect(await count('SELECT count(*) AS n FROM clinics')).toBe(0)
      expect(await emailsLike(`%ea-admin-${stamp}%`)).toEqual([adminEmail])

      await sessionPool.query('DELETE FROM users WHERE id = $1', [plantedId])
    })

    it("stores the founding admin's address normalised — not the clinic's contact address", async () => {
      admin = agent()
      const res = await admin.post('/auth/register-clinic').send({
        clinicName: 'Email Clinic',
        clinicEmail: `Front.Desk-${stamp}@Example.com`,
        email: adminTyped,
        password: 'password123',
        firstName: 'Ada',
        lastName: 'Admin',
      })

      expect(res.status).toBe(201)
      expect(res.body.email).toBe(adminEmail)
      expect(await emailsLike(`%ea-admin-${stamp}%`)).toEqual([adminEmail])
      clinicId = res.body.clinicId as number
      const { rows } = await sessionPool.query<{ email: string }>(
        'SELECT email FROM clinics WHERE id = $1',
        [clinicId],
      )
      expect(rows[0].email).toBe(`Front.Desk-${stamp}@Example.com`)
    })
  })

  // --- Signing in and resetting -------------------------------------------

  describe('signing in and asking for a reset link', () => {
    it('signs in whatever capitals and spaces the address is typed with', async () => {
      const res = await agent()
        .post('/auth/login')
        .send({
          email: ` ${adminEmail.toUpperCase()}`,
          password: 'password123',
        })

      expect(res.status).toBe(201)
      expect(res.body.email).toBe(adminEmail)
    })

    // forgotPassword answers 204 whether or not the account exists, so the
    // proof is the email: sent to the stored address.
    it('sends the reset link when the address is typed with other capitals', async () => {
      const before = outbox.sentTo(adminEmail).length

      const res = await agent()
        .post('/auth/forgot-password')
        .send({ email: adminTyped })

      expect(res.status).toBe(204)
      expect(outbox.sentTo(adminEmail)).toHaveLength(before + 1)
      expect(outbox.lastSentTo(adminEmail).subject).toMatch(/password/i)
    })
  })

  // --- Creating accounts ---------------------------------------------------

  describe('creating an account (POST /users)', () => {
    const create = (email: string) =>
      admin.post('/users').send({
        email,
        role: 'patient',
        firstName: 'Pat',
        lastName: 'Ient',
        dateOfBirth: '1980-02-03',
        clinicId,
      })

    it('stores the address normalised, and invites it there', async () => {
      const stored = `ea-new-${stamp}@example.com`

      const res = await create(`EA-New-${stamp}@EXAMPLE.com`)

      expect(res.status).toBe(201)
      expect(res.body.email).toBe(stored)
      expect(await emailsLike(`%ea-new-${stamp}%`)).toEqual([stored])
      expect(outbox.sentTo(stored)).toHaveLength(1)
      // The account can sign in with yet other capitals once it has a
      // password.
      await activateAccount(sessionPool, stored)
      const login = await agent()
        .post('/auth/login')
        .send({ email: `Ea-NEW-${stamp}@example.COM`, password: 'password123' })
      expect(login.status).toBe(201)
    })

    // Before, the UNIQUE compared exact strings: this made a second account.
    it('refuses an address taken in other capitals: no account, invitation, email or entry', async () => {
      const stored = `ea-twice-${stamp}@example.com`
      expect((await create(stored)).status).toBe(201)
      const entries = await count(
        "SELECT count(*) AS n FROM audit_logs WHERE action = 'USER_CREATED'",
      )
      const invitations = await count('SELECT count(*) AS n FROM invitations')

      const res = await create(`EA-Twice-${stamp}@Example.com`)

      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([DUPLICATE_EMAIL_MESSAGE])
      expect(await emailsLike(`%ea-twice-${stamp}%`)).toEqual([stored])
      expect(outbox.sentTo(stored)).toHaveLength(1)
      expect(
        await count(
          "SELECT count(*) AS n FROM audit_logs WHERE action = 'USER_CREATED'",
        ),
      ).toBe(entries)
      expect(await count('SELECT count(*) AS n FROM invitations')).toBe(
        invitations,
      )
    })

    // The race a read-then-write lost: another transaction has inserted the
    // address but not committed. A read sees nothing ("free"); the request's
    // own INSERT waits on the unique index until that transaction commits,
    // then is refused — and that refusal must be the 409, not a 500.
    it('answers a 409 when another transaction takes the address at the same moment', async () => {
      const stored = `ea-race-${stamp}@example.com`

      const { waited, res } = await whileHolding(
        `INSERT INTO users (email, first_name, last_name)
         VALUES ($1, 'Other', 'Request')`,
        [stored],
        () => create(`EA-Race-${stamp}@Example.com`),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([DUPLICATE_EMAIL_MESSAGE])
      expect(await emailsLike(`%ea-race-${stamp}%`)).toEqual([stored])
    })
  })

  // --- The database's rule -------------------------------------------------

  describe("the database's rule (CHECK users_email_normalized)", () => {
    it.each([
      ['capitals', `EA-Check-${stamp}@example.com`],
      ['a space before', ` ea-check-${stamp}@example.com`],
      ['a space after', `ea-check-${stamp}@example.com `],
    ])(
      'refuses an address with %s, whatever writes it',
      async (_case, email) => {
        expect(
          await refusal(
            `INSERT INTO users (email, first_name, last_name) VALUES ($1, 'A', 'B')`,
            [email],
          ),
        ).toEqual({ code: '23514', constraint: USERS_EMAIL_NORMALIZED })
      },
    )

    it('refuses an UPDATE to another spelling too', async () => {
      expect(
        await refusal(
          'UPDATE users SET email = upper(email) WHERE email = $1',
          [adminEmail],
        ),
      ).toEqual({ code: '23514', constraint: USERS_EMAIL_NORMALIZED })
    })

    // Letters outside A–Z are left as typed, by the app AND the database.
    it('accepts letters outside A–Z as they are', async () => {
      expect(await plantUser(`Émile-${stamp}@exämple.com`)).toEqual(
        expect.any(Number),
      )
    })

    // The two implementations of "the normal spelling" must agree on every
    // input, or an address the app stores could break the CHECK, or one the
    // migration rewrote could stop matching what the app looks up. Inputs
    // chosen where a locale-aware lower() and A–Z-only lowering differ (É,
    // the Turkish İ, ß, a titlecase ǅ), with spaces at the ends (the CHECK's
    // btrim() trims spaces; normalizeEmail's trim() more — @IsEmail() refuses
    // any other whitespace in an address).
    it("computes the same spelling as the app's normalizeEmail()", async () => {
      const inputs = [
        '  Jane.Doe@Example.COM ',
        'ÉMILE@EXÄMPLE.COM',
        'İSTANBUL@x.com',
        'STRAßE@X.COM',
        'ǅAN@x.com',
        'already@normal.test',
      ]
      const { rows } = await sessionPool.query<{ input: string; db: string }>(
        `SELECT input, btrim(lower(input COLLATE "C")) AS db
           FROM unnest($1::text[]) AS input`,
        [inputs],
      )

      expect(rows.map((row) => row.db)).toEqual(inputs.map(normalizeEmail))
    })
  })
})
