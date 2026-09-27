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
describe('MedicalFiles (e2e)', () => {
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
  let patientAId: number;

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
    practitionerA = practitionerAAgent();
    practitionerB = practitionerBAgent();
    patientA = patientAAgent();
    patientB = patientBAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Medical Files E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'MF',
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

    // practitionerB manages no one — no clinic membership at all.
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
    patientAId = patientARes.body.id;
    await patientA.post('/auth/login').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
    });

    // Since the care team (decisions §3), sharing a clinic no longer makes a
    // practitioner "manage" a patient — being on the patient's care team does.
    // practitionerA joins through the real endpoint (an empty body = "join").
    const joinRes = await practitionerA.post(`/users/${patientAId}/care-team`).send({});
    expect(joinRes.status).toBe(201);

    await patientB.post('/auth/register').send({
      email: `patient-b-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Patient',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
    });
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects a patient from creating a medical file entry — practitioner-only', async () => {
    const res = await patientA.post('/medical-files').send({ patientId: patientAId, clinicalData: {} });
    expect(res.status).toBe(403);
  });

  it('rejects a practitioner creating an entry for a patient they do not manage', async () => {
    const res = await practitionerB
      .post('/medical-files')
      .send({ patientId: patientAId, clinicalData: { note: 'should not work' } });
    expect(res.status).toBe(403);
  });

  it('creates an entry for a managed patient', async () => {
    const res = await practitionerA
      .post('/medical-files')
      .send({ patientId: patientAId, clinicalData: { note: 'initial intake' } });
    expect(res.status).toBe(201);
    expect(res.body.clinicalData).toEqual({ note: 'initial intake' });
  });

  it('lets a patient list their own files with no query param required', async () => {
    const res = await patientA.get('/medical-files');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('requires an explicit patientId for a practitioner or admin', async () => {
    const asPractitioner = await practitionerA.get('/medical-files');
    expect(asPractitioner.status).toBe(400);

    const asAdmin = await admin.get('/medical-files');
    expect(asAdmin.status).toBe(400);
  });

  it('rejects a practitioner listing a patient they do not manage', async () => {
    const res = await practitionerB.get('/medical-files').query({ patientId: patientAId });
    expect(res.status).toBe(403);
  });

  it('lets a managing practitioner and an admin list a managed patient by id', async () => {
    const asPractitioner = await practitionerA.get('/medical-files').query({ patientId: patientAId });
    expect(asPractitioner.status).toBe(200);

    const asAdmin = await admin.get('/medical-files').query({ patientId: patientAId });
    expect(asAdmin.status).toBe(200);
  });

  it('enforces the same view boundary on a single entry: self, admin, managing practitioner yes; others no', async () => {
    const createRes = await practitionerA
      .post('/medical-files')
      .send({ patientId: patientAId, clinicalData: { note: 'boundary check' } });
    const entryId = createRes.body.id;

    const asSelf = await patientA.get(`/medical-files/${entryId}`);
    expect(asSelf.status).toBe(200);

    const asAdmin = await admin.get(`/medical-files/${entryId}`);
    expect(asAdmin.status).toBe(200);

    const asManagingPractitioner = await practitionerA.get(`/medical-files/${entryId}`);
    expect(asManagingPractitioner.status).toBe(200);

    // Once findOne's fetch-by-id runs under RLS (see the "Row-Level Security"
    // writeup), a row that exists but isn't visible to this session's RLS
    // context simply doesn't come back from the database — indistinguishable
    // from a genuinely nonexistent id, hence 404 rather than 403 here. This is
    // a deliberate, accepted tradeoff, not a bug: not confirming a record's
    // existence to someone unauthorized to see it is the stricter posture.
    const asOtherPatient = await patientB.get(`/medical-files/${entryId}`);
    expect(asOtherPatient.status).toBe(404);

    const asNonManagingPractitioner = await practitionerB.get(`/medical-files/${entryId}`);
    expect(asNonManagingPractitioner.status).toBe(404);
  });

  it('returns 404 for a medical file entry that does not exist', async () => {
    const res = await admin.get('/medical-files/999999');
    expect(res.status).toBe(404);
  });

  // clinicalData is deliberately unstructured (@IsObject() only) but bounded
  // by @MaxJsonSize(50 * 1024) — this is the only place that limit is
  // actually exercised through the real ValidationPipe + HTTP pipeline,
  // rather than just at the decorator's own unit-test level.
  it('rejects a clinicalData payload that exceeds the 50KB MaxJsonSize limit', async () => {
    const res = await practitionerA.post('/medical-files').send({
      patientId: patientAId,
      clinicalData: { note: 'x'.repeat(51 * 1024) },
    });
    expect(res.status).toBe(400);
  });

  it('exposes no update or delete route at all — clinical entries are append-only', async () => {
    const createRes = await practitionerA
      .post('/medical-files')
      .send({ patientId: patientAId, clinicalData: { note: 'append only check' } });
    const entryId = createRes.body.id;

    const patchRes = await admin.patch(`/medical-files/${entryId}`).send({ clinicalData: { note: 'edited' } });
    expect(patchRes.status).toBe(404);

    const deleteRes = await admin.delete(`/medical-files/${entryId}`);
    expect(deleteRes.status).toBe(404);
  });
});