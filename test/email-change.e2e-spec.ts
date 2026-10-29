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
import { getAppDatabaseUrl, getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { MessagingEvents } from '../src/messaging/messaging-events'
import {
  ADDRESS_TAKEN_ON_CONFIRM_MESSAGE,
  ALREADY_CONFIRMED_MESSAGE,
  INVALID_EMAIL_CHANGE_LINK_MESSAGE,
  SAME_EMAIL_MESSAGE,
} from '../src/email-change/email-change.service'
import { WRONG_PASSWORD_MESSAGE } from '../src/common/current-password'
import { AUTHENTICATOR_LABEL_NOTE } from '../src/email/email.service'

// Changing one's own sign-in email ("Change email", Phase 6 pass 2 —
// decisions §12). What the person chose, and what these tests hold the code
// to:
//   - the change is ASKED with the current password, and MADE only by the
//     link emailed to the new address (24 hours);
//   - a taken address REVEALS NOTHING: the same answer, the request stored,
//     the old inbox told — only the new inbox's email differs;
//   - the OLD inbox gets a notice with the new address MASKED and a CANCEL
//     link, then a "changed" notice; a password reset cancels a pending
//     change;
//   - confirming SIGNS THE ACCOUNT OUT everywhere else;
//   - the person sees and cancels their pending change in the app;
//   - every write is ONE audit entry in its transaction;
//   - the database holds the rules too (row security, the guard trigger).
describe('Email change (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let appPool: Pool
  let outbox: InMemoryEmailTransport

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let clinicId: number
  const stamp = Date.now()
  let counter = 0

  // --- Accounts -------------------------------------------------------------

  // A fresh, activated patient — each test its own, so no test depends on
  // another's leftovers — signed in on one agent.
  async function newPerson() {
    counter += 1
    const email = `ec-${counter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Pat',
      lastName: 'Ient',
      dateOfBirth: '1980-02-03',
      // Many patients with one name and birthday, on purpose: the
      // possible-duplicate warning has its own suite (possible-duplicates).
      allowPossibleDuplicate: true,
      clinicId,
    })
    expect(res.status).toBe(201)
    const id = await activateAccount(sessionPool, email)
    const signedIn = agent()
    const login = await signIn(signedIn, email)
    expect(login.status).toBe(201)
    return { id, email, signedIn }
  }

  function signIn(who: ReturnType<typeof agent>, email: string) {
    return who.post('/auth/login').send({ email, password: 'password123' })
  }

  function freshAddress(label: string) {
    counter += 1
    return `ec-${label}-${counter}-${stamp}@example.com`
  }

  // --- Requests and links ---------------------------------------------------

  function ask(
    who: ReturnType<typeof agent>,
    newEmail: string,
    currentPassword = 'password123',
  ) {
    return who.post('/auth/email-change').send({ newEmail, currentPassword })
  }

  // The token of the last link to `path` emailed to `address`.
  function tokenFrom(address: string, path: string): string {
    const token = findLink(outbox.lastSentTo(address), path).searchParams.get(
      'token',
    )
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    return token as string
  }

  function confirm(token: string, who = agent()) {
    return who.post('/auth/email-change/confirm').send({ token })
  }

  function cancelByLink(token: string) {
    return agent().post('/auth/email-change/cancel').send({ token })
  }

  // --- Reading as the owner (no row security) -------------------------------

  interface RequestRow {
    id: number
    new_email: string
    confirmed: boolean
    cancel_reason: string | null
    open: boolean
  }

  async function requestsOf(userId: number): Promise<RequestRow[]> {
    const { rows } = await sessionPool.query<RequestRow>(
      `SELECT id, new_email, confirmed_at IS NOT NULL AS confirmed,
              cancel_reason::text, (confirmed_at IS NULL AND cancelled_at IS NULL) AS open
         FROM email_change_requests WHERE user_id = $1 ORDER BY id`,
      [userId],
    )
    return rows
  }

  async function emailOf(userId: number) {
    const { rows } = await sessionPool.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [userId],
    )
    return rows[0].email
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number
    entity_type: string
    entity_id: number
    details: Record<string, unknown> | null
  }

  // The email-change entries about one account, oldest first. (Setting the
  // account up wrote others — USER_CREATED, sign-ins — not under test here.)
  async function trail(userId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type,
              entity_id::int AS entity_id, details
         FROM audit_logs
        WHERE target_user_id = $1
          AND (action LIKE 'EMAIL_CHANGE_%' OR action = 'PASSWORD_RESET_COMPLETED')
        ORDER BY id`,
      [userId],
    )
    return rows
  }

  async function sessionsOf(userId: number) {
    const { rows } = await sessionPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM session
        WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
      [String(userId)],
    )
    return Number(rows[0].n)
  }

  // --- The database as the app sees it --------------------------------------

  // One statement under the app's role (row security applies), with the
  // settings a request would have — a signed-in user, and/or a link's token
  // hash — in a transaction that is always rolled back. The error's code and
  // constraint, or the rows.
  async function asApp(
    settings: Record<string, string>,
    statement: string,
    params: unknown[] = [],
  ): Promise<
    { rows: Record<string, unknown>[] } | { code?: string; constraint?: string }
  > {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      for (const [name, value] of Object.entries(settings)) {
        await client.query('SELECT set_config($1, $2, true)', [name, value])
      }
      const { rows } = await client.query<Record<string, unknown>>(
        statement,
        params,
      )
      return { rows }
    } catch (error) {
      const { code, constraint } = error as {
        code?: string
        constraint?: string
      }
      return { code, constraint }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  const asUser = (id: number) => ({
    'app.current_user_id': String(id),
    'app.current_role': 'patient',
  })

  async function tokenHashes(requestId: number) {
    const { rows } = await sessionPool.query<{
      token_hash: string
      cancel_token_hash: string
    }>(
      'SELECT token_hash, cancel_token_hash FROM email_change_requests WHERE id = $1',
      [requestId],
    )
    return rows[0]
  }

  // An uncommitted write held open on another connection while `send` runs;
  // committed after 300 ms (the helper of test/sessions.e2e-spec.ts).
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
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )
    await sessionPool.query('DELETE FROM session')
    // Request ids far from user ids: an entry naming one where the other
    // belongs must fail, not pass by coincidence.
    await sessionPool.query(
      "SELECT setval(pg_get_serial_sequence('email_change_requests', 'id'), 100000)",
    )

    admin = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Email Change Clinic',
      clinicEmail: `ec-clinic-${stamp}@example.com`,
      email: `ec-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicId = bootstrap.body.clinicId as number
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
    await appPool.end()
  })

  // === Asking for a change ===================================================

  describe('asking for a change (POST /auth/email-change)', () => {
    it('refuses without a session, on every signed-in route', async () => {
      const nobody = agent()
      expect((await nobody.get('/auth/email-change')).status).toBe(401)
      expect((await ask(nobody, freshAddress('x'))).status).toBe(401)
      expect((await nobody.delete('/auth/email-change')).status).toBe(401)
    })

    it('refuses a wrong current password: nothing stored, nothing sent', async () => {
      const pat = await newPerson()
      const sentBefore = outbox.sent.length

      const res = await ask(
        pat.signedIn,
        freshAddress('new'),
        'not-my-password',
      )

      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
      expect(await requestsOf(pat.id)).toEqual([])
      expect(outbox.sent.length).toBe(sentBefore)
      expect(await trail(pat.id)).toEqual([])
    })

    // Normalised first: the account's own address in other capitals is
    // still the account's own address.
    it('refuses the address the account already has, whatever its capitals', async () => {
      const pat = await newPerson()

      const res = await ask(pat.signedIn, pat.email.toUpperCase())

      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([SAME_EMAIL_MESSAGE])
      expect(await requestsOf(pat.id)).toEqual([])
    })

    it('stores the request, sends the link to the new address and the masked notice to the old one', async () => {
      const pat = await newPerson()
      const typed = `  EC-Moved-${stamp}@Example.COM `
      const moved = `ec-moved-${stamp}@example.com`

      const res = await ask(pat.signedIn, typed)

      expect(res.status).toBe(201)
      const pending = res.body.pending as {
        newEmail: string
        createdAt: string
        expiresAt: string
      }
      expect(pending.newEmail).toBe(moved)
      // 24 hours, by the database's clock (both moments are its own).
      expect(
        Date.parse(pending.expiresAt) - Date.parse(pending.createdAt),
      ).toBe(24 * 60 * 60 * 1000)
      // Nothing changes until the new address confirms.
      expect(await emailOf(pat.id)).toBe(pat.email)
      expect((await pat.signedIn.get('/auth/email-change')).body).toEqual({
        pending,
      })

      // The new address: the confirm link.
      const confirmEmail = outbox.lastSentTo(moved)
      expect(confirmEmail.subject).toBe(
        'Confirm your new email address for Stride',
      )
      tokenFrom(moved, '/confirm-email')
      // The old address: the notice — the new address MASKED, never in
      // full — with the cancel link.
      const notice = outbox.lastSentTo(pat.email)
      expect(notice.text).toContain('to e•••@e•••.com.')
      expect(notice.text).not.toContain(moved)
      expect(notice.html).not.toContain(moved)
      tokenFrom(pat.email, '/cancel-email-change')

      const [row] = await requestsOf(pat.id)
      expect(await trail(pat.id)).toStrictEqual([
        {
          action: 'EMAIL_CHANGE_REQUESTED',
          performed_by: pat.id,
          target_user_id: pat.id,
          entity_type: 'email_change_requests',
          entity_id: row.id,
          details: { newEmail: moved, expiresAt: pending.expiresAt },
        },
      ])
    })

    // "Reveal nothing": the same status and the same answer's shape, a
    // request stored and the old inbox told, as for a free address — only
    // the NEW inbox learns the address is taken, and the entry doesn't say.
    it('answers a taken address exactly like a free one; only the new inbox is told', async () => {
      const pat = await newPerson()
      const other = await newPerson()

      const res = await ask(pat.signedIn, other.email)

      expect(res.status).toBe(201)
      expect(Object.keys(res.body as object)).toEqual(['pending'])
      expect(Object.keys(res.body.pending as object).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'newEmail',
      ])
      expect(res.body.pending.newEmail).toBe(other.email)
      const [row] = await requestsOf(pat.id)
      expect(row.open).toBe(true)

      const told = outbox.lastSentTo(other.email)
      expect(told.subject).toBe('This address already has a Stride account')
      expect(told.text).not.toContain('http')
      expect(outbox.lastSentTo(pat.email).subject).toBe(
        'A change of your Stride sign-in email was requested',
      )
      const [entry] = await trail(pat.id)
      expect(Object.keys(entry.details as object).sort()).toEqual([
        'expiresAt',
        'newEmail',
      ])
    })

    it('replaces an open request: its links die, and the entry names it', async () => {
      const pat = await newPerson()
      const first = freshAddress('first')
      await ask(pat.signedIn, first)
      const firstToken = tokenFrom(first, '/confirm-email')
      const second = freshAddress('second')

      expect((await ask(pat.signedIn, second)).status).toBe(201)

      const rows = await requestsOf(pat.id)
      expect(
        rows.map((row) => [row.new_email, row.open, row.cancel_reason]),
      ).toEqual([
        [first, false, 'replaced'],
        [second, true, null],
      ])
      expect((await confirm(firstToken)).body.message).toEqual([
        INVALID_EMAIL_CHANGE_LINK_MESSAGE,
      ])
      const entries = await trail(pat.id)
      expect(entries[1].details).toMatchObject({
        replacedRequestId: rows[0].id,
      })
    })

    // Two tabs asking at once must run one after the other — the account's
    // row is locked — or both would find nothing open and the second would
    // fail on the one-open index. The held lock is FOR NO KEY UPDATE: the
    // insert's foreign-key check takes FOR KEY SHARE on the same row, which
    // a FOR UPDATE would block too (with or without the request's own lock —
    // a mutation removing the lock survived that version of this test);
    // NO KEY UPDATE blocks only the request's FOR UPDATE.
    it("waits for the account's row: requests from one person run in turn", async () => {
      const pat = await newPerson()

      const { waited, res } = await whileHolding(
        'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',
        [pat.id],
        () => ask(pat.signedIn, freshAddress('held')),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(201)
    })
  })

  // === Seeing and cancelling it in the app ===================================

  describe('the pending change in the app (GET / DELETE)', () => {
    it('answers null with nothing pending, and null again once the link has expired', async () => {
      const pat = await newPerson()
      expect((await pat.signedIn.get('/auth/email-change')).body).toEqual({
        pending: null,
      })

      await ask(pat.signedIn, freshAddress('ages'))
      await sessionPool.query(
        `UPDATE email_change_requests
            SET created_at = now() - interval '2 days',
                expires_at = now() - interval '1 second'
          WHERE user_id = $1`,
        [pat.id],
      )

      expect((await pat.signedIn.get('/auth/email-change')).body).toEqual({
        pending: null,
      })
    })

    it('cancels the open request once; a second cancel writes nothing', async () => {
      const pat = await newPerson()
      const address = freshAddress('undo')
      await ask(pat.signedIn, address)
      const token = tokenFrom(address, '/confirm-email')

      expect((await pat.signedIn.delete('/auth/email-change')).status).toBe(204)
      expect((await pat.signedIn.delete('/auth/email-change')).status).toBe(204)

      const [row] = await requestsOf(pat.id)
      expect(row.cancel_reason).toBe('cancelled_in_app')
      expect((await pat.signedIn.get('/auth/email-change')).body).toEqual({
        pending: null,
      })
      expect((await confirm(token)).status).toBe(400)
      expect((await trail(pat.id)).map((entry) => entry.action)).toEqual([
        'EMAIL_CHANGE_REQUESTED',
        'EMAIL_CHANGE_CANCELLED',
      ])
      expect((await trail(pat.id))[1]).toMatchObject({
        performed_by: pat.id,
        entity_id: row.id,
        details: { reason: 'cancelled_in_app' },
      })
    })
  })

  // === Confirming ============================================================

  describe('confirming (POST /auth/email-change/confirm)', () => {
    // An authenticator app keeps the label it scanned — the OLD email: the
    // notice of an account with two-factor on says so (decided 2026-10-29).
    it('tells an account with two-factor on that its authenticator app keeps the old address', async () => {
      const pat = await newPerson()
      const moved = freshAddress('moved-mfa')
      await ask(pat.signedIn, moved)
      // Two-factor turned on between the request and the click, as the
      // owner (the request itself was made without a code); what the
      // confirmation reads is the account at the moment it confirms.
      await sessionPool.query(
        "UPDATE users SET mfa_enabled = true, mfa_secret = 'stored-secret' WHERE id = $1",
        [pat.id],
      )

      expect((await confirm(tokenFrom(moved, '/confirm-email'))).status).toBe(
        200,
      )

      const changed = outbox.lastSentTo(pat.email)
      expect(changed.subject).toBe('Your Stride sign-in email was changed')
      expect(changed.text).toContain(AUTHENTICATOR_LABEL_NOTE)
    })

    it('changes the email, signs the account out everywhere, and tells the old address', async () => {
      const pat = await newPerson()
      const second = agent()
      await signIn(second, pat.email)
      expect(await sessionsOf(pat.id)).toBe(2)
      const moved = freshAddress('moved')
      await ask(pat.signedIn, moved)
      const { rows: before } = await sessionPool.query<{ sid: string }>(
        `SELECT sid FROM session
          WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
        [String(pat.id)],
      )
      // A signed-out device's socket must close too (it was authenticated
      // once, at its handshake) — as on logout.
      const disconnect = jest.spyOn(
        app.get(MessagingEvents),
        'disconnectSession',
      )

      // Opened on a device that isn't signed in.
      const res = await confirm(tokenFrom(moved, '/confirm-email'))
      const closed = disconnect.mock.calls.map(([sid]) => sid)
      disconnect.mockRestore()

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ email: moved })
      expect(await emailOf(pat.id)).toBe(moved)
      expect(await sessionsOf(pat.id)).toBe(0)
      expect(closed.sort()).toEqual(before.map((row) => row.sid).sort())
      expect((await pat.signedIn.get('/auth/me')).status).toBe(401)
      expect((await second.get('/auth/me')).status).toBe(401)
      // The new address signs in; the old one no longer does.
      expect((await signIn(agent(), moved)).status).toBe(201)
      expect((await signIn(agent(), pat.email)).status).toBe(401)

      const changed = outbox.lastSentTo(pat.email)
      expect(changed.subject).toBe('Your Stride sign-in email was changed')
      expect(changed.text).toContain('now signs in with e•••@e•••.com')
      expect(changed.text).not.toContain(moved)
      // Two-factor is off: nothing about an authenticator app.
      expect(changed.text).not.toContain(AUTHENTICATOR_LABEL_NOTE)

      const [row] = await requestsOf(pat.id)
      expect(row.confirmed).toBe(true)
      const entries = await trail(pat.id)
      expect(entries[1]).toStrictEqual({
        action: 'EMAIL_CHANGE_CONFIRMED',
        performed_by: pat.id,
        target_user_id: pat.id,
        entity_type: 'users',
        entity_id: pat.id,
        details: {
          requestId: row.id,
          changes: { email: { from: pat.email, to: moved } },
          signedOutSessions: 2,
        },
      })
    })

    // "Signed out everywhere ELSE": confirmed from the account's own signed-in
    // browser, that session stays — and reads the new address.
    it("keeps the confirming browser's own session", async () => {
      const pat = await newPerson()
      const second = agent()
      await signIn(second, pat.email)
      const moved = freshAddress('kept')
      await ask(pat.signedIn, moved)

      const res = await confirm(
        tokenFrom(moved, '/confirm-email'),
        pat.signedIn,
      )

      expect(res.status).toBe(200)
      const me = await pat.signedIn.get('/auth/me')
      expect(me.status).toBe(200)
      expect(me.body.email).toBe(moved)
      expect((await second.get('/auth/me')).status).toBe(401)
      expect(await sessionsOf(pat.id)).toBe(1)
      expect((await trail(pat.id))[1].details).toMatchObject({
        signedOutSessions: 1,
      })
    })

    // Signed in as SOMEONE ELSE in that browser: theirs is not the
    // account's session, so it is neither kept for the account nor ended.
    it("ends every session of the account when another account's browser confirms", async () => {
      const pat = await newPerson()
      const other = await newPerson()
      const moved = freshAddress('other-browser')
      await ask(pat.signedIn, moved)

      const res = await confirm(
        tokenFrom(moved, '/confirm-email'),
        other.signedIn,
      )

      expect(res.status).toBe(200)
      expect(await sessionsOf(pat.id)).toBe(0)
      expect((await other.signedIn.get('/auth/me')).status).toBe(200)
    })

    it('refuses the link a second time, an unknown one, and the cancel link', async () => {
      const pat = await newPerson()
      const moved = freshAddress('twice')
      await ask(pat.signedIn, moved)
      const token = tokenFrom(moved, '/confirm-email')
      const cancelToken = tokenFrom(pat.email, '/cancel-email-change')

      // Each link reaches only its own column: the old inbox can't confirm.
      const wrongLink = await confirm(cancelToken)
      expect(wrongLink.status).toBe(400)
      expect(wrongLink.body.message).toEqual([
        INVALID_EMAIL_CHANGE_LINK_MESSAGE,
      ])
      expect((await confirm('f'.repeat(64))).status).toBe(400)

      expect((await confirm(token)).status).toBe(200)
      const again = await confirm(token)
      expect(again.status).toBe(400)
      expect(again.body.message).toEqual([INVALID_EMAIL_CHANGE_LINK_MESSAGE])
      expect((await trail(pat.id)).map((entry) => entry.action)).toEqual([
        'EMAIL_CHANGE_REQUESTED',
        'EMAIL_CHANGE_CONFIRMED',
      ])
    })

    it('refuses an expired link (by the database clock), changing nothing', async () => {
      const pat = await newPerson()
      const moved = freshAddress('late')
      await ask(pat.signedIn, moved)
      await sessionPool.query(
        `UPDATE email_change_requests
            SET created_at = now() - interval '2 days',
                expires_at = now() - interval '1 second'
          WHERE user_id = $1`,
        [pat.id],
      )

      const res = await confirm(tokenFrom(moved, '/confirm-email'))

      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([INVALID_EMAIL_CHANGE_LINK_MESSAGE])
      expect(await emailOf(pat.id)).toBe(pat.email)
    })

    it('refuses for an account deactivated since the request', async () => {
      const pat = await newPerson()
      const moved = freshAddress('closed')
      await ask(pat.signedIn, moved)
      await sessionPool.query(
        'UPDATE users SET is_active = false WHERE id = $1',
        [pat.id],
      )

      const res = await confirm(tokenFrom(moved, '/confirm-email'))

      expect(res.status).toBe(400)
      expect(await emailOf(pat.id)).toBe(pat.email)
      expect((await requestsOf(pat.id))[0].open).toBe(true)
    })

    // Someone took the address between the request and the click: the
    // UNIQUE decides, the whole transaction is undone — the email, the
    // request, the sessions, the entry.
    it('answers 409 when the address was taken since, and changes nothing', async () => {
      const pat = await newPerson()
      const moved = freshAddress('race')
      await ask(pat.signedIn, moved)
      await sessionPool.query(
        `INSERT INTO users (email, first_name, last_name) VALUES ($1, 'Quick', 'Taker')`,
        [moved],
      )

      const res = await confirm(tokenFrom(moved, '/confirm-email'))

      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([ADDRESS_TAKEN_ON_CONFIRM_MESSAGE])
      expect(await emailOf(pat.id)).toBe(pat.email)
      expect((await requestsOf(pat.id))[0].open).toBe(true)
      expect(await sessionsOf(pat.id)).toBe(1)
      expect((await trail(pat.id)).map((entry) => entry.action)).toEqual([
        'EMAIL_CHANGE_REQUESTED',
      ])
    })

    // The click racing an admin's deactivation: the confirmation locks the
    // account's row, so it waits for the deactivation, then sees it.
    // Without the lock it would read "active" at once, and change the email
    // of an account deactivated a moment later.
    it('waits for a deactivation in progress, then refuses', async () => {
      const pat = await newPerson()
      const moved = freshAddress('held-deactivation')
      await ask(pat.signedIn, moved)

      const { waited, res } = await whileHolding(
        'UPDATE users SET is_active = false WHERE id = $1',
        [pat.id],
        () => confirm(tokenFrom(moved, '/confirm-email')),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(400)
      expect(await emailOf(pat.id)).toBe(pat.email)
    })

    // The click racing the profile's Cancel: the confirmation locks the
    // request, so a cancel held open first makes it wait, then find it
    // closed.
    it('waits for a cancellation in progress, then refuses', async () => {
      const pat = await newPerson()
      const moved = freshAddress('held-cancel')
      await ask(pat.signedIn, moved)
      const [row] = await requestsOf(pat.id)

      const { waited, res } = await whileHolding(
        `UPDATE email_change_requests
            SET cancelled_at = now(), cancel_reason = 'cancelled_in_app'
          WHERE id = $1`,
        [row.id],
        () => confirm(tokenFrom(moved, '/confirm-email')),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(400)
      expect(await emailOf(pat.id)).toBe(pat.email)
    })
  })

  // === Cancelling from the old inbox =========================================

  describe('cancelling by the link sent to the old address', () => {
    it("cancels the change once, as its owner's act; the confirm link then dies", async () => {
      const pat = await newPerson()
      const moved = freshAddress('stopped')
      await ask(pat.signedIn, moved)
      const cancelToken = tokenFrom(pat.email, '/cancel-email-change')

      expect((await cancelByLink(cancelToken)).status).toBe(204)
      expect((await cancelByLink(cancelToken)).status).toBe(204)

      const [row] = await requestsOf(pat.id)
      expect(row.cancel_reason).toBe('cancelled_by_email_link')
      expect((await confirm(tokenFrom(moved, '/confirm-email'))).status).toBe(
        400,
      )
      const entries = await trail(pat.id)
      expect(entries.map((entry) => entry.action)).toEqual([
        'EMAIL_CHANGE_REQUESTED',
        'EMAIL_CHANGE_CANCELLED',
      ])
      expect(entries[1]).toStrictEqual({
        action: 'EMAIL_CHANGE_CANCELLED',
        performed_by: pat.id,
        target_user_id: pat.id,
        entity_type: 'email_change_requests',
        entity_id: row.id,
        details: { reason: 'cancelled_by_email_link' },
      })
    })

    // The cancel link racing the confirmation: the cancel locks the request,
    // so it waits for the confirmation, then answers the 409 — not a 500
    // from the trigger's "closed" refusal, which an unlocked read followed
    // by an UPDATE would meet.
    it('waits for a confirmation in progress, then answers 409', async () => {
      const pat = await newPerson()
      await ask(pat.signedIn, freshAddress('held-confirm'))
      const [row] = await requestsOf(pat.id)
      const cancelToken = tokenFrom(pat.email, '/cancel-email-change')

      const { waited, res } = await whileHolding(
        'UPDATE email_change_requests SET confirmed_at = now() WHERE id = $1',
        [row.id],
        () => cancelByLink(cancelToken),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([ALREADY_CONFIRMED_MESSAGE])
    })

    it('answers 409 once the change is confirmed, and 400 for an unknown link', async () => {
      const pat = await newPerson()
      const moved = freshAddress('too-late')
      await ask(pat.signedIn, moved)
      const cancelToken = tokenFrom(pat.email, '/cancel-email-change')
      await confirm(tokenFrom(moved, '/confirm-email'))

      const res = await cancelByLink(cancelToken)

      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([ALREADY_CONFIRMED_MESSAGE])
      const unknown = await cancelByLink('a'.repeat(64))
      expect(unknown.status).toBe(400)
      expect(unknown.body.message).toEqual([INVALID_EMAIL_CHANGE_LINK_MESSAGE])
    })
  })

  // === A password reset ======================================================

  describe('a password reset', () => {
    it('cancels a pending change in its own transaction, and its entry says so', async () => {
      const pat = await newPerson()
      const moved = freshAddress('reset')
      await ask(pat.signedIn, moved)
      const confirmToken = tokenFrom(moved, '/confirm-email')

      await agent().post('/auth/forgot-password').send({ email: pat.email })
      const resetToken = tokenFrom(pat.email, '/reset-password')
      const reset = await agent()
        .post('/auth/reset-password')
        .send({ token: resetToken, newPassword: 'a-new-password-1' })
      expect(reset.status).toBe(204)

      const [row] = await requestsOf(pat.id)
      expect(row.cancel_reason).toBe('password_reset')
      expect((await confirm(confirmToken)).status).toBe(400)
      const entries = await trail(pat.id)
      expect(entries[1]).toMatchObject({
        action: 'PASSWORD_RESET_COMPLETED',
        details: { cancelledEmailChangeRequestId: row.id },
      })
    })
  })

  // === The database's own rules ==============================================

  describe('the database (as the app role)', () => {
    async function openRequest() {
      const pat = await newPerson()
      await ask(pat.signedIn, freshAddress('db'))
      const [row] = await requestsOf(pat.id)
      return { pat, row, hashes: await tokenHashes(row.id) }
    }

    it("hides a request from everyone but its owner and its two links' holders", async () => {
      const { pat, row, hashes } = await openRequest()
      const other = await newPerson()
      const select = 'SELECT id FROM email_change_requests WHERE id = $1'

      expect(await asApp(asUser(pat.id), select, [row.id])).toEqual({
        rows: [{ id: row.id }],
      })
      expect(await asApp(asUser(other.id), select, [row.id])).toEqual({
        rows: [],
      })
      expect(await asApp({}, select, [row.id])).toEqual({ rows: [] })
      expect(
        await asApp(
          { 'app.email_change_token_hash': hashes.token_hash },
          select,
          [row.id],
        ),
      ).toEqual({ rows: [{ id: row.id }] })
      expect(
        await asApp(
          { 'app.email_change_cancel_token_hash': hashes.cancel_token_hash },
          select,
          [row.id],
        ),
      ).toEqual({ rows: [{ id: row.id }] })
      // A hash in the OTHER link's setting reaches nothing.
      expect(
        await asApp(
          { 'app.email_change_cancel_token_hash': hashes.token_hash },
          select,
          [row.id],
        ),
      ).toEqual({ rows: [] })
    })

    // No RETURNING: it would ask the SELECT policy first and hide the
    // INSERT policy's refusal.
    it('refuses a request inserted for someone else', async () => {
      const pat = await newPerson()
      const other = await newPerson()

      expect(
        await asApp(
          asUser(pat.id),
          `INSERT INTO email_change_requests
             (user_id, new_email, token_hash, cancel_token_hash, expires_at)
           VALUES ($1, 'x@example.com', $2, $3, now() + interval '1 day')`,
          [other.id, 'a'.repeat(64), 'b'.repeat(64)],
        ),
      ).toEqual({ code: '42501', constraint: undefined })
    })

    // The spelling users.email accepts: a request for 'Pat@X.com' could
    // otherwise be confirmed into a row the users CHECK refuses.
    it('refuses a new address not in the normalised spelling', async () => {
      const pat = await newPerson()

      expect(
        await asApp(
          asUser(pat.id),
          `INSERT INTO email_change_requests
             (user_id, new_email, token_hash, cancel_token_hash, expires_at)
           VALUES ($1, 'Pat@Example.com', $2, $3, now() + interval '1 day')`,
          [pat.id, 'e'.repeat(64), 'f'.repeat(64)],
        ),
      ).toEqual({
        code: '23514',
        constraint: 'email_change_requests_new_email_normalized',
      })
    })

    // The service closes an open request before inserting a new one (under
    // the account's lock), so no API call reaches this index: it is the
    // database's own guarantee of one working link at a time.
    it('refuses a second open request for one account', async () => {
      const { pat } = await openRequest()

      expect(
        await asApp(
          asUser(pat.id),
          `INSERT INTO email_change_requests
             (user_id, new_email, token_hash, cancel_token_hash, expires_at)
           VALUES ($1, 'second@example.com', $2, $3, now() + interval '1 day')`,
          [pat.id, '1'.repeat(64), '2'.repeat(64)],
        ),
      ).toEqual({
        code: '23505',
        constraint: 'email_change_requests_one_open_per_user',
      })
    })

    it('starts a request open, at the database moment', async () => {
      const pat = await newPerson()
      const insert = (closed: string) =>
        asApp(
          asUser(pat.id),
          `INSERT INTO email_change_requests
             (user_id, new_email, token_hash, cancel_token_hash, created_at, expires_at${closed ? ', cancelled_at, cancel_reason' : ''})
           VALUES ($1, 'x@example.com', $2, $3, '2001-01-01', now() + interval '1 day'${closed})
           RETURNING created_at > now() - interval '1 minute' AS now_ish`,
          [pat.id, 'c'.repeat(64), 'd'.repeat(64)],
        )

      expect(await insert('')).toEqual({ rows: [{ now_ish: true }] })
      expect(await insert(", now(), 'replaced'")).toEqual({
        code: '23514',
        constraint: 'email_change_request_starts_open',
      })
    })

    it('confirms only with the confirm link, and only before the expiry', async () => {
      const { pat, row, hashes } = await openRequest()
      const confirmRow =
        'UPDATE email_change_requests SET confirmed_at = now() WHERE id = $1'

      // The owner, signed in, can't confirm without the new inbox's link.
      expect(await asApp(asUser(pat.id), confirmRow, [row.id])).toEqual({
        code: '23514',
        constraint: 'email_change_request_confirmed_by_link',
      })
      expect(
        await asApp(
          { 'app.email_change_token_hash': hashes.token_hash },
          confirmRow,
          [row.id],
        ),
      ).toEqual({ rows: [] })

      await sessionPool.query(
        `UPDATE email_change_requests
            SET created_at = now() - interval '2 days',
                expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [row.id],
      )
      expect(
        await asApp(
          { 'app.email_change_token_hash': hashes.token_hash },
          confirmRow,
          [row.id],
        ),
      ).toEqual({
        code: '23514',
        constraint: 'email_change_request_not_expired',
      })
    })

    it("cancels 'by the email link' only with the cancel link", async () => {
      const { pat, row, hashes } = await openRequest()
      const cancelRow = `UPDATE email_change_requests
                            SET cancelled_at = now(), cancel_reason = 'cancelled_by_email_link'
                          WHERE id = $1`

      expect(await asApp(asUser(pat.id), cancelRow, [row.id])).toEqual({
        code: '23514',
        constraint: 'email_change_request_cancelled_by_link',
      })
      expect(
        await asApp(
          { 'app.email_change_cancel_token_hash': hashes.cancel_token_hash },
          cancelRow,
          [row.id],
        ),
      ).toEqual({ rows: [] })
    })

    it('keeps what a request asks for fixed, and a closed request final', async () => {
      const { pat, row } = await openRequest()

      expect(
        await asApp(
          asUser(pat.id),
          "UPDATE email_change_requests SET new_email = 'other@example.com' WHERE id = $1",
          [row.id],
        ),
      ).toEqual({ code: '23514', constraint: 'email_change_request_fixed' })

      expect((await pat.signedIn.delete('/auth/email-change')).status).toBe(204)
      expect(
        await asApp(
          asUser(pat.id),
          "UPDATE email_change_requests SET cancel_reason = 'replaced' WHERE id = $1",
          [row.id],
        ),
      ).toEqual({ code: '23514', constraint: 'email_change_request_closed' })
    })

    it('never deletes a request (no DELETE policy)', async () => {
      const { pat, row } = await openRequest()

      expect(
        await asApp(
          asUser(pat.id),
          'DELETE FROM email_change_requests WHERE id = $1 RETURNING id',
          [row.id],
        ),
      ).toEqual({ rows: [] })
    })
  })
})
