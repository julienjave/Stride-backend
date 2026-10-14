// Same reason this exists in main.ts and scripts/seed-exercises.ts — Jest,
// like ts-node, never auto-loads .env. AppModule's DrizzleModule needs
// POSTGRES_* in process.env the moment Test.createTestingModule() below
// tries to construct it, so this has to be the very first thing that runs.
import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
// Every assigned program needs a schedule (decided 2026-10-09). The tests in
// this file aren't about schedules (test/program-schedules.e2e-spec.ts is),
// so they all share this one.
const SCHEDULE = { type: 'times_per_week', timesPerWeek: 3 }

describe('AssignedPrograms (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const adminAgent = () => request.agent(app.getHttpServer())
  const practitionerAAgent = () => request.agent(app.getHttpServer())
  const practitionerBAgent = () => request.agent(app.getHttpServer())
  const patientAAgent = () => request.agent(app.getHttpServer())
  const patientBAgent = () => request.agent(app.getHttpServer())

  let admin: ReturnType<typeof adminAgent>
  let practitionerA: ReturnType<typeof practitionerAAgent>
  let practitionerB: ReturnType<typeof practitionerBAgent>
  let patientA: ReturnType<typeof patientAAgent>
  let patientB: ReturnType<typeof patientBAgent>
  let patientAId: number
  let exerciseId: number

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Every invitation email lands in memory — tests never send real
      // email, whatever EMAIL_TRANSPORT says in .env.
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue(new InMemoryEmailTransport())
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )

    sessionPool = new Pool({ connectionString: getDatabaseUrl() })
    const PgSessionStore = connectPgSimple(session)
    app.use(
      session({
        store: new PgSessionStore({
          pool: sessionPool,
          createTableIfMissing: true,
        }),
        secret: 'e2e-test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
      }),
    )
    app.use(passport.initialize())
    app.use(passport.session())

    await app.init()

    // A hard safety check, not just a naming convention to remember —
    // refuses to proceed at all unless genuinely connected to the
    // dedicated test database. Without this, accidentally running e2e
    // tests via the wrong npm script (plain `test:e2e` instead of
    // `test:e2e:fresh`) would TRUNCATE the real dev database with no
    // warning, since nothing else in this file would notice the difference.
    const db = app.get<DrizzleDb>(DRIZZLE)
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    )
    const currentDatabase = rows[0].current_database
    if (currentDatabase !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test". ` +
          'Did you run this via `npm run test:e2e:fresh` (not plain `test:e2e`)?',
      )
    }

    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = adminAgent()
    practitionerA = practitionerAAgent()
    practitionerB = practitionerBAgent()
    patientA = patientAAgent()
    patientB = patientBAgent()

    const stamp = Date.now()

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Assigned Programs E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'AP',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    const clinicId = clinicRes.body.clinicId

    await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
      clinicId,
    })
    await activateAccount(sessionPool, `practitioner-a-${stamp}@example.com`)
    await practitionerA.post('/auth/login').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
    })

    // practitionerB manages NO patients at all — no clinic membership.
    await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
    })
    await activateAccount(sessionPool, `practitioner-b-${stamp}@example.com`)
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    })

    const patientARes = await admin.post('/users').send({
      email: `patient-a-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Patient',
      lastName: 'A',
      dateOfBirth: '1990-01-01',
      clinicId,
    })
    await activateAccount(sessionPool, `patient-a-${stamp}@example.com`)
    patientAId = patientARes.body.id
    await patientA.post('/auth/login').send({
      email: `patient-a-${stamp}@example.com`,
      password: 'password123',
    })

    // Since the care team (decisions §3), sharing a clinic no longer makes a
    // practitioner "manage" a patient — being on the patient's care team does.
    // practitionerA joins through the real endpoint (an empty body = "join").
    const joinRes = await practitionerA
      .post(`/users/${patientAId}/care-team`)
      .send({})
    expect(joinRes.status).toBe(201)

    // patientB shares NO clinic with practitionerA.
    // Public self-registration was removed (accounts are created by
    // invitation): the admin creates this patient instead — still in no
    // clinic, like the self-registered one it replaces — then the account
    // is activated (test/support/accounts.ts) and signs in.
    await admin.post('/users').send({
      email: `patient-b-${stamp}@example.com`,
      firstName: 'Patient',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
      role: 'patient',
    })
    await activateAccount(sessionPool, `patient-b-${stamp}@example.com`)
    await patientB
      .post('/auth/login')
      .send({
        email: `patient-b-${stamp}@example.com`,
        password: 'password123',
      })

    const exerciseRes = await practitionerA.post('/exercises').send({
      name: 'AP E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    exerciseId = exerciseRes.body.id
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  it('rejects assigning a program to a patient the practitioner does not manage', async () => {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId: (await patientB.get('/auth/me')).body.id,
      title: 'Should Not Work',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    expect(res.status).toBe(403)
  })

  it('rejects a patient from ever creating an assigned program, even for themselves', async () => {
    const res = await patientA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Self Assigned',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    expect(res.status).toBe(403)
  })

  // THE most important test in the suite: assigning FROM a template must
  // copy the template's exercises into independent rows. Mutating the
  // template afterward — even deleting the exercise from it entirely —
  // must never be visible through the already-assigned program.
  it('copies template exercises at assignment time — later template edits never leak through', async () => {
    const templateRes = await practitionerA
      .post('/programs')
      .send({ title: 'Copy Guarantee Template' })
    const templateId = templateRes.body.id

    const addExerciseRes = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({
        exerciseId,
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: 'kg',
        sortOrder: 0,
      })
    expect(addExerciseRes.status).toBe(201)
    // addExercise returns the FULL enriched template (see
    // programs.e2e-spec.ts's identical fix), not the bare inserted row —
    // the row's own id has to be found inside the returned exercises
    // array, by matching the exerciseId this request actually sent.
    const templateExerciseId = addExerciseRes.body.exercises.find(
      (e: any) => e.exerciseId === exerciseId,
    ).id

    const assignRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Copy Guarantee Assignment',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      basedOnTemplateId: templateId,
    })
    expect(assignRes.status).toBe(201)
    const assignedProgramId = assignRes.body.id
    expect(assignRes.body.exercises).toHaveLength(1)
    // weight/weightUnit included here specifically because they were
    // once silently dropped by the copy logic — objectContaining alone
    // wouldn't have caught that (it only checks properties you remember
    // to list), which is exactly how this slipped through the first
    // time. Listing them explicitly here is the real regression guard.
    // name/primaryMuscles/instructions are the newer, bigger piece of
    // this same guarantee: the exercise's own descriptive fields, not
    // just its prescription.
    expect(assignRes.body.exercises[0]).toEqual(
      expect.objectContaining({
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: 'kg',
        name: 'AP E2E Squat',
        primaryMuscles: ['legs'],
        instructions: ['Step one'],
      }),
    )

    // Mutate the SOURCE template after the fact: change its prescription,
    // then remove the exercise from it entirely. Both status codes are
    // checked here — without that, a wrong templateExerciseId could
    // silently 404 against the real row, and this test would still pass
    // for the wrong reason: the assigned program is an independent copy
    // regardless of whether these calls actually reached anything.
    const templateEdit = await practitionerA
      .patch(`/programs/${templateId}/exercises/${templateExerciseId}`)
      .send({ sets: 99, reps: 1 })
    expect(templateEdit.status).toBe(200)
    const templateExerciseDelete = await practitionerA.delete(
      `/programs/${templateId}/exercises/${templateExerciseId}`,
    )
    expect(templateExerciseDelete.status).toBe(200)

    // THE actual scenario that motivated this entire piece of work: edit
    // the underlying EXERCISE itself (not just the template) — its
    // name and instructions, the same fields a patient would actually
    // read while following the program. Before this session's snapshot
    // work, this WOULD have silently changed what an already-assigned
    // patient sees, live, with no notice to anyone relying on it.
    const exerciseEdit = await practitionerA
      .patch(`/exercises/${exerciseId}`)
      .send({
        name: 'Renamed After Assignment',
        instructions: ['Completely different instructions'],
      })
    expect(exerciseEdit.status).toBe(200)

    const assignedAfterTemplateChanged = await practitionerA.get(
      `/assigned-programs/${assignedProgramId}`,
    )
    expect(assignedAfterTemplateChanged.status).toBe(200)
    expect(assignedAfterTemplateChanged.body.exercises).toHaveLength(1)
    // Still the ORIGINAL copied values — completely unaffected by the
    // template edit/deletion above, AND by editing the underlying
    // exercise itself just now. This second part is the actual point of
    // this whole piece of work: a patient already following this
    // program still sees exactly what was there when it was assigned,
    // not a live reflection of the exercise's current (renamed) state.
    expect(assignedAfterTemplateChanged.body.exercises[0]).toEqual(
      expect.objectContaining({
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: 'kg',
        name: 'AP E2E Squat',
        primaryMuscles: ['legs'],
        instructions: ['Step one'],
      }),
    )

    // Restored afterward — exerciseId is a FILE-WIDE shared fixture
    // (set up once in beforeAll, reused by many other tests below this
    // one via its id), so leaving it permanently renamed would be a
    // real cross-test pollution risk for anything added later that
    // reasonably assumes its name stays constant, even though nothing
    // CURRENTLY in this file checks it beyond this one test.
    const exerciseRestore = await practitionerA
      .patch(`/exercises/${exerciseId}`)
      .send({ name: 'AP E2E Squat', instructions: ['Step one'] })
    expect(exerciseRestore.status).toBe(200)
  })

  it('rejects assigning without either basedOnTemplateId or an inline exercises array', async () => {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Neither Provided',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
    })
    expect(res.status).toBe(400)
  })

  it('enforces assertCanView: admin, self-patient, and managing practitioner may view; nobody else', async () => {
    const createRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'View Boundary Program',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    const programId = createRes.body.id

    const asAdmin = await admin.get(`/assigned-programs/${programId}`)
    expect(asAdmin.status).toBe(200)

    const asSelf = await patientA.get(`/assigned-programs/${programId}`)
    expect(asSelf.status).toBe(200)

    const asManagingPractitioner = await practitionerA.get(
      `/assigned-programs/${programId}`,
    )
    expect(asManagingPractitioner.status).toBe(200)

    // Both become 404, not 403: RLS makes this row invisible to their
    // session before assertCanView's own check is ever reached — same
    // reasoning as the equivalent medical_files test.
    const asOtherPatient = await patientB.get(`/assigned-programs/${programId}`)
    expect(asOtherPatient.status).toBe(404)

    const asNonManagingPractitioner = await practitionerB.get(
      `/assigned-programs/${programId}`,
    )
    expect(asNonManagingPractitioner.status).toBe(404)
  })

  it('enforces assertCanManage: the owning PATIENT may never manage their own program', async () => {
    const createRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Manage Boundary Program',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    const programId = createRes.body.id

    const patientAttemptsManage = await patientA
      .patch(`/assigned-programs/${programId}`)
      .send({ title: 'Patient Should Not Be Able To Do This' })
    expect(patientAttemptsManage.status).toBe(403)

    const adminManages = await admin
      .patch(`/assigned-programs/${programId}`)
      .send({ title: 'Admin Edit' })
    expect(adminManages.status).toBe(200)
  })

  it('validates reorder as an exact permutation, and rejects a non-managing practitioner', async () => {
    const createRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Reorder Program',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    const programId = createRes.body.id
    const firstRowId = createRes.body.exercises[0].id

    const secondExerciseRes = await practitionerA.post('/exercises').send({
      name: 'AP E2E Lunge',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    const addSecondRes = await practitionerA
      .post(`/assigned-programs/${programId}/exercises`)
      .send({ exerciseId: secondExerciseRes.body.id, sortOrder: 1 })
    // The answer is the full program (step 3b-0; it used to be the bare
    // inserted row): the new row is the one that isn't the first.
    const secondRowId = (
      addSecondRes.body as { exercises: { id: number }[] }
    ).exercises.find((row) => row.id !== firstRowId)!.id

    const badOrder = await practitionerA
      .patch(`/assigned-programs/${programId}/exercises`)
      .send({ order: [firstRowId] })
    expect(badOrder.status).toBe(400)

    const goodOrder = await practitionerA
      .patch(`/assigned-programs/${programId}/exercises`)
      .send({ order: [secondRowId, firstRowId] })
    expect(goodOrder.status).toBe(200)

    // 404, not 403: the program row is invisible to practitionerB's RLS
    // session (they manage no patients), so findProgramOrThrow throws
    // before assertCanManage ever runs.
    const foreignOrder = await practitionerB
      .patch(`/assigned-programs/${programId}/exercises`)
      .send({ order: [secondRowId, firstRowId] })
    expect(foreignOrder.status).toBe(404)
  })

  it('rejects updating or removing an exercise row through the wrong assigned program (IDOR check)', async () => {
    const programARes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'IDOR Program A',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    const programBRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'IDOR Program B',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    const programAId = programARes.body.id
    const foreignRowId = programBRes.body.exercises[0].id

    const updateThroughWrongProgram = await practitionerA
      .patch(`/assigned-programs/${programAId}/exercises/${foreignRowId}`)
      .send({ sets: 5 })
    expect(updateThroughWrongProgram.status).toBe(404)

    const removeThroughWrongProgram = await practitionerA.delete(
      `/assigned-programs/${programAId}/exercises/${foreignRowId}`,
    )
    expect(removeThroughWrongProgram.status).toBe(404)
  })

  it("clears an assigned exercise's weight with explicit nulls, but rejects clearing only half of it", async () => {
    const programRes = await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Weight Clearing Program',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [
        { exerciseId, sets: 3, weight: 62.5, weightUnit: 'kg', sortOrder: 0 },
      ],
    })
    expect(programRes.status).toBe(201)
    const programId = programRes.body.id
    const rowId = programRes.body.exercises[0].id
    const rowUrl = `/assigned-programs/${programId}/exercises/${rowId}`
    const readRow = async () =>
      (
        await practitionerA.get(`/assigned-programs/${programId}`)
      ).body.exercises.find((e: any) => e.id === rowId)

    const halfCleared = await practitionerA
      .patch(rowUrl)
      .send({ weight: null, weightUnit: 'kg' })
    expect(halfCleared.status).toBe(400)

    // Rejected before this fix too — but for the WRONG reason (null
    // counted as "started," so @IsNumber rejected it). Now it's accepted.
    const cleared = await practitionerA
      .patch(rowUrl)
      .send({ weight: null, weightUnit: null, sets: null })
    expect(cleared.status).toBe(200)

    expect(await readRow()).toEqual(
      expect.objectContaining({ weight: null, weightUnit: null, sets: null }),
    )
  })

  it('scopes GET /assigned-programs by role: patient sees own, practitioner sees managed, admin sees all', async () => {
    await practitionerA.post('/assigned-programs').send({
      patientId: patientAId,
      title: 'Scope Check Program',
      startDate: '2026-01-01',
      schedule: SCHEDULE,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })

    const asPatient = await patientA.get('/assigned-programs')
    expect(asPatient.status).toBe(200)
    expect(asPatient.body.every((p: any) => p.patientId === patientAId)).toBe(
      true,
    )

    const asNonManagingPractitioner =
      await practitionerB.get('/assigned-programs')
    expect(asNonManagingPractitioner.status).toBe(200)
    expect(asNonManagingPractitioner.body).toEqual([])

    const asAdmin = await admin.get('/assigned-programs')
    expect(asAdmin.status).toBe(200)
    expect(asAdmin.body.length).toBeGreaterThan(0)
  })

  // --- ?patientId= (the practitioner's patient page, 2026-10-08) ---

  it("narrows GET /assigned-programs to one patient with ?patientId=, naming each program's assigner", async () => {
    // A second patient of practitionerA, with a program of their own: the
    // unfiltered list holds both patients' programs, the filtered one must not.
    const stamp = Date.now()
    const clinicId = (await admin.get(`/users/${patientAId}`)).body.clinics[0]
      .id
    const otherRes = await admin.post('/users').send({
      email: `patient-c-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Patient',
      lastName: 'C',
      dateOfBirth: '1991-01-01',
      clinicId,
    })
    const otherPatientId = otherRes.body.id
    expect(
      (await practitionerA.post(`/users/${otherPatientId}/care-team`).send({}))
        .status,
    ).toBe(201)
    for (const patientId of [patientAId, otherPatientId]) {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        title: `Filter Check ${patientId}`,
        startDate: '2026-01-01',
        schedule: SCHEDULE,
        exercises: [{ exerciseId, sortOrder: 0 }],
      })
      expect(res.status).toBe(201)
    }
    const practitionerAId = (await practitionerA.get('/auth/me')).body.id

    const all = await practitionerA.get('/assigned-programs')
    expect(all.body.some((p: any) => p.patientId === otherPatientId)).toBe(true)

    const res = await practitionerA.get(
      `/assigned-programs?patientId=${patientAId}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    expect(res.body.every((p: any) => p.patientId === patientAId)).toBe(true)
    // The assigner's id and name — and nothing else (no email, no contact
    // details): toStrictEqual fails on any extra key.
    for (const program of res.body) {
      expect(program.assigner).toStrictEqual({
        id: practitionerAId,
        firstName: 'Practitioner',
        lastName: 'A',
      })
    }
  })

  it('allows ?patientId= to the care team, the patient and an admin — and refuses anyone else with a 403, not an empty list', async () => {
    const url = `/assigned-programs?patientId=${patientAId}`
    expect((await practitionerA.get(url)).status).toBe(200)
    expect((await patientA.get(url)).status).toBe(200)
    expect((await admin.get(url)).status).toBe(200)

    for (const outsider of [practitionerB, patientB]) {
      const res = await outsider.get(url)
      expect(res.status).toBe(403)
      expect(res.body.message).toEqual([
        'You do not have permission to view this assigned program',
      ])
    }
  })

  it('rejects a ?patientId= that is not a positive whole number (400)', async () => {
    for (const bad of ['abc', '0', '1.5']) {
      const res = await practitionerA.get(`/assigned-programs?patientId=${bad}`)
      expect(res.status).toBe(400)
    }
  })
})
