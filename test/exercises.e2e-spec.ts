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
describe('Exercises (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  // request.agent() is supertest's built-in cookie jar — every call made
  // through the SAME agent automatically remembers and resends whatever
  // session cookie the server issued. This is the exact -b/-c juggling done
  // by hand with curl throughout this project, handled automatically.
  const adminAgent = () => request.agent(app.getHttpServer())
  const practitionerAAgent = () => request.agent(app.getHttpServer())
  const practitionerBAgent = () => request.agent(app.getHttpServer())
  const patientAgent = () => request.agent(app.getHttpServer())

  let admin: ReturnType<typeof adminAgent>
  let practitionerA: ReturnType<typeof practitionerAAgent>
  let practitionerB: ReturnType<typeof practitionerBAgent>
  let patient: ReturnType<typeof patientAgent>

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

    // Same session setup as main.ts — an e2e test needs the REAL middleware
    // stack, not just the DI-wired providers, since guards/sessions live in
    // middleware that main.ts sets up manually, outside AppModule itself.
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

    // Resets this test's starting state, so this file can run any number of
    // times in a row and always begin from a genuinely empty database.
    // CASCADE truncates every table with a foreign key pointing at
    // users/clinics regardless of that FK's own ON DELETE rule — safe ONLY
    // because this is the dedicated, disposable stride_test database,
    // confirmed by the check just above.
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
    patient = patientAgent()

    const stamp = Date.now()

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'E2E',
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

    await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
      clinicId,
    })
    await activateAccount(sessionPool, `practitioner-b-${stamp}@example.com`)
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    })

    // Public self-registration was removed (accounts are created by
    // invitation): the admin creates this patient instead — still in no
    // clinic, like the self-registered one it replaces — then the account
    // is activated (test/support/accounts.ts) and signs in.
    await admin.post('/users').send({
      email: `patient-${stamp}@example.com`,
      firstName: 'E2E',
      lastName: 'Patient',
      dateOfBirth: '1990-01-01',
      role: 'patient',
    })
    await activateAccount(sessionPool, `patient-${stamp}@example.com`)
    await patient
      .post('/auth/login')
      .send({ email: `patient-${stamp}@example.com`, password: 'password123' })
  })

  afterAll(async () => {
    await app.close()
    // app.close() only closes what Nest's own DI container manages.
    // sessionPool was created manually, outside that container, so it needs
    // to be closed explicitly too.
    await sessionPool.end()
  })

  // A minimal buffer stands in for real image bytes here — imageUploadOptions'
  // fileFilter only inspects the multipart Content-Type header (set explicitly
  // below via .attach()'s options), never the buffer's actual content, and
  // StorageService.upload() just forwards whatever bytes it's given straight
  // to RustFS with no format validation of its own.
  const fakeImage = (label: string) =>
    Buffer.from(`fake-image-content-${label}`)

  const createExercise = async (
    agent: ReturnType<typeof practitionerAAgent>,
    name: string,
  ) => {
    const res = await agent.post('/exercises').send({
      name,
      primaryMuscles: ['shoulders'],
      instructions: ['Step one', 'Step two'],
    })
    return res
  }

  it('walks the full multi-role, ownership-based access scenario', async () => {
    const created = await createExercise(practitionerA, 'E2E Wall Slide')
    expect(created.status).toBe(201)
    expect(created.body.source).toBe('custom')

    const patientCreate = await patient.post('/exercises').send({
      name: 'Should Not Work',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    expect(patientCreate.status).toBe(403)

    // An admin CAN edit an exercise they did not create.
    const adminEdit = await admin
      .patch(`/exercises/${created.body.id}`)
      .send({ name: 'Corrected By Admin' })
    expect(adminEdit.status).toBe(200)
    expect(adminEdit.body.name).toBe('Corrected By Admin')

    // A DIFFERENT practitioner cannot edit exercise A created.
    const otherPractitionerEdit = await practitionerB
      .patch(`/exercises/${created.body.id}`)
      .send({ name: 'Should Not Work Either' })
    expect(otherPractitionerEdit.status).toBe(403)
  })

  // --- Image upload (POST /exercises/:id/images) ---

  it('lets the owning practitioner upload images, appending to the existing gallery', async () => {
    const created = await createExercise(practitionerA, 'Image Upload Exercise')
    const id = created.body.id

    const firstUpload = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('one'), {
        filename: 'one.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('two'), {
        filename: 'two.png',
        contentType: 'image/png',
      })
    expect(firstUpload.status).toBe(201)
    expect(firstUpload.body.images).toHaveLength(2)
    expect(
      firstUpload.body.images.every(
        (image: { objectKey: string; url: string }) =>
          image.objectKey.startsWith(`exercises/${id}/upload-`) &&
          // A real signed URL, not just "some truthy value" — confirms
          // the withImages conversion actually ran against real storage,
          // not just that the objectKey survived the round trip.
          typeof image.url === 'string' &&
          image.url.length > 0,
      ),
    ).toBe(true)

    // A second upload APPENDS rather than replacing — seeded/edited
    // exercises can legitimately have several distinct images (e.g. a
    // movement's start and end position).
    const secondUpload = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('three'), {
        filename: 'three.png',
        contentType: 'image/png',
      })
    expect(secondUpload.status).toBe(201)
    expect(secondUpload.body.images).toHaveLength(3)
    expect(
      secondUpload.body.images
        .slice(0, 2)
        .map((image: { objectKey: string }) => image.objectKey),
    ).toEqual(
      firstUpload.body.images.map(
        (image: { objectKey: string }) => image.objectKey,
      ),
    )
  })

  it('rejects an image upload from a practitioner who does not own the exercise', async () => {
    const created = await createExercise(
      practitionerA,
      'Image Ownership Exercise',
    )
    const id = created.body.id

    const res = await practitionerB
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('intruder'), {
        filename: 'intruder.png',
        contentType: 'image/png',
      })
    expect(res.status).toBe(403)
  })

  it('rejects an image upload from a patient — practitioner/admin only', async () => {
    const created = await createExercise(practitionerA, 'Image Role Exercise')
    const id = created.body.id

    const res = await patient
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('patient'), {
        filename: 'patient.png',
        contentType: 'image/png',
      })
    expect(res.status).toBe(403)
  })

  it('rejects an image upload request with no files attached', async () => {
    const created = await createExercise(
      practitionerA,
      'Image No Files Exercise',
    )
    const id = created.body.id

    const res = await practitionerA.post(`/exercises/${id}/images`)
    expect(res.status).toBe(400)
  })

  // --- Reorder images (PATCH /exercises/:id/images) ---

  it('reorders the gallery when the new order is an exact permutation of the current images', async () => {
    const created = await createExercise(
      practitionerA,
      'Reorder Valid Exercise',
    )
    const id = created.body.id

    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('r1'), {
        filename: 'r1.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('r2'), {
        filename: 'r2.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('r3'), {
        filename: 'r3.png',
        contentType: 'image/png',
      })
    const [k1, k2, k3] = uploaded.body.images.map(
      (image: { objectKey: string }) => image.objectKey,
    )

    const reordered = await practitionerA
      .patch(`/exercises/${id}/images`)
      .send({ order: [k3, k1, k2] })
    expect(reordered.status).toBe(200)
    expect(
      reordered.body.images.map(
        (image: { objectKey: string }) => image.objectKey,
      ),
    ).toEqual([k3, k1, k2])
  })

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
    const created = await createExercise(
      practitionerA,
      'Reorder Duplicate Exercise',
    )
    const id = created.body.id

    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('d1'), {
        filename: 'd1.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('d2'), {
        filename: 'd2.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('d3'), {
        filename: 'd3.png',
        contentType: 'image/png',
      })
    const [k1, k2, k3] = uploaded.body.images.map(
      (image: { objectKey: string }) => image.objectKey,
    )

    const res = await practitionerA
      .patch(`/exercises/${id}/images`)
      // Every real key present (so a deduped-set-only check sees a perfect
      // match), but k1 is padded in a second time, one longer than the
      // actual 3-image gallery.
      .send({ order: [k1, k2, k3, k1] })
    expect(res.status).toBe(400)

    // The gallery must be untouched by the rejected request — still all
    // three original keys, in their original order.
    const fetched = await practitionerA.get(`/exercises/${id}`)
    expect(
      fetched.body.images.map(
        (image: { objectKey: string }) => image.objectKey,
      ),
    ).toEqual([k1, k2, k3])
  })

  it('rejects a reorder request from a practitioner who does not own the exercise', async () => {
    const created = await createExercise(
      practitionerA,
      'Reorder Ownership Exercise',
    )
    const id = created.body.id

    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('o1'), {
        filename: 'o1.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('o2'), {
        filename: 'o2.png',
        contentType: 'image/png',
      })
    const [k1, k2] = uploaded.body.images.map(
      (image: { objectKey: string }) => image.objectKey,
    )

    const res = await practitionerB
      .patch(`/exercises/${id}/images`)
      .send({ order: [k2, k1] })
    expect(res.status).toBe(403)
  })

  // --- The list's cover photo (GET /exercises — the thumbnails, Phase 7) ---

  it('lists the FIRST photo as a cacheable cover, never the storage keys, and follows a reorder', async () => {
    const name = `Cover Probe ${Date.now()}`
    const created = await createExercise(practitionerA, name)
    const id = created.body.id
    const uploaded = await practitionerA
      .post(`/exercises/${id}/images`)
      .attach('files', fakeImage('cover-one'), {
        filename: 'one.png',
        contentType: 'image/png',
      })
      .attach('files', fakeImage('cover-two'), {
        filename: 'two.png',
        contentType: 'image/png',
      })
    expect(uploaded.status).toBe(201)
    const [k1, k2] = uploaded.body.images.map(
      (image: { objectKey: string }) => image.objectKey,
    )

    // As the patient: the list is open to every signed-in role.
    const listed = await patient.get('/exercises').query({ search: name })
    expect(listed.status).toBe(200)
    const [row] = listed.body.data
    expect(row.id).toBe(id)
    expect(row).not.toHaveProperty('mediaUrls')
    const cover = new URL(row.coverUrl)
    expect(cover.pathname).toBe(`/stride/${k1}`)
    // Signed at the start of an hour (minutes and seconds zero), for two
    // hours — the backend's real clock, so only the shape can be checked
    // here; the exact moments are unit-tested.
    expect(cover.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{2}0000Z$/)
    expect(cover.searchParams.get('X-Amz-Expires')).toBe('7200')

    // The URL really works against the storage server: the photo's bytes,
    // with the Cache-Control the signature asked for (S3's
    // response-cache-control override — a storage server that ignored it
    // would fail HERE).
    const served = await fetch(row.coverUrl)
    expect(served.status).toBe(200)
    expect(served.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(Buffer.from(await served.arrayBuffer())).toEqual(
      fakeImage('cover-one'),
    )

    // Putting the second photo first makes it the cover.
    const reordered = await practitionerA
      .patch(`/exercises/${id}/images`)
      .send({ order: [k2, k1] })
    expect(reordered.status).toBe(200)
    const relisted = await patient.get('/exercises').query({ search: name })
    expect(new URL(relisted.body.data[0].coverUrl).pathname).toBe(
      `/stride/${k2}`,
    )
  })

  it('lists null as the cover of an exercise with no photo', async () => {
    const name = `No Cover Probe ${Date.now()}`
    await createExercise(practitionerA, name)

    const listed = await patient.get('/exercises').query({ search: name })
    expect(listed.status).toBe(200)
    expect(listed.body.data).toHaveLength(1)
    expect(listed.body.data[0].coverUrl).toBeNull()
  })

  // --- Pagination (GET /exercises) ---

  // --- The description rules (2026-10-14) ---

  // The library shares its description rules with a program's own copy
  // (src/common/validators/exercise-description.ts). Over HTTP: `null` was a
  // 500 for each of the five fields on a PATCH (UpdateExerciseDto was a bare
  // PartialType, whose @IsOptional() lets null through to the NOT NULL
  // columns), and blank names and items were stored. Every refusal below is
  // a 400 and changes nothing.
  describe('the description rules', () => {
    // Each read states the shape it expects instead of reading `any` (the
    // project's known e2e lint category).
    interface ExerciseBody {
      id: number
      name: string
      primaryMuscles: string[]
      secondaryMuscles: string[]
      equipment: string[]
      instructions: string[]
    }
    const exerciseOf = (res: request.Response) => res.body as ExerciseBody
    const messagesOf = (res: request.Response) =>
      (res.body as { message: string[] }).message

    let exerciseId: number
    const AS_CREATED = {
      name: 'Description Rules Lunge',
      primaryMuscles: ['shoulders'],
      secondaryMuscles: [],
      equipment: [],
      instructions: ['Step one', 'Step two'],
    }

    beforeAll(async () => {
      const created = await createExercise(
        practitionerA,
        'Description Rules Lunge',
      )
      expect(created.status).toBe(201)
      exerciseId = exerciseOf(created).id
    })

    it.each([
      ['name', null, 'name must be a string'],
      ['primaryMuscles', null, 'primaryMuscles must be a list'],
      [
        'secondaryMuscles',
        null,
        'secondaryMuscles must be a list: send [] for none',
      ],
      ['equipment', null, 'equipment must be a list: send [] for none'],
      ['instructions', null, 'instructions must be a list'],
      ['name', '  ', "The exercise's name can't be blank"],
      ['primaryMuscles', [' '], "A primary muscle can't be blank"],
      ['instructions', [''], "An instruction step can't be blank"],
    ])(
      'refuses a PATCH of %s = %j (%s), changing nothing',
      async (field, value, message) => {
        const res = await practitionerA
          .patch(`/exercises/${exerciseId}`)
          .send({ [field]: value })
        expect(res.status).toBe(400)
        // The first message explains; a `null` also fails the field's
        // other rules, listed after it.
        expect(messagesOf(res)[0]).toBe(message)

        const after = await practitionerA.get(`/exercises/${exerciseId}`)
        expect(exerciseOf(after)).toMatchObject(AS_CREATED)
      },
    )

    it('refuses creating an exercise with a blank name, or null for an optional list', async () => {
      const blank = await practitionerA.post('/exercises').send({
        name: '   ',
        primaryMuscles: ['legs'],
        instructions: ['Step one'],
      })
      expect(blank.status).toBe(400)
      expect(messagesOf(blank)).toEqual(["The exercise's name can't be blank"])

      // "None" is [] — or leaving the list out — never null (it used to be
      // read as [] when creating, but was a 500 when editing).
      const nullList = await practitionerA.post('/exercises').send({
        name: 'Null Equipment Squat',
        primaryMuscles: ['legs'],
        instructions: ['Step one'],
        equipment: null,
      })
      expect(nullList.status).toBe(400)
      expect(messagesOf(nullList)[0]).toBe(
        'equipment must be a list: send [] for none',
      )
    })

    // The neighbours of the refusals: what IS allowed.
    it('accepts [] for an optional list, and an instruction step past the old 500-character limit', async () => {
      const longStep = 'Keep the knee over the foot. '.repeat(25).trim()
      expect(longStep.length).toBeGreaterThan(500)

      const res = await practitionerA
        .patch(`/exercises/${exerciseId}`)
        .send({ equipment: [], instructions: ['Step one', longStep] })
      expect(res.status).toBe(200)
      expect(exerciseOf(res)).toMatchObject({
        equipment: [],
        instructions: ['Step one', longStep],
      })
    })
  })

  describe('pagination', () => {
    // Scoped with a per-run "search" term so counts stay exact regardless of
    // exercises created by the other it() blocks in this file (or by
    // previous runs' leftover data, in the unlikely case TRUNCATE didn't
    // apply) — none of those match this stamp.
    const stamp = Date.now()
    const probeName = (i: number) => `Pagination Probe ${stamp} ${i}`
    const TOTAL = 23

    beforeAll(async () => {
      await Promise.all(
        Array.from({ length: TOTAL }, (_, i) =>
          createExercise(practitionerA, probeName(i)),
        ),
      )
    })

    it('defaults to page 1 with a limit of 20 and reports accurate pagination metadata', async () => {
      const res = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}` })
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(20)
      expect(res.body.meta).toEqual({
        total: TOTAL,
        page: 1,
        limit: 20,
        totalPages: 2,
      })
    })

    it('returns the remaining partial page and a disjoint set of rows on page 2', async () => {
      const page1 = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}`, page: 1, limit: 20 })
      const page2 = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}`, page: 2, limit: 20 })

      expect(page2.status).toBe(200)
      expect(page2.body.data).toHaveLength(3)
      expect(page2.body.meta).toEqual({
        total: TOTAL,
        page: 2,
        limit: 20,
        totalPages: 2,
      })

      const page1Ids = page1.body.data.map((e: any) => e.id)
      const page2Ids = page2.body.data.map((e: any) => e.id)
      expect(page1Ids.some((id: number) => page2Ids.includes(id))).toBe(false)
    })

    it('honors a smaller explicit limit', async () => {
      const res = await patient
        .get('/exercises')
        .query({ search: `Pagination Probe ${stamp}`, page: 1, limit: 10 })
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(10)
      expect(res.body.meta).toEqual({
        total: TOTAL,
        page: 1,
        limit: 10,
        totalPages: 3,
      })
    })

    it('rejects a limit above the hard ceiling of 100', async () => {
      const res = await patient.get('/exercises').query({ limit: 101 })
      expect(res.status).toBe(400)
    })

    it('rejects a page below 1', async () => {
      const res = await patient.get('/exercises').query({ page: 0 })
      expect(res.status).toBe(400)
    })
  })

  // --- The list's order (GET /exercises — Phase 7) ---

  describe('order', () => {
    const stamp = Date.now()
    const create = async (name: string) =>
      (await createExercise(practitionerA, name)).body.id as number
    const namesOn = async (search: string) =>
      (await patient.get('/exercises').query({ search })).body.data.map(
        (e: { name: string }) => e.name,
      )

    // Two cases in one list, so the test fails without lower() on EITHER
    // collation:
    //   - "b" before "C": the C collation (this sandbox's) sorts every
    //     capital before every small letter — plain `name` would give
    //     C, D, a, b, d;
    //   - "D" before "d", created in that order: the same name once
    //     lowered, so the id decides — en_US (the Docker image's) sorts a
    //     small letter before its capital, so plain `name` would give "d"
    //     first.
    it('lists names A to Z whatever their case, equal names by creation', async () => {
      const prefix = `Order ${stamp}`
      for (const letter of ['b', 'D', 'a', 'd', 'C']) {
        await create(`${prefix} ${letter}`)
      }

      expect(await namesOn(prefix)).toEqual([
        `${prefix} a`,
        `${prefix} b`,
        `${prefix} C`,
        `${prefix} D`,
        `${prefix} d`,
      ])
    })

    // The bug itself: page by page, every exercise once. Rows with the SAME
    // name, and the first one edited — an UPDATE writes a new copy of the
    // row at the end of the table, so the order on disk is no longer the
    // order of creation. Only the id can tell the three apart.
    it('pages through equal names one at a time, each exactly once, by id', async () => {
      const name = `Same Name ${stamp}`
      const ids = [await create(name), await create(name), await create(name)]
      const edited = await practitionerA
        .patch(`/exercises/${ids[0]}`)
        .send({ instructions: ['Edited, so stored again'] })
      expect(edited.status).toBe(200)

      const seen: number[] = []
      for (const page of [1, 2, 3]) {
        const res = await patient
          .get('/exercises')
          .query({ search: name, page, limit: 1 })
        expect(res.status).toBe(200)
        seen.push(...res.body.data.map((e: { id: number }) => e.id))
      }
      expect(seen).toEqual(ids)
    })
  })

  // --- Muscle search, mine filter, and author (GET /exercises) ---

  describe('search, mine filter, and author', () => {
    // Same isolation reasoning as the pagination block above — a unique
    // stamp per run so these assertions can't accidentally match one of
    // the ~800 real seeded exercises, or leftover fixtures from another
    // describe block in this same file.
    const stamp = Date.now()

    const createExerciseAs = (
      agent: ReturnType<typeof practitionerAAgent>,
      body: {
        name: string
        primaryMuscles: string[]
        secondaryMuscles?: string[]
      },
    ) => agent.post('/exercises').send({ ...body, instructions: ['Step'] })

    it('matches on a primary muscle, not just the name', async () => {
      const muscle = `PrimaryProbe${stamp}`
      const created = await createExerciseAs(practitionerA, {
        name: `Unrelated Name ${stamp}`,
        primaryMuscles: [muscle],
      })
      expect(created.status).toBe(201)

      // Searching a SUBSTRING of the muscle, not the exact string —
      // proves this is a real ILIKE partial match, not an exact-equality
      // check that would only work by coincidence.
      const res = await patient
        .get('/exercises')
        .query({ search: 'PrimaryProbe' + stamp })
      expect(res.status).toBe(200)
      expect(res.body.data.map((e: any) => e.id)).toContain(created.body.id)
    })

    it('matches on a secondary muscle too, not just primary', async () => {
      const muscle = `SecondaryProbe${stamp}`
      const created = await createExerciseAs(practitionerA, {
        name: `Also Unrelated ${stamp}`,
        primaryMuscles: ['core'],
        secondaryMuscles: [muscle],
      })
      expect(created.status).toBe(201)

      const res = await patient
        .get('/exercises')
        .query({ search: 'SecondaryProbe' + stamp })
      expect(res.status).toBe(200)
      expect(res.body.data.map((e: any) => e.id)).toContain(created.body.id)
    })

    it('does not match a search term that appears in neither the name nor either muscle array', async () => {
      const res = await patient
        .get('/exercises')
        .query({ search: `NothingShouldMatchThis${stamp}` })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
      expect(res.body.meta.total).toBe(0)
    })

    it("mine=true shows only the requesting user's own exercises, excluding another practitioner's", async () => {
      const mineNamePrefix = `MineProbe${stamp}`
      const ownExercise = await createExerciseAs(practitionerA, {
        name: `${mineNamePrefix} Own`,
        primaryMuscles: ['core'],
      })
      const otherExercise = await createExerciseAs(practitionerB, {
        name: `${mineNamePrefix} Other`,
        primaryMuscles: ['core'],
      })
      expect(ownExercise.status).toBe(201)
      expect(otherExercise.status).toBe(201)

      const mineOnly = await practitionerA
        .get('/exercises')
        .query({ search: mineNamePrefix, mine: true })
      expect(mineOnly.status).toBe(200)
      const mineIds = mineOnly.body.data.map((e: any) => e.id)
      expect(mineIds).toContain(ownExercise.body.id)
      expect(mineIds).not.toContain(otherExercise.body.id)

      // Same search WITHOUT mine=true should show both — confirms the
      // filter above is genuinely doing something, not just always
      // returning everyone's exercises by coincidence.
      const everyone = await practitionerA
        .get('/exercises')
        .query({ search: mineNamePrefix })
      const everyoneIds = everyone.body.data.map((e: any) => e.id)
      expect(everyoneIds).toContain(ownExercise.body.id)
      expect(everyoneIds).toContain(otherExercise.body.id)
    })

    it('mine=false behaves the same as omitting mine entirely, not as its own exclusion filter', async () => {
      // Guards against a subtle bug the includeInactive precedent this
      // pattern is modeled on explicitly warns about: naively converting
      // the string "false" to a boolean can behave unexpectedly. This
      // confirms ?mine=false genuinely means "no filter," not "only
      // exercises that are NOT mine" and not "treated as true."
      const name = `MineFalseProbe${stamp}`
      const created = await createExerciseAs(practitionerA, {
        name,
        primaryMuscles: ['core'],
      })

      const res = await practitionerA
        .get('/exercises')
        .query({ search: name, mine: false })
      expect(res.status).toBe(200)
      expect(res.body.data.map((e: any) => e.id)).toContain(created.body.id)
    })

    it("attaches the creator's name as author for a custom exercise, and null for one with no creator", async () => {
      const name = `AuthorProbe${stamp}`
      const created = await createExerciseAs(practitionerA, {
        name,
        primaryMuscles: ['core'],
      })

      const res = await patient.get('/exercises').query({ search: name })
      expect(res.status).toBe(200)
      const match = res.body.data.find((e: any) => e.id === created.body.id)
      // "Practitioner"/"A" match practitionerA's own firstName/lastName
      // from this file's outer beforeAll — asserting the REAL name here,
      // not just "author is truthy," to prove the right row was joined,
      // not just any row.
      expect(match.author).toEqual({
        firstName: 'Practitioner',
        lastName: 'A',
      })

      // Inserted via sessionPool — the same elevated, RLS-bypassing
      // connection this file already uses for TRUNCATE, not the
      // RLS-governed `db` connection the app itself uses. This isn't
      // optional here: exercises_insert's own RLS policy explicitly
      // requires source = 'custom' (see migrations/0006_exercises_
      // programs_rls.sql's own comment: "a directly issued INSERT can
      // never claim to be an 'api'-sourced row") — by design, there is
      // NO connection running under normal app privileges that could
      // ever create a source: 'api' row, which is exactly why this
      // needs the owner-level pool instead. This also makes the
      // assertion below deterministic and self-contained: it doesn't
      // depend on whether the disposable stride_test database has ever
      // had the real seed-exercises.ts script run against it (unlikely
      // — that's normally only run against a real dev database), unlike
      // relying on an unfiltered page happening to contain a real
      // seeded row.
      const noCreatorName = `NoCreatorProbe${stamp}`
      await sessionPool.query(
        `INSERT INTO exercises (name, primary_muscles, instructions, source, created_by)
         VALUES ($1, $2, $3, 'api', NULL)`,
        [noCreatorName, ['core'], ['Step']],
      )

      const res2 = await patient
        .get('/exercises')
        .query({ search: noCreatorName })
      expect(res2.status).toBe(200)
      expect(res2.body.data).toHaveLength(1)
      expect(res2.body.data[0].author).toBeNull()
    })
  })
})
