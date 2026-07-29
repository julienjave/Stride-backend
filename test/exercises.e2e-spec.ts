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
describe('Exercises (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    // Same session setup as main.ts — an e2e test needs the REAL middleware
    // stack, not just the DI-wired providers, since guards/sessions live in
    // middleware that main.ts sets up manually, outside AppModule itself.
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

    // Resets this test's starting state, so this file can run any number of
    // times in a row and always begin from a genuinely empty database.
    // CASCADE truncates every table with a foreign key pointing at
    // users/clinics regardless of that FK's own ON DELETE rule — safe ONLY
    // because this is the dedicated, disposable stride_test database,
    // confirmed by the check just above.
    await db.execute(sql`TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await app.close();
    // app.close() only closes what Nest's own DI container manages.
    // sessionPool was created manually, outside that container, so it needs
    // to be closed explicitly too.
    await sessionPool.end();
  });

  // request.agent() is supertest's built-in cookie jar — every call made
  // through the SAME agent automatically remembers and resends whatever
  // session cookie the server issued. This is the exact -b/-c juggling done
  // by hand with curl throughout this project, handled automatically.
  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAAgent = () => request.agent(app.getHttpServer());
  const practitionerBAgent = () => request.agent(app.getHttpServer());
  const patientAgent = () => request.agent(app.getHttpServer());

  it('walks the full multi-role, ownership-based access scenario', async () => {
    const admin = adminAgent();
    const practitionerA = practitionerAAgent();
    const practitionerB = practitionerBAgent();
    const patient = patientAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'E2E',
      lastName: 'Admin',
    });
    expect(clinicRes.status).toBe(201);
    // Read the real id back from the response — never assume what a freshly
    // created clinic's id will be.
    const clinicId = clinicRes.body.clinicId;

    await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
      clinicId,
    });
    await practitionerA.post('/auth/login').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
    });

    await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
      clinicId,
    });
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    });

    await patient.post('/auth/register').send({
      email: `patient-${stamp}@example.com`,
      password: 'password123',
      firstName: 'E2E',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
    });

    // --- The actual scenario ---

    const created = await practitionerA.post('/exercises').send({
      name: 'E2E Wall Slide',
      primaryMuscles: ['shoulders'],
      instructions: ['Step one', 'Step two'],
    });
    expect(created.status).toBe(201);
    expect(created.body.source).toBe('custom');

    const patientCreate = await patient.post('/exercises').send({
      name: 'Should Not Work',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    });
    expect(patientCreate.status).toBe(403);

    // An admin CAN edit an exercise they did not create.
    const adminEdit = await admin
      .patch(`/exercises/${created.body.id}`)
      .send({ name: 'Corrected By Admin' });
    expect(adminEdit.status).toBe(200);
    expect(adminEdit.body.name).toBe('Corrected By Admin');

    // A DIFFERENT practitioner cannot edit exercise A created.
    const otherPractitionerEdit = await practitionerB
      .patch(`/exercises/${created.body.id}`)
      .send({ name: 'Should Not Work Either' });
    expect(otherPractitionerEdit.status).toBe(403);
  });
});