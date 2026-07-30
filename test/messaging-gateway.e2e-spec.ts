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
    await db.execute(sql`TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE`);

    // port 0 = let the OS assign a free port. WebSocket connections need a
    // REAL, listening network server, unlike the REST e2e tests, which can
    // drive supertest against the app instance without necessarily binding
    // a real port at all.
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects a socket connection with no session cookie', async () => {
    const socket: Socket = io(baseUrl, { transports: ['websocket'] });

    const disconnected = await new Promise<boolean>((resolve) => {
      socket.on('connect', () => {
        // handleConnection runs its own socket.disconnect() when there's no
        // valid session — give it a moment to actually take effect.
        setTimeout(() => resolve(!socket.connected), 300);
      });
      socket.on('connect_error', () => resolve(true));
    });

    expect(disconnected).toBe(true);
    socket.close();
  });

  it('authenticates via the session cookie and broadcasts a message to a room', async () => {
    const stamp = Date.now();

    const clinicRes = await post('/auth/register-clinic', {
      clinicName: 'WS Test Clinic',
      clinicEmail: `ws-clinic-${stamp}@example.com`,
      email: `ws-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'WS',
      lastName: 'Admin',
    });
    const clinicId = clinicRes.body.clinicId;
    const adminCookie = clinicRes.cookie!;

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
    const practitionerCookie = practitionerLogin.cookie!;

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
      practitionerCookie,
    );
    const conversationId = conversationRes.body.id;

    // extraHeaders is socket.io-client's way of attaching a raw Cookie
    // header to the initial handshake request — this is what
    // SessionIoAdapter's wrapped session middleware then reads.
    const socket: Socket = io(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: practitionerCookie },
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (err) => reject(err));
    });

    socket.emit('joinConversation', { conversationId });

    const receivedMessage = new Promise<{ messageBody: string }>((resolve) => {
      socket.on('newMessage', (msg) => resolve(msg));
    });

    // A small delay to let the join actually register server-side before
    // sending — joining a room and sending are two separate emitted events,
    // with no built-in guarantee of ordering completion on the server.
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.emit('sendMessage', { conversationId, messageBody: 'Hello over WebSocket!' });

    const received = await receivedMessage;
    expect(received.messageBody).toBe('Hello over WebSocket!');

    socket.close();
  });
});