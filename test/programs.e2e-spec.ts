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
describe('Programs (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;

  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAAgent = () => request.agent(app.getHttpServer());
  const practitionerBAgent = () => request.agent(app.getHttpServer());

  let admin: ReturnType<typeof adminAgent>;
  let practitionerA: ReturnType<typeof practitionerAAgent>;
  let practitionerB: ReturnType<typeof practitionerBAgent>;
  let exerciseId: number;

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

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Programs E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Programs',
      lastName: 'Admin',
    });
    if (clinicRes.status !== 201) {
      throw new Error(`Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`);
    }

    await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
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

    const exerciseRes = await practitionerA.post('/exercises').send({
      name: 'Programs E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    });
    expect(exerciseRes.status).toBe(201);
    exerciseId = exerciseRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('lets the owning practitioner build a template and add exercises to it', async () => {
    const createRes = await practitionerA.post('/programs').send({ title: 'E2E Rehab Template' });
    expect(createRes.status).toBe(201);
    const templateId = createRes.body.id;

    const addRes = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sets: 3, reps: 10, sortOrder: 0 });
    expect(addRes.status).toBe(201);

    const found = await practitionerA.get(`/programs/${templateId}`);
    expect(found.status).toBe(200);
    expect(found.body.exercises).toHaveLength(1);
  });

  it('rejects a different practitioner from adding an exercise to a template they do not own', async () => {
    const createRes = await practitionerA.post('/programs').send({ title: 'Owner Only Template' });
    const templateId = createRes.body.id;

    const res = await practitionerB
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sortOrder: 0 });
    expect(res.status).toBe(403);
  });

  it('lets an admin edit a template they did not create, but rejects a non-owning practitioner', async () => {
    const createRes = await practitionerA.post('/programs').send({ title: 'Admin Editable Template' });
    const templateId = createRes.body.id;

    const practitionerBEdit = await practitionerB
      .patch(`/programs/${templateId}`)
      .send({ title: 'Should Not Work' });
    expect(practitionerBEdit.status).toBe(403);

    const adminEdit = await admin.patch(`/programs/${templateId}`).send({ title: 'Edited By Admin' });
    expect(adminEdit.status).toBe(200);
    expect(adminEdit.body.title).toBe('Edited By Admin');
  });

  it('validates reorder as an exact permutation of the current template exercises', async () => {
    const createRes = await practitionerA.post('/programs').send({ title: 'Reorder Template' });
    const templateId = createRes.body.id;

    const secondExerciseRes = await practitionerA.post('/exercises').send({
      name: 'Programs E2E Lunge',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    });
    const secondExerciseId = secondExerciseRes.body.id;

    const firstAdd = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sortOrder: 0 });
    const secondAdd = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId: secondExerciseId, sortOrder: 1 });

    const firstRowId = firstAdd.body.id;
    const secondRowId = secondAdd.body.id;

    const badReorder = await practitionerA
      .patch(`/programs/${templateId}/exercises`)
      .send({ order: [firstRowId] });
    expect(badReorder.status).toBe(400);

    const goodReorder = await practitionerA
      .patch(`/programs/${templateId}/exercises`)
      .send({ order: [secondRowId, firstRowId] });
    expect(goodReorder.status).toBe(200);
    expect(goodReorder.body.exercises.map((e: any) => e.id)).toEqual([secondRowId, firstRowId]);

    const foreignReorder = await practitionerB
      .patch(`/programs/${templateId}/exercises`)
      .send({ order: [secondRowId, firstRowId] });
    expect(foreignReorder.status).toBe(403);
  });

  it('rejects updating or removing a template-exercise row through the wrong template (IDOR check)', async () => {
    const templateARes = await practitionerA.post('/programs').send({ title: 'IDOR Template A' });
    const templateAId = templateARes.body.id;
    const templateBRes = await practitionerA.post('/programs').send({ title: 'IDOR Template B' });
    const templateBId = templateBRes.body.id;

    const rowInB = await practitionerA
      .post(`/programs/${templateBId}/exercises`)
      .send({ exerciseId, sortOrder: 0 });
    const foreignRowId = rowInB.body.id;

    const updateThroughWrongTemplate = await practitionerA
      .patch(`/programs/${templateAId}/exercises/${foreignRowId}`)
      .send({ sets: 5 });
    expect(updateThroughWrongTemplate.status).toBe(404);

    const removeThroughWrongTemplate = await practitionerA.delete(
      `/programs/${templateAId}/exercises/${foreignRowId}`,
    );
    expect(removeThroughWrongTemplate.status).toBe(404);
  });

  it('archives a template (soft delete) and drops it out of the public listing', async () => {
    const createRes = await practitionerA.post('/programs').send({ title: 'Archive Me Template' });
    const templateId = createRes.body.id;

    const archiveRes = await practitionerA.delete(`/programs/${templateId}`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.isArchived).toBe(true);

    const listRes = await practitionerA.get('/programs');
    expect(listRes.body.map((t: any) => t.id)).not.toContain(templateId);
  });
});
