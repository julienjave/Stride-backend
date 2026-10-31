// Same reason this exists in every e2e file — Jest never auto-loads .env,
// and AppModule's DrizzleModule needs POSTGRES_* the moment it's built.
import 'dotenv/config'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Test } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { TEST_PASSWORD } from './support/accounts'

// POST /monitoring, the tunnel for the browser's error reports (decisions
// §32), through the whole app — and a stand-in for GlitchTip: a plain HTTP
// server on a random port that records what reaches it. The frontend
// project's DSN points at it, exactly as in production it points at
// `glitchtip:8000` on Docker's network: the tunnel forwards to the host IN
// the DSN.
//
// What a browser could put in a report is planted in every envelope below —
// the page's address with a search, a click on a patient's name, a console
// line, an email, the user the page claims, its headers — and the test reads
// what GlitchTip received.

interface Received {
  url: string
  headers: IncomingHttpHeaders
  body: string
}

describe('Monitoring tunnel (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let glitchtip: Server
  let glitchtipStatus = 200
  const received: Received[] = []
  let dsn: string
  let adminId: number
  const previousDsn = process.env.SENTRY_BROWSER_DSN
  const stamp = Date.now()
  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>

  beforeAll(async () => {
    glitchtip = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.statusCode = glitchtipStatus
        res.end('{}')
      })
    })
    await new Promise<void>((resolve) =>
      glitchtip.listen(0, '127.0.0.1', resolve),
    )
    const { port } = glitchtip.address() as AddressInfo
    dsn = `http://browserkey@127.0.0.1:${port}/2`
    // Read when the app is built (the controller's settings).
    process.env.SENTRY_BROWSER_DSN = dsn

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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

    // A signed-in account: the clinic's founding admin.
    admin = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Main Clinic',
      clinicEmail: `monitoring-${stamp}@example.com`,
      email: `monitoring-admin-${stamp}@example.com`,
      password: TEST_PASSWORD,
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    adminId = bootstrap.body.id as number
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
    await new Promise((resolve) => glitchtip.close(resolve))
    if (previousDsn === undefined) delete process.env.SENTRY_BROWSER_DSN
    else process.env.SENTRY_BROWSER_DSN = previousDsn
  })

  beforeEach(() => {
    received.length = 0
    glitchtipStatus = 200
  })

  // A browser SDK's envelope, with everything a page could put in it.
  function envelope(
    options: { dsn?: string; extraItems?: string[] } = {},
  ): string {
    const event = {
      event_id: 'e1',
      platform: 'javascript',
      level: 'error',
      exception: {
        values: [
          { type: 'TypeError', value: 'x is undefined for jane@example.com' },
        ],
      },
      request: {
        url: 'http://localhost:5173/admin/users?search=Jane%20Doe',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'http://localhost:5173/x?search=Jane',
        },
      },
      user: { id: '999', email: 'jane@example.com', ip_address: '203.0.113.7' },
      breadcrumbs: [
        { category: 'ui.click', message: "button 'Open Pat Lee'" },
        { category: 'console', message: 'Pat Lee loaded' },
        {
          category: 'navigation',
          data: { from: '/patients?search=Pat', to: '/patients/7' },
        },
      ],
      extra: { note: 'My knee still hurts' },
      tags: { requestId: 'r-1', patient: 'Pat Lee' },
    }
    return [
      JSON.stringify({
        event_id: 'e1',
        sent_at: '2031-03-04T10:00:00.000Z',
        dsn: options.dsn ?? dsn,
      }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
      ...(options.extraItems ?? []),
    ].join('\n')
  }

  const send = (
    who: ReturnType<typeof agent>,
    body: string,
    type = 'text/plain;charset=UTF-8',
  ) => who.post('/monitoring').set('Content-Type', type).send(body)

  it("forwards the event to the project's envelope address, scrubbed, with the session's user", async () => {
    await send(admin, envelope()).expect(200)

    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/api/2/envelope/')
    expect(received[0].headers['content-type']).toBe(
      'application/x-sentry-envelope',
    )
    expect(received[0].headers['x-sentry-auth']).toBe(
      'Sentry sentry_version=7, sentry_key=browserkey, sentry_client=stride-monitoring-tunnel/1.0',
    )
    const [, , payload] = received[0].body.split('\n')
    expect(JSON.parse(payload)).toStrictEqual({
      event_id: 'e1',
      platform: 'javascript',
      level: 'error',
      exception: {
        values: [{ type: 'TypeError', value: 'x is undefined for [email]' }],
      },
      request: { url: 'http://localhost:5173/admin/users' },
      user: { id: String(adminId) },
      breadcrumbs: [
        {
          category: 'navigation',
          data: { from: '/patients', to: '/patients/7' },
        },
      ],
      tags: { requestId: 'r-1' },
    })
    expect(received[0].body).not.toMatch(
      /jane|Jane|Pat Lee|knee|Mozilla|203\.0|"999"/,
    )
  })

  // Signed out (an error on the sign-in page): no user at all, whatever the
  // page claims.
  it('sends no user for a visitor who is not signed in', async () => {
    await send(request(app.getHttpServer()), envelope()).expect(200)
    const payload = JSON.parse(received[0].body.split('\n')[2]) as object
    expect(payload).not.toHaveProperty('user')
  })

  it('accepts Sentry’s own content type too', async () => {
    await send(admin, envelope(), 'application/x-sentry-envelope').expect(200)
    expect(received).toHaveLength(1)
  })

  // Sessions, client reports… are dropped; with no event left, nothing is
  // forwarded — and the browser still gets its 200.
  it('forwards nothing when no error event is in the envelope', async () => {
    const body = [
      JSON.stringify({ dsn }),
      JSON.stringify({ type: 'session' }),
      JSON.stringify({ sid: 's', did: 'jane@example.com' }),
    ].join('\n')
    await send(admin, body).expect(200)
    expect(received).toHaveLength(0)
  })

  it('refuses another project, and forwards nothing (not an open relay)', async () => {
    const res = await send(
      admin,
      envelope({ dsn: 'http://someonekey@sentry.io/77' }),
    ).expect(403)
    expect(res.body.message).toEqual([
      'This server only accepts reports for its own project',
    ])
    expect(received).toHaveLength(0)
  })

  it('refuses a body that is not an envelope', async () => {
    const res = await send(admin, 'hello').expect(400)
    expect(res.body.message).toEqual(['The body must be a Sentry envelope'])
  })

  it('refuses JSON and forms (another content type)', async () => {
    const res = await admin.post('/monitoring').send({ a: 1 }).expect(415)
    expect(res.body.message).toEqual(['The body must be a Sentry envelope'])
  })

  it('refuses a body over 256 KB, forwarding nothing', async () => {
    const res = await send(
      admin,
      envelope() + '\n' + 'x'.repeat(256 * 1024),
    ).expect(413)
    expect(res.body.message).toEqual([
      'An error report can be at most 262144 bytes',
    ])
    expect(received).toHaveLength(0)
  })

  it('answers 502 when GlitchTip refuses it', async () => {
    glitchtipStatus = 503
    const res = await send(admin, envelope()).expect(502)
    expect(res.body.message).toEqual(['The report could not be passed on'])
  })
})
