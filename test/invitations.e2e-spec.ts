// Same reason as every e2e file: Jest never auto-loads .env, and AppModule
// needs POSTGRES_* the moment it's built.
import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql, type SQL } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { getAppDatabaseUrl, getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'

// Invitations (design decisions §3), tested against the real database.
//
// This first part covers the database layer added before the invitation
// endpoints exist (migrations 0020 and 0021):
//   1. accounts with no password yet (users.password_hash NULL) — they can't
//      log in, and forgot/reset password can't be used to get around the
//      invitation;
//   2. the invitations table's row-level security, queried as the app's
//      own database role, the way the running app queries it;
//   3. its constraints.
//
// The cast, in one clinic:
//   practitionerA — creates the patient, so is on their care team
//   practitionerB — same clinic, NOT on the care team
//   patient       — created by practitionerA, then has its password removed:
//                   the state an invited, not-yet-accepted account is in
// plus one open invitation for the patient, sent by practitionerA.
//
// Its own file (not auth.e2e-spec.ts) partly because the auth suite is
// already at the rate limits for login and forgot-password (5 per minute
// each, per app instance — deferred-improvements.md). Each e2e file builds
// its own app, so this one starts with fresh counts.
describe('Invitations (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb
  const outbox = new InMemoryEmailTransport()

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>

  let adminId: number
  let practitionerAId: number
  let practitionerBId: number
  let practitionerBEmail: string
  let patientId: number
  let patientEmail: string

  // The open invitation's token. The database only ever sees its hash.
  const token = randomBytes(32).toString('hex')
  const tokenHash = sha256(token)
  let invitationId: number

  function sha256(value: string) {
    return createHash('sha256').update(value).digest('hex')
  }

  // --- Running queries as someone, then throwing the changes away ---------

  // Who a query runs as. Mirrors what the app does:
  //   { userId, role } — a signed-in request (withRlsContext);
  //   { tokenHash }    — the accept page, holding a token
  //                      (withInvitationTokenContext);
  //   {}               — no context at all.
  type Actor = { userId?: number; role?: string; tokenHash?: string }

  // Postgres's error code and the constraint it names, dug out of drizzle's
  // wrapper (the pg error is its `cause`). Codes used below:
  //   42501 — "new row violates row-level security policy"
  //   23505 — unique violation      23514 — CHECK violation
  // `unknown`, narrowed step by step, rather than `any`: same walk as
  // isPgError() in src/database/pg-errors.ts.
  function pgError(error: unknown): { code?: string; constraint?: string } {
    let current: unknown = error
    for (let depth = 0; depth < 5; depth++) {
      if (typeof current !== 'object' || current === null) {
        return {}
      }
      const fields = current as {
        code?: unknown
        constraint?: unknown
        cause?: unknown
      }
      if (typeof fields.code === 'string') {
        return {
          code: fields.code,
          constraint:
            typeof fields.constraint === 'string'
              ? fields.constraint
              : undefined,
        }
      }
      current = fields.cause
    }
    return {}
  }

  // Throwing out of db.transaction()'s callback makes drizzle ROLL BACK.
  // run() throws this on purpose to carry the result out, so every query
  // below leaves the database as it found it: each test sees the same
  // starting state, whatever order they run in.
  // Extends Error so it is a real exception (lint's only-throw-error rule,
  // and stack traces if one ever escaped).
  class RolledBack extends Error {
    constructor(readonly rows: Record<string, unknown>[]) {
      super('rolled back on purpose')
    }
  }

  // Runs `query` as the app's database role (stride_app — RLS applies to it,
  // as in the running app) with `actor`'s context. Resolves to the rows the
  // policies let through, or to the database error if the query was refused.
  //
  // `query` may be a list of statements, run in order in the same
  // transaction (the rows returned are the LAST one's) — e.g. "close the
  // open invitation, then insert a new one", as two statements, the way the
  // service will do it. Not one statement with a WITH clause: Postgres runs
  // a data-modifying WITH that the main statement doesn't read from AFTER
  // the main statement, so the INSERT would still see the old invitation
  // open.
  async function run(
    actor: Actor,
    query: SQL | SQL[],
  ): Promise<{
    rows?: Record<string, unknown>[]
    error?: ReturnType<typeof pgError>
  }> {
    try {
      await db.transaction(async (tx) => {
        if (actor.userId !== undefined && actor.role !== undefined) {
          await tx.execute(
            sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true)`,
          )
          await tx.execute(
            sql`SELECT set_config('app.current_role', ${actor.role}, true)`,
          )
        }
        if (actor.tokenHash !== undefined) {
          await tx.execute(
            sql`SELECT set_config('app.invitation_token_hash', ${actor.tokenHash}, true)`,
          )
        }
        let rows: Record<string, unknown>[] = []
        for (const statement of Array.isArray(query) ? query : [query]) {
          rows = (await tx.execute<Record<string, unknown>>(statement)).rows
        }
        throw new RolledBack(rows)
      })
    } catch (error) {
      if (error instanceof RolledBack) {
        return { rows: error.rows }
      }
      return { error: pgError(error) }
    }
    throw new Error('unreachable: run() always rolls back')
  }

  // Shorthands for the actors.
  const asAdmin = (): Actor => ({ userId: adminId, role: 'admin' })
  const asPractitionerA = (): Actor => ({
    userId: practitionerAId,
    role: 'practitioner',
  })
  const asPractitionerB = (): Actor => ({
    userId: practitionerBId,
    role: 'practitioner',
  })

  const selectInvitations = sql`SELECT id FROM invitations`

  // --- Setup ---------------------------------------------------------------

  beforeAll(async () => {
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

    db = app.get<DrizzleDb>(DRIZZLE)

    // Refuse to run anywhere but the test database (see users.e2e-spec.ts).
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    )
    if (rows[0].current_database !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${rows[0].current_database}" — expected "stride_test".`,
      )
    }
    // CASCADE also empties invitations and care_team_members (both
    // reference users).
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = agent()
    const practitionerA = agent()
    const stamp = Date.now()

    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Invitations Clinic',
      clinicEmail: `inv-clinic-${stamp}@example.com`,
      email: `inv-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Invite',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    const clinicId = bootstrap.body.clinicId as number
    adminId = bootstrap.body.id as number

    const practitionerAEmail = `inv-pa-${stamp}@example.com`
    const createA = await admin.post('/users').send({
      email: practitionerAEmail,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Alice',
      lastName: 'Practitioner',
      licenseNumber: `INV-A-${stamp}`,
      clinicId,
    })
    expect(createA.status).toBe(201)
    practitionerAId = createA.body.id as number

    practitionerBEmail = `inv-pb-${stamp}@example.com`
    const createB = await admin.post('/users').send({
      email: practitionerBEmail,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Bob',
      lastName: 'Practitioner',
      licenseNumber: `INV-B-${stamp}`,
      clinicId,
    })
    expect(createB.status).toBe(201)
    practitionerBId = createB.body.id as number

    // practitionerA creates the patient, so joins their care team (same
    // transaction, UsersService.create). Until the invitation endpoints
    // exist, POST /users still takes a password — removed just below.
    const loginA = await practitionerA
      .post('/auth/login')
      .send({ email: practitionerAEmail, password: 'password123' })
    expect(loginA.status).toBe(201)
    patientEmail = `inv-patient-${stamp}@example.com`
    const createPatient = await practitionerA.post('/users').send({
      email: patientEmail,
      password: 'password123',
      role: 'patient',
      firstName: 'Ines',
      lastName: 'Vited',
      dateOfBirth: '1992-03-04',
      clinicId,
    })
    expect(createPatient.status).toBe(201)
    patientId = createPatient.body.id as number

    // The state an invited account is in before accepting: no password, and
    // one open invitation. Written as the database owner (sessionPool), which
    // isn't subject to RLS — this is test setup, not what's under test.
    await sessionPool.query(
      'UPDATE users SET password_hash = NULL WHERE id = $1',
      [patientId],
    )
    const invitation = await sessionPool.query<{ id: number }>(
      `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')
       RETURNING id`,
      [patientId, tokenHash, practitionerAId],
    )
    invitationId = invitation.rows[0].id
  })

  afterAll(async () => {
    await app.close()
    // Created outside Nest's container, so closed by hand.
    await sessionPool.end()
  })

  // --- 1. Accounts with no password yet -------------------------------------

  describe('an account with no password yet', () => {
    // Same status and message as a wrong password: nothing tells the caller
    // the account exists, or that it's waiting for an invitation.
    it('cannot log in, and fails exactly like a wrong password', async () => {
      const res = await agent()
        .post('/auth/login')
        .send({ email: patientEmail, password: 'password123' })
      expect(res.status).toBe(401)
      expect(res.body.message).toEqual(['Invalid email or password'])
    })

    // Checked next to an ordinary account in the same test: without that
    // half, "no email was sent" would also pass if forgot-password had
    // stopped sending emails to anyone.
    it('gets no reset email from forgot-password, while an account with a password does', async () => {
      const passwordless = await agent()
        .post('/auth/forgot-password')
        .send({ email: patientEmail })
      expect(passwordless.status).toBe(204)

      const ordinary = await agent()
        .post('/auth/forgot-password')
        .send({ email: practitionerBEmail })
      expect(ordinary.status).toBe(204)

      expect(outbox.sentTo(patientEmail)).toHaveLength(0)
      expect(outbox.sentTo(practitionerBEmail)).toHaveLength(1)

      const { rows } = await sessionPool.query<{
        password_reset_token_hash: string | null
      }>('SELECT password_reset_token_hash FROM users WHERE id = $1', [
        patientId,
      ])
      expect(rows[0].password_reset_token_hash).toBeNull()
    })

    // A reset token can't normally reach such an account (see above), so
    // it's planted directly — the defence-in-depth check in resetPassword()
    // is what's under test.
    it('cannot set a password through reset-password, even with a valid reset token', async () => {
      const resetToken = randomBytes(32).toString('hex')
      await sessionPool.query(
        `UPDATE users
            SET password_reset_token_hash = $1,
                password_reset_token_expires_at = now() + interval '1 hour'
          WHERE id = $2`,
        [sha256(resetToken), patientId],
      )

      const res = await agent()
        .post('/auth/reset-password')
        .send({ token: resetToken, newPassword: 'chosen-by-attacker' })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'This password reset link is invalid or has expired',
      ])

      const { rows } = await sessionPool.query<{
        password_hash: string | null
      }>('SELECT password_hash FROM users WHERE id = $1', [patientId])
      expect(rows[0].password_hash).toBeNull()

      await sessionPool.query(
        `UPDATE users
            SET password_reset_token_hash = NULL,
                password_reset_token_expires_at = NULL
          WHERE id = $1`,
        [patientId],
      )
    })
  })

  // --- 2. Row-level security --------------------------------------------------

  describe('invitations row-level security', () => {
    describe('reading', () => {
      it('lets an admin and the care team see the invitation', async () => {
        expect((await run(asAdmin(), selectInvitations)).rows).toEqual([
          { id: invitationId },
        ])
        expect((await run(asPractitionerA(), selectInvitations)).rows).toEqual([
          { id: invitationId },
        ])
      })

      // The case the care-team rule exists for: sharing a clinic is not
      // enough.
      it('hides it from a practitioner of the same clinic who is not on the care team', async () => {
        expect((await run(asPractitionerB(), selectInvitations)).rows).toEqual(
          [],
        )
      })

      it('hides it from the invited patient, and from a query with no context', async () => {
        expect(
          (await run({ userId: patientId, role: 'patient' }, selectInvitations))
            .rows,
        ).toEqual([])
        expect((await run({}, selectInvitations)).rows).toEqual([])
      })

      // The accept page's view: the matching row, and only that row.
      it('shows the token holder exactly the invitation matching the token', async () => {
        expect((await run({ tokenHash }, selectInvitations)).rows).toEqual([
          { id: invitationId },
        ])
        expect(
          (
            await run(
              { tokenHash: sha256('some-other-token') },
              selectInvitations,
            )
          ).rows,
        ).toEqual([])
      })

      // A connection from the pool that a signed-in request used before
      // carries app.current_user_id = '' afterwards (not NULL — see
      // migration 0007), and rls_current_user_id() would fail casting '' to
      // an integer. One dedicated connection, used for a user context and
      // then for a token lookup, checks the token branch still works there
      // — the situation the real accept page will be in.
      it('still works on a pooled connection a signed-in request used before', async () => {
        const singleConnection = new Pool({
          connectionString: getAppDatabaseUrl(),
          max: 1,
        })
        const client = await singleConnection.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', 'practitioner', true)",
            [String(practitionerAId)],
          )
          await client.query('COMMIT')

          const leftover = await client.query<{ uid: string }>(
            "SELECT current_setting('app.current_user_id', true) AS uid",
          )
          expect(leftover.rows[0].uid).toBe('')

          await client.query('BEGIN')
          await client.query(
            "SELECT set_config('app.invitation_token_hash', $1, true)",
            [tokenHash],
          )
          const found = await client.query<{ id: number }>(
            'SELECT id FROM invitations',
          )
          await client.query('ROLLBACK')
          expect(found.rows).toEqual([{ id: invitationId }])
        } finally {
          client.release()
          await singleConnection.end()
        }
      })
    })

    describe('inviting (insert)', () => {
      // No RETURNING, on purpose. Returning a row also requires being
      // allowed to SELECT it, so an INSERT … RETURNING by someone the read
      // policy hides the row from fails with the same 42501 even when the
      // INSERT policy would have let it through — a refusal test would
      // then pass whatever the insert policy says. (Found by mutation-
      // checking these tests.) The resend test reads its row back with a
      // separate SELECT instead.
      const insertFor = (invitedBy: number, hash: string) =>
        sql`INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
            VALUES (${patientId}, ${hash}, ${invitedBy}, now() + interval '7 days')`

      // "Resend": close the open invitation and send a new one, in one
      // transaction — what the service will do. Allowed for the care team.
      // A function, not a constant: describe() bodies run when Jest
      // COLLECTS the tests, before beforeAll() has set invitationId.
      const closeOpenInvitation = () =>
        sql`UPDATE invitations SET accepted_at = now()
             WHERE id = ${invitationId}`

      it('lets the care team resend: revoke the open invitation, insert a new one', async () => {
        const result = await run(asPractitionerA(), [
          sql`UPDATE invitations
                 SET revoked_at = now(), revoked_by = ${practitionerAId}
               WHERE id = ${invitationId}`,
          insertFor(practitionerAId, sha256('resent')),
          sql`SELECT invited_by FROM invitations
               WHERE token_hash = ${sha256('resent')}`,
        ])
        expect(result.error).toBeUndefined()
        expect(result.rows).toEqual([{ invited_by: practitionerAId }])
      })

      // B can't close the open invitation first (it's hidden from B), so
      // this also relies on Postgres checking the policy BEFORE the
      // one-open index: a 42501, not a 23505.
      it('refuses a practitioner of the same clinic who is not on the care team', async () => {
        const result = await run(
          asPractitionerB(),
          insertFor(practitionerBId, sha256('by-b')),
        )
        expect(result.error?.code).toBe('42501')
      })

      // Nobody can send an invitation in someone else's name — admins
      // included. The admin closes the open one first, so the only thing
      // left to refuse the INSERT is the policy.
      it('refuses an invitation recorded as sent by someone else', async () => {
        const result = await run(asAdmin(), [
          closeOpenInvitation(),
          insertFor(practitionerAId, sha256('forged')),
        ])
        expect(result.error?.code).toBe('42501')
      })

      // A token lets its holder ACCEPT one invitation, never create one.
      // The token holder closes the open one first (accepting is allowed),
      // so again only the policy can refuse. This is the test that found
      // the ''::integer problem fixed at the top of migration 0021: it used
      // to fail with 22P02 instead of 42501.
      it('refuses the token holder', async () => {
        const result = await run({ tokenHash }, [
          closeOpenInvitation(),
          insertFor(patientId, sha256('self-made')),
        ])
        expect(result.error?.code).toBe('42501')
      })
    })

    describe('closing (update)', () => {
      const revokeAs = (revokedBy: number) =>
        sql`UPDATE invitations
               SET revoked_at = now(), revoked_by = ${revokedBy}
             WHERE id = ${invitationId}
            RETURNING id`

      it('lets an admin and the care team revoke it', async () => {
        expect((await run(asAdmin(), revokeAs(adminId))).rows).toEqual([
          { id: invitationId },
        ])
        expect(
          (await run(asPractitionerA(), revokeAs(practitionerAId))).rows,
        ).toEqual([{ id: invitationId }])
      })

      // The row is hidden from B, so the UPDATE matches nothing — no error,
      // just 0 rows, the same as for a row that doesn't exist. (Hidden by
      // the READ policy as much as the update policy: an UPDATE with a
      // WHERE also applies the SELECT policy to the rows it targets. Since
      // both policies allow the same people here, the update policy's
      // USING adds no protection of its own — mutation-checking showed it:
      // opening it alone left this test green. Its WITH CHECK does, and is
      // tested just below.)
      it('changes nothing for a practitioner who is not on the care team', async () => {
        const result = await run(asPractitionerB(), revokeAs(practitionerBId))
        expect(result.error).toBeUndefined()
        expect(result.rows).toEqual([])
      })

      // WITH CHECK: a revocation is recorded as made by whoever made it.
      it('refuses a revocation recorded as made by someone else', async () => {
        const result = await run(asPractitionerA(), revokeAs(adminId))
        expect(result.error?.code).toBe('42501')
      })

      it('lets the token holder accept their invitation — and only theirs', async () => {
        const accept = sql`UPDATE invitations SET accepted_at = now()
                            WHERE accepted_at IS NULL RETURNING id`
        expect((await run({ tokenHash }, accept)).rows).toEqual([
          { id: invitationId },
        ])
        expect(
          (await run({ tokenHash: sha256('some-other-token') }, accept)).rows,
        ).toEqual([])
      })

      it('never deletes an invitation, not even for an admin', async () => {
        const result = await run(
          asAdmin(),
          sql`DELETE FROM invitations RETURNING id`,
        )
        expect(result.error).toBeUndefined()
        expect(result.rows).toEqual([])
      })
    })
  })

  // --- 3. Constraints -----------------------------------------------------------

  // Constraints hold for everyone — the database owner included, who isn't
  // subject to RLS. Run as the owner (sessionPool) inside a transaction
  // that is always rolled back.
  describe('invitations constraints', () => {
    // Statements run in order, each with its own parameters (see run() on
    // why "close, then insert" is two statements, not one WITH).
    async function asOwner(...statements: [string, unknown[]][]) {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        for (const [statement, params] of statements) {
          await client.query(statement, params)
        }
        return {}
      } catch (error) {
        return pgError(error)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    // The partial unique index: two OPEN invitations for one account are
    // impossible, whoever inserts them and however close together.
    it('refuses a second open invitation for the same account', async () => {
      const error = await asOwner([
        `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, now() + interval '7 days')`,
        [patientId, sha256('second'), practitionerAId],
      ])
      expect(error).toEqual({
        code: '23505',
        constraint: 'invitations_one_open_per_user',
      })
    })

    // …while closed ones may pile up: that's the history.
    it('accepts a new invitation once the open one is closed', async () => {
      const error = await asOwner(
        [
          'UPDATE invitations SET revoked_at = now(), revoked_by = $1 WHERE id = $2',
          [practitionerAId, invitationId],
        ],
        [
          `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, now() + interval '7 days')`,
          [patientId, sha256('after-close'), practitionerAId],
        ],
      )
      expect(error).toEqual({})
    })

    it('refuses an invitation both accepted and revoked', async () => {
      const error = await asOwner([
        `UPDATE invitations
            SET accepted_at = now(), revoked_at = now(), revoked_by = $1
          WHERE id = $2`,
        [adminId, invitationId],
      ])
      expect(error).toEqual({
        code: '23514',
        constraint: 'invitations_accepted_or_revoked',
      })
    })

    it('refuses a revocation without who made it, and a "revoked by" without a revocation', async () => {
      expect(
        await asOwner([
          'UPDATE invitations SET revoked_at = now() WHERE id = $1',
          [invitationId],
        ]),
      ).toEqual({ code: '23514', constraint: 'invitations_revoked_with_actor' })
      expect(
        await asOwner([
          'UPDATE invitations SET revoked_by = $1 WHERE id = $2',
          [adminId, invitationId],
        ]),
      ).toEqual({ code: '23514', constraint: 'invitations_revoked_with_actor' })
    })

    it('refuses an invitation that expires before it was created', async () => {
      const error = await asOwner([
        `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 second')`,
        [practitionerBId, sha256('expired-at-birth'), adminId],
      ])
      expect(error).toEqual({
        code: '23514',
        constraint: 'invitations_expires_after_creation',
      })
    })
  })
})