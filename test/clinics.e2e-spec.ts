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
describe('Clinics (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;

  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAgent = () => request.agent(app.getHttpServer());
  const patientAgent = () => request.agent(app.getHttpServer());

  let admin: ReturnType<typeof adminAgent>;
  let practitioner: ReturnType<typeof practitionerAgent>;
  let patient: ReturnType<typeof patientAgent>;
  let practitionerId: number;

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
    patient = patientAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Clinics E2E Founding Clinic',
      clinicEmail: `founding-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Clinics',
      lastName: 'Admin',
    });
    if (clinicRes.status !== 201) {
      throw new Error(`Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`);
    }

    const practitionerRes = await admin.post('/users').send({
      email: `practitioner-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Clinics',
      lastName: 'Practitioner',
      licenseNumber: `PT-${stamp}`,
    });
    expect(practitionerRes.status).toBe(201);
    practitionerId = practitionerRes.body.id;
    await practitioner.post('/auth/login').send({
      email: `practitioner-${stamp}@example.com`,
      password: 'password123',
    });

    await patient.post('/auth/register').send({
      email: `patient-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Clinics',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
    });
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects a non-admin from creating a clinic', async () => {
    const res = await practitioner.post('/clinics').send({
      name: 'Rogue Clinic',
      email: `rogue-${Date.now()}@example.com`,
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin create, list, and view clinics — open reads for any authenticated role', async () => {
    const stamp = Date.now();
    const createRes = await admin.post('/clinics').send({
      name: 'Second Clinic',
      email: `second-${stamp}@example.com`,
    });
    expect(createRes.status).toBe(201);
    const clinicId = createRes.body.id;

    const listAsPatient = await patient.get('/clinics');
    expect(listAsPatient.status).toBe(200);
    expect(listAsPatient.body.map((c: any) => c.id)).toContain(clinicId);

    const viewAsPractitioner = await practitioner.get(`/clinics/${clinicId}`);
    expect(viewAsPractitioner.status).toBe(200);
    expect(viewAsPractitioner.body.name).toBe('Second Clinic');
  });

  it('returns 404 for a clinic that does not exist', async () => {
    const res = await admin.get('/clinics/999999');
    expect(res.status).toBe(404);
  });

  it('returns 404 when removing a member from a clinic that does not exist', async () => {
    const res = await admin.delete(`/clinics/999999/members/${practitionerId}`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin from adding or removing a clinic member', async () => {
    const stamp = Date.now();
    const clinicRes = await admin.post('/clinics').send({
      name: 'Membership Clinic',
      email: `membership-${stamp}@example.com`,
    });
    const clinicId = clinicRes.body.id;

    const addRes = await practitioner.post(`/clinics/${clinicId}/members`).send({ userId: practitionerId });
    expect(addRes.status).toBe(403);

    const removeRes = await practitioner.delete(`/clinics/${clinicId}/members/${practitionerId}`);
    expect(removeRes.status).toBe(403);
  });

  it('lets an admin add a member, rejects a duplicate add, then lets an admin remove the member', async () => {
    const stamp = Date.now();
    const clinicRes = await admin.post('/clinics').send({
      name: 'Membership Clinic Two',
      email: `membership2-${stamp}@example.com`,
    });
    const clinicId = clinicRes.body.id;

    const addRes = await admin.post(`/clinics/${clinicId}/members`).send({ userId: practitionerId });
    expect(addRes.status).toBe(201);

    const duplicateAddRes = await admin
      .post(`/clinics/${clinicId}/members`)
      .send({ userId: practitionerId });
    expect(duplicateAddRes.status).toBe(409);

    const membersRes = await admin.get(`/clinics/${clinicId}/members`);
    expect(membersRes.status).toBe(200);
    expect(membersRes.body.map((m: any) => m.id)).toContain(practitionerId);

    const removeRes = await admin.delete(`/clinics/${clinicId}/members/${practitionerId}`);
    expect(removeRes.status).toBe(200);

    const membersAfterRemove = await admin.get(`/clinics/${clinicId}/members`);
    expect(membersAfterRemove.body.map((m: any) => m.id)).not.toContain(practitionerId);
  });

  it('lets an admin update and deactivate a clinic; rejects a non-admin from doing either', async () => {
    const stamp = Date.now();
    const clinicRes = await admin.post('/clinics').send({
      name: 'Lifecycle Clinic',
      email: `lifecycle-${stamp}@example.com`,
    });
    const clinicId = clinicRes.body.id;

    const forbiddenUpdate = await practitioner.patch(`/clinics/${clinicId}`).send({ name: 'Hijacked' });
    expect(forbiddenUpdate.status).toBe(403);

    const updateRes = await admin.patch(`/clinics/${clinicId}`).send({ name: 'Renamed Clinic' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('Renamed Clinic');

    const updateAddressRes = await admin
      .patch(`/clinics/${clinicId}`)
      .send({ addressLine1: '99 Renamed Clinic Rd' });
    expect(updateAddressRes.status).toBe(200);
    expect(updateAddressRes.body.addressLine1).toBe('99 Renamed Clinic Rd');

    const forbiddenDeactivate = await practitioner.delete(`/clinics/${clinicId}`);
    expect(forbiddenDeactivate.status).toBe(403);

    const deactivateRes = await admin.delete(`/clinics/${clinicId}`);
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.isActive).toBe(false);

    // A deactivated clinic drops out of findAll() (isActive = true filter)
    // without being hard-deleted.
    const listAfterDeactivate = await admin.get('/clinics');
    expect(listAfterDeactivate.body.map((c: any) => c.id)).not.toContain(clinicId);
  });
});