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

  // request.agent() is supertest's built-in cookie jar — every call made
  // through the SAME agent automatically remembers and resends whatever
  // session cookie the server issued. This is the exact -b/-c juggling done
  // by hand with curl throughout this project, handled automatically.
  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAAgent = () => request.agent(app.getHttpServer());
  const practitionerBAgent = () => request.agent(app.getHttpServer());
  const patientAgent = () => request.agent(app.getHttpServer());

  let admin: ReturnType<typeof adminAgent>;
  let practitionerA: ReturnType<typeof practitionerAAgent>;
  let practitionerB: ReturnType<typeof practitionerBAgent>;
  let patient: ReturnType<typeof patientAgent>;

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

    admin = adminAgent();
    practitionerA = practitionerAAgent();
    practitionerB = practitionerBAgent();
    patient = patientAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'E2E',
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
  });

  afterAll(async () => {
    await app.close();
    // app.close() only closes what Nest's own DI container manages.
    // sessionPool was created manually, outside that container, so it needs
    // to be closed explicitly too.
    await sessionPool.end();
  });

  // A minimal buffer stands in for real image bytes here — imageUploadOptions'
  // fileFilter only inspects the multipart Content-Type header (set explicitly
  // below via .attach()'s options), never the buffer's actual content, and
  // StorageService.upload() just forwards whatever bytes it's given straight
  // to RustFS with no format validation of its own.
  const fakeImage = (label: string) => Buffer.from(`fake-image-content-${label}`);

  const createExercise = async (
    agent: ReturnType<typeof practitionerAAgent>,
    name: string,
  ) => {
    const res = await agent.post('/exercises').send({
      name,
      primaryMuscles: ['shoulders'],
      instructions: ['Step one', 'Step two'],
    });
    return res;
  };

  it('walks the full multi-role, ownership-based access scenario', async () => {
    const created = await createExercise(practitionerA, 'E2E Wall Slide');
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

  // --- Image upload (POST /exercises/:id/images) ---

  it('lets the owning practitioner upload images, appending to the existing gallery', async () => {
    const created = await createExercise(practitionerA, 'Image Upload Exercise');
    const id = created.body.id;

    const firstUpload = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('one'), { filename: 'one.png', contentType: 'image/png' })
      .attach('files', fakeImage('two'), { filename: 'two.png', contentType: 'image/png' });
    expect(firstUpload.status).toBe(201);
    expect(firstUpload.body.mediaUrls).toHaveLength(2);
    expect(
      firstUpload.body.mediaUrls.every((key: string) => key.startsWith(`exercises/${id}/upload-`)),
    ).toBe(true);

    // A second upload APPENDS rather than replacing — seeded/edited
    // exercises can legitimately have several distinct images (e.g. a
    // movement's start and end position).
    const secondUpload = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('three'), { filename: 'three.png', contentType: 'image/png' });
    expect(secondUpload.status).toBe(201);
    expect(secondUpload.body.mediaUrls).toHaveLength(3);
    expect(secondUpload.body.mediaUrls.slice(0, 2)).toEqual(firstUpload.body.mediaUrls);
  });

  it('rejects an image upload from a practitioner who does not own the exercise', async () => {
    const created = await createExercise(practitionerA, 'Image Ownership Exercise');
    const id = created.body.id;

    const res = await practitionerB
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('intruder'), { filename: 'intruder.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('rejects an image upload from a patient — practitioner/admin only', async () => {
    const created = await createExercise(practitionerA, 'Image Role Exercise');
    const id = created.body.id;

    const res = await patient
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('patient'), { filename: 'patient.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('rejects an image upload request with no files attached', async () => {
    const created = await createExercise(practitionerA, 'Image No Files Exercise');
    const id = created.body.id;

    const res = await practitionerA.post(`/exercises/${id}/images`);
    expect(res.status).toBe(400);
  });

  // --- Reorder images (PATCH /exercises/:id/images) ---

  it('reorders the gallery when the new order is an exact permutation of the current images', async () => {
    const created = await createExercise(practitionerA, 'Reorder Valid Exercise');
    const id = created.body.id;

    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('r1'), { filename: 'r1.png', contentType: 'image/png' })
      .attach('files', fakeImage('r2'), { filename: 'r2.png', contentType: 'image/png' })
      .attach('files', fakeImage('r3'), { filename: 'r3.png', contentType: 'image/png' });
    const [k1, k2, k3] = uploaded.body.mediaUrls;

    const reordered = await practitionerA
      .patch(`/exercises/${id}/images`)
      .send({ order: [k3, k1, k2] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.mediaUrls).toEqual([k3, k1, k2]);
  });

  // Regression coverage for the bug fixed in "Fix: reorder endpoints accept
  // duplicate-padded arrays". The OLD permutation check only compared
  // DEDUPED set sizes (`new Set(current).size === new Set(newOrder).size`)
  // plus membership — it never checked newOrder's raw length against the
  // gallery's actual length, and never checked newOrder for internal
  // duplicates. So an array containing every real key PLUS one duplicate —
  // e.g. [k1, k2, k3, k1], one longer than the real 3-image gallery — still
  // deduped down to exactly {k1, k2, k3}, satisfying the old check. Since
  // mediaUrls gets overwritten wholesale with newOrder (not looped
  // per-row), applying it would have silently stored a duplicated,
  // padded-out array. The new check adds `newOrder.length ===
  // exercise.mediaUrls.length`, which this case fails. Verified against the
  // pre-fix logic directly (not just by reading the diff): the old
  // predicate evaluates to `true` for this exact array, the new one to
  // `false`.
  it('rejects a duplicate-padded order array instead of silently corrupting the gallery', async () => {
    const created = await createExercise(practitionerA, 'Reorder Duplicate Exercise');
    const id = created.body.id;

    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('d1'), { filename: 'd1.png', contentType: 'image/png' })
      .attach('files', fakeImage('d2'), { filename: 'd2.png', contentType: 'image/png' })
      .attach('files', fakeImage('d3'), { filename: 'd3.png', contentType: 'image/png' });
    const [k1, k2, k3] = uploaded.body.mediaUrls;

    const res = await practitionerA
      .patch(`/exercises/${id}/images`)
      // Every real key present (so a deduped-set-only check sees a perfect
      // match), but k1 is padded in a second time, one longer than the
      // actual 3-image gallery.
      .send({ order: [k1, k2, k3, k1] });
    expect(res.status).toBe(400);

    // The gallery must be untouched by the rejected request — still all
    // three original keys, in their original order.
    const fetched = await practitionerA.get(`/exercises/${id}`);
    expect(fetched.body.mediaUrls).toEqual([k1, k2, k3]);
  });

  it('rejects a reorder request from a practitioner who does not own the exercise', async () => {
    const created = await createExercise(practitionerA, 'Reorder Ownership Exercise');
    const id = created.body.id;

    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('o1'), { filename: 'o1.png', contentType: 'image/png' })
      .attach('files', fakeImage('o2'), { filename: 'o2.png', contentType: 'image/png' });
    const [k1, k2] = uploaded.body.mediaUrls;

    const res = await practitionerB
      .patch(`/exercises/${id}/images`)
      .send({ order: [k2, k1] });
    expect(res.status).toBe(403);
  });

  // --- Pagination (GET /exercises) ---

  describe('pagination', () => {
    // Scoped with a per-run "search" term so counts stay exact regardless of
    // exercises created by the other it() blocks in this file (or by
    // previous runs' leftover data, in the unlikely case TRUNCATE didn't
    // apply) — none of those match this stamp.
    const stamp = Date.now();
    const probeName = (i: number) => `Pagination Probe ${stamp} ${i}`;
    const TOTAL = 23;

    beforeAll(async () => {
      await Promise.all(
        Array.from({ length: TOTAL }, (_, i) => createExercise(practitionerA, probeName(i))),
      );
    });

    it('defaults to page 1 with a limit of 20 and reports accurate pagination metadata', async () => {
      const res = await patient.get('/exercises').query({ search: `Pagination Probe ${stamp}` });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(20);
      expect(res.body.meta).toEqual({ total: TOTAL, page: 1, limit: 20, totalPages: 2 });
    });

    it('returns the remaining partial page and a disjoint set of rows on page 2', async () => {
      const page1 = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}`, page: 1, limit: 20 });
      const page2 = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}`, page: 2, limit: 20 });

      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(3);
      expect(page2.body.meta).toEqual({ total: TOTAL, page: 2, limit: 20, totalPages: 2 });

      const page1Ids = page1.body.data.map((e: any) => e.id);
      const page2Ids = page2.body.data.map((e: any) => e.id);
      expect(page1Ids.some((id: number) => page2Ids.includes(id))).toBe(false);
    });

    it('honors a smaller explicit limit', async () => {
      const res = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}`, page: 1, limit: 10 });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(10);
      expect(res.body.meta).toEqual({ total: TOTAL, page: 1, limit: 10, totalPages: 3 });
    });

    it('rejects a limit above the hard ceiling of 100', async () => {
      const res = await patient.get('/exercises').query({ limit: 101 });
      expect(res.status).toBe(400);
    });

    it('rejects a page below 1', async () => {
      const res = await patient.get('/exercises').query({ page: 0 });
      expect(res.status).toBe(400);
    });
  });
});
