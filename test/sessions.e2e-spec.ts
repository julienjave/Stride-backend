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
describe('Sessions (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;

  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAAgent = () => request.agent(app.getHttpServer());
  const practitionerBAgent = () => request.agent(app.getHttpServer());
  const patientAAgent = () => request.agent(app.getHttpServer());
  const patientBAgent = () => request.agent(app.getHttpServer());

  let admin: ReturnType<typeof adminAgent>;
  let practitionerA: ReturnType<typeof practitionerAAgent>;
  let practitionerB: ReturnType<typeof practitionerBAgent>;
  let patientA: ReturnType<typeof patientAAgent>;
  let patientB: ReturnType<typeof patientBAgent>;
  let assignedProgramId: number;

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

    await db.execute(sql`TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE`);

    admin = adminAgent();
    practitionerA = practitionerAAgent();
    practitionerB = practitionerBAgent();
    patientA = patientAAgent();
    patientB = patientBAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Sessions E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Sessions',
      lastName: 'Admin',
    });
    if (clinicRes.status !== 201) {
      throw new Error(`Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`);
    }
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
    });
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    });

    const patientARes = await admin.post('/users').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Patient',
      lastName: 'A',
      dateOfBirth: '1990-01-01',
      clinicId,
    });
    const patientAId = patientARes.body.id;
    await patientA.post('/auth/login').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
    });

    await patientB.post('/auth/register').send({
      email: `patient-b-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Patient',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
    });

    const exerciseRes = await practitionerA.post('/exercises').send({
      name: 'Sessions E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    });
    const exerciseId = exerciseRes.body.id;

    const assignedRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Sessions E2E Program',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    assignedProgramId = assignedRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects a patient creating a session for an assigned program that is not their own', async () => {
    const res = await patientB.post('/sessions').send({ assignedProgramId });
    expect(res.status).toBe(403);
  });

  it("rejects a practitioner or admin from creating a session at all — sessions role-restrict to 'patient'", async () => {
    const asPractitioner = await practitionerA.post('/sessions').send({ assignedProgramId });
    expect(asPractitioner.status).toBe(403);

    const asAdmin = await admin.post('/sessions').send({ assignedProgramId });
    expect(asAdmin.status).toBe(403);
  });

  it("creates a session pre-populated from the assigned program's current exercises", async () => {
    const res = await patientA.post('/sessions').send({ assignedProgramId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.exercises).toHaveLength(1);
    expect(res.body.exercises[0].completed).toBe(false);
  });

  it('walks the pending -> in_progress -> completed state machine, server-setting the timestamps', async () => {
    const createRes = await patientA.post('/sessions').send({ assignedProgramId });
    const sessionId = createRes.body.id;
    expect(createRes.body.startedAt).toBeNull();

    const startRes = await patientA.patch(`/sessions/${sessionId}`).send({ status: 'in_progress' });
    expect(startRes.status).toBe(200);
    expect(startRes.body.status).toBe('in_progress');
    expect(startRes.body.startedAt).not.toBeNull();

    const completeRes = await patientA.patch(`/sessions/${sessionId}`).send({ status: 'completed' });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('completed');
    expect(completeRes.body.completedAt).not.toBeNull();
  });

  it('lets a managing practitioner and an admin VIEW a session, but never WRITE to it', async () => {
    const createRes = await patientA.post('/sessions').send({ assignedProgramId });
    const sessionId = createRes.body.id;

    const practitionerView = await practitionerA.get(`/sessions/${sessionId}`);
    expect(practitionerView.status).toBe(200);
    const adminView = await admin.get(`/sessions/${sessionId}`);
    expect(adminView.status).toBe(200);

    const practitionerWrite = await practitionerA
      .patch(`/sessions/${sessionId}`)
      .send({ status: 'in_progress' });
    expect(practitionerWrite.status).toBe(403);

    const adminWrite = await admin.patch(`/sessions/${sessionId}`).send({ status: 'in_progress' });
    expect(adminWrite.status).toBe(403);
  });

  it('rejects a non-managing practitioner and an unrelated patient from viewing the session at all', async () => {
    const createRes = await patientA.post('/sessions').send({ assignedProgramId });
    const sessionId = createRes.body.id;

    const foreignPractitioner = await practitionerB.get(`/sessions/${sessionId}`);
    expect(foreignPractitioner.status).toBe(403);

    const foreignPatient = await patientB.get(`/sessions/${sessionId}`);
    expect(foreignPatient.status).toBe(403);
  });

  it('rejects updating a session-exercise row through the wrong session (IDOR check)', async () => {
    const sessionARes = await patientA.post('/sessions').send({ assignedProgramId });
    const sessionBRes = await patientA.post('/sessions').send({ assignedProgramId });
    const sessionAId = sessionARes.body.id;
    const foreignRowId = sessionBRes.body.exercises[0].id;

    const res = await patientA
      .patch(`/sessions/${sessionAId}/exercises/${foreignRowId}`)
      .send({ completed: true });
    expect(res.status).toBe(404);
  });

  it('updates a session-exercise row that genuinely belongs to the session, honoring the difficultyRating bounds', async () => {
    const createRes = await patientA.post('/sessions').send({ assignedProgramId });
    const sessionId = createRes.body.id;
    const rowId = createRes.body.exercises[0].id;

    const goodUpdate = await patientA
      .patch(`/sessions/${sessionId}/exercises/${rowId}`)
      .send({ completed: true, difficultyRating: 7 });
    expect(goodUpdate.status).toBe(200);
    expect(goodUpdate.body.completed).toBe(true);

    const outOfRange = await patientA
      .patch(`/sessions/${sessionId}/exercises/${rowId}`)
      .send({ difficultyRating: 11 });
    expect(outOfRange.status).toBe(400);
  });

  it('scopes GET /sessions by role: patient sees own, unrelated practitioner sees none, admin sees all', async () => {
    await patientA.post('/sessions').send({ assignedProgramId });

    const asPatient = await patientA.get('/sessions');
    expect(asPatient.status).toBe(200);
    expect(asPatient.body.length).toBeGreaterThan(0);

    const asForeignPractitioner = await practitionerB.get('/sessions');
    expect(asForeignPractitioner.status).toBe(200);
    expect(asForeignPractitioner.body).toEqual([]);

    const asAdmin = await admin.get('/sessions');
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.length).toBeGreaterThan(0);
  });
});
