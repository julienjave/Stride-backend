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
import { activateAccount, TEST_PASSWORD } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { ENDED_PRACTITIONER_DEACTIVATED_REASON } from '../src/care-team/care-team.service'
import { DEACTIVATE_PRACTITIONER_MESSAGE } from '../src/users/users.service'

// Deactivating a practitioner ENDS their care-team links (decided with the
// person, 2026-10-25): someone who can't sign in treats nobody, so the links
// say so — in the deactivation's own transaction, each with its own
// CARE_TEAM_ENDED entry about its patient. A deactivated PATIENT keeps their
// links: deactivating blocks a sign-in, it doesn't end treatment, and the
// care team must still read the file.
//
// People (all at Main Clinic):
//   Paula — practitioner, deactivated by the admin in the first test. Her
//     links: Pia (current), Cal (current, a cover with a planned end next
//     week), Ola (ENDED yesterday — must keep its real end).
//   Rory  — practitioner, also on Pia's team (a colleague's link: untouched).
//   Max   — practitioner AND patient: Rory treats him; Max treats Kim.
//   Sue   — practitioner who deactivates her own account; treats Kim.
//   Tom   — practitioner whose deactivation is made to fail mid-way.
//   Olga  — practitioner deactivated BEFORE this change (as the owner): her
//     link to Kim was never ended — the old data no migration closes.
//   Pia, Cal, Ola, Kim — patients.
//
// Links are written as the owner (set-up, not under test), so their periods
// can be put anywhere in time; the deactivations go through the real API.
describe('Deactivating a practitioner (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let rory: ReturnType<typeof agent>
  const stamp = Date.now()
  const ids: Record<string, number> = {}
  const emails: Record<string, string> = {}
  let mainId: number

  // An account through the API as the admin (the real path, with its
  // invitation), activated as if the invitation had been accepted.
  async function newUser(key: string, role: 'practitioner' | 'patient') {
    const email = `deact-${key}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role,
      firstName: key[0].toUpperCase() + key.slice(1),
      lastName: 'Test',
      clinicId: mainId,
      ...(role === 'patient'
        ? { dateOfBirth: '1980-02-03' }
        : { licenseNumber: `DEACT-${key}-${stamp}` }),
    })
    expect(res.status).toBe(201)
    ids[key] = res.body.id as number
    emails[key] = email
    await activateAccount(sessionPool, email)
  }

  async function signedIn(key: string) {
    const who = agent()
    const res = await who
      .post('/auth/login')
      .send({ email: emails[key], password: TEST_PASSWORD })
    expect(res.status).toBe(201)
    return who
  }

  // A link written as the owner; answers its id. `endsAt` is SQL.
  async function link(patient: string, practitioner: string, endsAt: string) {
    const { rows } = await sessionPool.query<{ id: number }>(
      `INSERT INTO care_team_members (patient_id, practitioner_id, started_at, ends_at, created_by)
       VALUES ($1, $2, now() - interval '10 days', ${endsAt}, $3)
       RETURNING id`,
      [ids[patient], ids[practitioner], ids.admin],
    )
    return rows[0].id
  }

  // A link as stored now, read as the owner.
  async function linkRow(id: number) {
    const { rows } = await sessionPool.query<{
      ends_at: Date | null
      ended_by: number | null
      still_current: boolean
    }>(
      `SELECT ends_at, ended_by,
              (ends_at IS NULL OR ends_at > now()) AS still_current
       FROM care_team_members WHERE id = $1`,
      [id],
    )
    return rows[0]
  }

  // The audit entries about care-team links, or about one account, as the
  // owner — a short pause first: nothing here is written after the answer,
  // but a missing entry must not be mistaken for a late one.
  async function linkEntries() {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<{
      action: string
      performed_by: number
      target_user_id: number
      entity_id: number
      details: Record<string, unknown>
    }>(
      `SELECT action, performed_by, target_user_id, entity_id, details
       FROM audit_logs WHERE entity_type = 'care_team_members' ORDER BY id`,
    )
    return rows
  }
  async function accountEntries(key: string, action: string) {
    const { rows } = await sessionPool.query<{
      details: Record<string, unknown>
    }>(
      `SELECT details FROM audit_logs
       WHERE entity_type = 'users' AND entity_id = $1 AND action = $2 ORDER BY id`,
      [ids[key], action],
    )
    return rows
  }
  async function isActive(key: string) {
    const { rows } = await sessionPool.query<{ is_active: boolean }>(
      'SELECT is_active FROM users WHERE id = $1',
      [ids[key]],
    )
    return rows[0].is_active
  }

  const links: Record<string, number> = {}

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    admin = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Main Clinic',
      clinicEmail: `deact-main-${stamp}@example.com`,
      email: `deact-admin-${stamp}@example.com`,
      password: TEST_PASSWORD,
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    mainId = bootstrap.body.clinicId as number
    ids.admin = bootstrap.body.id as number

    for (const key of ['paula', 'rory', 'max', 'sue', 'tom', 'olga']) {
      await newUser(key, 'practitioner')
    }
    for (const key of ['pia', 'cal', 'ola', 'kim']) {
      await newUser(key, 'patient')
    }
    // Max is a patient too (a practitioner + patient account).
    const granted = await admin
      .post(`/users/${ids.max}/roles`)
      .send({ role: 'patient', dateOfBirth: '1975-05-06' })
    expect(granted.status).toBe(201)

    links.piaPaula = await link('pia', 'paula', 'NULL')
    links.calPaula = await link('cal', 'paula', "now() + interval '7 days'")
    links.olaPaula = await link('ola', 'paula', "now() - interval '1 day'")
    links.piaRory = await link('pia', 'rory', 'NULL')
    links.maxRory = await link('max', 'rory', 'NULL')
    links.kimMax = await link('kim', 'max', 'NULL')
    links.kimSue = await link('kim', 'sue', 'NULL')
    links.kimTom = await link('kim', 'tom', 'NULL')
    links.kimOlga = await link('kim', 'olga', 'NULL')
    await sessionPool.query(
      'UPDATE users SET is_active = false WHERE id = $1',
      [ids.olga],
    )

    rory = await signedIn('rory')
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  it("ends a deactivated practitioner's current links — and only those", async () => {
    const before = await linkRow(links.olaPaula)

    const res = await admin.delete(`/users/${ids.paula}`)

    expect(res.status).toBe(200)
    expect(res.body.isActive).toBe(false)
    // Her two current links end now, signed by the admin — the cover with a
    // planned end next week too.
    for (const id of [links.piaPaula, links.calPaula]) {
      const row = await linkRow(id)
      expect(row.still_current).toBe(false)
      expect(row.ended_by).toBe(ids.admin)
    }
    // A link that had already ended keeps its real end.
    expect(await linkRow(links.olaPaula)).toStrictEqual(before)
    // A colleague's link to the same patient is untouched.
    expect(await linkRow(links.piaRory)).toMatchObject({
      ends_at: null,
      still_current: true,
    })
    // The patient's care team says so: Paula is a past member.
    const team = await admin.get(`/users/${ids.pia}/care-team`)
    expect(team.status).toBe(200)
    expect(
      (team.body as { practitioner: { id: number } }[]).map(
        (entry) => entry.practitioner.id,
      ),
    ).toEqual([ids.rory])
  })

  it('records the deactivation with the links it ended, and one CARE_TEAM_ENDED per link about its patient', async () => {
    const [deactivation] = await accountEntries('paula', 'USER_DEACTIVATED')
    // Compared as sets: an UPDATE's RETURNING has no order.
    expect(
      [...(deactivation.details.endedCareTeamLinkIds as number[])].sort(
        (a, b) => a - b,
      ),
    ).toEqual([links.piaPaula, links.calPaula].sort((a, b) => a - b))

    const ended = (await linkEntries()).filter(
      (entry) => entry.action === 'CARE_TEAM_ENDED',
    )
    expect(
      ended
        .map((entry) => ({
          performedBy: entry.performed_by,
          targetUserId: entry.target_user_id,
          linkId: Number(entry.entity_id),
          practitionerId: entry.details.practitionerId,
          reason: entry.details.reason,
        }))
        .sort((a, b) => a.linkId - b.linkId),
    ).toStrictEqual(
      [
        { linkId: links.piaPaula, targetUserId: ids.pia },
        { linkId: links.calPaula, targetUserId: ids.cal },
      ]
        .map((expected) => ({
          performedBy: ids.admin,
          targetUserId: expected.targetUserId,
          linkId: expected.linkId,
          practitionerId: ids.paula,
          reason: ENDED_PRACTITIONER_DEACTIVATED_REASON,
        }))
        .sort((a, b) => a.linkId - b.linkId),
    )
  })

  it('reactivating the practitioner restores none of the links', async () => {
    const res = await admin.post(`/users/${ids.paula}/reactivate`)

    expect(res.status).toBe(201)
    expect(await isActive('paula')).toBe(true)
    for (const id of [links.piaPaula, links.calPaula]) {
      expect((await linkRow(id)).still_current).toBe(false)
    }
  })

  // Old data (decided with the person: no migration): a practitioner
  // deactivated before this change still has an open link. Reactivating
  // ends nothing — only a deactivation does — so she has her patient back.
  it('ends nothing when reactivating an account deactivated before this change', async () => {
    const endedBefore = (await linkEntries()).length

    const res = await admin.post(`/users/${ids.olga}/reactivate`)

    expect(res.status).toBe(201)
    expect(await linkRow(links.kimOlga)).toMatchObject({
      ends_at: null,
      still_current: true,
    })
    expect((await linkEntries()).length).toBe(endedBefore)
  })

  // A patient's deactivation blocks the sign-in only: their care team keeps
  // its links, and so its access to the file.
  it("keeps a deactivated patient's care team, which can still open their record", async () => {
    const endedBefore = (await linkEntries()).length

    const res = await admin.delete(`/users/${ids.pia}`)

    expect(res.status).toBe(200)
    expect(await linkRow(links.piaRory)).toMatchObject({
      ends_at: null,
      still_current: true,
    })
    const [deactivation] = await accountEntries('pia', 'USER_DEACTIVATED')
    expect(deactivation.details.endedCareTeamLinkIds).toEqual([])
    expect((await linkEntries()).length).toBe(endedBefore)
    // Rory, still on her team, opens her file.
    expect((await rory.get(`/users/${ids.pia}`)).status).toBe(200)
    expect((await rory.get(`/medical-files?patientId=${ids.pia}`)).status).toBe(
      200,
    )
  })

  // Max is a practitioner AND Rory's patient: the route lets Rory deactivate
  // a patient of his — but his own links' UPDATE policy wouldn't let Rory
  // end Max's links, so the deactivation is refused instead of leaving them
  // silently open.
  it("refuses a practitioner's deactivation by anyone but an admin or themselves, changing nothing", async () => {
    const entriesBefore = (await linkEntries()).length

    const res = await rory.delete(`/users/${ids.max}`)

    expect(res.status).toBe(403)
    expect(res.body.message).toEqual([DEACTIVATE_PRACTITIONER_MESSAGE])
    expect(await isActive('max')).toBe(true)
    expect((await linkRow(links.kimMax)).still_current).toBe(true)
    expect(await accountEntries('max', 'USER_DEACTIVATED')).toEqual([])
    expect((await linkEntries()).length).toBe(entriesBefore)
  })

  // The practitioner themselves: the UPDATE policy lets them end their own
  // links — signed by them.
  it('lets a practitioner deactivate their own account, ending their links in their name', async () => {
    const sue = await signedIn('sue')

    const res = await sue.delete(`/users/${ids.sue}`)

    expect(res.status).toBe(200)
    expect(await linkRow(links.kimSue)).toMatchObject({
      still_current: false,
      ended_by: ids.sue,
    })
  })

  // One transaction: when a link's entry can't be written, the whole
  // deactivation is undone — the account active, its links open, no entry.
  it('undoes the whole deactivation when a link cannot be recorded', async () => {
    await sessionPool.query(`
      CREATE FUNCTION test_refuse_care_team_ended() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test: no CARE_TEAM_ENDED';
      END $$`)
    await sessionPool.query(`
      CREATE TRIGGER test_refuse_care_team_ended
      BEFORE INSERT ON audit_logs FOR EACH ROW
      WHEN (NEW.action = 'CARE_TEAM_ENDED')
      EXECUTE FUNCTION test_refuse_care_team_ended()`)
    try {
      const res = await admin.delete(`/users/${ids.tom}`)

      expect(res.status).toBe(500)
      expect(await isActive('tom')).toBe(true)
      expect((await linkRow(links.kimTom)).still_current).toBe(true)
      expect(await accountEntries('tom', 'USER_DEACTIVATED')).toEqual([])
    } finally {
      await sessionPool.query(
        'DROP TRIGGER test_refuse_care_team_ended ON audit_logs',
      )
      await sessionPool.query('DROP FUNCTION test_refuse_care_team_ended()')
    }
  })
})
