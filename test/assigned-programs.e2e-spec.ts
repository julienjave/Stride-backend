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
describe('AssignedPrograms (e2e)', () => {
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
    patientA = patientAAgent();
    patientB = patientBAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Assigned Programs E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'AP',
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

    // practitionerB manages NO patients at all — no clinic membership.
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

    // patientB shares NO clinic with practitionerA.
    await patientB.post('/auth/register').send({
      email: `patient-b-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Patient',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
    });

    const exerciseRes = await practitionerA.post('/exercises').send({
      name: 'AP E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    });
    exerciseId = exerciseRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it('rejects assigning a program to a patient the practitioner does not manage', async () => {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId: (await patientB.get('/auth/me')).body.id,
      title: 'Should Not Work',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    expect(res.status).toBe(403);
  });

  it('rejects a patient from ever creating an assigned program, even for themselves', async () => {
    const res = await patientA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Self Assigned',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    expect(res.status).toBe(403);
  });

  // THE most important test in the suite: assigning FROM a template must
  // copy the template's exercises into independent rows. Mutating the
  // template afterward — even deleting the exercise from it entirely —
  // must never be visible through the already-assigned program.
  it('copies template exercises at assignment time — later template edits never leak through', async () => {
    const templateRes = await practitionerA.post('/programs').send({ title: 'Copy Guarantee Template' });
    const templateId = templateRes.body.id;

    const addExerciseRes = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sets: 3, reps: 10, sortOrder: 0 });
    expect(addExerciseRes.status).toBe(201);
    const templateExerciseId = addExerciseRes.body.id;

    const assignRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Copy Guarantee Assignment',
      startDate: '2026-01-01',
      basedOnTemplateId: templateId,
    });
    expect(assignRes.status).toBe(201);
    const assignedProgramId = assignRes.body.id;
    expect(assignRes.body.exercises).toHaveLength(1);
    expect(assignRes.body.exercises[0]).toEqual(expect.objectContaining({ sets: 3, reps: 10 }));

    // Mutate the SOURCE template after the fact: change its prescription,
    // then remove the exercise from it entirely.
    await practitionerA
      .patch(`/programs/${templateId}/exercises/${templateExerciseId}`)
      .send({ sets: 99, reps: 1 });
    await practitionerA.delete(`/programs/${templateId}/exercises/${templateExerciseId}`);

    const assignedAfterTemplateChanged = await practitionerA.get(`/assigned-programs/${assignedProgramId}`);
    expect(assignedAfterTemplateChanged.status).toBe(200);
    expect(assignedAfterTemplateChanged.body.exercises).toHaveLength(1);
    // Still the ORIGINAL copied values — completely unaffected by both the
    // edit and the deletion performed on the template above.
    expect(assignedAfterTemplateChanged.body.exercises[0]).toEqual(
      expect.objectContaining({ sets: 3, reps: 10 }),
    );
  });

  it('rejects assigning without either basedOnTemplateId or an inline exercises array', async () => {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Neither Provided',
      startDate: '2026-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('enforces assertCanView: admin, self-patient, and managing practitioner may view; nobody else', async () => {
    const createRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'View Boundary Program',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    const programId = createRes.body.id;

    const asAdmin = await admin.get(`/assigned-programs/${programId}`);
    expect(asAdmin.status).toBe(200);

    const asSelf = await patientA.get(`/assigned-programs/${programId}`);
    expect(asSelf.status).toBe(200);

    const asManagingPractitioner = await practitionerA.get(`/assigned-programs/${programId}`);
    expect(asManagingPractitioner.status).toBe(200);

    // Both become 404, not 403: RLS makes this row invisible to their
    // session before assertCanView's own check is ever reached — same
    // reasoning as the equivalent medical_files test.
    const asOtherPatient = await patientB.get(`/assigned-programs/${programId}`);
    expect(asOtherPatient.status).toBe(404);

    const asNonManagingPractitioner = await practitionerB.get(`/assigned-programs/${programId}`);
    expect(asNonManagingPractitioner.status).toBe(404);
  });

  it('enforces assertCanManage: the owning PATIENT may never manage their own program', async () => {
    const createRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Manage Boundary Program',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    const programId = createRes.body.id;

    const patientAttemptsManage = await patientA
      .patch(`/assigned-programs/${programId}`)
      .send({ title: 'Patient Should Not Be Able To Do This' });
    expect(patientAttemptsManage.status).toBe(403);

    const adminManages = await admin.patch(`/assigned-programs/${programId}`).send({ title: 'Admin Edit' });
    expect(adminManages.status).toBe(200);
  });

  it('validates reorder as an exact permutation, and rejects a non-managing practitioner', async () => {
    const createRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Reorder Program',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    const programId = createRes.body.id;
    const firstRowId = createRes.body.exercises[0].id;

    const secondExerciseRes = await practitionerA.post('/exercises').send({
      name: 'AP E2E Lunge',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    });
    const addSecondRes = await practitionerA
      .post(`/assigned-programs/${programId}/exercises`)
      .send({ exerciseId: secondExerciseRes.body.id, sortOrder: 1 });
    const secondRowId = addSecondRes.body.id;

    const badOrder = await practitionerA
      .patch(`/assigned-programs/${programId}/exercises`)
      .send({ order: [firstRowId] });
    expect(badOrder.status).toBe(400);

    const goodOrder = await practitionerA
      .patch(`/assigned-programs/${programId}/exercises`)
      .send({ order: [secondRowId, firstRowId] });
    expect(goodOrder.status).toBe(200);

    // 404, not 403: the program row is invisible to practitionerB's RLS
    // session (they manage no patients), so findProgramOrThrow throws
    // before assertCanManage ever runs.
    const foreignOrder = await practitionerB
      .patch(`/assigned-programs/${programId}/exercises`)
      .send({ order: [secondRowId, firstRowId] });
    expect(foreignOrder.status).toBe(404);
  });

  it('rejects updating or removing an exercise row through the wrong assigned program (IDOR check)', async () => {
    const programARes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'IDOR Program A',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    const programBRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'IDOR Program B',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });
    const programAId = programARes.body.id;
    const foreignRowId = programBRes.body.exercises[0].id;

    const updateThroughWrongProgram = await practitionerA
      .patch(`/assigned-programs/${programAId}/exercises/${foreignRowId}`)
      .send({ sets: 5 });
    expect(updateThroughWrongProgram.status).toBe(404);

    const removeThroughWrongProgram = await practitionerA.delete(
      `/assigned-programs/${programAId}/exercises/${foreignRowId}`,
    );
    expect(removeThroughWrongProgram.status).toBe(404);
  });

  it('scopes GET /assigned-programs by role: patient sees own, practitioner sees managed, admin sees all', async () => {
    await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Scope Check Program',
      startDate: '2026-01-01',
      exercises: [{ exerciseId, sortOrder: 0 }],
    });

    const asPatient = await patientA.get('/assigned-programs');
    expect(asPatient.status).toBe(200);
    expect(asPatient.body.every((p: any) => p.patientId === patientAId)).toBe(true);

    const asNonManagingPractitioner = await practitionerB.get('/assigned-programs');
    expect(asNonManagingPractitioner.status).toBe(200);
    expect(asNonManagingPractitioner.body).toEqual([]);

    const asAdmin = await admin.get('/assigned-programs');
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.length).toBeGreaterThan(0);
  });
});
