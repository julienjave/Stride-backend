import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { getDatabaseUrl } from '../src/config/database-url';
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider';
import { SessionIoAdapter } from '../src/messaging/session-io.adapter';

// Named distinctly from any REST-focused messaging.e2e-spec.ts — this file
// covers ONLY the live WebSocket behavior (handshake auth, room joins,
// real-time broadcast), which supertest cannot exercise at all: it has no
// concept of a WebSocket upgrade. A real socket.io-client, connecting to a
// genuinely listening server, is required here specifically.
describe('MessagingGateway (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;
  let baseUrl: string;
  let adminCookie: string;
  // A single shared practitioner/patient/conversation, set up ONCE in
  // beforeAll and reused (read-only) by every test below that just needs
  // "some real, authenticated participant of some real conversation" — see
  // the comment on POST /auth/login's rate limit further down for why this
  // matters, not just for speed.
  let sharedPractitionerCookie: string;
  let sharedConversationId: number;

  // Handles the raw HTTP calls used to set up test data. Uses plain fetch(),
  // not supertest, specifically because the login calls below need direct,
  // unambiguous access to the real Set-Cookie response header — the exact
  // thing that has to be handed to socket.io-client explicitly, since it has
  // no automatic cookie-jar behavior linking it to a prior HTTP login call
  // the way chained supertest requests do.
  async function post(path: string, body: unknown, cookie?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    // Only the "connect.sid=..." portion is usable as a Cookie header value —
    // the rest of a Set-Cookie string (Path, HttpOnly, Expires, etc.) is
    // metadata for a BROWSER's cookie jar to interpret, not something to
    // forward verbatim.
    const cookieValue = setCookie ? setCookie.split(';')[0] : undefined;
    const json = await response.json().catch(() => undefined);
    return { status: response.status, body: json, cookie: cookieValue };
  }

  async function get(path: string, cookie: string) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
    return response.json();
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    sessionPool = new Pool({ connectionString: getDatabaseUrl() });
    const PgSessionStore = connectPgSimple(session);
    const sessionMiddleware = session({
      store: new PgSessionStore({ pool: sessionPool, createTableIfMissing: true }),
      secret: 'e2e-test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
    });
    app.use(sessionMiddleware);
    app.use(passport.initialize());
    app.use(passport.session());
    app.useWebSocketAdapter(new SessionIoAdapter(app, sessionMiddleware));

    await app.init();

    const db = app.get<DrizzleDb>(DRIZZLE);
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    );
    const currentDatabase = rows[0].current_database;
    if (currentDatabase !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test".`,
      );
    }
    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query('TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE');

    // port 0 = let the OS assign a free port. WebSocket connections need a
    // REAL, listening network server, unlike the REST e2e tests, which can
    // drive supertest against the app instance without necessarily binding
    // a real port at all.
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    // --- Shared scaffolding for every test below ---
    //
    // Two real constraints shape this setup, both learned the hard way
    // while writing this file:
    //
    // 1. POST /auth/register-clinic is a ONE-TIME bootstrap — it throws
    //    ForbiddenException the instant any admin already exists anywhere
    //    in the database (see AuthService.registerClinic). It can only
    //    ever be called ONCE per test run, here.
    // 2. POST /auth/login is throttled to 5 requests per 60 seconds PER IP
    //    (@Throttle on AuthController.login) — a real, deliberate
    //    brute-force protection, not a bug. Every test in this file shares
    //    127.0.0.1, so their login calls all draw from the SAME budget.
    //    That's why this is a single shared practitioner/patient/
    //    conversation set up once here (2 logins total), rather than each
    //    test minting its own fresh pair (which independently worked, but
    //    blew through the 5/60s budget once enough tests did it in the
    //    same run). Only the "no relationship to this conversation" test
    //    below needs one additional, genuinely distinct identity, and logs
    //    in exactly once for it — 3 logins total across the whole file.
    const stamp = Date.now();
    const bootstrapRes = await post('/auth/register-clinic', {
      clinicName: 'WS Bootstrap Clinic',
      clinicEmail: `ws-bootstrap-clinic-${stamp}@example.com`,
      email: `ws-bootstrap-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'WS',
      lastName: 'Admin',
    });
    adminCookie = bootstrapRes.cookie!;
    const clinicId = bootstrapRes.body.clinicId;

    await post(
      '/users',
      {
        email: `ws-practitioner-${stamp}@example.com`,
        password: 'password123',
        role: 'practitioner',
        firstName: 'WS',
        lastName: 'Practitioner',
        licenseNumber: `PT-WS-${stamp}`,
        clinicId,
      },
      adminCookie,
    );
    const practitionerLogin = await post('/auth/login', {
      email: `ws-practitioner-${stamp}@example.com`,
      password: 'password123',
    });
    sharedPractitionerCookie = practitionerLogin.cookie!;

    await post(
      '/users',
      {
        email: `ws-patient-${stamp}@example.com`,
        password: 'password123',
        role: 'patient',
        firstName: 'WS',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
        clinicId,
      },
      adminCookie,
    );
    const patientLogin = await post('/auth/login', {
      email: `ws-patient-${stamp}@example.com`,
      password: 'password123',
    });
    const patientCookie = patientLogin.cookie!;
    const patientMe = await get('/auth/me', patientCookie);

    const conversationRes = await post(
      '/conversations',
      { userId: patientMe.id },
      sharedPractitionerCookie,
    );
    sharedConversationId = conversationRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects a socket connection with no session cookie', async () => {
    const socket: Socket = io(baseUrl, { transports: ['websocket'] });

    // Auth now runs as real Socket.IO middleware (server.use(), registered
    // from afterInit) rather than the old handleConnection lifecycle hook —
    // a rejected socket never completes the handshake at all, so 'connect'
    // must never fire here, only 'connect_error'.
    const outcome = await new Promise<'connected' | 'rejected'>((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', () => resolve('rejected'));
    });

    expect(outcome).toBe('rejected');
    expect(socket.connected).toBe(false);
    socket.close();
  });

  it('authenticates via the session cookie and broadcasts a message to a room', async () => {
    // extraHeaders is socket.io-client's way of attaching a raw Cookie
    // header to the initial handshake request — this is what
    // SessionIoAdapter's wrapped session middleware then reads.
    const socket: Socket = io(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: sharedPractitionerCookie },
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (err) => reject(err));
    });

    socket.emit('joinConversation', { conversationId: sharedConversationId });

    const receivedMessage = new Promise<{ messageBody: string }>((resolve) => {
      socket.on('newMessage', (msg) => resolve(msg));
    });

    // A small delay to let the join actually register server-side before
    // sending — joining a room and sending are two separate emitted events,
    // with no built-in guarantee of ordering completion on the server.
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.emit('sendMessage', { conversationId: sharedConversationId, messageBody: 'Hello over WebSocket!' });

    const received = await receivedMessage;
    expect(received.messageBody).toBe('Hello over WebSocket!');

    socket.close();
  });

  it('rejects joinConversation from an authenticated socket with no relationship to that conversation, with the real WsHttpExceptionFilter error', async () => {
    const stamp = Date.now();

    // A practitioner with no clinic membership at all — genuinely
    // authenticated (a valid session and role), but no relationship
    // whatsoever to the shared conversation above. This is the one place
    // in the file that needs a genuinely distinct identity (and the one
    // additional login call beyond the shared setup's two).
    await post(
      '/users',
      {
        email: `ws-unrelated-practitioner-${stamp}@example.com`,
        password: 'password123',
        role: 'practitioner',
        firstName: 'WS',
        lastName: 'Unrelated',
        licenseNumber: `PT-WSU-${stamp}`,
      },
      adminCookie,
    );
    const unrelatedLogin = await post('/auth/login', {
      email: `ws-unrelated-practitioner-${stamp}@example.com`,
      password: 'password123',
    });
    const unrelatedCookie = unrelatedLogin.cookie!;

    const socket: Socket = io(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: unrelatedCookie },
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (err) => reject(err));
    });

    // The whole point of WsHttpExceptionFilter: MessagingService throws an
    // ordinary ForbiddenException (assertParticipant), same as the REST API
    // would, and the filter must translate it into a real, specific
    // 'exception' payload — not a generic "an error occurred" message.
    const exception = new Promise<{ status: number; message: string }>((resolve) => {
      socket.on('exception', (err) => resolve(err));
    });

    socket.emit('joinConversation', { conversationId: sharedConversationId });

    const err = await exception;
    expect(err.status).toBe(403);
    expect(err.message).toBe('You are not a participant in this conversation');

    socket.close();
  });

  // The specific regression guard for the handleConnection-based race
  // condition this gateway used to have: a socket that emits an event the
  // INSTANT 'connect' fires client-side, with zero artificial delay. Under
  // the old handleConnection lifecycle hook, the connection was considered
  // "open" (and further client events deliverable) before the hook's own
  // `await usersService.findOne(...)` had resolved, so socket.data.user
  // could still be undefined when this event's handler ran. Genuine
  // Socket.IO middleware (server.use(), see afterInit in messaging.gateway.ts)
  // fully resolves before the client's 'connect' event fires at all, so
  // this must now succeed cleanly. A test with any delay between connecting
  // and emitting — like the "authenticates..." test above, which
  // deliberately waits 100ms before sendMessage — would never actually
  // catch a regression of this specific bug.
  //
  // Verification is deliberately split from the regression trigger: the
  // trigger is emitting 'joinConversation' with zero delay after 'connect'
  // (that's the only thing that has to be immediate to actually exercise
  // the old bug). Confirming the join succeeded is a SEPARATE step, done
  // after a short grace period — joinConversation and a later sendMessage
  // are independent async handlers with no ordering guarantee between them,
  // so immediately firing both back-to-back would make the room-broadcast
  // check below flaky (the sender's own socket.join() might not have
  // resolved yet when its own message broadcasts), which has nothing to do
  // with the auth race condition this test exists to catch.
  it('handles a joinConversation event emitted immediately on connect, with no delay', async () => {
    const socket: Socket = io(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: sharedPractitionerCookie },
    });

    const exceptions: unknown[] = [];
    socket.on('exception', (err) => exceptions.push(err));

    // The regression trigger: emit 'joinConversation' the instant 'connect'
    // fires, with no setTimeout/await in between — the exact condition
    // that exposed the old handleConnection-based race.
    await new Promise<void>((resolve, reject) => {
      socket.on('connect_error', (err) => reject(err));
      socket.on('connect', () => {
        socket.emit('joinConversation', { conversationId: sharedConversationId });
        resolve();
      });
    });

    // Verification is a SEPARATE step, given a grace period to actually
    // settle server-side — this delay is only about confirming the
    // OUTCOME, not part of the regression-triggering condition above.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exceptions).toEqual([]);

    const receivedMessage = new Promise<{ messageBody: string }>((resolve) => {
      socket.on('newMessage', (msg) => resolve(msg));
    });
    socket.emit('sendMessage', { conversationId: sharedConversationId, messageBody: 'Immediate join, then confirmed' });

    const received = await receivedMessage;
    expect(received.messageBody).toBe('Immediate join, then confirmed');

    socket.close();
  });
});
