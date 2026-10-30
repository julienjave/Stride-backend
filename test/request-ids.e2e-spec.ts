// Same reason this exists in every e2e file — Jest never auto-loads .env,
// and AppModule's DrizzleModule needs POSTGRES_* the moment it's built.
import 'dotenv/config'
import { Test } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'

// Request ids through the whole app (decisions §32): every answer — a
// success, a refusal, an unknown route, a body the parser refuses — carries
// an `X-Request-Id` the SERVER made, and every error body repeats it as
// `requestId`: the reference an error screen shows, leading to the log
// lines of that request. (What the lines themselves say is
// src/observability/logger-options.spec.ts's, which reads them back.)
//
// The app's OWN logger settings, untouched (some files replace them to
// silence the logger): genReqId is what's under test, and only AppModule's
// real LoggerModule proves it is wired in. One app in the file, so
// pino-pretty's worker thread is no trouble (rate-limits.e2e-spec.ts says
// when it is). Nothing here touches the database.

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('Request ids (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
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
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  const server = () => request(app.getHttpServer())

  it('gives a successful answer a server-made id, ignoring one the client sent', async () => {
    const first = await server()
      .get('/auth/setup-status')
      .set('X-Request-Id', 'chosen-by-the-client')
      .expect(200)
    const second = await server().get('/auth/setup-status').expect(200)
    expect(first.headers['x-request-id']).toMatch(UUID)
    expect(second.headers['x-request-id']).toMatch(UUID)
    expect(first.headers['x-request-id']).not.toBe(
      second.headers['x-request-id'],
    )
  })

  // A refusal (here the validation pipe's: no email): the body names the
  // same id as the header — the request the logger knew.
  it('repeats the id in the body of a refusal', async () => {
    const response = await server()
      .post('/auth/forgot-password')
      .send({})
      .expect(400)
    const body = response.body as { requestId: string }
    expect(body.requestId).toMatch(UUID)
    expect(body.requestId).toBe(response.headers['x-request-id'])
  })

  it('does the same for an address that matches no route', async () => {
    const response = await server().get('/no-such-route?search=x').expect(404)
    const body = response.body as { requestId: string }
    expect(body.requestId).toMatch(UUID)
    expect(body.requestId).toBe(response.headers['x-request-id'])
  })

  // A body that isn't JSON is refused by the body parser — the first thing
  // that reads the request. Its answer still has its reference.
  it('and for a body the parser refuses', async () => {
    const response = await server()
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "jane@example.com", ')
      .expect(400)
    const body = response.body as { requestId: string }
    expect(body.requestId).toMatch(UUID)
    expect(body.requestId).toBe(response.headers['x-request-id'])
  })
})
