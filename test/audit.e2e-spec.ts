// Same reason this exists in main.ts and scripts/seed-exercises.ts — Jest,
// like ts-node, never auto-loads .env. AppModule's DrizzleModule needs
// POSTGRES_* in process.env the moment Test.createTestingModule() below
// tries to construct it, so this has to be the very first thing that runs.
import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { getDatabaseUrl } from '../src/config/database-url';
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider';

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
describe('Audit (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;

  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAgent = () => request.agent(app.getHttpServer());

  let admin: ReturnType<typeof adminAgent>;
  let practitioner: ReturnType<typeof practitionerAgent>;
  let adminId: number;

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
    app.use(
      session({
        store: new PgSessionStore({ pool: sessionPool, createTableIfMissing: true }),
        secret: 'e2e-test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());

    await app.init();

    // A hard safety check, not just a naming convention to remember —
    // refuses to proceed at all unless genuinely connected to the
    // dedicated test database. Without this, accidentally running e2e
    // tests via the wrong npm script (plain `test:e2e` instead of
    // `test:e2e:fresh`) would TRUNCATE the real dev database with no
    // warning, since nothing else in this file would notice the difference.
    const db = app.get<DrizzleDb>(DRIZZLE);
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    );
    const currentDatabase = rows[0].current_database;
    if (currentDatabase !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test". ` +
          'Did you run this via `npm run test:e2e:fresh` (not plain `test:e2e`)?',
      );
    }

    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query('TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE');

    admin = adminAgent();
    practitioner = practitionerAgent();

    const stamp = Date.now();

    // Bootstrapping itself generates a REGISTER_CLINIC audit entry, and the
    // req.login() that follows generates no LOGIN_SUCCESS entry (register
    // flows log the caller in directly, without going through
    // validateUser()) — logging in separately below is what actually
    // produces LOGIN_SUCCESS entries to filter on.
    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Audit E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Audit',
      lastName: 'Admin',
    });
    if (clinicRes.status !== 201) {
      throw new Error(`Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`);
    }
    adminId = clinicRes.body.id;

    // A second, real login (not the auto-login from register-clinic) —
    // this is what actually exercises validateUser()'s LOGIN_SUCCESS path.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `admin-${stamp}@example.com`, password: 'password123' });

    await admin.post('/users').send({
      email: `practitioner-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Audit',
      lastName: 'Practitioner',
      licenseNumber: `PT-${stamp}`,
    });
    await practitioner.post('/auth/login').send({
      email: `practitioner-${stamp}@example.com`,
      password: 'password123',
    });
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app.getHttpServer()).get('/audit-logs');
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin from reading the audit log', async () => {
    const res = await practitioner.get('/audit-logs');
    expect(res.status).toBe(403);
  });

  // res.body.data, not res.body directly — AuditController.findAll() now
  // returns { data: [...], meta: {...} } since pagination was added, not a
  // plain array. Only these four tests below needed updating; the two above
  // only ever checked res.status, so pagination's shape change never touched them.
  it('lets an admin read the audit log, including the REGISTER_CLINIC entry from bootstrap', async () => {
    const res = await admin.get('/audit-logs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((entry: any) => entry.action === 'REGISTER_CLINIC')).toBe(true);
  });

  it('filters by action', async () => {
    const res = await admin.get('/audit-logs').query({ action: 'LOGIN_SUCCESS' });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((entry: any) => entry.action === 'LOGIN_SUCCESS')).toBe(true);
  });

  it('filters by performedBy', async () => {
    const res = await admin.get('/audit-logs').query({ performedBy: adminId });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((entry: any) => entry.performedBy === adminId)).toBe(true);
  });

  it('filters by entityType', async () => {
    const res = await admin.get('/audit-logs').query({ entityType: 'clinics' });
    expect(res.status).toBe(200);
    expect(res.body.data.every((entry: any) => entry.entityType === 'clinics')).toBe(true);
  });
});