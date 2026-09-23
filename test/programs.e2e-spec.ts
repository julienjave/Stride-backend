// Same reason this exists in main.ts and scripts/seed-exercises.ts — Jest,
// like ts-node, never auto-loads .env. AppModule's DrizzleModule needs
// POSTGRES_* in process.env the moment Test.createTestingModule() below
// tries to construct it, so this has to be the very first thing that runs.
import "dotenv/config";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import session from "express-session";
import passport from "passport";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { getDatabaseUrl } from "../src/config/database-url";
import { DRIZZLE, DrizzleDb } from "../src/database/drizzle.provider";

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
describe("Programs (e2e)", () => {
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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    sessionPool = new Pool({ connectionString: getDatabaseUrl() });
    const PgSessionStore = connectPgSimple(session);
    app.use(
      session({
        store: new PgSessionStore({
          pool: sessionPool,
          createTableIfMissing: true,
        }),
        secret: "e2e-test-secret",
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
    if (currentDatabase !== "stride_test") {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test". ` +
          "Did you run this via `npm run test:e2e:fresh` (not plain `test:e2e`)?",
      );
    }

    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query(
      "TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE",
    );

    admin = adminAgent();
    practitionerA = practitionerAAgent();
    practitionerB = practitionerBAgent();

    const stamp = Date.now();

    const clinicRes = await admin.post("/auth/register-clinic").send({
      clinicName: "Programs E2E Clinic",
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: "password123",
      firstName: "Programs",
      lastName: "Admin",
    });
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      );
    }

    await admin.post("/users").send({
      email: `practitioner-a-${stamp}@example.com`,
      password: "password123",
      role: "practitioner",
      firstName: "Practitioner",
      lastName: "A",
      licenseNumber: `PT-A-${stamp}`,
    });
    await practitionerA.post("/auth/login").send({
      email: `practitioner-a-${stamp}@example.com`,
      password: "password123",
    });

    await admin.post("/users").send({
      email: `practitioner-b-${stamp}@example.com`,
      password: "password123",
      role: "practitioner",
      firstName: "Practitioner",
      lastName: "B",
      licenseNumber: `PT-B-${stamp}`,
    });
    await practitionerB.post("/auth/login").send({
      email: `practitioner-b-${stamp}@example.com`,
      password: "password123",
    });

    const exerciseRes = await practitionerA.post("/exercises").send({
      name: "Programs E2E Squat",
      primaryMuscles: ["legs"],
      instructions: ["Step one"],
    });
    expect(exerciseRes.status).toBe(201);
    exerciseId = exerciseRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    await sessionPool.end();
  });

  it("lets the owning practitioner build a template and add exercises to it", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "E2E Rehab Template" });
    expect(createRes.status).toBe(201);
    const templateId = createRes.body.id;

    const addRes = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sets: 3, reps: 10, sortOrder: 0 });
    expect(addRes.status).toBe(201);

    const found = await practitionerA.get(`/programs/${templateId}`);
    expect(found.status).toBe(200);
    expect(found.body.exercises).toHaveLength(1);
    // The actual point of this enrichment: a bare exerciseId is useless
    // for rendering a card, so each row should carry the real exercise's
    // name and muscles alongside its own sets/reps/sortOrder/etc.
    expect(found.body.exercises[0].exercise).toEqual({
      id: exerciseId,
      name: "Programs E2E Squat",
      primaryMuscles: ["legs"],
    });
  });

  it("lets the owning practitioner update a single exercise row, returning the full enriched template", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Update Exercise Template" });
    const templateId = createRes.body.id;

    const addRes = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sets: 3, reps: 10, sortOrder: 0 });
    const templateExerciseId = addRes.body.exercises.find(
      (e: any) => e.exerciseId === exerciseId,
    ).id;

    const updateRes = await practitionerA
      .patch(`/programs/${templateId}/exercises/${templateExerciseId}`)
      .send({ sets: 5, reps: 8 });
    expect(updateRes.status).toBe(200);
    // The actual regression guard: before this fix, this endpoint
    // returned the bare updated row with no `exercise` field at all —
    // a real gap only noticed once the frontend actually needed the
    // exercise's name/muscles back after a save, not just its own
    // prescription fields.
    const updatedRow = updateRes.body.exercises.find(
      (e: any) => e.id === templateExerciseId,
    );
    expect(updatedRow).toEqual(
      expect.objectContaining({
        sets: 5,
        reps: 8,
        exercise: {
          id: exerciseId,
          name: "Programs E2E Squat",
          primaryMuscles: ["legs"],
        },
      }),
    );
  });

  it("accepts a weight and weightUnit together, and rejects either one given alone", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Weighted Template" });
    const templateId = createRes.body.id;

    const withWeight = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, weight: 62.5, weightUnit: "kg", sortOrder: 0 });
    expect(withWeight.status).toBe(201);
    const addedRow = withWeight.body.exercises.find(
      (e: any) => e.exerciseId === exerciseId,
    );
    expect(addedRow.weight).toBe(62.5);
    expect(addedRow.weightUnit).toBe("kg");

    const weightWithoutUnit = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, weight: 50, sortOrder: 1 });
    expect(weightWithoutUnit.status).toBe(400);

    const unitWithoutWeight = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, weightUnit: "lbs", sortOrder: 1 });
    expect(unitWithoutWeight.status).toBe(400);
  });

  it("rejects a different practitioner from adding an exercise to a template they do not own", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Owner Only Template" });
    const templateId = createRes.body.id;

    const res = await practitionerB
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sortOrder: 0 });
    expect(res.status).toBe(403);
  });

  it("lets an admin edit a template they did not create, but rejects a non-owning practitioner", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Admin Editable Template" });
    const templateId = createRes.body.id;

    const practitionerBEdit = await practitionerB
      .patch(`/programs/${templateId}`)
      .send({ title: "Should Not Work" });
    expect(practitionerBEdit.status).toBe(403);

    const adminEdit = await admin
      .patch(`/programs/${templateId}`)
      .send({ title: "Edited By Admin" });
    expect(adminEdit.status).toBe(200);
    expect(adminEdit.body.title).toBe("Edited By Admin");
  });

  it("returns the full enriched template from a title/description update, and clears the description with null", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Rename Me", description: "Temporary description" });
    const templateId = createRes.body.id;
    await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sets: 3, sortOrder: 0 });

    const renameRes = await practitionerA
      .patch(`/programs/${templateId}`)
      .send({ title: "Renamed" });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.title).toBe("Renamed");
    // The regression guard: this used to be the bare row, with no
    // exercises array — the frontend writes this response straight into
    // its cache, so the list would have vanished right after a rename.
    expect(renameRes.body.exercises).toHaveLength(1);
    expect(renameRes.body.exercises[0].exercise.name).toBe(
      "Programs E2E Squat",
    );

    // The frontend clears a description by sending an explicit null.
    // @IsOptional() skips validation for null (not just undefined), and
    // .set(dto) then writes a real SQL NULL — confirmed here against the
    // real pipeline rather than assumed from reading the decorators.
    const clearRes = await practitionerA
      .patch(`/programs/${templateId}`)
      .send({ description: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.description).toBeNull();
    expect(clearRes.body.title).toBe("Renamed");
  });

  it("validates reorder as an exact permutation of the current template exercises", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Reorder Template" });
    const templateId = createRes.body.id;

    const secondExerciseRes = await practitionerA.post("/exercises").send({
      name: "Programs E2E Lunge",
      primaryMuscles: ["legs"],
      instructions: ["Step one"],
    });
    const secondExerciseId = secondExerciseRes.body.id;

    const firstAdd = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId, sortOrder: 0 });
    const secondAdd = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({ exerciseId: secondExerciseId, sortOrder: 1 });

    // addExercise now returns the FULL enriched template (matching
    // reorderExercises' own existing convention), not the bare inserted
    // row — so the new row's own id has to be found inside the
    // returned exercises array, by matching the exerciseId this request
    // actually sent, rather than read directly off the top-level body.
    const firstRowId = firstAdd.body.exercises.find(
      (e: any) => e.exerciseId === exerciseId,
    ).id;
    const secondRowId = secondAdd.body.exercises.find(
      (e: any) => e.exerciseId === secondExerciseId,
    ).id;

    const badReorder = await practitionerA
      .patch(`/programs/${templateId}/exercises`)
      .send({ order: [firstRowId] });
    expect(badReorder.status).toBe(400);

    const goodReorder = await practitionerA
      .patch(`/programs/${templateId}/exercises`)
      .send({ order: [secondRowId, firstRowId] });
    expect(goodReorder.status).toBe(200);
    expect(goodReorder.body.exercises.map((e: any) => e.id)).toEqual([
      secondRowId,
      firstRowId,
    ]);

    const foreignReorder = await practitionerB
      .patch(`/programs/${templateId}/exercises`)
      .send({ order: [secondRowId, firstRowId] });
    expect(foreignReorder.status).toBe(403);
  });

  it("rejects updating or removing a template-exercise row through the wrong template (IDOR check)", async () => {
    const templateARes = await practitionerA
      .post("/programs")
      .send({ title: "IDOR Template A" });
    const templateAId = templateARes.body.id;
    const templateBRes = await practitionerA
      .post("/programs")
      .send({ title: "IDOR Template B" });
    const templateBId = templateBRes.body.id;

    const rowInB = await practitionerA
      .post(`/programs/${templateBId}/exercises`)
      .send({ exerciseId, sortOrder: 0 });
    // Same reasoning as the reorder test above — addExercise's response
    // is now the full template, not the bare inserted row.
    const foreignRowId = rowInB.body.exercises.find(
      (e: any) => e.exerciseId === exerciseId,
    ).id;

    const updateThroughWrongTemplate = await practitionerA
      .patch(`/programs/${templateAId}/exercises/${foreignRowId}`)
      .send({ sets: 5 });
    expect(updateThroughWrongTemplate.status).toBe(404);

    const removeThroughWrongTemplate = await practitionerA.delete(
      `/programs/${templateAId}/exercises/${foreignRowId}`,
    );
    expect(removeThroughWrongTemplate.status).toBe(404);
  });

  it("archives a template (soft delete) and drops it out of the public listing", async () => {
    const createRes = await practitionerA
      .post("/programs")
      .send({ title: "Archive Me Template" });
    const templateId = createRes.body.id;

    const archiveRes = await practitionerA.delete(`/programs/${templateId}`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.isArchived).toBe(true);
    // Same enriched shape as every other write on this controller now.
    expect(archiveRes.body.exercises).toEqual([]);

    const listRes = await practitionerA.get("/programs");
    expect(listRes.body.map((t: any) => t.id)).not.toContain(templateId);

    // Still reachable by direct id, deliberately — the frontend relies on
    // this to show a read-only "this template has been deleted" view for
    // an old bookmark, rather than a bare error.
    const directRes = await practitionerA.get(`/programs/${templateId}`);
    expect(directRes.status).toBe(200);
    expect(directRes.body.isArchived).toBe(true);
  });

  describe("duplicate", () => {
    // Builds a source template owned by practitioner A with two very
    // different rows — one weighted with notes, one timed — so a copy
    // that dropped ANY column would show up as a mismatch below.
    async function createSourceTemplate(title: string) {
      const createRes = await practitionerA
        .post("/programs")
        .send({ title, description: "Source description" });
      const templateId: number = createRes.body.id;
      await practitionerA.post(`/programs/${templateId}/exercises`).send({
        exerciseId,
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: "kg",
        notes: "Go slow",
        sortOrder: 0,
      });
      await practitionerA
        .post(`/programs/${templateId}/exercises`)
        .send({ exerciseId, durationInSeconds: 30, sortOrder: 1 });
      return templateId;
    }

    // Strips exactly the two columns a copy is SUPPOSED to change, so the
    // rest can be compared field-for-field with toEqual.
    const withoutIdentity = (rows: any[]) =>
      rows.map(({ id, templateId, ...rest }) => rest);

    it("lets a practitioner duplicate a colleague's template into their own copy, with every exercise field intact", async () => {
      const sourceId = await createSourceTemplate("Colleague Template");
      const sourceBefore = await practitionerA.get(`/programs/${sourceId}`);

      const dupRes = await practitionerB.post(
        `/programs/${sourceId}/duplicate`,
      );
      expect(dupRes.status).toBe(201);
      const copyId: number = dupRes.body.id;
      expect(copyId).not.toBe(sourceId);
      expect(dupRes.body.title).toBe("Copy of Colleague Template");
      expect(dupRes.body.description).toBe("Source description");
      expect(dupRes.body.isArchived).toBe(false);

      // Every column except id/templateId matches the source, in order.
      expect(withoutIdentity(dupRes.body.exercises)).toEqual(
        withoutIdentity(sourceBefore.body.exercises),
      );
      // Genuinely NEW rows, pointing at the copy — not the source's rows.
      for (const row of dupRes.body.exercises) {
        expect(row.templateId).toBe(copyId);
      }
      const sourceRowIds = sourceBefore.body.exercises.map((e: any) => e.id);
      for (const row of dupRes.body.exercises) {
        expect(sourceRowIds).not.toContain(row.id);
      }

      // Ownership, proved by behavior: B (who duplicated it) can edit the
      // copy; A (who owns the SOURCE) cannot.
      const bEdit = await practitionerB
        .patch(`/programs/${copyId}`)
        .send({ title: "B's Version" });
      expect(bEdit.status).toBe(200);
      const aEdit = await practitionerA
        .patch(`/programs/${copyId}`)
        .send({ title: "Should Not Work" });
      expect(aEdit.status).toBe(403);

      // The copy is independent: editing one of its rows leaves the
      // source's matching row untouched.
      const copyRowId = dupRes.body.exercises[0].id;
      await practitionerB
        .patch(`/programs/${copyId}/exercises/${copyRowId}`)
        .send({ sets: 5, notes: "Changed on the copy" });
      const sourceAfter = await practitionerA.get(`/programs/${sourceId}`);
      expect(sourceAfter.body.exercises).toEqual(sourceBefore.body.exercises);
      expect(sourceAfter.body.title).toBe("Colleague Template");
    });

    it("duplicates a template with no exercises", async () => {
      const createRes = await practitionerA
        .post("/programs")
        .send({ title: "Empty Source" });

      const dupRes = await practitionerA.post(
        `/programs/${createRes.body.id}/duplicate`,
      );
      expect(dupRes.status).toBe(201);
      expect(dupRes.body.title).toBe("Copy of Empty Source");
      expect(dupRes.body.exercises).toEqual([]);
    });

    it("trims the generated title to the 200-character limit", async () => {
      const createRes = await practitionerA
        .post("/programs")
        .send({ title: "x".repeat(200) });

      const dupRes = await practitionerA.post(
        `/programs/${createRes.body.id}/duplicate`,
      );
      expect(dupRes.status).toBe(201);
      expect(dupRes.body.title).toHaveLength(200);
      expect(dupRes.body.title.startsWith("Copy of ")).toBe(true);
    });

    it("refuses to duplicate an archived template", async () => {
      const sourceId = await createSourceTemplate("Archived Source");
      await practitionerA.delete(`/programs/${sourceId}`);

      const dupRes = await practitionerB.post(
        `/programs/${sourceId}/duplicate`,
      );
      expect(dupRes.status).toBe(400);
    });

    it("rejects an admin (practitioner-only, like creating a template)", async () => {
      const sourceId = await createSourceTemplate("Admin Cannot Copy");

      const dupRes = await admin.post(`/programs/${sourceId}/duplicate`);
      expect(dupRes.status).toBe(403);
    });

    it("returns 404 for a template that does not exist", async () => {
      const dupRes = await practitionerA.post("/programs/999999/duplicate");
      expect(dupRes.status).toBe(404);
    });
  });
});