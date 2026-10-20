import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { io, Socket } from 'socket.io-client'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { SessionIoAdapter } from '../src/messaging/session-io.adapter'

// The LIVE half of messaging (Phase 5): the socket's handshake, its rooms,
// the events the server pushes, and what each event answers through its
// acknowledgement. supertest can't do any of this — it has no notion of a
// WebSocket upgrade — so the app listens on a real port and real
// socket.io-client connections talk to it. The REST rules themselves are
// test/messaging.e2e-spec.ts.
//
// The cast: a practitioner (Alex) and a patient (Pat) on Pat's care team,
// with one conversation; another practitioner of the clinic (Uma) on
// nobody's team; the admin. Each test opens its own sockets and closes them.
describe('MessagingGateway (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let baseUrl: string
  let stamp: number
  let clinicId: number
  let adminCookie: string
  type Account = { id: number; email: string; cookie: string }
  let alex: Account
  let pat: Account
  let uma: Account
  let conversationId: number
  const sockets: Socket[] = []

  // Raw HTTP with fetch, not supertest: the tests need the exact Set-Cookie
  // value to hand to socket.io-client, which has no cookie jar of its own.
  async function call(
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = response.headers.get('set-cookie')
    // Only "connect.sid=…" is a Cookie header value; the rest of Set-Cookie
    // (Path, HttpOnly…) is for a browser's jar.
    const newCookie = setCookie ? setCookie.split(';')[0] : undefined
    const json: unknown = await response.json().catch(() => undefined)
    return {
      status: response.status,
      body: json as Record<string, any>,
      cookie: newCookie,
    }
  }

  async function login(email: string, role?: string) {
    const res = await call('POST', '/auth/login', {
      email,
      password: 'password123',
      ...(role ? { role } : {}),
    })
    expect(res.status).toBe(201)
    return res.cookie!
  }

  async function newAccount(
    role: 'practitioner' | 'patient',
    firstName: string,
  ) {
    const email = `ws-${firstName.toLowerCase()}-${stamp}@example.com`
    const res = await call(
      'POST',
      '/users',
      {
        email,
        role,
        firstName,
        lastName: 'Test',
        clinicId,
        ...(role === 'practitioner'
          ? { licenseNumber: `PT-${firstName}-${stamp}` }
          : { dateOfBirth: '1990-01-01' }),
      },
      adminCookie,
    )
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, email)
    return { id: res.body.id as number, email, cookie: await login(email) }
  }

  // A connected socket (or the handshake's error).
  async function connect(cookie?: string): Promise<Socket> {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      // No automatic reconnection: a test that closes a socket on the server
      // side must see it stay closed.
      reconnection: false,
      ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
    })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve())
      socket.on('connect_error', (err) => reject(err))
    })
    return socket
  }

  // An event sent WITH an acknowledgement: resolves with the server's
  // answer ({ ok, data } or { ok: false, status, message }).
  function emitWithAck(socket: Socket, event: string, data: unknown) {
    return socket.timeout(3000).emitWithAck(event, data) as Promise<
      Record<string, any>
    >
  }

  // The next `event` on this socket (fails after 3 s).
  function next(socket: Socket, event: string) {
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${event} within 3 s`)),
        3000,
      )
      socket.once(event, (payload: Record<string, any>) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
  }

  // Everything `event` delivered to this socket during `ms` — for "this
  // socket hears NOTHING" (an absence needs a window; it's checked after a
  // presence elsewhere proved the event went out).
  async function collect(socket: Socket, event: string, ms = 400) {
    const seen: unknown[] = []
    const listener = (payload: unknown) => seen.push(payload)
    socket.on(event, listener)
    await new Promise((resolve) => setTimeout(resolve, ms))
    socket.off(event, listener)
    return seen
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

    sessionPool = new Pool({ connectionString: getDatabaseUrl() })
    const PgSessionStore = connectPgSimple(session)
    const sessionMiddleware = session({
      store: new PgSessionStore({
        pool: sessionPool,
        createTableIfMissing: true,
      }),
      secret: 'e2e-test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
    })
    app.use(sessionMiddleware)
    app.use(passport.initialize())
    app.use(passport.session())
    app.useWebSocketAdapter(new SessionIoAdapter(app, sessionMiddleware))

    await app.init()

    const db = app.get<DrizzleDb>(DRIZZLE)
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    )
    const currentDatabase = rows[0].current_database
    if (currentDatabase !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test".`,
      )
    }
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    // port 0 = any free port: WebSockets need a real listening server.
    await app.listen(0)
    const address = app.getHttpServer().address()
    baseUrl = `http://127.0.0.1:${address.port}`

    stamp = Date.now()
    const bootstrap = await call('POST', '/auth/register-clinic', {
      clinicName: 'WS Clinic',
      clinicEmail: `ws-clinic-${stamp}@example.com`,
      email: `ws-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'WS',
      lastName: 'Admin',
    })
    adminCookie = bootstrap.cookie!
    clinicId = bootstrap.body.clinicId as number

    alex = await newAccount('practitioner', 'Alex')
    pat = await newAccount('patient', 'Pat')
    uma = await newAccount('practitioner', 'Uma')
    expect(
      (await call('POST', `/users/${pat.id}/care-team`, {}, alex.cookie))
        .status,
    ).toBe(201)
    const conversation = await call(
      'POST',
      '/conversations',
      { userId: pat.id },
      alex.cookie,
    )
    conversationId = conversation.body.id as number
  })

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close()
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // === THE HANDSHAKE =========================================================

  describe('the handshake', () => {
    it('refuses a connection with no session', async () => {
      await expect(connect()).rejects.toThrow('Unauthorized')
    })

    // Admins have no messaging (decided 2026-10-20): refused at the door.
    it("refuses an admin's connection", async () => {
      await expect(connect(adminCookie)).rejects.toThrow('Forbidden')
    })

    // The regression the middleware fixed: an event emitted the INSTANT the
    // client sees 'connect' — no delay — must find the user (and the rooms)
    // already set. A test with a pause in between couldn't catch it.
    it('handles an event emitted immediately on connect', async () => {
      const socket = io(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { Cookie: alex.cookie },
      })
      sockets.push(socket)
      const answer = await new Promise<Record<string, any>>(
        (resolve, reject) => {
          socket.on('connect_error', reject)
          socket.on('connect', () => {
            socket
              .timeout(3000)
              .emitWithAck('sendMessage', {
                conversationId,
                messageBody: 'Right on connect',
              })
              .then(resolve, reject)
          })
        },
      )
      expect(answer.ok).toBe(true)
      expect(answer.data.messageBody).toBe('Right on connect')
    })
  })

  // === EVENTS REACH THE PARTICIPANTS =========================================

  describe('events', () => {
    // No "joinConversation" any more: each connection is in its person's
    // room from the handshake, so both participants hear the message, with
    // nothing joined — and someone else hears nothing.
    it('sends through the socket: the ack carries the message, both participants receive it, nobody else does', async () => {
      const alexSocket = await connect(alex.cookie)
      const patSocket = await connect(pat.cookie)
      const umaSocket = await connect(uma.cookie)
      const umaHeard = collect(umaSocket, 'newMessage')
      const alexHears = next(alexSocket, 'newMessage')
      const patHears = next(patSocket, 'newMessage')

      const answer = await emitWithAck(alexSocket, 'sendMessage', {
        conversationId,
        messageBody: 'Hello over WebSocket!',
      })
      expect(answer).toStrictEqual({
        ok: true,
        data: {
          id: answer.data.id,
          conversationId,
          senderId: alex.id,
          messageBody: 'Hello over WebSocket!',
          sentAt: answer.data.sentAt,
          readAt: null,
          deletedAt: null,
        },
      })
      // The sender's own socket too: their other tabs stay in step.
      expect(await alexHears).toStrictEqual(answer.data)
      expect(await patHears).toStrictEqual(answer.data)
      expect(await umaHeard).toEqual([])
    })

    // The two doors behave the same: a message sent through REST is pushed
    // like one sent through the socket (the service emits, not the gateway).
    it('pushes a message sent through REST', async () => {
      const patSocket = await connect(pat.cookie)
      const heard = next(patSocket, 'newMessage')
      const res = await call(
        'POST',
        `/conversations/${conversationId}/messages`,
        { messageBody: 'Through REST' },
        alex.cookie,
      )
      expect(res.status).toBe(201)
      expect((await heard).id).toBe(res.body.id)
    })

    it('pushes a deletion, without the text, to both participants', async () => {
      const alexSocket = await connect(alex.cookie)
      const patSocket = await connect(pat.cookie)
      const sent = await emitWithAck(alexSocket, 'sendMessage', {
        conversationId,
        messageBody: 'To be deleted',
      })
      const patHears = next(patSocket, 'messageDeleted')
      const answer = await emitWithAck(alexSocket, 'deleteMessage', {
        conversationId,
        messageId: sent.data.id,
      })
      expect(answer.ok).toBe(true)
      expect(answer.data.messageBody).toBeNull()
      const event = await patHears
      expect(event).toStrictEqual(answer.data)
    })

    // The sender's "Seen", and the reader's own other tabs.
    it('pushes conversationRead to both participants when the reader marks the thread read', async () => {
      const alexSocket = await connect(alex.cookie)
      const patSocket = await connect(pat.cookie)
      const sent = await emitWithAck(alexSocket, 'sendMessage', {
        conversationId,
        messageBody: 'Please read me',
      })
      const alexHears = next(alexSocket, 'conversationRead')
      const patHears = next(patSocket, 'conversationRead')
      const res = await call(
        'PATCH',
        `/conversations/${conversationId}/read`,
        undefined,
        pat.cookie,
      )
      expect(res.status).toBe(200)
      const event = await alexHears
      expect(event).toStrictEqual({
        conversationId,
        readerId: pat.id,
        readAt: res.body.readAt,
        messageIds: res.body.messageIds,
      })
      expect(event.messageIds).toContain(sent.data.id)
      expect(await patHears).toStrictEqual(event)

      // Nothing new to read: nothing written, and nothing pushed.
      const alexHeard = collect(alexSocket, 'conversationRead')
      await call(
        'PATCH',
        `/conversations/${conversationId}/read`,
        undefined,
        pat.cookie,
      )
      expect(await alexHeard).toEqual([])
    })

    // Archiving is mine alone: my other tabs hear it, the other person
    // doesn't.
    it('pushes conversationArchived to my own connections only', async () => {
      const alexSocket = await connect(alex.cookie)
      const patSocket = await connect(pat.cookie)
      const patHeard = collect(patSocket, 'conversationArchived')
      const alexHears = next(alexSocket, 'conversationArchived')
      const res = await call(
        'PATCH',
        `/conversations/${conversationId}/archive`,
        undefined,
        alex.cookie,
      )
      expect(await alexHears).toStrictEqual({
        conversationId,
        archivedAt: res.body.archivedAt,
      })
      expect(await patHeard).toEqual([])
      await call(
        'PATCH',
        `/conversations/${conversationId}/unarchive`,
        undefined,
        alex.cookie,
      )
    })
  })

  // === WHAT AN EVENT ANSWERS WHEN REFUSED =====================================

  describe('refusals, through the acknowledgement', () => {
    // The gateway's own ValidationPipe — the global one is HTTP-only, and
    // before Phase 5 the socket took its payloads as they came.
    it.each([
      ['a blank message', { messageBody: '   ' }, ["A message can't be blank"]],
      [
        'a message too long',
        { messageBody: 'a'.repeat(5001) },
        ['A message can be at most 5000 characters'],
      ],
      [
        'an unknown field',
        { messageBody: 'Hi', extra: true },
        ['property extra should not exist'],
      ],
    ])(
      'answers 400 to %s, and stores nothing',
      async (_name, payload, message) => {
        const socket = await connect(alex.cookie)
        const before = await sessionPool.query(
          'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1',
          [conversationId],
        )
        const answer = await emitWithAck(socket, 'sendMessage', {
          conversationId,
          ...payload,
        })
        expect(answer).toStrictEqual({ ok: false, status: 400, message })
        const after = await sessionPool.query(
          'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1',
          [conversationId],
        )
        expect(after.rows[0].n).toBe(before.rows[0].n)
      },
    )

    it('answers 400 to a conversation id sent as text', async () => {
      const socket = await connect(alex.cookie)
      const answer = await emitWithAck(socket, 'sendMessage', {
        conversationId: String(conversationId),
        messageBody: 'Hi',
      })
      expect(answer.ok).toBe(false)
      expect(answer.status).toBe(400)
    })

    it('answers 404 to someone outside the conversation — and keeps the old `exception` event for a client sending no ack', async () => {
      const socket = await connect(uma.cookie)
      const answer = await emitWithAck(socket, 'sendMessage', {
        conversationId,
        messageBody: 'Should not land',
      })
      expect(answer).toStrictEqual({
        ok: false,
        status: 404,
        message: [`Conversation ${conversationId} not found`],
      })

      const exception = next(socket, 'exception')
      socket.emit('deleteMessage', { conversationId, messageId: 1 })
      expect(await exception).toStrictEqual({
        status: 404,
        message: [`Conversation ${conversationId} not found`],
      })
    })
  })

  // === A SESSION THAT ENDS OR CHANGES ROLE ====================================

  describe('when the session ends or changes role', () => {
    // A socket is authenticated once, at its handshake. Logging out must
    // close it — and ONLY that session's sockets: Alex's other login (a
    // phone, say) stays connected.
    it("closes the logged-out session's sockets, not another session's", async () => {
      const laptopCookie = await login(alex.email)
      const phoneCookie = await login(alex.email)
      const laptop = await connect(laptopCookie)
      const phone = await connect(phoneCookie)
      const closed = new Promise<string>((resolve) =>
        laptop.on('disconnect', (reason) => resolve(reason)),
      )
      expect(
        (await call('POST', '/auth/logout', undefined, laptopCookie)).status,
      ).toBe(204)
      // 'io server disconnect' = the SERVER closed it (not a network drop).
      expect(await closed).toBe('io server disconnect')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(phone.connected).toBe(true)
      // And the logged-out cookie can't open a new one.
      await expect(connect(laptopCookie)).rejects.toThrow('Unauthorized')
    })

    // Morgan's case: one person, practitioner AND patient. A connection
    // belongs to the role it was opened in — the practitioner socket hears
    // nothing of a conversation where she is the patient — and switching
    // role closes it; a new connection with the new session hears it.
    it('keeps roles apart, and closes the old role’s sockets on a role switch', async () => {
      const dana = await newAccount('practitioner', 'Dana')
      expect(
        (
          await call(
            'POST',
            `/users/${dana.id}/roles`,
            { role: 'patient', dateOfBirth: '1985-05-05' },
            adminCookie,
          )
        ).status,
      ).toBe(201)
      expect(
        (await call('POST', `/users/${dana.id}/care-team`, {}, alex.cookie))
          .status,
      ).toBe(201)
      const asDanaPatient = await call(
        'POST',
        '/conversations',
        { userId: dana.id },
        alex.cookie,
      )
      const danaConversation = asDanaPatient.body.id as number

      const practitionerCookie = await login(dana.email, 'practitioner')
      const asPractitioner = await connect(practitionerCookie)
      const heardAsPractitioner = collect(asPractitioner, 'newMessage')
      const alexSocket = await connect(alex.cookie)
      const alexHears = next(alexSocket, 'newMessage')
      await emitWithAck(alexSocket, 'sendMessage', {
        conversationId: danaConversation,
        messageBody: 'For Dana the patient',
      })
      await alexHears
      expect(await heardAsPractitioner).toEqual([])

      const closed = new Promise<string>((resolve) =>
        asPractitioner.on('disconnect', (reason) => resolve(reason)),
      )
      const switched = await call(
        'POST',
        '/auth/switch-role',
        { role: 'patient' },
        practitionerCookie,
      )
      expect(switched.status).toBe(201)
      expect(await closed).toBe('io server disconnect')

      // The switch regenerated the session: a new cookie, a new socket in
      // the patient's room.
      const asPatient = await connect(switched.cookie)
      const hears = next(asPatient, 'newMessage')
      await emitWithAck(alexSocket, 'sendMessage', {
        conversationId: danaConversation,
        messageBody: 'Now you hear me',
      })
      expect((await hears).messageBody).toBe('Now you hear me')
    })
  })
})
