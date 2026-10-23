import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { OTP } from 'otplib'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { MessagingEvents } from '../src/messaging/messaging-events'
import { encryptMfaSecret } from '../src/auth/mfa-secret-crypto'
import {
  MFA_CODE_REQUIRED_MESSAGE,
  WRONG_PASSWORD_MESSAGE,
} from '../src/common/current-password'
import {
  INVALID_MFA_CODE_MESSAGE,
  MFA_CODE_ALREADY_USED_MESSAGE,
  MFA_CODE_FORMAT_MESSAGE,
  newMfaSecret,
} from '../src/mfa/totp'
import {
  MFA_ALREADY_ON_MESSAGE,
  MFA_NOT_ON_MESSAGE,
  MFA_SETUP_FIRST_MESSAGE,
} from '../src/mfa/mfa.service'

// Two-factor sign-in (MFA enrolment, Phase 6 — pass 1, hardening what
// existed). What the person chose, and what these tests hold the code to:
//   - starting set-up asks for the current password; it is REFUSED while MFA
//     is on (it used to replace the working secret — the bug this pass fixed);
//   - turning it off asks for the password AND a code;
//   - turning it on signs out every other session (and closes its socket);
//   - no code works twice (RFC 6238 §5.2), checked under the account's row
//     lock so two requests with one code can't both pass;
//   - an account with MFA on gives a code in the email and password changes'
//     step-up too;
//   - ONE audit entry per change, in its transaction; a notice email for on
//     and off.
describe('Two-factor sign-in (e2e)', () => {
  // 40 s per test, not Jest's default 5: freshCode may WAIT for the next
  // 30-second window — up to 20 s when a test needs one code to stay valid
  // across several requests. Found when a run landed late in a window and
  // two tests timed out with nothing wrong in the code.
  jest.setTimeout(40_000)

  let app: INestApplication
  let sessionPool: Pool
  let outbox: InMemoryEmailTransport

  const agent = () => request.agent(app.getHttpServer())
  type Agent = ReturnType<typeof agent>
  let admin: Agent
  let clinicId: number
  const stamp = Date.now()
  let counter = 0
  const otp = new OTP({ strategy: 'totp' })

  // --- Codes ----------------------------------------------------------------

  // The current window's step — what the server computes for a code typed
  // now (floor(unix seconds / 30)).
  const currentStep = () => Math.floor(Date.now() / 1000 / 30)

  // A code for `secret` still valid when the server checks it: the server
  // accepts only the current 30-second window, so when fewer than
  // `minSeconds` are left, wait for the next window first (auth-recovery's
  // freshCode). Tests that use ONE code several times ask for more seconds,
  // so every use falls in the same window.
  async function freshCode(secret: string, minSeconds = 5): Promise<string> {
    const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30)
    if (secondsLeft < minSeconds) {
      await new Promise((resolve) =>
        setTimeout(resolve, secondsLeft * 1000 + 100),
      )
    }
    return otp.generate({ secret })
  }

  // Clearing what the account remembers of its last code — standing in for
  // "30 seconds later" where a test needs a second code from one window
  // (the replay tests below prove the refusal this side-steps).
  async function forgetUsedCode(userId: number): Promise<void> {
    await sessionPool.query(
      'UPDATE users SET mfa_last_used_step = NULL WHERE id = $1',
      [userId],
    )
  }

  // --- Accounts -------------------------------------------------------------

  // A fresh, activated patient — each test its own — signed in on one agent.
  async function newPerson() {
    counter += 1
    const email = `mfa-${counter}-${stamp}@example.com`
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

  function signIn(who: Agent, email: string) {
    return who.post('/auth/login').send({ email, password: 'password123' })
  }

  const setup = (who: Agent, currentPassword = 'password123') =>
    who.post('/auth/mfa/setup').send({ currentPassword })
  const enable = (who: Agent, code: string) =>
    who.post('/auth/mfa/enable').send({ code })
  const disable = (who: Agent, body: object) =>
    who.post('/auth/mfa/disable').send(body)
  const verify = (who: Agent, code: string) =>
    who.post('/auth/mfa/verify').send({ code })

  // Set up and turned on, the code then forgotten (so the test's next code
  // isn't refused as already used). Answers the secret.
  async function turnOn(person: { id: number; signedIn: Agent }) {
    const res = await setup(person.signedIn)
    expect(res.status).toBe(201)
    const secret = res.body.secret as string
    expect(
      (await enable(person.signedIn, await freshCode(secret))).status,
    ).toBe(204)
    await forgetUsedCode(person.id)
    return secret
  }

  // --- Reading as the owner (no row security) -------------------------------

  async function mfaColumnsOf(userId: number) {
    const { rows } = await sessionPool.query<{
      mfa_enabled: boolean
      mfa_secret: string | null
      mfa_last_used_step: number | null
    }>(
      'SELECT mfa_enabled, mfa_secret, mfa_last_used_step FROM users WHERE id = $1',
      [userId],
    )
    return rows[0]
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number
    entity_type: string
    entity_id: number
    details: Record<string, unknown> | null
  }

  // The account's two-factor entries, oldest first.
  async function mfaEntries(userId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type,
              entity_id::int AS entity_id, details
         FROM audit_logs
        WHERE target_user_id = $1 AND action LIKE 'MFA\\_%'
        ORDER BY id`,
      [userId],
    )
    return rows
  }

  // The account's sessions' ids, sorted in JavaScript (never ORDER BY: the
  // database's order depends on its collation — password-change's lesson).
  async function sessionsOf(userId: number) {
    const { rows } = await sessionPool.query<{ sid: string }>(
      `SELECT sid FROM session
        WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
      [String(userId)],
    )
    return rows.map((row) => row.sid).sort()
  }

  // The sockets closed while `send` runs.
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
  // committed after 300 ms (the helper of test/sessions.e2e-spec.ts). The
  // request must still be unanswered at 300 ms (`waited`) — proof that it
  // waited for the lock, rather than having read past the write.
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
    // earlier suite's sessions would belong to this suite's accounts.
    await sessionPool.query('DELETE FROM session')

    admin = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Two-Factor Clinic',
      clinicEmail: `mfa-clinic-${stamp}@example.com`,
      email: `mfa-admin-${stamp}@example.com`,
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

  // === The database's half ====================================================

  // MFA on with no secret would leave sign-in nothing to check a code
  // against: the CHECK makes the state impossible, whatever writes it.
  it('refuses, in the database, two-factor on without a secret', async () => {
    const pat = await newPerson()
    await expect(
      sessionPool.query(
        'UPDATE users SET mfa_enabled = true, mfa_secret = NULL WHERE id = $1',
        [pat.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'users_mfa_enabled_has_secret',
    })
  })

  // === Set-up =================================================================

  describe('set-up', () => {
    it('refuses without a session', async () => {
      expect((await setup(agent())).status).toBe(401)
    })

    // The step-up: a stolen session alone must not put someone else's phone
    // on the account. Refused in the transaction: nothing stored, no entry.
    it('asks for the current password: a wrong or missing one stores nothing', async () => {
      const pat = await newPerson()

      const wrong = await setup(pat.signedIn, 'not-my-password')
      expect(wrong.status).toBe(400)
      expect(wrong.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
      const missing = await pat.signedIn.post('/auth/mfa/setup').send({})
      expect(missing.status).toBe(400)

      expect(await mfaColumnsOf(pat.id)).toStrictEqual({
        mfa_enabled: false,
        mfa_secret: null,
        mfa_last_used_step: null,
      })
      expect(await mfaEntries(pat.id)).toEqual([])
    })

    it('answers the secret, its address and its QR code — and stores the secret encrypted, not yet in force', async () => {
      const pat = await newPerson()

      const res = await setup(pat.signedIn)

      expect(res.status).toBe(201)
      const { secret, otpauthUrl, qrCodeDataUrl } = res.body as Record<
        string,
        string
      >
      expect(Object.keys(res.body as object).sort()).toEqual([
        'otpauthUrl',
        'qrCodeDataUrl',
        'secret',
      ])
      // The address names Stride and the sign-in email, and carries the
      // secret — what the authenticator app reads from the QR code.
      const uri = new URL(otpauthUrl)
      expect(decodeURIComponent(uri.pathname)).toBe(`/Stride:${pat.email}`)
      expect(uri.searchParams.get('secret')).toBe(secret)
      expect(qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true)

      const stored = await mfaColumnsOf(pat.id)
      expect(stored.mfa_enabled).toBe(false)
      expect(stored.mfa_secret).not.toBeNull()
      expect(stored.mfa_secret).not.toContain(secret)

      const entries = await mfaEntries(pat.id)
      expect(entries).toStrictEqual([
        {
          action: 'MFA_SETUP_STARTED',
          performed_by: pat.id,
          target_user_id: pat.id,
          entity_type: 'users',
          entity_id: pat.id,
          details: null,
        },
      ])
      expect(JSON.stringify(entries)).not.toContain(secret)
    })

    // Set-up again before confirming: the first QR code stops working.
    it('replaces a set-up not yet confirmed — its codes stop working, and the entry says so', async () => {
      const pat = await newPerson()
      const first = (await setup(pat.signedIn)).body.secret as string
      const second = (await setup(pat.signedIn)).body.secret as string
      expect(second).not.toBe(first)

      const withFirst = await enable(pat.signedIn, await freshCode(first))
      expect(withFirst.status).toBe(400)
      expect(withFirst.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])
      expect((await enable(pat.signedIn, await freshCode(second))).status).toBe(
        204,
      )

      expect((await mfaEntries(pat.id)).map((e) => e.details)).toEqual([
        null,
        { replacedUnconfirmedSetup: true },
        { signedOutSessions: 0 },
      ])
    })

    // THE BUG this pass fixed: set-up used to replace the secret even with
    // MFA on — no code needed — and the person's app stopped matching: their
    // next sign-in failed. Now refused, and the working secret stays.
    it('refuses a set-up while two-factor is on — the working secret stays, sign-in still works', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const before = await mfaColumnsOf(pat.id)
      const entriesBefore = await mfaEntries(pat.id)

      const res = await setup(pat.signedIn)

      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([MFA_ALREADY_ON_MESSAGE])
      expect(await mfaColumnsOf(pat.id)).toStrictEqual(before)
      expect(await mfaEntries(pat.id)).toEqual(entriesBefore)
      // The app's codes still sign in.
      const later = agent()
      expect((await signIn(later, pat.email)).body).toEqual({
        mfaRequired: true,
      })
      expect((await verify(later, await freshCode(secret))).status).toBe(201)
    })
  })

  // === Enable =================================================================

  describe('enable', () => {
    it('refuses before any set-up', async () => {
      const pat = await newPerson()
      const res = await enable(pat.signedIn, '123456')
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([MFA_SETUP_FIRST_MESSAGE])
    })

    it('refuses a wrong code, and a code that is not 6 digits — still off', async () => {
      const pat = await newPerson()
      await setup(pat.signedIn)

      const wrong = await enable(pat.signedIn, '000000')
      expect(wrong.status).toBe(400)
      expect(wrong.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])
      const letters = await enable(pat.signedIn, '12345a')
      expect(letters.status).toBe(400)
      expect(letters.body.message).toEqual([MFA_CODE_FORMAT_MESSAGE])

      expect((await mfaColumnsOf(pat.id)).mfa_enabled).toBe(false)
      expect((await mfaEntries(pat.id)).map((e) => e.action)).toEqual([
        'MFA_SETUP_STARTED',
      ])
    })

    // Sessions opened with the password alone end; their sockets close; this
    // browser stays signed in. ONE entry, a notice email.
    it('turns it on with a good code: the other sessions end, this one stays — one entry, a notice', async () => {
      const pat = await newPerson()
      const elsewhere = agent()
      await signIn(elsewhere, pat.email)
      const secret = (await setup(pat.signedIn)).body.secret as string
      const sessionsBefore = await sessionsOf(pat.id)
      expect(sessionsBefore).toHaveLength(2)
      const sentBefore = outbox.sentTo(pat.email).length

      const { res, closed } = await closingSockets(async () =>
        enable(pat.signedIn, await freshCode(secret)),
      )

      expect(res.status).toBe(204)
      const after = await sessionsOf(pat.id)
      expect(after).toHaveLength(1)
      expect(closed).toEqual(sessionsBefore.filter((s) => !after.includes(s)))
      expect((await pat.signedIn.get('/auth/me')).status).toBe(200)
      expect((await elsewhere.get('/auth/me')).status).toBe(401)

      const stored = await mfaColumnsOf(pat.id)
      expect(stored.mfa_enabled).toBe(true)
      expect(stored.mfa_last_used_step).toBe(currentStep())
      expect(await mfaEntries(pat.id)).toStrictEqual([
        expect.objectContaining({ action: 'MFA_SETUP_STARTED' }),
        {
          action: 'MFA_ENABLED',
          performed_by: pat.id,
          target_user_id: pat.id,
          entity_type: 'users',
          entity_id: pat.id,
          details: { signedOutSessions: 1 },
        },
      ])
      const sent = outbox.sentTo(pat.email).slice(sentBefore)
      expect(sent.map((email) => email.subject)).toEqual([
        'Two-factor sign-in is on for your Stride account',
      ])
    })

    it('refuses to turn it on twice — nothing written', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const entriesBefore = await mfaEntries(pat.id)

      const res = await enable(pat.signedIn, await freshCode(secret))

      expect(res.status).toBe(409)
      expect(res.body.message).toEqual([MFA_ALREADY_ON_MESSAGE])
      expect(await mfaEntries(pat.id)).toEqual(entriesBefore)
      // The code wasn't spent either (the transaction rolled back).
      expect((await mfaColumnsOf(pat.id)).mfa_last_used_step).toBeNull()
    })

    // The race the row lock closes: a set-up in another tab replaces the
    // secret WHILE "enable" runs. Read before the transaction (the old
    // code), the code matched the OLD secret, then MFA was turned on with
    // the NEW one — a secret no app holds: locked out. Now "enable" waits
    // for the other write, then checks the code against what it stored.
    it('waits for a set-up in another tab, and checks the code against the secret it stored', async () => {
      const pat = await newPerson()
      const first = (await setup(pat.signedIn)).body.secret as string
      const code = await freshCode(first)

      const { waited, res } = await whileHolding(
        'UPDATE users SET mfa_secret = $1 WHERE id = $2',
        [encryptMfaSecret(newMfaSecret()), pat.id],
        () => enable(pat.signedIn, code),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])
      expect((await mfaColumnsOf(pat.id)).mfa_enabled).toBe(false)
    })
  })

  // === No code works twice ====================================================

  describe('replay', () => {
    // The code that turned MFA on, typed again at sign-in in the same
    // window: refused, and recorded with its reason — then accepted once the
    // account has forgotten it (standing in for the next window).
    it('refuses at sign-in a code already used, recording why — the pending sign-in stays', async () => {
      const pat = await newPerson()
      const secret = (await setup(pat.signedIn)).body.secret as string
      // 20 seconds left at least: every use below falls in this window.
      const code = await freshCode(secret, 20)
      expect((await enable(pat.signedIn, code)).status).toBe(204)
      const later = agent()
      await signIn(later, pat.email)

      const wrong = await verify(later, code === '000000' ? '111111' : '000000')
      const replayed = await verify(later, code)

      expect(wrong.status).toBe(401)
      expect(wrong.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])
      expect(replayed.status).toBe(401)
      expect(replayed.body.message).toEqual([MFA_CODE_ALREADY_USED_MESSAGE])
      const failures = (await mfaEntries(pat.id)).filter(
        (entry) => entry.action === 'MFA_LOGIN_FAILURE',
      )
      expect(failures.map((entry) => entry.details)).toEqual([
        { reason: 'wrong_code' },
        { reason: 'code_already_used' },
      ])

      await forgetUsedCode(pat.id)
      const accepted = await verify(later, code)
      expect(accepted.status).toBe(201)
      expect(accepted.body).not.toHaveProperty('mfaLastUsedStep')
      expect((await mfaColumnsOf(pat.id)).mfa_last_used_step).toBe(
        currentStep(),
      )
    })

    // Two sign-ins with ONE code at the same moment (a code relayed by a fake
    // sign-in page, say): the other connection holds the first one's write
    // — its code recorded, not yet committed. The second must wait for it,
    // then find the code used. Without the lock it would read "unused" past
    // the uncommitted write and sign in.
    // MFA turned off — and set up again, not yet confirmed — on another
    // device while a sign-in waits for its code: the pending sign-in can't
    // finish with a code of the UNCONFIRMED secret (it isn't in force).
    it('refuses a pending sign-in once two-factor is off, even with a code of a new, unconfirmed set-up', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const later = agent()
      await signIn(later, pat.email)
      expect(
        (
          await disable(pat.signedIn, {
            currentPassword: 'password123',
            code: await freshCode(secret),
          })
        ).status,
      ).toBe(204)
      const unconfirmed = (await setup(pat.signedIn)).body.secret as string

      const res = await verify(later, await freshCode(unconfirmed))

      expect(res.status).toBe(401)
      expect(res.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])
      expect((await later.get('/auth/me')).status).toBe(401)
    })

    it('makes a second sign-in with the same code wait for the first, then refuses it', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const later = agent()
      await signIn(later, pat.email)
      const code = await freshCode(secret, 10)

      const { waited, res } = await whileHolding(
        'UPDATE users SET mfa_last_used_step = $1 WHERE id = $2',
        [currentStep(), pat.id],
        () => verify(later, code),
      )

      expect(waited).toBe(true)
      expect(res.status).toBe(401)
      expect(res.body.message).toEqual([MFA_CODE_ALREADY_USED_MESSAGE])
      expect((await later.get('/auth/me')).status).toBe(401)
    })
  })

  // === Disable ================================================================

  describe('disable', () => {
    it('asks for the password AND a code — each refusal changes nothing', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const before = await mfaColumnsOf(pat.id)

      // The DTO's own words: a code is required here (always — the account
      // has MFA on), not the step-up's "enter the code" further in.
      const noCode = await disable(pat.signedIn, {
        currentPassword: 'password123',
      })
      expect(noCode.status).toBe(400)
      expect(noCode.body.message).toContain(MFA_CODE_FORMAT_MESSAGE)
      // A wrong password with a GOOD code: refused for the password, and the
      // code isn't spent (the step stays as it was).
      const wrongPassword = await disable(pat.signedIn, {
        currentPassword: 'not-my-password',
        code: await freshCode(secret),
      })
      expect(wrongPassword.status).toBe(400)
      expect(wrongPassword.body.message).toEqual([WRONG_PASSWORD_MESSAGE])
      const wrongCode = await disable(pat.signedIn, {
        currentPassword: 'password123',
        code: '000000',
      })
      expect(wrongCode.status).toBe(400)
      expect(wrongCode.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])

      expect(await mfaColumnsOf(pat.id)).toStrictEqual(before)
      expect(
        (await mfaEntries(pat.id)).filter((e) => e.action === 'MFA_DISABLED'),
      ).toEqual([])
    })

    it('turns it off: the secret deleted, one entry, a notice — sign-in no longer asks for a code', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const sentBefore = outbox.sentTo(pat.email).length

      const res = await disable(pat.signedIn, {
        currentPassword: 'password123',
        code: await freshCode(secret),
      })

      expect(res.status).toBe(204)
      expect(await mfaColumnsOf(pat.id)).toStrictEqual({
        mfa_enabled: false,
        mfa_secret: null,
        mfa_last_used_step: null,
      })
      const entries = await mfaEntries(pat.id)
      expect(entries[entries.length - 1]).toStrictEqual({
        action: 'MFA_DISABLED',
        performed_by: pat.id,
        target_user_id: pat.id,
        entity_type: 'users',
        entity_id: pat.id,
        details: null,
      })
      const sent = outbox.sentTo(pat.email).slice(sentBefore)
      expect(sent.map((email) => email.subject)).toEqual([
        'Two-factor sign-in is off for your Stride account',
      ])
      const later = agent()
      const login = await signIn(later, pat.email)
      expect(login.body).toMatchObject({ email: pat.email })
    })

    it('refuses when two-factor is not on', async () => {
      const pat = await newPerson()
      const res = await disable(pat.signedIn, {
        currentPassword: 'password123',
        code: '123456',
      })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([MFA_NOT_ON_MESSAGE])
    })
  })

  // === The step-up of the email and password changes ==========================

  describe('the step-up of the email and password changes', () => {
    const changePassword = (who: Agent, body: object) =>
      who.post('/auth/password').send({
        currentPassword: 'password123',
        newPassword: 'a-new-password',
        ...body,
      })
    const changeEmail = (who: Agent, newEmail: string, body: object) =>
      who.post('/auth/email-change').send({
        newEmail,
        currentPassword: 'password123',
        ...body,
      })

    async function passwordHashOf(userId: number) {
      const { rows } = await sessionPool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId],
      )
      return rows[0].password_hash
    }

    it('asks an account with two-factor on for a code: none, or a wrong one, changes nothing', async () => {
      const pat = await newPerson()
      await turnOn(pat)
      const hashBefore = await passwordHashOf(pat.id)

      const passwordNoCode = await changePassword(pat.signedIn, {})
      expect(passwordNoCode.status).toBe(400)
      expect(passwordNoCode.body.message).toEqual([MFA_CODE_REQUIRED_MESSAGE])
      const passwordWrongCode = await changePassword(pat.signedIn, {
        mfaCode: '000000',
      })
      expect(passwordWrongCode.status).toBe(400)
      expect(passwordWrongCode.body.message).toEqual([INVALID_MFA_CODE_MESSAGE])
      const emailNoCode = await changeEmail(
        pat.signedIn,
        `mfa-new-${stamp}@example.com`,
        {},
      )
      expect(emailNoCode.status).toBe(400)
      expect(emailNoCode.body.message).toEqual([MFA_CODE_REQUIRED_MESSAGE])

      expect(await passwordHashOf(pat.id)).toBe(hashBefore)
      const { rows } = await sessionPool.query(
        'SELECT 1 FROM email_change_requests WHERE user_id = $1',
        [pat.id],
      )
      expect(rows).toEqual([])
    })

    // The code is spent by the change it allowed: the same code can't then
    // allow another one.
    it('passes with a good code, which is then spent: the same code is refused for the next change', async () => {
      const pat = await newPerson()
      const secret = await turnOn(pat)
      const code = await freshCode(secret, 10)

      const changed = await changePassword(pat.signedIn, { mfaCode: code })
      expect(changed.status).toBe(204)
      expect((await mfaColumnsOf(pat.id)).mfa_last_used_step).toBe(
        currentStep(),
      )

      const again = await changeEmail(
        pat.signedIn,
        `mfa-again-${stamp}@example.com`,
        { currentPassword: 'a-new-password', mfaCode: code },
      )
      expect(again.status).toBe(400)
      expect(again.body.message).toEqual([MFA_CODE_ALREADY_USED_MESSAGE])

      await forgetUsedCode(pat.id)
      const email = await changeEmail(
        pat.signedIn,
        `mfa-again-${stamp}@example.com`,
        { currentPassword: 'a-new-password', mfaCode: code },
      )
      expect(email.status).toBe(201)
    })

    // `ValidateIf(isPresent)`, not `IsOptional()`: null is not "no code" —
    // in both DTOs (for an account WITHOUT two-factor, where a code would
    // otherwise be ignored and the change made).
    it('refuses null as a code, in both changes', async () => {
      const pat = await newPerson()
      const password = await changePassword(pat.signedIn, { mfaCode: null })
      expect(password.status).toBe(400)
      expect(password.body.message).toContain('mfaCode must be a string')
      const email = await changeEmail(
        pat.signedIn,
        `mfa-null-${stamp}@example.com`,
        { mfaCode: null },
      )
      expect(email.status).toBe(400)
      expect(email.body.message).toContain('mfaCode must be a string')
    })

    // An account without two-factor: the password alone, as before.
    it('asks nothing more of an account without two-factor', async () => {
      const pat = await newPerson()
      expect((await changePassword(pat.signedIn, {})).status).toBe(204)
    })
  })
})
