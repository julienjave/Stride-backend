// Same reason this exists in every e2e file — Jest never auto-loads .env,
// and AppModule's DrizzleModule needs POSTGRES_* the moment it's built.
import 'dotenv/config'
import { Test } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import passport from 'passport'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'

// The rate limits, proven to work (decided 2026-10-15, after Phase 4 step
// 1b). Every other e2e file runs with them OFF (test/support/e2e-env.ts) —
// so without this file, removing the limits would leave every test green.
// HIPAA asks for protection against password guessing; this is its proof.
//
// Each test builds its OWN app: the throttler counts in memory, per app, so
// a fresh app starts every count at zero — and RATE_LIMITS is read when the
// app is built (config/rate-limits.ts, forRootAsync's factory), so setting
// it just before decides for that app. Nothing here writes to the database:
// the logins are for an account that doesn't exist (401 each).
//
// The request logger is SILENCED here (PARAMS_PROVIDER_TOKEN is the options
// object nestjs-pino's LoggerModule is built from). Outside production, each
// app's logger writes through pino-pretty in a separate worker thread, and
// with several apps in one file that thread sometimes kept Jest from exiting
// — the tests passed, then the run never ended (about one run in three).
// Silent pino starts no thread. Nothing here reads the logs.
describe('Rate limits (e2e)', () => {
  let app: INestApplication

  async function buildApp(rateLimits: 'on' | 'off') {
    process.env.RATE_LIMITS = rateLimits
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue(new InMemoryEmailTransport())
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue({ pinoHttp: { level: 'silent' } })
      .compile()
    const built = moduleRef.createNestApplication()
    built.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    // The login route's guard runs passport's local strategy.
    built.use(passport.initialize())
    await built.init()
    return built
  }

  afterEach(async () => {
    await app?.close()
  })

  afterAll(() => {
    // Back to what every e2e file starts with.
    process.env.RATE_LIMITS = 'off'
  })

  const login = () =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })

  // Requests are sent one after another (not Promise.all): the count is
  // what's under test, and the order of the answers must be the order sent.
  async function statuses(send: () => request.Test, times: number) {
    const result: number[] = []
    for (let i = 0; i < times; i++) result.push((await send()).status)
    return result
  }

  // One app for both limits — each route has its own count, so exhausting
  // the login's allowance leaves an ordinary route's whole 60 untouched
  // (which this test also proves).
  it('refuses the 6th login and the 61st ordinary request in a minute with 429', async () => {
    app = await buildApp('on')

    // @Throttle on AuthController.login: 5 a minute per IP (supertest always
    // comes from 127.0.0.1). The 6th is refused BEFORE the password is even
    // checked — the throttler is a global guard, it runs first.
    expect(await statuses(login, 6)).toEqual([401, 401, 401, 401, 401, 429])

    // The global limit, on a route with no @Throttle of its own — its count
    // untouched by the logins above.
    const setupStatus = () =>
      request(app.getHttpServer()).get('/auth/setup-status')
    const answers = await statuses(setupStatus, 61)
    expect(answers.slice(0, 60).every((status) => status === 200)).toBe(true)
    expect(answers[60]).toBe(429)
  })

  // The two forms that check the CURRENT password of a signed-in account
  // (changing the email, changing the password) keep the sign-in limit: from
  // a stolen session, they must not become a way to guess the password. The
  // throttler is a global guard, so it runs before the session guard — even
  // without a session, the 6th request is counted and refused. Each route
  // its own count.
  it('refuses the 6th request in a minute to each current-password route', async () => {
    app = await buildApp('on')
    const server = () => request(app.getHttpServer())

    const changePassword = () =>
      server()
        .post('/auth/password')
        .send({ currentPassword: 'x', newPassword: 'a-new-password' })
    expect(await statuses(changePassword, 6)).toEqual([
      401, 401, 401, 401, 401, 429,
    ])

    const changeEmail = () =>
      server()
        .post('/auth/email-change')
        .send({ newEmail: 'new@example.com', currentPassword: 'x' })
    expect(await statuses(changeEmail, 6)).toEqual([
      401, 401, 401, 401, 401, 429,
    ])
  })

  // The records export (decisions §20) reads a whole record and draws a PDF
  // on each request — far heavier than an ordinary read — so it keeps 5 a
  // minute too. Counted before the session guard, like the routes above.
  it('refuses the 6th records export in a minute', async () => {
    app = await buildApp('on')
    const exportRecords = () =>
      request(app.getHttpServer()).get('/records-export')

    expect(await statuses(exportRecords, 6)).toEqual([
      401, 401, 401, 401, 401, 429,
    ])
  })

  // And the switch the other suites rely on: off means never counted — the
  // login limit (an @Throttle override) included.
  it('counts nothing when the limits are off', async () => {
    app = await buildApp('off')
    expect(await statuses(login, 7)).toEqual(Array(7).fill(401))
  })
})
