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

// GET /admin/users — the Users page's list (Phase 6.5, decided with the
// person 2026-10-29): search, role, clinic, account status, the "needs
// attention" groups (tested with the metrics, admin-metrics.e2e-spec.ts),
// and paging, 25 a page.
//
// One dataset where each filter changes the answer:
//
//   Main clinic:   Ada Admin (admin, the founder) · Paula Shaw (practitioner)
//                  · Ana Lopez (patient) · Mo Reyes (practitioner + admin —
//                  a two-role account must be listed ONCE)
//   Second clinic: Pablo Shaw (practitioner — the same last name as Paula,
//                  so the first name decides their order) · Ben Lopez
//                  (patient, created BEFORE Ana Lopez: ordered by id he
//                  would come first, by first name he comes after her)
//   No clinic:     Zoe Field (patient — removed from Main as the owner)
//   Deactivated:   Dan Gray (practitioner, Main)
//   Email only:    Cleo Hart's address holds "kiwi", her name doesn't
//
// Names are plain ASCII with a capital first letter: the expected orders
// are written out by hand, never computed with JavaScript's sort (which
// disagrees with a language collation — deferred-improvements.md).
describe('Admin users list (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitioner: ReturnType<typeof agent>
  const stamp = Date.now()
  const ids: Record<string, number> = {}
  let mainId: number
  let secondId: number

  interface ListBody {
    data: { id: number; roles: string[]; isActive: boolean }[]
    meta: { total: number; page: number; limit: number; totalPages: number }
  }
  const list = async (query: string) => {
    const res = await admin.get(`/admin/users${query}`)
    expect(res.status).toBe(200)
    return res.body as ListBody
  }
  const idsOf = (body: ListBody) => body.data.map((user) => user.id)

  async function newUser(
    key: string,
    firstName: string,
    lastName: string,
    role: 'practitioner' | 'patient',
    clinicId: number,
    email = `list-${key}-${stamp}@example.com`,
  ) {
    const res = await admin.post('/users').send({
      email,
      role,
      firstName,
      lastName,
      clinicId,
      ...(role === 'patient'
        ? { dateOfBirth: '1980-02-03' }
        : { licenseNumber: `LIST-${key}-${stamp}` }),
    })
    expect(res.status).toBe(201)
    ids[key] = res.body.id as number
    return email
  }

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
      clinicEmail: `list-main-${stamp}@example.com`,
      email: `list-admin-${stamp}@example.com`,
      password: TEST_PASSWORD,
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    mainId = bootstrap.body.clinicId as number
    ids.admin = bootstrap.body.id as number

    const second = await admin.post('/clinics').send({
      name: 'Second Clinic',
      email: `list-second-${stamp}@example.com`,
    })
    expect(second.status).toBe(201)
    secondId = second.body.id as number

    const paulaEmail = await newUser(
      'paula',
      'Paula',
      'Shaw',
      'practitioner',
      mainId,
    )
    await newUser('pablo', 'Pablo', 'Shaw', 'practitioner', secondId)
    await newUser('ben', 'Ben', 'Lopez', 'patient', secondId)
    await newUser('ana', 'Ana', 'Lopez', 'patient', mainId)
    await newUser('mo', 'Mo', 'Reyes', 'practitioner', mainId)
    const granted = await admin
      .post(`/users/${ids.mo}/roles`)
      .send({ role: 'admin' })
    expect(granted.status).toBe(201)
    await newUser('zoe', 'Zoe', 'Field', 'patient', mainId)
    await sessionPool.query('DELETE FROM user_clinics WHERE user_id = $1', [
      ids.zoe,
    ])
    await newUser('dan', 'Dan', 'Gray', 'practitioner', mainId)
    const deactivated = await admin.delete(`/users/${ids.dan}`)
    expect(deactivated.status).toBe(200)
    await newUser(
      'cleo',
      'Cleo',
      'Hart',
      'patient',
      mainId,
      `list-kiwi-${stamp}@example.com`,
    )

    // A practitioner signed in, for the refusal.
    await activateAccount(sessionPool, paulaEmail)
    practitioner = agent()
    const login = await practitioner
      .post('/auth/login')
      .send({ email: paulaEmail, password: TEST_PASSWORD })
    expect(login.status).toBe(201)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // Every active account, by last name, then first name: Admin, Field,
  // Hart, Lopez Ana, Lopez Ben, Reyes, Shaw Pablo, Shaw Paula. Dan Gray
  // (deactivated) isn't there.
  const ACTIVE_IN_ORDER = () => [
    ids.admin,
    ids.zoe,
    ids.cleo,
    ids.ana,
    ids.ben,
    ids.mo,
    ids.pablo,
    ids.paula,
  ]

  it('lists the active accounts by last name, then first name, with the page described', async () => {
    const body = await list('')

    expect(idsOf(body)).toEqual(ACTIVE_IN_ORDER())
    expect(body.meta).toStrictEqual({
      total: 8,
      page: 1,
      limit: 25,
      totalPages: 1,
    })
    // The users list's own shape — roles and clinics — never a hash.
    const mo = body.data.find((user) => user.id === ids.mo)!
    expect([...mo.roles].sort()).toEqual(['admin', 'practitioner'])
    expect(mo).not.toHaveProperty('passwordHash')
  })

  // Paging walks the same order without overlap or gap: three pages of 3,
  // the last one short. A page past the last answers no rows, and says how
  // many pages there are.
  it('pages through the same order, every account exactly once', async () => {
    const pages = [
      await list('?limit=3&page=1'),
      await list('?limit=3&page=2'),
      await list('?limit=3&page=3'),
    ]
    expect(pages.map(idsOf).flat()).toEqual(ACTIVE_IN_ORDER())
    expect(pages.map((page) => page.data.length)).toEqual([3, 3, 2])
    for (const [index, page] of pages.entries()) {
      expect(page.meta).toStrictEqual({
        total: 8,
        page: index + 1,
        limit: 3,
        totalPages: 3,
      })
    }
    const past = await list('?limit=3&page=4')
    expect(past.data).toEqual([])
    expect(past.meta).toStrictEqual({
      total: 8,
      page: 4,
      limit: 3,
      totalPages: 3,
    })
  })

  it('shows deactivated accounts on their own, or everyone with them', async () => {
    expect(idsOf(await list('?status=deactivated'))).toEqual([ids.dan])
    // Gray sorts between Field and Hart.
    const everyone = await list('?status=all')
    expect(idsOf(everyone)).toEqual([
      ids.admin,
      ids.zoe,
      ids.dan,
      ids.cleo,
      ids.ana,
      ids.ben,
      ids.mo,
      ids.pablo,
      ids.paula,
    ])
    expect(everyone.meta.total).toBe(9)
  })

  // A two-role account matches each of its roles and is listed ONCE — the
  // count too (a JOIN on user_roles would count Mo twice under "all").
  it('filters by role, a two-role account under each of its roles', async () => {
    expect(idsOf(await list('?role=practitioner'))).toEqual([
      ids.mo,
      ids.pablo,
      ids.paula,
    ])
    expect(idsOf(await list('?role=admin'))).toEqual([ids.admin, ids.mo])
    const patients = await list('?role=patient')
    expect(idsOf(patients)).toEqual([ids.zoe, ids.cleo, ids.ana, ids.ben])
    expect(patients.meta.total).toBe(4)
  })

  it('filters by clinic, or by belonging to none', async () => {
    expect(idsOf(await list(`?clinic=${secondId}`))).toEqual([
      ids.ben,
      ids.pablo,
    ])
    expect(idsOf(await list('?clinic=none'))).toEqual([ids.zoe])
    // Main's active members — Zoe left it, Dan is deactivated.
    expect(idsOf(await list(`?clinic=${mainId}`))).toEqual([
      ids.admin,
      ids.cleo,
      ids.ana,
      ids.mo,
      ids.paula,
    ])
  })

  describe('search', () => {
    it('finds a part of a name, ignoring case', async () => {
      expect(idsOf(await list('?search=SHAW'))).toEqual([ids.pablo, ids.paula])
      expect(idsOf(await list('?search=ula'))).toEqual([ids.paula])
    })

    it('finds "first last" as typed', async () => {
      expect(
        idsOf(await list(`?search=${encodeURIComponent('ana lop')}`)),
      ).toEqual([ids.ana])
    })

    it('finds a part of an email address', async () => {
      expect(idsOf(await list('?search=kiwi'))).toEqual([ids.cleo])
    })

    // % and _ are LIKE's wildcards: typed, they are characters — no name or
    // address here holds one, so nothing is found (unescaped, "%" would
    // match everyone).
    it('treats LIKE wildcards literally', async () => {
      expect((await list(`?search=${encodeURIComponent('%')}`)).data).toEqual(
        [],
      )
      expect((await list('?search=_')).data).toEqual([])
    })

    it('treats an empty or blank search as no search', async () => {
      expect(idsOf(await list('?search='))).toEqual(ACTIVE_IN_ORDER())
      expect(idsOf(await list('?search=%20%20'))).toEqual(ACTIVE_IN_ORDER())
    })
  })

  // All filters combine with AND, the count included.
  it('combines every filter', async () => {
    const body = await list(
      `?role=patient&clinic=${mainId}&search=lopez&status=all`,
    )
    expect(idsOf(body)).toEqual([ids.ana])
    expect(body.meta.total).toBe(1)
  })

  describe('refusals', () => {
    it.each([
      ['?role=nurse', 'role must be one of: admin, practitioner, patient'],
      ['?clinic=0', 'clinic must be a clinic id or none'],
      ['?clinic=abc', 'clinic must be a clinic id or none'],
      ['?clinic=1.5', 'clinic must be a clinic id or none'],
      // 10 digits: past Postgres's integer — refused here, not a 500 there.
      ['?clinic=1234567890', 'clinic must be a clinic id or none'],
      ['?status=gone', 'status must be one of: active, deactivated, all'],
      ['?limit=101', 'limit must not be greater than 100'],
      ['?page=0', 'page must not be less than 1'],
      ['?includeInactive=true', 'property includeInactive should not exist'],
    ])('refuses %s', async (query, message) => {
      const res = await admin.get(`/admin/users${query}`)
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([message])
    })

    it('refuses a search longer than 100 characters', async () => {
      const res = await admin.get(`/admin/users?search=${'a'.repeat(101)}`)
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'search must be shorter than or equal to 100 characters',
      ])
    })

    it("refuses a practitioner with the roles guard's message", async () => {
      const res = await practitioner.get('/admin/users')
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([
        'You do not have permission to access this resource',
      ])
    })

    it('refuses a request without a session', async () => {
      const res = await agent().get('/admin/users')
      expect(res.status).toBe(401)
    })
  })

  // GET /users is unchanged: the screens that pick from every account still
  // get the whole list, as an array.
  it('leaves GET /users answering the whole list', async () => {
    const res = await admin.get('/users?includeInactive=true')
    expect(res.status).toBe(200)
    expect(
      (res.body as { id: number }[]).map((u) => u.id).sort((a, b) => a - b),
    ).toEqual([...ACTIVE_IN_ORDER(), ids.dan].sort((a, b) => a - b))
  })
})
