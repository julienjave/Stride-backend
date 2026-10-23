import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import {
  InMemoryEmailTransport,
  findLink,
} from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { MessagingEvents } from '../src/messaging/messaging-events'
import { WRONG_PASSWORD_MESSAGE } from '../src/common/current-password'
import { SAME_PASSWORD_MESSAGE } from '../src/password-change/password-change.service'
import { INVALID_EMAIL_CHANGE_LINK_MESSAGE } from '../src/email-change/email-change.service'

// Changing one's own password from the profile ("Change password", Phase 6 —
// decisions §13). What the person chose, and what these tests hold the code
// to:
//   - the CURRENT password is asked again (step-up) and checked under a lock
//     on the account, so two changes at once can't both pass;
//   - a wrong current password is refused: nothing stored, nothing audited;
//   - every OTHER session ends and its socket closes — always; this browser
//     stays signed in;
//   - a pending email change is cancelled (`password_changed`), and so is an
//     unused reset link;
//   - ONE audit entry, in the transaction; a notice email after the commit.
describe('Password change (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let outbox: InMemoryEmailTransport

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let adminEmail: string
  let clinicId: number
  const stamp = Date.now()
  let counter = 0

  // --- Accounts -------------------------------------------------------------

  // A fresh, activated patient — each test its own — signed in on one agent.
  async function newPerson() {
    counter += 1
    const email = `pc-${counter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Pat',
      lastName: 'Ient',
      dateOfBirth: '1980-02-03',
      clinicId,
    })
    expect(res.status).toBe(201)
    const id = await activateAccount(sessionPool, email)
    const signedIn = agent()
    expect((await signIn(signedIn, email)).status).toBe(201)
    return { id, email, signedIn }
  }

  function signIn(
    who: ReturnType<typeof agent>,
    email: string,
    password = 'password123',
  ) {
    return who.post('/auth/login').send({ email, password })
  }

  function change(
    who: ReturnType<typeof agent>,
    currentPassword: string,
    newPassword: string,
  ) {
    return who.post('/auth/password').send({ currentPassword, newPassword })
  }

  // --- Reading as the owner (no row security) -------------------------------

  async function passwordHashOf(userId: number) {
    const { rows } = await sessionPool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    )
    return rows[0].password_hash
  }

  // The account's sessions' ids. Compared with a list read just before —
  // never a fixed count (the session table outlives each suite's TRUNCATE).
  // Sorted HERE, not with ORDER BY: the database's order depends on its
  // collation (byte order under C.UTF-8, language order under en_US.utf8 —
  // "gS…" before "Py…"), and these lists are compared with ones sorted
  // by JavaScript. One ordering for both, whatever the database.
  async function sessionsOf(userId: number) {
    const { rows } = await sessionPool.query<{ sid: string }>(
      `SELECT sid FROM session
        WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
      [String(userId)],
    )
    return rows.map((row) => row.sid).sort()
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number
    entity_type: string
    entity_id: number
    details: Record<string, unknown> | null
  }

  async function passwordEntries(userId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type,
              entity_id::int AS entity_id, details
         FROM audit_logs
        WHERE target_user_id = $1 AND action = 'PASSWORD_CHANGED'
        ORDER BY id`,
      [userId],
    )
    return rows
  }

  async function emailChangeRequestsOf(userId: number) {
    const { rows } = await sessionPool.query<{
      id: number
      cancel_reason: string | null
      open: boolean
    }>(
      `SELECT id, cancel_reason::text,
              (confirmed_at IS NULL AND cancelled_at IS NULL) AS open
         FROM email_change_requests WHERE user_id = $1 ORDER BY id`,
      [userId],
    )
    return rows
  }

  // The closed sockets, while `send` runs (MessagingEvents.disconnectSession
  // is how every sign-out closes a socket).
  async function closingSockets(send: () => PromiseLike<request.Response>) {
    const disconnect = jest.spyOn(app.get(MessagingEvents), 'disconnectSession')
    try {
      const res = await send()
      return { res, closed: disconnect.mock.calls.map(([sid]) => sid).sort() }
    } finally {
      disconnect.mockRestore()
    }
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
    // The session table outlives the TRUNCATE, and user ids restart: an
    // earlier suite's sessions would belong to this suite's accounts, and
    // be counted in `signedOutSessions`. Emptied, as in the email-change
    // suite.
    await sessionPool.query('DELETE FROM session')
    // Request ids far from user ids: an entry naming one where the other
    // belongs must fail, not pass by coincidence.
    await sessionPool.query(
      "SELECT setval(pg_get_serial_sequence('email_change_requests', 'id'), 100000)",
    )

    admin = agent()
    adminEmail = `pc-admin-${stamp}@example.com`
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Password Change Clinic',
      clinicEmail: `pc-clinic-${stamp}@example.com`,
      email: adminEmail,
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
  })

  // === Refusals ===============================================================

  describe('refusals', () => {
    it('refuses without a session', async () => {
      const res = await change(agent(), 'password123', 'a-new-password')
      expect(res.status).toBe(401)
    })

    // The step-up: a session alone must not set a new password. Refused in
    // the transaction — nothing stored, no entry (the person's choice), no
    // session ended, no email.
    it('refuses a wrong current password, changing nothing', async () => {
      const pat = await newPerson()
      const second = agent()
      await signIn(second, pat.email)
      const hashBefore = await passwordHashOf(pat.id)
      const sessionsBefore = await sessionsOf(pat.id)
      const sentBefore = outbox.sentTo(pat.email).length

      const { res, closed } = await closingSockets(() =>
        change(pat.signedIn, 'not-my-password', 'a-new-password'),
      )

      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
      expect(await passwordHashOf(pat.id)).toBe(hashBefore)
      expect(await sessionsOf(pat.id)).toEqual(sessionsBefore)
      expect(closed).toEqual([])
      expect(await passwordEntries(pat.id)).toEqual([])
      expect(outbox.sentTo(pat.email)).toHaveLength(sentBefore)
    })

    it('refuses a new password equal to the current one', async () => {
      const pat = await newPerson()
      const hashBefore = await passwordHashOf(pat.id)

      const res = await change(pat.signedIn, 'password123', 'password123')

      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([SAME_PASSWORD_MESSAGE])
      expect(await passwordHashOf(pat.id)).toBe(hashBefore)
      expect(await passwordEntries(pat.id)).toEqual([])
    })

    // The shared rule for choosing a password (8–128, like a reset and an
    // invitation), and the current password's own limits (like signing in).
    it('applies the password rules to both fields', async () => {
      const pat = await newPerson()

      const short = await change(pat.signedIn, 'password123', 'seven77')
      expect(short.status).toBe(400)
      expect(short.body.message).toEqual([
        'newPassword must be longer than or equal to 8 characters',
      ])
      const long = await change(pat.signedIn, 'password123', 'x'.repeat(129))
      expect(long.status).toBe(400)
      expect(long.body.message).toEqual([
        'newPassword must be shorter than or equal to 128 characters',
      ])
      const empty = await change(pat.signedIn, '', 'a-new-password')
      expect(empty.status).toBe(400)
      expect(empty.body.message).toEqual([
        'currentPassword must be longer than or equal to 1 characters',
      ])
      // 8 and 128 themselves are allowed (the bounds are inclusive).
      expect(
        (await change(pat.signedIn, 'password123', 'eight888')).status,
      ).toBe(204)
      expect(
        (await change(pat.signedIn, 'eight888', 'y'.repeat(128))).status,
      ).toBe(204)
    })
  })

  // === The change =============================================================

  describe('changing the password (POST /auth/password)', () => {
    it('stores the new password, keeps this browser, signs out the others, and tells the account', async () => {
      const pat = await newPerson()
      const second = agent()
      const third = agent()
      await signIn(second, pat.email)
      await signIn(third, pat.email)
      const before = await sessionsOf(pat.id)
      expect(before).toHaveLength(3)

      const { res, closed } = await closingSockets(() =>
        change(pat.signedIn, 'password123', 'a-brand-new-one'),
      )

      expect(res.status).toBe(204)
      // The password: the new one signs in, the old one no longer does.
      expect((await signIn(agent(), pat.email, 'a-brand-new-one')).status).toBe(
        201,
      )
      expect((await signIn(agent(), pat.email)).status).toBe(401)

      // This browser stays; the two others are out, and their sockets
      // closed — not this browser's.
      expect((await pat.signedIn.get('/auth/me')).status).toBe(200)
      expect((await second.get('/auth/me')).status).toBe(401)
      expect((await third.get('/auth/me')).status).toBe(401)
      const kept = before.filter((sid) => !closed.includes(sid))
      expect(kept).toHaveLength(1)
      expect(closed).toEqual(before.filter((sid) => sid !== kept[0]))

      const [entry] = await passwordEntries(pat.id)
      // Exactly these keys: nothing pending was cancelled, so nothing else
      // is named — and never the password or a hash.
      expect(entry).toStrictEqual({
        action: 'PASSWORD_CHANGED',
        performed_by: pat.id,
        target_user_id: pat.id,
        entity_type: 'users',
        entity_id: pat.id,
        details: { signedOutSessions: 2 },
      })

      const notice = outbox.lastSentTo(pat.email)
      expect(notice.subject).toBe('Your Stride password was changed')
      expect(findLink(notice, '/forgot-password').search).toBe('')
    })

    it('ends nothing else when this is the only session', async () => {
      const pat = await newPerson()

      const { res, closed } = await closingSockets(() =>
        change(pat.signedIn, 'password123', 'a-brand-new-one'),
      )

      expect(res.status).toBe(204)
      expect(closed).toEqual([])
      expect((await pat.signedIn.get('/auth/me')).status).toBe(200)
      expect((await passwordEntries(pat.id))[0].details).toStrictEqual({
        signedOutSessions: 0,
      })
    })

    // Another account's sessions are not this account's to end.
    it("leaves other accounts' sessions alone", async () => {
      const pat = await newPerson()
      const other = await newPerson()
      const othersBefore = await sessionsOf(other.id)

      await change(pat.signedIn, 'password123', 'a-brand-new-one')

      expect(await sessionsOf(other.id)).toEqual(othersBefore)
      expect((await other.signedIn.get('/auth/me')).status).toBe(200)
    })

    // Every role: it's about the account, not a role's work.
    it("works for an admin's own password too", async () => {
      const res = await change(admin, 'password123', 'admin-new-password')
      expect(res.status).toBe(204)
      expect(
        (await signIn(agent(), adminEmail, 'admin-new-password')).status,
      ).toBe(201)
      // Put back, for the tests after this one.
      expect(
        (await change(admin, 'admin-new-password', 'password123')).status,
      ).toBe(204)
    })
  })

  // === What else stops working ================================================

  describe('what the change cancels', () => {
    // As a reset does (decisions §12), with its own reason (the person's
    // choice): the record says a CHANGE happened.
    it('cancels a pending email change — its link dies — and the entry names it', async () => {
      const pat = await newPerson()
      const moved = `pc-moved-${stamp}@example.com`
      const ask = await pat.signedIn
        .post('/auth/email-change')
        .send({ newEmail: moved, currentPassword: 'password123' })
      expect(ask.status).toBe(201)
      const token = findLink(
        outbox.lastSentTo(moved),
        '/confirm-email',
      ).searchParams.get('token')

      expect(
        (await change(pat.signedIn, 'password123', 'a-brand-new-one')).status,
      ).toBe(204)

      const [request] = await emailChangeRequestsOf(pat.id)
      expect(request.open).toBe(false)
      expect(request.cancel_reason).toBe('password_changed')
      const confirm = await agent()
        .post('/auth/email-change/confirm')
        .send({ token })
      expect(confirm.status).toBe(400)
      expect(confirm.body.message).toEqual([INVALID_EMAIL_CHANGE_LINK_MESSAGE])
      expect((await pat.signedIn.get('/auth/email-change')).body).toEqual({
        pending: null,
      })
      expect((await passwordEntries(pat.id))[0].details).toStrictEqual({
        signedOutSessions: 0,
        cancelledEmailChangeRequestId: request.id,
      })
    })

    // Only THIS account's. Three layers say so — the service's own filter on
    // the account, the UPDATE policy (a user updates only their own
    // requests), and the SELECT policy (an UPDATE only reaches rows it can
    // see) — so removing any one of them changes nothing (those mutants are
    // equivalent). This test pins the outcome; it fails once all three are
    // gone (checked 2026-10-22).
    it("leaves another account's pending email change open", async () => {
      const pat = await newPerson()
      const other = await newPerson()
      await other.signedIn.post('/auth/email-change').send({
        newEmail: `pc-other-${stamp}@example.com`,
        currentPassword: 'password123',
      })

      expect(
        (await change(pat.signedIn, 'password123', 'a-brand-new-one')).status,
      ).toBe(204)

      expect(await emailChangeRequestsOf(other.id)).toEqual([
        expect.objectContaining({ open: true, cancel_reason: null }),
      ])
      expect((await passwordEntries(pat.id))[0].details).toStrictEqual({
        signedOutSessions: 0,
      })
    })

    // A reset link asked for under the old password must not undo a change
    // made since.
    it('cancels an unused reset link, and the entry says so', async () => {
      const pat = await newPerson()
      const forgot = await agent()
        .post('/auth/forgot-password')
        .send({ email: pat.email })
      expect(forgot.status).toBe(204)
      const token = findLink(
        outbox.lastSentTo(pat.email),
        '/reset-password',
      ).searchParams.get('token')

      expect(
        (await change(pat.signedIn, 'password123', 'a-brand-new-one')).status,
      ).toBe(204)

      const reset = await agent()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'attackers-choice' })
      expect(reset.status).toBe(400)
      expect((await signIn(agent(), pat.email, 'a-brand-new-one')).status).toBe(
        201,
      )
      expect((await passwordEntries(pat.id))[0].details).toStrictEqual({
        signedOutSessions: 0,
        cancelledResetLink: true,
      })
    })
  })

  // === Atomicity and concurrency ==============================================

  describe('one transaction, under a lock', () => {
    // The current password is checked under the account's lock: a change
    // committed meanwhile (here, held open by another connection) is waited
    // for, and the request then judges the password against the NEW hash.
    // Checked before locking, it would pass against the old one and then
    // overwrite the other change.
    it('waits for a change in progress, then refuses the old password', async () => {
      const pat = await newPerson()
      const elsewhere = await bcrypt.hash('changed-elsewhere', 4)

      const { waited, res } = await whileHolding(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [elsewhere, pat.id],
        () => change(pat.signedIn, 'password123', 'a-brand-new-one'),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
      expect(await passwordHashOf(pat.id)).toBe(elsewhere)
      expect(await passwordEntries(pat.id)).toEqual([])
    })

    // The entry can't be written → nothing else happens: the password, the
    // sessions, the pending email change all stay as they were, and no
    // socket or email goes out (both come after the commit). A trigger
    // planted as the owner refuses this one action's entry.
    it('changes nothing when its audit entry fails', async () => {
      const pat = await newPerson()
      const second = agent()
      await signIn(second, pat.email)
      const moved = `pc-atomic-${stamp}@example.com`
      await pat.signedIn
        .post('/auth/email-change')
        .send({ newEmail: moved, currentPassword: 'password123' })
      const hashBefore = await passwordHashOf(pat.id)
      const sessionsBefore = await sessionsOf(pat.id)
      const sentBefore = outbox.sentTo(pat.email).length

      await sessionPool.query(`
        CREATE FUNCTION e2e_refuse_password_changed() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
        CREATE TRIGGER e2e_refuse_password_changed
          BEFORE INSERT ON audit_logs FOR EACH ROW
          WHEN (NEW.action = 'PASSWORD_CHANGED')
          EXECUTE FUNCTION e2e_refuse_password_changed();`)
      try {
        const { res, closed } = await closingSockets(() =>
          change(pat.signedIn, 'password123', 'a-brand-new-one'),
        )

        expect(res.status).toBe(500)
        expect(closed).toEqual([])
      } finally {
        await sessionPool.query(`
          DROP TRIGGER e2e_refuse_password_changed ON audit_logs;
          DROP FUNCTION e2e_refuse_password_changed();`)
      }
      expect(await passwordHashOf(pat.id)).toBe(hashBefore)
      expect(await sessionsOf(pat.id)).toEqual(sessionsBefore)
      expect((await emailChangeRequestsOf(pat.id))[0].open).toBe(true)
      expect(outbox.sentTo(pat.email)).toHaveLength(sentBefore)
    })
  })
})
