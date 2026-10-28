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

// GET /audit-logs for the audit log viewer (decided with the person
// 2026-10-21): the names of who acted and of whom, each entry's kind and
// area, and the filters kind / targetUserId / from / before; GET
// /audit-logs/actions for the screen's action filter.
//
// The entries are PLANTED as the owner, with chosen times, after the set-up's
// own entries are cleared — so every filter is checked against a known set.
// They are built so the rules DISAGREE: two entries share one instant (the
// tie-break), the range bounds fall exactly ON entries (>= vs >, < vs <=)
// and are written with a +01:00 offset (a server reading them as UTC would
// be an hour off), and one row has an action the vocabulary doesn't know.
describe('Audit log viewer (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitioner: ReturnType<typeof agent>
  let adminId: number
  let practitionerId: number
  let xId: number
  let yId: number
  const stamp = Date.now()

  // The planted entries' ids, by letter (see beforeAll for each one).
  const ids: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
    F: 0,
    G: 0,
  }

  async function plant(row: {
    performedBy: number
    action: string
    targetUserId: number | null
    entityType: string
    entityId: number | null
    details: unknown
    createdAt: string
  }) {
    const { rows } = await sessionPool.query<{ id: string }>(
      `INSERT INTO audit_logs
         (performed_by, action, target_user_id, entity_type, entity_id,
          details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        row.performedBy,
        row.action,
        row.targetUserId,
        row.entityType,
        row.entityId,
        row.details === null ? null : JSON.stringify(row.details),
        row.createdAt,
      ],
    )
    // pg answers bigserial ids as strings.
    return Number(rows[0].id)
  }

  // The ids of an answer, in order.
  const idsOf = (res: request.Response) =>
    (res.body.data as { id: number }[]).map((entry) => entry.id)

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
    practitioner = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Viewer Clinic',
      clinicEmail: `av-clinic-${stamp}@example.com`,
      email: `av-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Avery',
      lastName: 'Viewer',
    })
    expect(bootstrap.status).toBe(201)
    const clinicId = bootstrap.body.clinicId as number
    adminId = (await admin.get('/auth/me')).body.id as number

    const practitionerEmail = `av-p-${stamp}@example.com`
    const created = await admin.post('/users').send({
      email: practitionerEmail,
      role: 'practitioner',
      firstName: 'Paula',
      lastName: 'Prescott',
      licenseNumber: `AV-${stamp}`,
      clinicId,
    })
    expect(created.status).toBe(201)
    practitionerId = created.body.id as number
    await activateAccount(sessionPool, practitionerEmail)
    const login = await practitioner
      .post('/auth/login')
      .send({ email: practitionerEmail, password: 'password123' })
    expect(login.status).toBe(201)

    const newPatient = async (firstName: string, lastName: string) => {
      const res = await practitioner.post('/users').send({
        email: `av-${lastName.toLowerCase()}-${stamp}@example.com`,
        role: 'patient',
        firstName,
        lastName,
        dateOfBirth: '1990-01-01',
        clinicId,
      })
      expect(res.status).toBe(201)
      return res.body.id as number
    }
    xId = await newPatient('Xavier', 'Xu')
    yId = await newPatient('Yara', 'Young')

    // Only the planted entries from here on; their ids far from any user
    // id, so an entry id mistaken for a user id (or back) can't pass.
    await sessionPool.query('DELETE FROM audit_logs')
    await sessionPool.query(
      "SELECT setval(pg_get_serial_sequence('audit_logs', 'id'), 100000)",
    )

    // G — the oldest: an action the vocabulary knows, on an entity type it
    //     doesn't (shown as stored).
    ids.G = await plant({
      performedBy: adminId,
      action: 'CLINIC_UPDATED',
      targetUserId: null,
      entityType: 'mystery_table',
      entityId: null,
      details: null,
      createdAt: '2031-03-09T00:00:00Z',
    })
    // A — a view of X's program.
    ids.A = await plant({
      performedBy: practitionerId,
      action: 'PROGRAM_VIEWED',
      targetUserId: xId,
      entityType: 'assigned-programs',
      entityId: 7,
      details: null,
      createdAt: '2031-03-10T09:00:00Z',
    })
    // B — a change to it (the "from" bound falls exactly here).
    ids.B = await plant({
      performedBy: practitionerId,
      action: 'ASSIGNED_PROGRAM_UPDATED',
      targetUserId: xId,
      entityType: 'assigned-programs',
      entityId: 7,
      details: { changes: { title: { from: 'Knee', to: 'Knee, phase 2' } } },
      createdAt: '2031-03-10T10:00:00Z',
    })
    // C — a sign-in, about no one.
    ids.C = await plant({
      performedBy: adminId,
      action: 'LOGIN_SUCCESS',
      targetUserId: null,
      entityType: 'users',
      entityId: adminId,
      details: null,
      createdAt: '2031-03-10T11:00:00Z',
    })
    // D — a row from before the vocabulary (the old generic interceptor's
    //     kind of action): a change. The "before" bound falls exactly here.
    ids.D = await plant({
      performedBy: adminId,
      action: 'POST /users/6',
      targetUserId: null,
      entityType: 'users',
      entityId: null,
      details: null,
      createdAt: '2031-03-11T08:00:00Z',
    })
    // E and F — one list read showing two patients: the SAME instant (one
    //     INSERT, one now()), F inserted after E.
    ids.E = await plant({
      performedBy: practitionerId,
      action: 'PROGRAMS_VIEWED',
      targetUserId: xId,
      entityType: 'assigned-programs',
      entityId: null,
      details: { programIds: [7] },
      createdAt: '2031-03-11T12:00:00Z',
    })
    ids.F = await plant({
      performedBy: practitionerId,
      action: 'PROGRAMS_VIEWED',
      targetUserId: yId,
      entityType: 'assigned-programs',
      entityId: null,
      details: { programIds: [8] },
      createdAt: '2031-03-11T12:00:00Z',
    })
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- THE ENTRIES ---

  it('answers each entry with its kind, its area and both names', async () => {
    const res = await admin
      .get('/audit-logs')
      .query({ action: 'ASSIGNED_PROGRAM_UPDATED' })

    expect(res.status).toBe(200)
    expect(res.body).toStrictEqual({
      data: [
        {
          id: ids.B,
          action: 'ASSIGNED_PROGRAM_UPDATED',
          kind: 'change',
          entityType: 'assigned-programs',
          area: 'Programs',
          entityId: 7,
          // A program is clinical: its details stay stored, never answered
          // (decisions §16 — the next test proves both halves).
          details: null,
          detailsWithheld: true,
          createdAt: '2031-03-10T10:00:00.000Z',
          performer: {
            id: practitionerId,
            firstName: 'Paula',
            lastName: 'Prescott',
          },
          target: { id: xId, firstName: 'Xavier', lastName: 'Xu' },
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    })
  })

  it('answers a null target, an unknown action as a change, and an unknown entity type as stored', async () => {
    const res = await admin.get('/audit-logs').query({ performedBy: adminId })

    expect(res.status).toBe(200)
    expect(
      (
        res.body.data as {
          id: number
          action: string
          kind: string
          area: string
          performer: { firstName: string }
          target: unknown
        }[]
      ).map(({ id, action, kind, area, performer, target }) => ({
        id,
        action,
        kind,
        area,
        performer: performer.firstName,
        target,
      })),
    ).toStrictEqual([
      {
        id: ids.D,
        action: 'POST /users/6',
        kind: 'change',
        area: 'Accounts',
        performer: 'Avery',
        target: null,
      },
      {
        id: ids.C,
        action: 'LOGIN_SUCCESS',
        kind: 'sign_in',
        area: 'Accounts',
        performer: 'Avery',
        target: null,
      },
      {
        id: ids.G,
        action: 'CLINIC_UPDATED',
        kind: 'change',
        area: 'mystery_table',
        performer: 'Avery',
        target: null,
      },
    ])
  })

  // --- ORDER AND PAGES ---

  it('lists newest first, and the later-written of two same-instant entries first', async () => {
    const res = await admin.get('/audit-logs')

    expect(res.status).toBe(200)
    expect(idsOf(res)).toEqual([
      ids.F,
      ids.E,
      ids.D,
      ids.C,
      ids.B,
      ids.A,
      ids.G,
    ])
    expect(res.body.meta).toStrictEqual({
      total: 7,
      page: 1,
      limit: 20,
      totalPages: 1,
    })
  })

  it('shows every entry exactly once across pages of one', async () => {
    const seen: number[] = []
    for (let page = 1; page <= 7; page++) {
      const res = await admin.get('/audit-logs').query({ page, limit: 1 })
      expect(res.status).toBe(200)
      expect(res.body.meta).toStrictEqual({
        total: 7,
        page,
        limit: 1,
        totalPages: 7,
      })
      seen.push(...idsOf(res))
    }
    expect(seen).toEqual([ids.F, ids.E, ids.D, ids.C, ids.B, ids.A, ids.G])
  })

  // --- FILTERS ---

  it('filters by kind: views, sign-ins, and changes (a legacy action included)', async () => {
    const views = await admin.get('/audit-logs').query({ kind: 'view' })
    const signIns = await admin.get('/audit-logs').query({ kind: 'sign_in' })
    const changes = await admin.get('/audit-logs').query({ kind: 'change' })

    expect(idsOf(views)).toEqual([ids.F, ids.E, ids.A])
    expect(views.body.meta.total).toBe(3)
    expect(idsOf(signIns)).toEqual([ids.C])
    expect(signIns.body.meta.total).toBe(1)
    expect(idsOf(changes)).toEqual([ids.D, ids.B, ids.G])
    expect(changes.body.meta.total).toBe(3)
  })

  it('filters by the person an entry is about', async () => {
    const aboutX = await admin.get('/audit-logs').query({ targetUserId: xId })
    const aboutY = await admin.get('/audit-logs').query({ targetUserId: yId })

    expect(idsOf(aboutX)).toEqual([ids.E, ids.B, ids.A])
    expect(aboutX.body.meta.total).toBe(3)
    expect(idsOf(aboutY)).toEqual([ids.F])
  })

  it('combines filters (all of them must match)', async () => {
    const res = await admin
      .get('/audit-logs')
      .query({ targetUserId: xId, kind: 'change' })

    expect(idsOf(res)).toEqual([ids.B])
    expect(res.body.meta.total).toBe(1)
  })

  // [from, before): B's instant included, D's excluded — written as +01:00
  // (10:00Z and 08:00Z), so an offset read as UTC would miss both.
  it('filters by a time range, the start included and the end excluded', async () => {
    const res = await admin.get('/audit-logs').query({
      from: '2031-03-10T11:00:00+01:00',
      before: '2031-03-11T09:00:00+01:00',
    })

    expect(res.status).toBe(200)
    expect(idsOf(res)).toEqual([ids.C, ids.B])
    expect(res.body.meta.total).toBe(2)
  })

  it('takes either end of the range alone', async () => {
    const fromOnly = await admin
      .get('/audit-logs')
      .query({ from: '2031-03-11T12:00:00.000Z' })
    const beforeOnly = await admin
      .get('/audit-logs')
      .query({ before: '2031-03-10T09:00:00Z' })

    expect(idsOf(fromOnly)).toEqual([ids.F, ids.E])
    expect(idsOf(beforeOnly)).toEqual([ids.G])
  })

  // --- REFUSALS ---

  it('refuses a range that ends before or where it starts', async () => {
    const backwards = await admin.get('/audit-logs').query({
      from: '2031-03-11T00:00:00Z',
      before: '2031-03-10T00:00:00Z',
    })
    // The same instant written two ways — an empty range. As TEXT, `from`
    // is the smaller ("…-09T23…" < "…-10T00…"): only a comparison of
    // instants refuses it.
    const empty = await admin.get('/audit-logs').query({
      from: '2031-03-09T23:00:00-01:00',
      before: '2031-03-10T00:00:00Z',
    })

    for (const res of [backwards, empty]) {
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual(['`from` must be earlier than `before`'])
    }
  })

  it('refuses a time without its offset, or that does not exist', async () => {
    const noOffset = await admin
      .get('/audit-logs')
      .query({ from: '2031-03-10T00:00:00' })
    const noSuchDay = await admin
      .get('/audit-logs')
      .query({ before: '2031-02-30T00:00:00Z' })

    expect(noOffset.status).toBe(400)
    expect(noOffset.body.message).toEqual([
      'from must be a date and time with its offset, like 2026-10-21T00:00:00+02:00',
    ])
    expect(noSuchDay.status).toBe(400)
    expect(noSuchDay.body.message).toEqual([
      'before must be a date and time with its offset, like 2026-10-21T00:00:00+02:00',
    ])
  })

  it('refuses an unknown kind and a target that is not a user id', async () => {
    const kind = await admin.get('/audit-logs').query({ kind: 'reads' })
    const target = await admin.get('/audit-logs').query({ targetUserId: 0 })

    expect(kind.status).toBe(400)
    expect(kind.body.message).toEqual([
      'kind must be one of: change, view, sign_in',
    ])
    expect(target.status).toBe(400)
    expect(target.body.message).toEqual([
      'targetUserId must not be less than 1',
    ])
  })

  it('keeps the audit log from anyone but an admin', async () => {
    const res = await practitioner.get('/audit-logs')

    expect(res.status).toBe(403)
    expect(res.body.message).toEqual([
      'You do not have permission to access this resource',
    ])
  })

  // --- THE ACTION LIST ---

  it('lists every action with its kind, by name', async () => {
    const res = await admin.get('/audit-logs/actions')

    expect(res.status).toBe(200)
    const list = res.body as { action: string; kind: string }[]
    expect(list).toHaveLength(107)
    expect(list.map((item) => item.action)).toEqual(
      list.map((item) => item.action).sort(),
    )
    expect(list.slice(0, 2)).toStrictEqual([
      { action: 'ALERTS_VIEWED', kind: 'view' },
      { action: 'ASSIGNED_PROGRAM_ARCHIVED', kind: 'change' },
    ])
    expect(list).toContainEqual({ action: 'LOGOUT', kind: 'sign_in' })
    expect(list).toContainEqual({ action: 'CONVERSATION_READ', kind: 'change' })
  })

  it('keeps the action list from anyone but an admin', async () => {
    const asPractitioner = await practitioner.get('/audit-logs/actions')
    const anonymous = await request(app.getHttpServer()).get(
      '/audit-logs/actions',
    )

    expect(asPractitioner.status).toBe(403)
    expect(asPractitioner.body.message).toEqual([
      'You do not have permission to access this resource',
    ])
    expect(anonymous.status).toBe(401)
  })

  // --- CLINICAL DETAILS (decisions §16, 2026-10-23) ---

  // Admins read no clinical data; an entry's details would hand it to them
  // (a session's pain scores, a prescription before → after). Withheld
  // from the ANSWER for a clinical area — and for an area the vocabulary
  // doesn't know — kept for the account areas; the stored rows untouched.
  // Planted on their own day (2031-05-01) and removed after, so the other
  // tests' counts don't move.
  it('withholds the details of clinical and unknown areas, keeps them for accounts — and stores everything', async () => {
    const at = '2031-05-01T08:00:00.000Z'
    const stored: Record<string, unknown> = {
      account: { changes: { firstName: { from: 'Xav', to: 'Xavier' } } },
      session: { session: { painAfter: 7, endNote: 'Sharp pain' } },
      unknown: { note: 'from before the vocabulary' },
    }
    const account = await plant({
      performedBy: adminId,
      action: 'USER_UPDATED',
      targetUserId: xId,
      entityType: 'users',
      entityId: xId,
      details: stored.account,
      createdAt: at,
    })
    const session = await plant({
      performedBy: xId,
      action: 'SESSION_COMPLETED',
      targetUserId: xId,
      entityType: 'sessions',
      entityId: 31,
      details: stored.session,
      createdAt: '2031-05-01T08:00:01.000Z',
    })
    const unknown = await plant({
      performedBy: adminId,
      action: 'CLINIC_UPDATED',
      targetUserId: null,
      entityType: 'another_mystery',
      entityId: 1,
      details: stored.unknown,
      createdAt: '2031-05-01T08:00:02.000Z',
    })
    try {
      const res = await admin
        .get('/audit-logs')
        .query({ from: '2031-05-01T00:00:00Z', before: '2031-05-02T00:00:00Z' })
      expect(res.status).toBe(200)
      expect(
        (
          res.body.data as {
            id: number
            details: unknown
            detailsWithheld: boolean
          }[]
        ).map(({ id, details, detailsWithheld }) => ({
          id,
          details,
          detailsWithheld,
        })),
      ).toStrictEqual([
        { id: unknown, details: null, detailsWithheld: true },
        { id: session, details: null, detailsWithheld: true },
        { id: account, details: stored.account, detailsWithheld: false },
      ])
      // The database keeps every entry whole.
      const { rows } = await sessionPool.query<{ details: unknown }>(
        'SELECT details FROM audit_logs WHERE id = ANY($1) ORDER BY id',
        [[account, session, unknown]],
      )
      expect(rows.map((row) => row.details)).toStrictEqual([
        stored.account,
        stored.session,
        stored.unknown,
      ])
    } finally {
      await sessionPool.query('DELETE FROM audit_logs WHERE id = ANY($1)', [
        [account, session, unknown],
      ])
    }
  })
})
