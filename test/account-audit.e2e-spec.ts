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
import { OTP } from 'otplib'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// The audit review, Phase 6 — slices 1a (users, care teams, invitations) and
// 1b (clinics, sign-in and account security). Every write on these routes
// now follows the audit convention (deferred-improvements.md, "Audit review"):
//   - ONE complete entry per request that changes something — what changed
//     (before → after for edits, the record for creations), who did it, and
//     whose account it concerns (target_user_id);
//   - written in the change's OWN transaction: no change without its entry,
//     no entry without its change;
//   - nothing written for a refused request, or one that changes nothing;
//   - no generic interceptor entry ("POST /users/12") beside it.
// Each module's own suite tests what the routes DO; this one tests what they
// leave in audit_logs.
describe('Account audit trail (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let outbox: InMemoryEmailTransport

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitionerA: ReturnType<typeof agent>
  let practitionerB: ReturnType<typeof agent>

  let adminId: number
  let clinicXId: number
  let clinicYId: number
  let practitionerAId: number
  let practitionerBId: number
  const stamp = Date.now()
  let counter = 0

  // --- Reading the trail (as the owner: audit_logs is admin-only) ---------

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  // Every entry about one account, oldest first. entity_id is a bigint,
  // which node-postgres returns as a string — cast for a plain number.
  async function trail(userId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type,
              entity_id::int AS entity_id, details
         FROM audit_logs
        WHERE target_user_id = $1
        ORDER BY id`,
      [userId],
    )
    return rows
  }

  // The generic interceptor's entries for these routes ("PATCH /users/12"),
  // and since slice 1b for /clinics and /auth too,
  // which must never appear again. It writes AFTER the response,
  // fire-and-forget — so wait a moment first, or a late entry would be
  // missed and a test would pass for nothing.
  async function genericEntries() {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE action ~ '^(POST|PATCH|PUT|DELETE) /(users|invitations|clinics|auth)'`,
    )
    return rows.map((row) => row.action)
  }

  // One value, read as the owner.
  async function one<T>(query: string, params: unknown[]): Promise<T> {
    const { rows } = await sessionPool.query<{ value: T }>(query, params)
    return rows[0].value
  }

  // --- Making accounts ----------------------------------------------------

  function uniqueEmail(label: string) {
    counter += 1
    return `aa-${label}-${counter}-${stamp}@example.com`
  }

  // A patient created by `who` in clinic X, NOT activated (its invitation
  // still open). As practitioner A by default — who then joins the care
  // team automatically.
  async function newPatient(who: ReturnType<typeof agent> = practitionerA) {
    const email = uniqueEmail('patient')
    const res = await who.post('/users').send({
      email,
      role: 'patient',
      firstName: 'Pat',
      lastName: 'Ient',
      dateOfBirth: '1980-02-03',
      clinicId: clinicXId,
    })
    expect(res.status).toBe(201)
    return { id: res.body.id as number, email }
  }

  async function createAndLogIn(
    who: ReturnType<typeof agent>,
    fields: Record<string, unknown>,
  ) {
    const res = await admin.post('/users').send(fields)
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, fields.email as string)
    const login = await who
      .post('/auth/login')
      .send({ email: fields.email, password: 'password123' })
    expect(login.status).toBe(201)
    return res.body.id as number
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
    // Invitation ids far from user ids: an entry naming the invitation's id
    // where the account's belongs (performed_by, target_user_id) must FAIL
    // the tests, not pass because the two numbers happen to coincide — they
    // did, once, and a wrong performer survived a mutation check.
    await sessionPool.query(
      "SELECT setval(pg_get_serial_sequence('invitations', 'id'), 100000)",
    )

    admin = agent()
    practitionerA = agent()
    practitionerB = agent()
    const practitionerC = agent()

    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Audit Clinic X',
      clinicEmail: `aa-x-${stamp}@example.com`,
      email: `aa-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Audit',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicXId = bootstrap.body.clinicId
    adminId = (await admin.get('/auth/me')).body.id

    const clinicY = await admin
      .post('/clinics')
      .send({ name: 'Audit Clinic Y', email: `aa-y-${stamp}@example.com` })
    expect(clinicY.status).toBe(201)
    clinicYId = clinicY.body.id

    practitionerAId = await createAndLogIn(practitionerA, {
      email: `aa-pa-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Alex',
      lastName: 'A',
      licenseNumber: `AA-A-${stamp}`,
      clinicId: clinicXId,
    })
    practitionerBId = await createAndLogIn(practitionerB, {
      email: `aa-pb-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Blake',
      lastName: 'B',
      licenseNumber: `AA-B-${stamp}`,
      clinicId: clinicXId,
    })
    // In clinic Y only: shares no clinic with clinic X's patients.
    await createAndLogIn(practitionerC, {
      email: `aa-pc-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Casey',
      lastName: 'C',
      licenseNumber: `AA-C-${stamp}`,
      clinicId: clinicYId,
    })
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // === USERS ================================================================

  describe('users', () => {
    // One act, one entry: the account, the creator's care-team link and the
    // first invitation — no CARE_TEAM_JOINED or INVITATION_SENT beside it.
    it('records a creation once: the account as sent, with its care-team link and invitation', async () => {
      const patient = await newPatient()
      const linkId = await one<number>(
        'SELECT id AS value FROM care_team_members WHERE patient_id = $1',
        [patient.id],
      )
      const invitationId = await one<number>(
        'SELECT id AS value FROM invitations WHERE user_id = $1',
        [patient.id],
      )

      expect(await trail(patient.id)).toEqual([
        {
          action: 'USER_CREATED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'users',
          entity_id: patient.id,
          details: {
            record: {
              email: patient.email,
              role: 'patient',
              firstName: 'Pat',
              lastName: 'Ient',
              dateOfBirth: '1980-02-03',
              clinicId: clinicXId,
            },
            careTeamLinkId: linkId,
            invitationId,
          },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    it('names no care-team link when an admin creates the account', async () => {
      const patient = await newPatient(admin)
      const [entry] = await trail(patient.id)
      expect(entry.performed_by).toBe(adminId)
      expect(Object.keys(entry.details ?? {}).sort()).toEqual([
        'invitationId',
        'record',
      ])
    })

    it('records nothing for a refused creation', async () => {
      const email = uniqueEmail('refused')
      const refused = [
        // A clinic practitioner A doesn't belong to.
        await practitionerA.post('/users').send({
          email,
          role: 'patient',
          firstName: 'No',
          lastName: 'Body',
          dateOfBirth: '1990-01-01',
          clinicId: clinicYId,
        }),
        // A license number already taken: refused by the database's UNIQUE
        // constraint INSIDE the transaction, after the users row was
        // inserted — everything rolls back, the entry included.
        await admin.post('/users').send({
          email,
          role: 'practitioner',
          firstName: 'No',
          lastName: 'Body',
          licenseNumber: `AA-A-${stamp}`,
          clinicId: clinicXId,
        }),
      ]
      expect(refused.map((res) => res.status)).toEqual([403, 409])
      const { rows } = await sessionPool.query(
        `SELECT 1 FROM audit_logs WHERE details -> 'record' ->> 'email' = $1`,
        [email],
      )
      expect(rows).toEqual([])
    })

    it('records a granted role with the profile it came with', async () => {
      const patient = await newPatient()
      const res = await admin
        .post(`/users/${patient.id}/roles`)
        .send({ role: 'admin', position: 'Front desk' })
      expect(res.status).toBe(201)

      const entries = await trail(patient.id)
      expect(entries.map((entry) => entry.action)).toEqual([
        'USER_CREATED',
        'USER_ROLE_GRANTED',
      ])
      expect(entries[1]).toEqual({
        action: 'USER_ROLE_GRANTED',
        performed_by: adminId,
        target_user_id: patient.id,
        entity_type: 'users',
        entity_id: patient.id,
        details: { role: 'admin', profile: { position: 'Front desk' } },
      })
      expect(await genericEntries()).toEqual([])
    })

    // A patient's date of birth and phone are personal health information:
    // who changed them, from what, to what.
    it('records an edit as before → after, only for what really changed', async () => {
      const patient = await newPatient()
      const res = await practitionerA.patch(`/users/${patient.id}`).send({
        firstName: 'Pat', // the stored value: not a change
        phone: '+1 555 0100',
        dateOfBirth: '1980-02-04',
      })
      expect(res.status).toBe(200)

      const [, updated] = await trail(patient.id)
      expect(updated).toEqual({
        action: 'USER_UPDATED',
        performed_by: practitionerAId,
        target_user_id: patient.id,
        entity_type: 'users',
        entity_id: patient.id,
        details: {
          changes: {
            phone: { from: null, to: '+1 555 0100' },
            dateOfBirth: { from: '1980-02-03', to: '1980-02-04' },
          },
        },
      })
      expect(await genericEntries()).toEqual([])
    })

    it('records nothing for an edit that changes nothing, or a refused one', async () => {
      const patient = await newPatient()
      const responses = [
        // Every value as stored.
        await practitionerA
          .patch(`/users/${patient.id}`)
          .send({ firstName: 'Pat', dateOfBirth: '1980-02-03' }),
        // Not on this patient's care team.
        await practitionerB
          .patch(`/users/${patient.id}`)
          .send({ firstName: 'Changed' }),
        // A field the target has no profile for.
        await admin
          .patch(`/users/${patient.id}`)
          .send({ licenseNumber: 'NOPE' }),
      ]
      expect(responses.map((res) => res.status)).toEqual([200, 403, 400])
      expect((await trail(patient.id)).map((entry) => entry.action)).toEqual([
        'USER_CREATED',
      ])
    })

    // The entry is written THROUGH the change's transaction. Proof: make
    // the audit insert itself fail (a trigger planted for this test) —
    // the change must be undone with it. Written after the commit, as the
    // old code did, the name would have changed and only the entry been
    // lost.
    it('undoes the change when its entry cannot be written', async () => {
      const patient = await newPatient()
      await sessionPool.query(`
        CREATE FUNCTION aa_refuse_user_updated() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'audit insert refused (test)';
          END $$;
        CREATE TRIGGER aa_refuse_user_updated
          BEFORE INSERT ON audit_logs
          FOR EACH ROW WHEN (NEW.action = 'USER_UPDATED')
          EXECUTE FUNCTION aa_refuse_user_updated();
      `)
      try {
        const res = await practitionerA
          .patch(`/users/${patient.id}`)
          .send({ firstName: 'Lost' })
        expect(res.status).toBe(500)
      } finally {
        await sessionPool.query(`
          DROP TRIGGER aa_refuse_user_updated ON audit_logs;
          DROP FUNCTION aa_refuse_user_updated();
        `)
      }
      expect(
        await one<string>(
          'SELECT first_name AS value FROM users WHERE id = $1',
          [patient.id],
        ),
      ).toBe('Pat')
    })

    // The "before" values are read under a row lock (SELECT … FOR UPDATE).
    // Deterministic: another transaction holds an uncommitted change of the
    // same row; the request must wait for it, and its entry must say it
    // replaced THAT value — not the one committed before. (Without the lock,
    // the read returns the older committed name at once, and only the
    // UPDATE waits: the entry would claim to have replaced "Pat".)
    it('reads what it replaces under a row lock: two edits take turns, each entry exact', async () => {
      const patient = await newPatient()
      const client = await sessionPool.connect()
      let waited: boolean
      let status: number
      try {
        await client.query('BEGIN')
        await client.query(
          "UPDATE users SET first_name = 'Held' WHERE id = $1",
          [patient.id],
        )
        let answered = false
        const pending = practitionerA
          .patch(`/users/${patient.id}`)
          .send({ firstName: 'Mine' })
          .then((res) => {
            answered = true
            return res
          })
        await new Promise((resolve) => setTimeout(resolve, 300))
        waited = !answered
        await client.query('COMMIT')
        status = (await pending).status
      } finally {
        client.release()
      }

      expect(waited).toBe(true)
      expect(status).toBe(200)
      const [, updated] = await trail(patient.id)
      expect(updated.details).toEqual({
        changes: { firstName: { from: 'Held', to: 'Mine' } },
      })
    })

    it('records a new photo and its removal by storage key — and nothing for removing none', async () => {
      const patient = await newPatient()
      const upload = await admin
        .post(`/users/${patient.id}/avatar`)
        .attach('file', Buffer.from('fake-avatar-audit'), {
          filename: 'me.png',
          contentType: 'image/png',
        })
      expect(upload.status).toBe(201)
      const key = await one<string>(
        'SELECT avatar_path AS value FROM users WHERE id = $1',
        [patient.id],
      )
      const removals = [
        await admin.delete(`/users/${patient.id}/avatar`),
        // Nothing left to remove: succeeds, changes nothing, writes nothing.
        await admin.delete(`/users/${patient.id}/avatar`),
      ]
      expect(removals.map((res) => res.status)).toEqual([200, 200])

      const entries = await trail(patient.id)
      expect(entries.slice(1)).toEqual([
        {
          action: 'USER_AVATAR_CHANGED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'users',
          entity_id: patient.id,
          details: { changes: { avatarPath: { from: null, to: key } } },
        },
        {
          action: 'USER_AVATAR_REMOVED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'users',
          entity_id: patient.id,
          details: { changes: { avatarPath: { from: key, to: null } } },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    it('records a deactivation and a reactivation — once each, however many clicks', async () => {
      const patient = await newPatient()
      const responses = [
        await admin.delete(`/users/${patient.id}`),
        await admin.delete(`/users/${patient.id}`),
        await admin.post(`/users/${patient.id}/reactivate`),
        await admin.post(`/users/${patient.id}/reactivate`),
      ]
      expect(responses.map((res) => res.status)).toEqual([200, 200, 201, 201])

      const entries = await trail(patient.id)
      expect(entries.slice(1)).toEqual([
        {
          action: 'USER_DEACTIVATED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'users',
          entity_id: patient.id,
          details: { changes: { isActive: { from: true, to: false } } },
        },
        {
          action: 'USER_REACTIVATED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'users',
          entity_id: patient.id,
          details: { changes: { isActive: { from: false, to: true } } },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })
  })

  // === CARE TEAMS ===========================================================

  describe('care teams', () => {
    // The link's own row, as the owner, for comparing with the entry.
    async function link(patientId: number, practitionerId: number) {
      const { rows } = await sessionPool.query<{
        id: number
        started_at: Date
        ends_at: Date | null
      }>(
        `SELECT id, started_at, ends_at FROM care_team_members
          WHERE patient_id = $1 AND practitioner_id = $2
          ORDER BY id DESC LIMIT 1`,
        [patientId, practitionerId],
      )
      return rows[0]
    }

    it('records a join, a colleague added, and an ending — each with its period', async () => {
      const patient = await newPatient()
      const joined = await practitionerB
        .post(`/users/${patient.id}/care-team`)
        .send({ reason: 'Covering Tuesdays' })
      expect(joined.status).toBe(201)
      const bJoin = await link(patient.id, practitionerBId)

      const ended = await practitionerB.post(
        `/users/${patient.id}/care-team/${practitionerBId}/end`,
      )
      expect(ended.status).toBe(201)
      const bEnded = await link(patient.id, practitionerBId)

      const added = await practitionerA
        .post(`/users/${patient.id}/care-team`)
        .send({ practitionerId: practitionerBId })
      expect(added.status).toBe(201)
      const bAdded = await link(patient.id, practitionerBId)

      const entries = await trail(patient.id)
      expect(entries.slice(1)).toEqual([
        {
          action: 'CARE_TEAM_JOINED',
          performed_by: practitionerBId,
          target_user_id: patient.id,
          entity_type: 'care_team_members',
          entity_id: bJoin.id,
          details: {
            practitionerId: practitionerBId,
            startedAt: bJoin.started_at.toISOString(),
            endsAt: null,
            reason: 'Covering Tuesdays',
          },
        },
        {
          action: 'CARE_TEAM_ENDED',
          performed_by: practitionerBId,
          target_user_id: patient.id,
          entity_type: 'care_team_members',
          entity_id: bJoin.id,
          details: {
            practitionerId: practitionerBId,
            startedAt: bJoin.started_at.toISOString(),
            endsAt: (bEnded.ends_at as Date).toISOString(),
          },
        },
        {
          action: 'CARE_TEAM_MEMBER_ADDED',
          performed_by: practitionerAId,
          target_user_id: patient.id,
          entity_type: 'care_team_members',
          entity_id: bAdded.id,
          details: {
            practitionerId: practitionerBId,
            startedAt: bAdded.started_at.toISOString(),
            endsAt: null,
            reason: null,
          },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    it('records nothing for a refused join or ending', async () => {
      const patient = await newPatient()
      const refused = [
        // Already on the team (the creator): the overlap constraint's 409.
        await practitionerA.post(`/users/${patient.id}/care-team`).send({}),
        // Not on the team: nothing to end.
        await practitionerB.post(
          `/users/${patient.id}/care-team/${practitionerBId}/end`,
        ),
        // Someone else's membership.
        await practitionerB.post(
          `/users/${patient.id}/care-team/${practitionerAId}/end`,
        ),
      ]
      expect(refused.map((res) => res.status)).toEqual([409, 404, 403])
      expect((await trail(patient.id)).map((entry) => entry.action)).toEqual([
        'USER_CREATED',
      ])
    })
  })

  // === INVITATIONS ==========================================================

  describe('invitations', () => {
    it('records a resend naming what it replaced, a revoke, a new invitation, and the acceptance', async () => {
      const patient = await newPatient()
      const firstId = await one<number>(
        'SELECT id AS value FROM invitations WHERE user_id = $1',
        [patient.id],
      )
      const resent = await practitionerA.post(
        `/users/${patient.id}/invitations`,
      )
      expect(resent.status).toBe(201)
      const revoked = await practitionerA.post(
        `/users/${patient.id}/invitations/revoke`,
      )
      expect(revoked.status).toBe(200)
      // Nothing open any more: a second revoke is refused, and writes nothing.
      const again = await practitionerA.post(
        `/users/${patient.id}/invitations/revoke`,
      )
      expect(again.status).toBe(404)
      const sent = await practitionerA.post(`/users/${patient.id}/invitations`)
      expect(sent.status).toBe(201)

      // Accepting for real: the token from the latest email.
      const token = findLink(
        outbox.lastSentTo(patient.email),
        '/accept-invitation',
      ).searchParams.get('token')
      const accepted = await agent()
        .post('/invitations/accept')
        .send({ token, password: 'a-long-password-1' })
      expect(accepted.status).toBe(204)

      const { rows: invitations } = await sessionPool.query<{
        id: number
        expires_at: Date
      }>(
        'SELECT id, expires_at FROM invitations WHERE user_id = $1 ORDER BY id',
        [patient.id],
      )
      const [, second, third] = invitations
      const base = {
        target_user_id: patient.id,
        entity_type: 'invitations',
      }
      expect((await trail(patient.id)).slice(1)).toEqual([
        {
          ...base,
          action: 'INVITATION_RESENT',
          performed_by: practitionerAId,
          entity_id: second.id,
          details: {
            expiresAt: second.expires_at.toISOString(),
            replacedIds: [firstId],
          },
        },
        {
          ...base,
          action: 'INVITATION_REVOKED',
          performed_by: practitionerAId,
          entity_id: second.id,
          details: null,
        },
        {
          ...base,
          action: 'INVITATION_SENT',
          performed_by: practitionerAId,
          entity_id: third.id,
          details: { expiresAt: third.expires_at.toISOString() },
        },
        // Performed by the account itself; the password is nowhere in it.
        {
          ...base,
          action: 'INVITATION_ACCEPTED',
          performed_by: patient.id,
          entity_id: third.id,
          details: null,
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    // The entry no longer depends on the email: written in the
    // transaction, before the email is tried. The invitation row says
    // whether it went out.
    it('records the invitation the same way when its email fails', async () => {
      const patient = await newPatient()
      outbox.failNext()
      const res = await practitionerA.post(`/users/${patient.id}/invitations`)
      expect(res.status).toBe(201)
      expect(res.body.emailSent).toBe(false)

      const entries = await trail(patient.id)
      expect(entries.map((entry) => entry.action)).toEqual([
        'USER_CREATED',
        'INVITATION_RESENT',
      ])
      expect(
        await one<Date | null>(
          'SELECT email_sent_at AS value FROM invitations WHERE id = $1',
          [entries[1].entity_id],
        ),
      ).toBeNull()
    })
  })
  // === CLINICS (slice 1b) =================================================

  describe('clinics', () => {
    // Every entry about one clinic (organisation data: no target user).
    async function clinicTrail(clinicId: number) {
      const { rows } = await sessionPool.query<AuditRow>(
        `SELECT action, performed_by, target_user_id, entity_type,
                entity_id::int AS entity_id, details
           FROM audit_logs
          WHERE entity_type = 'clinics' AND entity_id = $1
          ORDER BY id`,
        [clinicId],
      )
      return rows
    }

    it('records a new clinic, an edit before → after, and nothing for an unchanged one', async () => {
      const email = uniqueEmail('clinic')
      const created = await admin
        .post('/clinics')
        .send({ name: 'Audit Clinic Z', email })
      expect(created.status).toBe(201)
      const id = created.body.id as number
      const edits = [
        await admin.patch(`/clinics/${id}`).send({ name: 'Audit Clinic Zed' }),
        await admin.patch(`/clinics/${id}`).send({ name: 'Audit Clinic Zed' }),
      ]
      expect(edits.map((res) => res.status)).toEqual([200, 200])

      expect(await clinicTrail(id)).toEqual([
        {
          action: 'CLINIC_CREATED',
          performed_by: adminId,
          target_user_id: null,
          entity_type: 'clinics',
          entity_id: id,
          details: { record: { name: 'Audit Clinic Z', email } },
        },
        {
          action: 'CLINIC_UPDATED',
          performed_by: adminId,
          target_user_id: null,
          entity_type: 'clinics',
          entity_id: id,
          details: {
            changes: {
              name: { from: 'Audit Clinic Z', to: 'Audit Clinic Zed' },
            },
          },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    it('records a logo, its removal, a deactivation and a reactivation — once each', async () => {
      const created = await admin
        .post('/clinics')
        .send({ name: 'Audit Clinic Logo', email: uniqueEmail('logo') })
      const id = created.body.id as number
      const upload = await admin
        .post(`/clinics/${id}/logo`)
        .attach('file', Buffer.from('fake-logo-audit'), {
          filename: 'logo.png',
          contentType: 'image/png',
        })
      expect(upload.status).toBe(201)
      const key = await one<string>(
        'SELECT logo_path AS value FROM clinics WHERE id = $1',
        [id],
      )
      const responses = [
        await admin.delete(`/clinics/${id}/logo`),
        await admin.delete(`/clinics/${id}/logo`), // nothing left: no entry
        await admin.delete(`/clinics/${id}`),
        await admin.delete(`/clinics/${id}`), // already: no entry
        await admin.post(`/clinics/${id}/reactivate`),
      ]
      expect(responses.map((res) => res.status)).toEqual([
        200, 200, 200, 200, 201,
      ])

      const base = {
        performed_by: adminId,
        target_user_id: null,
        entity_type: 'clinics',
        entity_id: id,
      }
      expect((await clinicTrail(id)).slice(1)).toEqual([
        {
          ...base,
          action: 'CLINIC_LOGO_CHANGED',
          details: { changes: { logoPath: { from: null, to: key } } },
        },
        {
          ...base,
          action: 'CLINIC_LOGO_REMOVED',
          details: { changes: { logoPath: { from: key, to: null } } },
        },
        {
          ...base,
          action: 'CLINIC_DEACTIVATED',
          details: { changes: { isActive: { from: true, to: false } } },
        },
        {
          ...base,
          action: 'CLINIC_REACTIVATED',
          details: { changes: { isActive: { from: false, to: true } } },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    // Removing someone from a clinic can end care-team links: the removal is
    // one entry about the member, and each ended link one more about ITS
    // patient (decided with the person 2026-10-21) — all in one transaction.
    it('records a membership added and removed, and each care-team link the removal ended, for its patient', async () => {
      const patient = await newPatient() // practitioner A on the team, clinic X
      const added = await admin
        .post(`/clinics/${clinicYId}/members`)
        .send({ userId: patient.id })
      expect(added.status).toBe(201)
      const membershipId = added.body.id as number
      const xMembershipId = await one<number>(
        'SELECT id AS value FROM user_clinics WHERE user_id = $1 AND clinic_id = $2',
        [patient.id, clinicXId],
      )
      // Out of clinic X: A no longer shares a clinic with the patient.
      const removed = await admin.delete(
        `/clinics/${clinicXId}/members/${patient.id}`,
      )
      expect(removed.status).toBe(200)
      const { rows: links } = await sessionPool.query<{
        id: number
        practitioner_id: number
        started_at: Date
        ends_at: Date
      }>(
        'SELECT id, practitioner_id, started_at, ends_at FROM care_team_members WHERE patient_id = $1',
        [patient.id],
      )
      expect(links).toHaveLength(1)

      expect((await trail(patient.id)).slice(1)).toEqual([
        {
          action: 'CLINIC_MEMBER_ADDED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'user_clinics',
          entity_id: membershipId,
          details: { clinicId: clinicYId },
        },
        {
          action: 'CLINIC_MEMBER_REMOVED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'user_clinics',
          entity_id: xMembershipId,
          details: { clinicId: clinicXId, endedCareTeamLinkIds: [links[0].id] },
        },
        {
          action: 'CARE_TEAM_ENDED',
          performed_by: adminId,
          target_user_id: patient.id,
          entity_type: 'care_team_members',
          entity_id: links[0].id,
          details: {
            practitionerId: practitionerAId,
            startedAt: links[0].started_at.toISOString(),
            endsAt: links[0].ends_at.toISOString(),
            reason: 'No longer share a clinic',
            clinicId: clinicXId,
          },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })
  })

  // === SIGN-IN AND ACCOUNT SECURITY (slice 1b) ============================

  describe('sign-in and account security', () => {
    const otp = new OTP({ strategy: 'totp' })
    // A TOTP code still valid when the server checks it (the server accepts
    // only the current 30-second window — see auth-recovery.e2e-spec.ts).
    async function freshCode(secret: string): Promise<string> {
      const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30)
      if (secondsLeft < 5) {
        await new Promise((resolve) =>
          setTimeout(resolve, secondsLeft * 1000 + 100),
        )
      }
      return otp.generate({ secret })
    }

    // A fresh, activated patient (password 'password123'), and an agent.
    async function readyPatient() {
      const patient = await newPatient()
      await activateAccount(sessionPool, patient.email)
      return patient
    }

    it('records the founding of the deployment, naming the admin', async () => {
      const { rows } = await sessionPool.query<AuditRow>(
        `SELECT action, performed_by, target_user_id, entity_type,
                entity_id::int AS entity_id, details
           FROM audit_logs WHERE action = 'REGISTER_CLINIC'`,
      )
      expect(rows).toEqual([
        {
          action: 'REGISTER_CLINIC',
          performed_by: adminId,
          target_user_id: adminId,
          entity_type: 'clinics',
          entity_id: clinicXId,
          details: { adminUserId: adminId },
        },
      ])
    })

    it('records a failed sign-in, a sign-in and a sign-out, each about the account', async () => {
      const patient = await readyPatient()
      const who = agent()
      const responses = [
        await who
          .post('/auth/login')
          .send({ email: patient.email, password: 'wrong-password' }),
        await who
          .post('/auth/login')
          .send({ email: patient.email, password: 'password123' }),
        await who.post('/auth/logout'),
      ]
      expect(responses.map((res) => res.status)).toEqual([401, 201, 204])

      const base = {
        performed_by: patient.id,
        target_user_id: patient.id,
        entity_type: 'users',
        entity_id: patient.id,
      }
      expect((await trail(patient.id)).slice(1)).toEqual([
        { ...base, action: 'LOGIN_FAILURE', details: null },
        {
          ...base,
          action: 'LOGIN_SUCCESS',
          details: { activeRole: 'patient' },
        },
        { ...base, action: 'LOGOUT', details: null },
      ])
      expect(await genericEntries()).toEqual([])
    })

    // Awaited before answering (decided with the person): no sign-in
    // without its entry. Proof: refuse the entry (a planted trigger) — the
    // sign-in must fail and no session be opened. Fire-and-forget, it would
    // have succeeded and only the entry been lost.
    it('refuses the sign-in when its entry cannot be written', async () => {
      const patient = await readyPatient()
      await sessionPool.query(`
        CREATE FUNCTION aa_refuse_login() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'audit insert refused (test)';
          END $$;
        CREATE TRIGGER aa_refuse_login
          BEFORE INSERT ON audit_logs
          FOR EACH ROW WHEN (NEW.action = 'LOGIN_SUCCESS')
          EXECUTE FUNCTION aa_refuse_login();
      `)
      const who = agent()
      try {
        const res = await who
          .post('/auth/login')
          .send({ email: patient.email, password: 'password123' })
        expect(res.status).toBe(500)
      } finally {
        await sessionPool.query(`
          DROP TRIGGER aa_refuse_login ON audit_logs;
          DROP FUNCTION aa_refuse_login();
        `)
      }
      expect((await who.get('/auth/me')).status).toBe(401)
    })

    it('records MFA set up, enabled, a wrong code at sign-in, and disabled', async () => {
      const patient = await readyPatient()
      const who = agent()
      await who
        .post('/auth/login')
        .send({ email: patient.email, password: 'password123' })
      const setup = await who.post('/auth/mfa/setup')
      expect(setup.status).toBe(201)
      const secret = setup.body.secret as string
      const enabled = await who
        .post('/auth/mfa/enable')
        .send({ code: await freshCode(secret) })
      expect(enabled.status).toBe(204)
      await who.post('/auth/logout')

      const second = agent()
      await second
        .post('/auth/login')
        .send({ email: patient.email, password: 'password123' })
      const wrong = await second
        .post('/auth/mfa/verify')
        .send({ code: '000000' })
      expect(wrong.status).toBe(401)
      const right = await second
        .post('/auth/mfa/verify')
        .send({ code: await freshCode(secret) })
      expect(right.status).toBe(201)
      const disabled = await second
        .post('/auth/mfa/disable')
        .send({ code: await freshCode(secret) })
      expect(disabled.status).toBe(204)

      const actions = (await trail(patient.id)).map((entry) => entry.action)
      expect(actions).toEqual([
        'USER_CREATED',
        'LOGIN_SUCCESS',
        'MFA_SETUP_STARTED',
        'MFA_ENABLED',
        'LOGOUT',
        // The password step of the second sign-in, then the wrong code.
        'LOGIN_SUCCESS',
        'MFA_LOGIN_FAILURE',
        'MFA_DISABLED',
      ])
      const entries = await trail(patient.id)
      // Never the secret, encrypted or not, in any entry.
      expect(JSON.stringify(entries)).not.toContain(secret)
      for (const entry of entries.slice(2)) {
        expect(entry).toMatchObject({
          performed_by: patient.id,
          target_user_id: patient.id,
          entity_type: 'users',
          entity_id: patient.id,
        })
      }
      expect(await genericEntries()).toEqual([])
    })

    it('records a role switch with its from and to — and nothing for "switching" to the active role', async () => {
      const email = uniqueEmail('two-roles')
      const who = agent()
      const id = await createAndLogIn(who, {
        email,
        role: 'practitioner',
        firstName: 'Two',
        lastName: 'Roles',
        licenseNumber: `AA-2R-${stamp}`,
        clinicId: clinicXId,
      })
      const granted = await admin
        .post(`/users/${id}/roles`)
        .send({ role: 'admin', position: 'Lead' })
      expect(granted.status).toBe(201)
      // A fresh session sees the new role.
      await who.post('/auth/logout')
      await who
        .post('/auth/login')
        .send({ email, password: 'password123', role: 'practitioner' })
      const switches = [
        await who.post('/auth/switch-role').send({ role: 'practitioner' }),
        await who.post('/auth/switch-role').send({ role: 'admin' }),
      ]
      expect(switches.map((res) => res.status)).toEqual([201, 201])

      const switched = (await trail(id)).filter(
        (entry) => entry.action === 'ROLE_SWITCHED',
      )
      expect(switched).toEqual([
        {
          action: 'ROLE_SWITCHED',
          performed_by: id,
          target_user_id: id,
          entity_type: 'users',
          entity_id: id,
          details: { from: 'practitioner', to: 'admin' },
        },
      ])
      expect(await genericEntries()).toEqual([])
    })

    it('records a reset requested and completed — and nothing for checking the link', async () => {
      const patient = await readyPatient()
      const requested = await agent()
        .post('/auth/forgot-password')
        .send({ email: patient.email })
      expect(requested.status).toBe(204)
      const token = findLink(
        outbox.lastSentTo(patient.email),
        '/reset-password',
      ).searchParams.get('token')
      const expiresAt = await one<Date>(
        'SELECT password_reset_token_expires_at AS value FROM users WHERE id = $1',
        [patient.id],
      )
      // A signed-in visitor checking the link: the route is @NotAudited.
      const checked = await practitionerA
        .post('/auth/reset-password/check')
        .send({ token })
      expect(checked.status).toBe(200)
      const reset = await agent()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'a-brand-new-password-1' })
      expect(reset.status).toBe(204)

      const base = {
        performed_by: patient.id,
        target_user_id: patient.id,
        entity_type: 'users',
        entity_id: patient.id,
      }
      expect((await trail(patient.id)).slice(1)).toEqual([
        {
          ...base,
          action: 'PASSWORD_RESET_REQUESTED',
          details: { expiresAt: expiresAt.toISOString() },
        },
        { ...base, action: 'PASSWORD_RESET_COMPLETED', details: null },
      ])
      expect(await genericEntries()).toEqual([])
    })
  })
})
