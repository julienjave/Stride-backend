/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// Same reason as every e2e file: Jest never auto-loads .env, and AppModule
// needs POSTGRES_* the moment it's built.
import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { sql, type SQL } from 'drizzle-orm'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { addDays, utcToday } from '../src/common/calendar-date'

// Tailoring an assigned program's exercises — the backend of step 3b-0
// (decided 2026-10-13):
//   1. the four exercise routes (add, edit / move, reorder, remove) follow
//      the audit convention — ONE complete entry each, in the change's own
//      transaction, none when nothing changes — and answer with the full
//      program;
//   2. removing an exercise a session used RETIRES it (kept for the
//      sessions, out of the program); one no session used is deleted — the
//      foreign key decides, and the race between the two is proven;
//   3. each session keeps a COPY of what it was prescribed;
//   4. the end date never moves into the past;
//   5. the database's own guarantees (migrations 0032 and 0033).
//
// Its own file — first for the rate limits (60 requests a minute per route),
// off in the e2e suites since 2026-10-15 (test/support/e2e-env.ts). Dates
// come from the real clock (utcToday).
//
// Logins: 3 (practitioner A, practitioner C, the patient) — the admin's
// session comes from register-clinic.
describe('Program exercises (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb

  let admin: ReturnType<typeof request.agent>
  // On the patient's care team.
  let practitionerA: ReturnType<typeof request.agent>
  // Same clinic, NOT on the care team.
  let practitionerC: ReturnType<typeof request.agent>
  let patient: ReturnType<typeof request.agent>

  let patientId: number
  let practitionerAId: number
  let practitionerCId: number
  // Library exercises written by A.
  let rowExerciseId: number
  let plankExerciseId: number
  // Two workouts: A ("Upper": Row 2 × 10) and B ("Core": Plank 45 s).
  let templateId: number

  const today = utcToday()

  // supertest types `res.body` as `any`, and every property read on an
  // `any` is what the project's strict lint flags — the known e2e category
  // (deferred-improvements.md). Here each read says the shape it expects
  // instead: `bodyOf<SessionBody>(res).exercises`. The cast checks nothing
  // at runtime (the assertions do); it states what the test relies on.
  function bodyOf<T>(res: request.Response): T {
    return res.body as T
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    // Never anything but the dedicated test database (see
    // assigned-programs.e2e-spec.ts for why this check exists).
    db = app.get<DrizzleDb>(DRIZZLE)
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    )
    if (rows[0].current_database !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${rows[0].current_database}" — expected "stride_test".`,
      )
    }
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    const stamp = Date.now()
    admin = request.agent(app.getHttpServer())
    practitionerA = request.agent(app.getHttpServer())
    practitionerC = request.agent(app.getHttpServer())
    patient = request.agent(app.getHttpServer())

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Exercises E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Ex',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(clinicRes.body)}`)
    }
    const clinicId = bodyOf<{ clinicId: number }>(clinicRes).clinicId

    // Created by the admin, then logged in.
    async function createUser(
      body: Record<string, unknown>,
      agent: ReturnType<typeof request.agent>,
    ): Promise<number> {
      const res = await admin.post('/users').send({ ...body, clinicId })
      if (res.status !== 201) {
        throw new Error(`Setup failed: ${JSON.stringify(res.body)}`)
      }
      await activateAccount(sessionPool, body.email as string)
      await agent
        .post('/auth/login')
        .send({ email: body.email, password: 'password123' })
      return bodyOf<{ id: number }>(res).id
    }

    practitionerAId = await createUser(
      {
        email: `pa-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'A',
        licenseNumber: `EX-A-${stamp}`,
      },
      practitionerA,
    )
    practitionerCId = await createUser(
      {
        email: `pc-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'C',
        licenseNumber: `EX-C-${stamp}`,
      },
      practitionerC,
    )
    patientId = await createUser(
      {
        email: `patient-${stamp}@example.com`,
        role: 'patient',
        firstName: 'Ex',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
      },
      patient,
    )
    const join = await practitionerA
      .post(`/users/${patientId}/care-team`)
      .send({})
    expect(join.status).toBe(201)

    for (const [name, muscle] of [
      ['Exercises E2E Row', 'back'],
      ['Exercises E2E Plank', 'core'],
    ]) {
      const res = await practitionerA.post('/exercises').send({
        name,
        primaryMuscles: [muscle],
        instructions: ['Do it'],
      })
      expect(res.status).toBe(201)
      const { id } = bodyOf<{ id: number }>(res)
      if (name.endsWith('Row')) rowExerciseId = id
      else plankExerciseId = id
    }
    const created = await practitionerA
      .post('/programs')
      .send({ title: 'Exercises Template' })
    templateId = bodyOf<{ id: number }>(created).id
    const template = await practitionerA.get(`/programs/${templateId}`)
    const workoutA = bodyOf<Program>(template).workouts[0].id
    await practitionerA
      .patch(`/programs/${templateId}/workouts/${workoutA}`)
      .send({ name: 'Upper' })
    const withB = await practitionerA
      .post(`/programs/${templateId}/workouts`)
      .send({ name: 'Core' })
    const workoutB = bodyOf<Program>(withB).workouts[1].id
    const row = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({
        exerciseId: rowExerciseId,
        sets: 2,
        reps: 10,
        sortOrder: 0,
        workoutId: workoutA,
      })
    expect(row.status).toBe(201)
    const plank = await practitionerA
      .post(`/programs/${templateId}/exercises`)
      .send({
        exerciseId: plankExerciseId,
        durationInSeconds: 45,
        sortOrder: 0,
        workoutId: workoutB,
      })
    expect(plank.status).toBe(201)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  interface Exercise {
    id: number
    workoutId: number
    exerciseId: number
    name: string
    sets: number | null
    reps: number | null
    durationInSeconds: number | null
    sortOrder: number
    retiredAt: string | null
    retiredBy: number | null
    primaryMuscles: string[]
    secondaryMuscles: string[]
    equipment: string[]
    instructions: string[]
    // The LIBRARY exercise's photos, read live (2026-10-14): a signed URL
    // each, never the object key.
    images: { url: string }[]
  }
  interface Program {
    id: number
    status: string
    workouts: { id: number; name: string | null; sortOrder: number }[]
    exercises: Exercise[]
    retiredExercises: Exercise[]
  }
  // A session as GET /sessions/:id and POST /sessions answer: its checklist
  // rows carry the copy of their prescription (step 3b-0) and description
  // (2026-10-14).
  interface SessionBody {
    id: number
    exercises: {
      id: number
      assignedProgramExerciseId: number
      name: string
      sets: number | null
      reps: number | null
      primaryMuscles: string[]
      secondaryMuscles: string[]
      equipment: string[]
      instructions: string[]
    }[]
  }
  // A refusal's body (HttpExceptionFilter: `message` is always a list).
  interface ErrorBody {
    message: string[]
  }
  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    details: Record<string, unknown> | null
  }

  // Every day is workout A — sessions here always do A, unless a test asks.
  const EVERY_DAY_A = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      workoutIndex: 0,
    })),
  }

  // A program for the patient from the two-workout template, started
  // yesterday unless said otherwise (so a session today is inside it).
  async function assign(startedDaysAgo = 1): Promise<Program> {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId,
      basedOnTemplateId: templateId,
      title: 'Exercises Program',
      startDate: addDays(today, -startedDaysAgo),
      schedule: EVERY_DAY_A,
    })
    expect(res.status).toBe(201)
    return res.body as Program
  }

  const workoutA = (program: Program) => program.workouts[0].id
  const workoutB = (program: Program) => program.workouts[1].id
  const rowOf = (program: Program) =>
    program.exercises.find((e) => e.exerciseId === rowExerciseId)!

  // The patient starts a session of workout A today.
  async function startSession(program: Program) {
    const res = await patient.post('/sessions').send({
      assignedProgramId: program.id,
      localDate: today,
      workoutId: workoutA(program),
    })
    return res
  }

  // What audit_logs holds for one program, read as the owner. The generic
  // interceptor writes AFTER the response, fire-and-forget: the pause gives
  // a duplicate the chance to appear — otherwise "no generic entry" could
  // pass just by being early.
  async function auditTrail(programId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, details FROM audit_logs
       WHERE entity_type = 'assigned-programs' AND entity_id = $1 ORDER BY id`,
      [programId],
    )
    return rows
  }

  // The entries after the creation — every one a NAMED action (the generic
  // interceptor's twin would read "POST /assigned-programs/…": a route that
  // lost its @AuditedByService() tag fails here), by practitioner A, about
  // the patient.
  async function changeEntries(programId: number) {
    const trail = await auditTrail(programId)
    expect(trail[0].action).toBe('ASSIGNED_PROGRAM_CREATED')
    for (const entry of trail.slice(1)) {
      expect(entry.action).toMatch(/^ASSIGNED_PROGRAM_[A-Z_]+$/)
      expect(entry.performed_by).toBe(practitionerAId)
      expect(entry.target_user_id).toBe(patientId)
    }
    return trail.slice(1)
  }

  async function programExerciseRow(id: number) {
    const { rows } = await sessionPool.query<{
      retired_at: Date | null
      retired_by: number | null
    }>(
      'SELECT retired_at, retired_by FROM assigned_program_exercises WHERE id = $1',
      [id],
    )
    return rows[0]
  }

  // --- 1. Adding ---------------------------------------------------------------------------------------------

  describe('adding an exercise', () => {
    it("appends it after the workout's LAST position (not a count), with one complete entry, answering with the full program", async () => {
      const program = await assign()
      // A gap: an exercise placed at position 5 explicitly.
      const placed = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({
          exerciseId: plankExerciseId,
          workoutId: workoutA(program),
          sortOrder: 5,
        })
      expect(placed.status).toBe(201)

      const res = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({
          exerciseId: plankExerciseId,
          workoutId: workoutA(program),
          sets: 3,
        })

      expect(res.status).toBe(201)
      const body = res.body as Program
      // The full program: both workouts, every exercise, nothing retired.
      expect(body.workouts).toHaveLength(2)
      expect(body.retiredExercises).toEqual([])
      const inA = body.exercises.filter(
        (e) => e.workoutId === workoutA(program),
      )
      expect(inA.map((e) => e.sortOrder)).toEqual([0, 5, 6])

      const entries = await changeEntries(program.id)
      expect(entries.map((e) => e.action)).toEqual([
        'ASSIGNED_PROGRAM_EXERCISE_ADDED',
        'ASSIGNED_PROGRAM_EXERCISE_ADDED',
      ])
      expect(entries[1].details).toEqual({
        exercise: {
          id: inA[2].id,
          workoutId: workoutA(program),
          exerciseId: plankExerciseId,
          name: 'Exercises E2E Plank',
          primaryMuscles: ['core'],
          secondaryMuscles: [],
          equipment: [],
          instructions: ['Do it'],
          sets: 3,
          reps: null,
          durationInSeconds: null,
          weight: null,
          weightUnit: null,
          sortOrder: 6,
          notes: null,
        },
      })
    })

    // Off the care team, the program is invisible (row-level security):
    // nothing written, nothing recorded.
    it('refuses a practitioner off the care team, recording nothing', async () => {
      const program = await assign()

      const res = await practitionerC
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({ exerciseId: plankExerciseId })

      expect(res.status).toBe(404)
      expect(await changeEntries(program.id)).toEqual([])
    })
  })

  // --- 2. Editing and moving ---------------------------------------------------------------------------------

  describe('editing an exercise', () => {
    it('records only what changed, before → after', async () => {
      const program = await assign()
      const row = rowOf(program)

      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
        // reps re-sent as stored: not a change.
        .send({ sets: 4, reps: 10 })

      expect(res.status).toBe(200)
      expect(rowOf(res.body as Program).sets).toBe(4)
      expect((await changeEntries(program.id)).map((e) => e.details)).toEqual([
        {
          exerciseRowId: row.id,
          name: 'Exercises E2E Row',
          changes: { sets: { from: 2, to: 4 } },
        },
      ])
    })

    it('records nothing when nothing changes', async () => {
      const program = await assign()
      const row = rowOf(program)

      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
        .send({ sets: 2, workoutId: workoutA(program) })

      expect(res.status).toBe(200)
      expect(await changeEntries(program.id)).toEqual([])
    })

    it('moves it to the end of another workout, recorded as the workout and position changes', async () => {
      const program = await assign()
      const row = rowOf(program)

      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
        .send({ workoutId: workoutB(program) })

      expect(res.status).toBe(200)
      // B had the Plank at 0: the Row goes to 1.
      expect(rowOf(res.body as Program)).toMatchObject({
        workoutId: workoutB(program),
        sortOrder: 1,
      })
      const [entry] = await changeEntries(program.id)
      expect(entry).toMatchObject({
        action: 'ASSIGNED_PROGRAM_EXERCISE_UPDATED',
        details: {
          changes: {
            workoutId: { from: workoutA(program), to: workoutB(program) },
            sortOrder: { from: 0, to: 1 },
          },
        },
      })
    })

    // The row lock (lockProgramExercise): an edit that arrives while
    // another change of the same row is in flight WAITS for it, then reads
    // the row as that change left it — so its audit entry's "from" is the
    // value it really replaced. (Without the lock it would read the old
    // committed value, 2, and record "from 2" for a change from 4.) The
    // other change is made here by the owner, so the test decides when it
    // commits.
    it('waits for a change in flight, and records the value it really replaced', async () => {
      const program = await assign()
      const row = rowOf(program)
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          'UPDATE assigned_program_exercises SET sets = 4 WHERE id = $1',
          [row.id],
        )
        let answered = false
        const pending = practitionerA
          .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
          .send({ sets: 5 })
          .then((res) => {
            answered = true
            return res
          })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(answered).toBe(false)
        await client.query('COMMIT')
        expect((await pending).status).toBe(200)
      } finally {
        client.release()
      }
      expect((await changeEntries(program.id)).map((e) => e.details)).toEqual([
        {
          exerciseRowId: row.id,
          name: 'Exercises E2E Row',
          changes: { sets: { from: 4, to: 5 } },
        },
      ])
    })
  })

  // --- 3. Reordering ---------------------------------------------------------------------------------------

  describe('reordering a workout', () => {
    it('records the workout and the order before → after, and nothing for the same order', async () => {
      const program = await assign()
      const added = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({ exerciseId: plankExerciseId, workoutId: workoutA(program) })
      const [first, second] = (added.body as Program).exercises
        .filter((e) => e.workoutId === workoutA(program))
        .map((e) => e.id)

      const same = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises`)
        .send({ workoutId: workoutA(program), order: [first, second] })
      expect(same.status).toBe(200)
      const swapped = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises`)
        .send({ workoutId: workoutA(program), order: [second, first] })
      expect(swapped.status).toBe(200)

      const entries = await changeEntries(program.id)
      // The ADDED entry, then ONE reorder: the same order recorded nothing.
      expect(entries.map((e) => e.action)).toEqual([
        'ASSIGNED_PROGRAM_EXERCISE_ADDED',
        'ASSIGNED_PROGRAM_EXERCISES_REORDERED',
      ])
      expect(entries[1].details).toEqual({
        workoutId: workoutA(program),
        from: [first, second],
        to: [second, first],
      })
    })

    // "from" is the order by POSITION, not the order the rows happen to be
    // stored in. Here the two disagree: the owner rewrites the first row's
    // position, then the second's, so the table holds them first-then-second
    // while their positions say second-then-first. A read without ORDER BY
    // would return storage order — "from [first, second]", which equals the
    // new order, and the reorder would be taken for no change at all.
    it('records the order by position, whatever order the rows are stored in', async () => {
      const program = await assign()
      const added = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({ exerciseId: plankExerciseId, workoutId: workoutA(program) })
      const [first, second] = (added.body as Program).exercises
        .filter((e) => e.workoutId === workoutA(program))
        .map((e) => e.id)
      await sessionPool.query(
        'UPDATE assigned_program_exercises SET sort_order = 1 WHERE id = $1',
        [first],
      )
      await sessionPool.query(
        'UPDATE assigned_program_exercises SET sort_order = 0 WHERE id = $1',
        [second],
      )

      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises`)
        .send({ workoutId: workoutA(program), order: [first, second] })
      expect(res.status).toBe(200)

      const entries = await changeEntries(program.id)
      expect(entries.at(-1)).toEqual(
        expect.objectContaining({
          action: 'ASSIGNED_PROGRAM_EXERCISES_REORDERED',
          details: {
            workoutId: workoutA(program),
            from: [second, first],
            to: [first, second],
          },
        }),
      )
    })
  })

  // --- 4. Removing: deleted or retired -------------------------------------------------------------------------

  describe('removing an exercise', () => {
    it('DELETES one no session used, recorded whole', async () => {
      const program = await assign()
      const row = rowOf(program)
      // The preview first (3b-1): what the removal WILL do — and then does.
      const preview = await practitionerA.get(
        `/assigned-programs/${program.id}/exercises/${row.id}/removal`,
      )
      expect(preview.status).toBe(200)
      expect(preview.body).toStrictEqual({
        outcome: 'deleted',
        sessionCount: 0,
      })

      const res = await practitionerA.delete(
        `/assigned-programs/${program.id}/exercises/${row.id}`,
      )

      expect(res.status).toBe(200)
      const body = res.body as Program
      expect(body.exercises.map((e) => e.id)).not.toContain(row.id)
      expect(body.retiredExercises).toEqual([])
      expect(await programExerciseRow(row.id)).toBeUndefined()
      // ONE entry: the preview, a read, records nothing.
      const entries = await changeEntries(program.id)
      expect(entries).toHaveLength(1)
      const [entry] = entries
      expect(entry.action).toBe('ASSIGNED_PROGRAM_EXERCISE_REMOVED')
      expect(entry.details).toMatchObject({
        exercise: { id: row.id, name: 'Exercises E2E Row', sets: 2, reps: 10 },
      })
    })

    describe('one a session used', () => {
      let program: Program
      let row: Exercise
      let sessionId: number
      beforeAll(async () => {
        program = await assign()
        row = rowOf(program)
        // A second exercise in A, so A still has one once the Row is out.
        const added = await practitionerA
          .post(`/assigned-programs/${program.id}/exercises`)
          .send({ exerciseId: plankExerciseId, workoutId: workoutA(program) })
        expect(added.status).toBe(201)
        const started = await startSession(program)
        expect(started.status).toBe(201)
        sessionId = bodyOf<SessionBody>(started).id
      })

      // Before removing it: the preview says it will be KEPT, for the one
      // session that used it.
      it('previews keeping it for the session that used it', async () => {
        const preview = await practitionerA.get(
          `/assigned-programs/${program.id}/exercises/${row.id}/removal`,
        )
        expect(preview.status).toBe(200)
        expect(preview.body).toStrictEqual({
          outcome: 'retired',
          sessionCount: 1,
        })
      })

      // The neighbour: B's exercise, in the same program, used by no session
      // — while A's are. The count is about THIS exercise only; counting the
      // patient's other checklist rows would say "retired" here.
      it('previews deleting an exercise no session used, next to ones that were', async () => {
        const unused = program.exercises.find(
          (e) => e.workoutId === workoutB(program),
        )!
        const preview = await practitionerA.get(
          `/assigned-programs/${program.id}/exercises/${unused.id}/removal`,
        )
        expect(preview.body).toStrictEqual({
          outcome: 'deleted',
          sessionCount: 0,
        })
      })

      // "How many SESSIONS", not how many checklist rows: a second row for
      // the same exercise in the same session (written here by the owner —
      // the app writes one) still counts as one session. Rolled back. (The
      // copy of the description has no default since 0034: a row written by
      // hand must carry it, like the app's.)
      it('counts sessions, not checklist rows', async () => {
        const client = await sessionPool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `INSERT INTO session_exercises
               (session_id, assigned_program_exercise_id, name, primary_muscles,
                secondary_muscles, equipment, instructions, completed, sort_order)
             VALUES ($1, $2, 'Exercises E2E Row', ARRAY['back'], '{}', '{}',
                     ARRAY['Do it'], false, 9)`,
            [sessionId, row.id],
          )
          const { rows } = await client.query<{
            sessions: string
            rows: string
          }>(
            `SELECT count(DISTINCT session_id) AS sessions, count(*) AS rows
             FROM session_exercises WHERE assigned_program_exercise_id = $1`,
            [row.id],
          )
          // The fixture makes the two counts DISAGREE (1 session, 2 rows).
          expect(rows[0]).toEqual({ sessions: '1', rows: '2' })
          await client.query('COMMIT')
          const preview = await practitionerA.get(
            `/assigned-programs/${program.id}/exercises/${row.id}/removal`,
          )
          expect(preview.body).toStrictEqual({
            outcome: 'retired',
            sessionCount: 1,
          })
        } finally {
          await client.query(
            'DELETE FROM session_exercises WHERE session_id = $1 AND sort_order = 9',
            [sessionId],
          )
          client.release()
        }
      })

      // The preview, as the people who couldn't remove it: the patient (who
      // sees the program — 403) and a practitioner off the care team (who
      // doesn't — 404).
      it("refuses the preview to anyone who couldn't remove it", async () => {
        const url = `/assigned-programs/${program.id}/exercises/${row.id}/removal`
        expect((await patient.get(url)).status).toBe(403)
        expect((await practitionerC.get(url)).status).toBe(404)
      })

      it('RETIRES it: out of the program, kept — by whom, when — and recorded', async () => {
        const res = await practitionerA.delete(
          `/assigned-programs/${program.id}/exercises/${row.id}`,
        )

        expect(res.status).toBe(200)
        const body = res.body as Program
        expect(body.exercises.map((e) => e.id)).not.toContain(row.id)
        expect(body.retiredExercises).toHaveLength(1)
        expect(body.retiredExercises[0]).toMatchObject({
          id: row.id,
          retiredBy: practitionerAId,
        })
        expect(body.retiredExercises[0].retiredAt).not.toBeNull()
        const stored = await programExerciseRow(row.id)
        expect(stored.retired_by).toBe(practitionerAId)
        const entries = await changeEntries(program.id)
        expect(entries.at(-1)).toMatchObject({
          action: 'ASSIGNED_PROGRAM_EXERCISE_RETIRED',
          details: { exercise: { id: row.id, name: 'Exercises E2E Row' } },
        })
      })

      // The session that used it still lists it, with what it prescribed.
      it("leaves the session's checklist as it was", async () => {
        const res = await patient.get(`/sessions/${sessionId}`)
        expect(res.status).toBe(200)
        const { exercises } = bodyOf<SessionBody>(res)
        expect(
          exercises.find((e) => e.assignedProgramExerciseId === row.id),
        ).toMatchObject({ name: 'Exercises E2E Row', sets: 2 })
      })

      it('refuses to change it, or to remove it again', async () => {
        const edit = await practitionerA
          .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
          .send({ sets: 5 })
        expect(edit.status).toBe(409)
        expect(bodyOf<ErrorBody>(edit).message).toEqual([
          'This exercise was removed from the program, so it can no longer change',
        ])
        const again = await practitionerA.delete(
          `/assigned-programs/${program.id}/exercises/${row.id}`,
        )
        expect(again.status).toBe(409)
        expect(bodyOf<ErrorBody>(again).message).toEqual([
          'This exercise was already removed from the program',
        ])
        const preview = await practitionerA.get(
          `/assigned-programs/${program.id}/exercises/${row.id}/removal`,
        )
        expect(preview.status).toBe(409)
        expect(bodyOf<ErrorBody>(preview).message).toEqual([
          'This exercise was already removed from the program',
        ])
      })

      // Reordering A is about its ACTIVE exercises: the retired one isn't
      // part of the order any more.
      it("leaves it out of the workout's order", async () => {
        const current = await practitionerA.get(
          `/assigned-programs/${program.id}`,
        )
        const active = (current.body as Program).exercises
          .filter((e) => e.workoutId === workoutA(program))
          .map((e) => e.id)
        expect(active).toHaveLength(1)
        const withRetired = await practitionerA
          .patch(`/assigned-programs/${program.id}/exercises`)
          .send({ workoutId: workoutA(program), order: [...active, row.id] })
        expect(withRetired.status).toBe(400)
        const withoutIt = await practitionerA
          .patch(`/assigned-programs/${program.id}/exercises`)
          .send({ workoutId: workoutA(program), order: active })
        expect(withoutIt.status).toBe(200)
      })

      it("leaves it out of a new session's checklist", async () => {
        // One open session per program (2026-10-15): the session that used
        // the exercise is stopped first, so today can start another.
        const stopped = await patient
          .post(`/sessions/${sessionId}/stop`)
          .send({ reason: 'other' })
        expect(stopped.status).toBe(200)
        const res = await startSession(program)
        expect(res.status).toBe(201)
        const ids = bodyOf<SessionBody>(res).exercises.map(
          (e) => e.assignedProgramExerciseId,
        )
        expect(ids).not.toContain(row.id)
        expect(ids).toHaveLength(1)
      })

      // Last, as it closes the program: "Assign again" copies the ACTIVE
      // exercises — the retired one isn't brought back.
      it('leaves it out of "Assign again"', async () => {
        const cancelled = await practitionerA
          .post(`/assigned-programs/${program.id}/cancel`)
          .send({ today })
        expect(bodyOf<{ outcome: string }>(cancelled).outcome).toBe('cancelled')
        // A closed program has nothing to remove: the preview is a 409 too.
        const active = (
          await practitionerA.get(`/assigned-programs/${program.id}`)
        ).body as Program
        const closedPreview = await practitionerA.get(
          `/assigned-programs/${program.id}/exercises/${active.exercises[0].id}/removal`,
        )
        expect(closedPreview.status).toBe(409)
        const again = await practitionerA.post('/assigned-programs').send({
          patientId,
          basedOnProgramId: program.id,
          title: 'Exercises Program, again',
          startDate: today,
          schedule: EVERY_DAY_A,
        })
        expect(again.status).toBe(201)
        const names = (again.body as Program).exercises.map((e) => e.exerciseId)
        expect(names).not.toContain(rowExerciseId)
        expect(names).toHaveLength(2)
      })
    })

    // The race, made deterministic: a session's checklist row pointing at
    // the exercise is being written (uncommitted) when the removal arrives.
    // The removal's row lock (FOR UPDATE) conflicts with the lock that
    // insert's foreign-key check holds (FOR KEY SHARE), so it WAITS; once the
    // session commits, its DELETE is refused by the foreign key — inside the
    // savepoint — and the exercise is retired. Without the savepoint, the
    // retiring UPDATE would fail ("current transaction is aborted") → 500.
    it('waits for a session being written with it, then retires it', async () => {
      const program = await assign()
      const row = rowOf(program)
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        // As the owner (no row-level security, no triggers): a session of A,
        // and its checklist row for the Row.
        const {
          rows: [s],
        } = await client.query<{ id: number }>(
          `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
             scheduled_date, local_date, status, started_at)
           VALUES ($1, $2, $3, now(), $4, 'in_progress', now()) RETURNING id`,
          [program.id, workoutA(program), patientId, today],
        )
        await client.query(
          `INSERT INTO session_exercises
             (session_id, assigned_program_exercise_id, name, primary_muscles,
              secondary_muscles, equipment, instructions, completed, sort_order)
           VALUES ($1, $2, 'Exercises E2E Row', ARRAY['back'], '{}', '{}',
                   ARRAY['Do it'], false, 0)`,
          [s.id, row.id],
        )
        let answered = false
        const pending = practitionerA
          .delete(`/assigned-programs/${program.id}/exercises/${row.id}`)
          .then((res) => {
            answered = true
            return res
          })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(answered).toBe(false)
        await client.query('COMMIT')
        const res = await pending
        expect(res.status).toBe(200)
        expect((res.body as Program).retiredExercises.map((e) => e.id)).toEqual(
          [row.id],
        )
      } finally {
        client.release()
      }
    })

    // The other side of the race: the practitioner's DELETE of an unused
    // exercise is in flight (uncommitted, holding the row) when the patient
    // starts a session whose checklist was read with it. The checklist row's
    // foreign-key check waits; once the delete commits, it fails — and the
    // patient gets a 409 "start again", not a 500. (The DELETE is made here
    // by the owner, so the test controls when it commits.)
    it('answers a session started in the middle of a deletion with a 409', async () => {
      const program = await assign()
      const row = rowOf(program)
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          'DELETE FROM assigned_program_exercises WHERE id = $1',
          [row.id],
        )
        let answered = false
        const pending = startSession(program).then((res) => {
          answered = true
          return res
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(answered).toBe(false)
        await client.query('COMMIT')
        const res = await pending
        expect(res.status).toBe(409)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          'Your program was just changed: start the session again',
        ])
      } finally {
        client.release()
      }
    })
  })

  // --- 5. The session's copy of its prescription and description -------------------------------------------

  describe("a session's copy of its prescription and description", () => {
    // What the library's "Exercises E2E Row" says (beforeAll), copied by the
    // program, then by the session.
    const ROW_DESCRIPTION = {
      primaryMuscles: ['back'],
      secondaryMuscles: [],
      equipment: [],
      instructions: ['Do it'],
    }

    it('keeps what the session was given when it started, whatever the program says next', async () => {
      const program = await assign()
      const row = rowOf(program)
      const started = await startSession(program)
      expect(started.status).toBe(201)
      // Copied when the session starts: the answer already carries it.
      const rowOfSession = (body: SessionBody) =>
        body.exercises.find((e) => e.assignedProgramExerciseId === row.id)
      expect(rowOfSession(bodyOf<SessionBody>(started))).toMatchObject(
        ROW_DESCRIPTION,
      )

      // The practitioner tailors the exercise for this patient — every
      // copied field changes, so each one the session failed to keep would
      // show below.
      const edited = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
        .send({
          sets: 4,
          reps: 8,
          name: 'Bent-over row',
          primaryMuscles: ['lats'],
          secondaryMuscles: ['biceps'],
          equipment: ['dumbbell'],
          instructions: ['Pull to the ribs', 'Stop if the back hurts'],
        })
      expect(edited.status).toBe(200)

      const res = await patient.get(
        `/sessions/${bodyOf<SessionBody>(started).id}`,
      )
      expect(rowOfSession(bodyOf<SessionBody>(res))).toMatchObject({
        name: 'Exercises E2E Row',
        sets: 2,
        reps: 10,
        ...ROW_DESCRIPTION,
      })
    })
  })

  // --- 5b. The description -------------------------------------------------------------------------------

  // The program's own copy of the exercise's description, edited per
  // patient (2026-10-14). The rules are exercise-description.ts's, checked in
  // depth by its validation spec; here, over HTTP: every refusal is a 400
  // (never a 500), changes nothing, and records nothing.
  describe('the description', () => {
    it.each([
      // `null` for each of the five — each was a 500 (the null trap).
      ['name', null, 'name must be a string'],
      ['primaryMuscles', null, 'primaryMuscles must be a list'],
      [
        'secondaryMuscles',
        null,
        'secondaryMuscles must be a list: send [] for none',
      ],
      ['equipment', null, 'equipment must be a list: send [] for none'],
      ['instructions', null, 'instructions must be a list'],
      // Blank values — each used to be stored.
      ['name', '   ', "The exercise's name can't be blank"],
      ['primaryMuscles', ['  '], "A primary muscle can't be blank"],
      ['instructions', ['Do it', ''], "An instruction step can't be blank"],
      ['equipment', [''], "A piece of equipment can't be blank"],
    ])(
      'refuses %s = %j (%s), changing nothing and recording nothing',
      async (field, value, message) => {
        const program = await assign()
        const row = rowOf(program)

        const res = await practitionerA
          .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
          .send({ [field]: value })

        expect(res.status).toBe(400)
        // The FIRST message is the one that explains (a `null` also fails
        // the field's other rules, listed after it).
        expect(bodyOf<ErrorBody>(res).message[0]).toBe(message)
        const after = await practitionerA.get(
          `/assigned-programs/${program.id}`,
        )
        expect(rowOf(bodyOf<Program>(after))).toMatchObject({
          name: 'Exercises E2E Row',
          primaryMuscles: ['back'],
          secondaryMuscles: [],
          equipment: [],
          instructions: ['Do it'],
        })
        expect(await changeEntries(program.id)).toEqual([])
      },
    )

    it('records a real change, lists compared item by item; [] says "none"', async () => {
      const program = await assign()
      const row = rowOf(program)
      // A step as long as the imported library's longest kind (they reach
      // 744 characters; the limit is now 1,000).
      const longStep = 'Slowly. '.repeat(100).trim()

      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
        // primaryMuscles re-sent as stored: an EQUAL list (a new array, the
        // same items) is not a change.
        .send({
          primaryMuscles: ['back'],
          equipment: ['band'],
          instructions: ['Do it', longStep],
        })
      expect(res.status).toBe(200)
      // [] = no equipment: accepted, and recorded as a change too.
      const cleared = await practitionerA
        .patch(`/assigned-programs/${program.id}/exercises/${row.id}`)
        .send({ equipment: [] })
      expect(cleared.status).toBe(200)
      expect(rowOf(bodyOf<Program>(cleared)).equipment).toEqual([])

      expect(
        (await changeEntries(program.id)).map((e) => [e.action, e.details]),
      ).toEqual([
        [
          'ASSIGNED_PROGRAM_EXERCISE_UPDATED',
          {
            exerciseRowId: row.id,
            name: 'Exercises E2E Row',
            changes: {
              equipment: { from: [], to: ['band'] },
              instructions: { from: ['Do it'], to: ['Do it', longStep] },
            },
          },
        ],
        [
          'ASSIGNED_PROGRAM_EXERCISE_UPDATED',
          {
            exerciseRowId: row.id,
            name: 'Exercises E2E Row',
            changes: { equipment: { from: ['band'], to: [] } },
          },
        ],
      ])
    })
  })

  // --- 6. The title -------------------------------------------------------------------------------------------

  // Step 3b-2: a program's title can't be blank — renaming (PATCH) and
  // creating (POST) share one rule (program-title.decorator.ts). Both used
  // to store '' and '   '.
  describe('the title', () => {
    it('refuses a blank or null title on a PATCH, changing nothing and recording nothing', async () => {
      const program = await assign()
      for (const title of ['', '   ']) {
        const res = await practitionerA
          .patch(`/assigned-programs/${program.id}`)
          .send({ title })
        expect(res.status).toBe(400)
        expect(bodyOf<ErrorBody>(res).message).toEqual([
          "The program's title can't be blank",
        ])
      }
      // null too: the column is NOT NULL, so a 400, never a 500
      // (@ValidateIf(isPresent)) — every rule it breaks is listed.
      const nullRes = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ title: null })
      expect(nullRes.status).toBe(400)
      expect(bodyOf<ErrorBody>(nullRes).message).toEqual([
        'title must be a string',
        'title must be shorter than or equal to 200 characters',
        "The program's title can't be blank",
      ])
      const after = await practitionerA.get(`/assigned-programs/${program.id}`)
      expect(bodyOf<{ title: string }>(after).title).toBe('Exercises Program')
      // A refused request writes no entry (the pipe refuses it before the
      // service runs).
      expect(await changeEntries(program.id)).toEqual([])
    })

    it('records a real rename, before → after', async () => {
      const program = await assign()
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ title: 'Knee Rehab — Pat, phase 2' })
      expect(res.status).toBe(200)
      const entries = await changeEntries(program.id)
      expect(entries.map((entry) => [entry.action, entry.details])).toEqual([
        [
          'ASSIGNED_PROGRAM_UPDATED',
          {
            changes: {
              title: {
                from: 'Exercises Program',
                to: 'Knee Rehab — Pat, phase 2',
              },
            },
          },
        ],
      ])
    })

    it('refuses creating a program with a blank title', async () => {
      const res = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnTemplateId: templateId,
        title: '   ',
        startDate: today,
        schedule: EVERY_DAY_A,
      })
      expect(res.status).toBe(400)
      expect(bodyOf<ErrorBody>(res).message).toEqual([
        "The program's title can't be blank",
      ])
    })
  })

  // --- 7. The end date ---------------------------------------------------------------------------------------

  describe('the end date', () => {
    // Started 10 days ago: an end 3 days ago is after the start — so the
    // refusal is about the past, not about the order of the dates.
    it('never moves into the past; today is fine', async () => {
      const program = await assign(10)

      const past = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ endDate: addDays(today, -3) })
      expect(past.status).toBe(400)
      expect(bodyOf<ErrorBody>(past).message).toEqual([
        "The end date can't be moved into the past: to end the program now, complete or cancel it",
      ])
      const now = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ endDate: today })
      expect(now.status).toBe(200)
      expect(bodyOf<{ endDate: string }>(now).endDate).toBe(today)
    })
  })

  // --- 7b. Photos ----------------------------------------------------------------------------------------------

  // Decided 2026-10-14: a program exercise shows its LIBRARY exercise's
  // photos, LIVE. The program copies the clinical record (prescription and
  // description); photos are illustrations, improved once for everyone. These
  // tests use their own library exercise, with real uploads to storage.
  describe('photos', () => {
    // The library's own answer about its photos (it pairs each URL with its
    // object key, which reorder and remove take).
    interface LibraryExercise {
      id: number
      images: { objectKey: string; url: string }[]
    }
    // A signed URL's PATH names the file; its query (the signature, the
    // expiry) differs every time it's signed — so photos are compared by path.
    const pathOf = (url: string) => new URL(url).pathname
    const photosOf = (program: Program, exerciseId: number) =>
      program.exercises
        .find((e) => e.exerciseId === exerciseId)!
        .images.map((image) => pathOf(image.url))

    let libraryId: number
    let library: LibraryExercise
    let program: Program

    beforeAll(async () => {
      const created = await practitionerA.post('/exercises').send({
        name: 'Exercises E2E Bridge',
        primaryMuscles: ['glutes'],
        instructions: ['Lift the hips'],
      })
      expect(created.status).toBe(201)
      libraryId = bodyOf<{ id: number }>(created).id
      const uploaded = await practitionerA
        .post(`/exercises/${libraryId}/images`)
        .attach('files', Buffer.from('bridge-photo-one'), {
          filename: 'one.png',
          contentType: 'image/png',
        })
        .attach('files', Buffer.from('bridge-photo-two'), {
          filename: 'two.png',
          contentType: 'image/png',
        })
      expect(uploaded.status).toBe(201)
      library = bodyOf<LibraryExercise>(uploaded)
      expect(library.images).toHaveLength(2)

      program = await assign()
      const added = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({ exerciseId: libraryId })
      expect(added.status).toBe(201)
      program = bodyOf<Program>(added)
    })

    it("shows the library's photos as working signed URLs, without their keys", async () => {
      const row = program.exercises.find((e) => e.exerciseId === libraryId)!
      // Only `url` — toStrictEqual fails on an objectKey (or anything else).
      expect(row.images.map((image) => Object.keys(image))).toStrictEqual([
        ['url'],
        ['url'],
      ])
      expect(photosOf(program, libraryId)).toEqual(
        library.images.map((image) => pathOf(image.url)),
      )
      // A real signed URL: storage serves the file to whoever holds it.
      const file = await fetch(row.images[0].url)
      expect(file.status).toBe(200)
      expect(await file.text()).toBe('bridge-photo-one')
      // An exercise with no library photos shows none.
      expect(rowOf(program).images).toEqual([])
    })

    it('follows the library LIVE: reordered, removed, then the exercise archived', async () => {
      const [first, second] = library.images.map((image) => image.objectKey)
      const read = async () => {
        const res = await practitionerA.get(`/assigned-programs/${program.id}`)
        expect(res.status).toBe(200)
        return photosOf(bodyOf<Program>(res), libraryId)
      }
      const pathFor = (key: string) =>
        pathOf(library.images.find((image) => image.objectKey === key)!.url)

      const reordered = await practitionerA
        .patch(`/exercises/${libraryId}/images`)
        .send({ order: [second, first] })
      expect(reordered.status).toBe(200)
      expect(await read()).toEqual([pathFor(second), pathFor(first)])

      const removed = await practitionerA
        .delete(`/exercises/${libraryId}/images`)
        .send({ objectKey: second })
      expect(removed.status).toBe(200)
      expect(await read()).toEqual([pathFor(first)])

      // Archiving a library exercise only flags its row: the program still
      // uses it, so its photo still shows.
      const archived = await practitionerA.delete(`/exercises/${libraryId}`)
      expect(archived.status).toBe(200)
      expect(await read()).toEqual([pathFor(first)])
    })

    // The patient's own screens (Phase 4) read their program — under THEIR
    // database context, where the library is readable too.
    it('shows the patient the same photos', async () => {
      const res = await patient.get(`/assigned-programs/${program.id}`)
      expect(res.status).toBe(200)
      expect(photosOf(bodyOf<Program>(res), libraryId)).toHaveLength(1)
    })
  })

  // --- 8. The database's own guarantees ----------------------------------------------------------------------

  // What node-postgres reports, through Drizzle's wrapper (the original
  // error is in `cause`) — the code and, when there is one, the constraint.
  function pgError(error: unknown): { code?: string; constraint?: string } {
    let current: unknown = error
    for (let depth = 0; depth < 5; depth++) {
      if (typeof current !== 'object' || current === null) return {}
      const fields = current as {
        code?: unknown
        constraint?: unknown
        cause?: unknown
      }
      if (typeof fields.code === 'string') {
        return {
          code: fields.code,
          ...(typeof fields.constraint === 'string'
            ? { constraint: fields.constraint }
            : {}),
        }
      }
      current = fields.cause
    }
    return {}
  }

  describe('database guarantees', () => {
    // As the OWNER, in a transaction always rolled back: the constraints
    // hold for everyone; the triggers exempt the owner.
    async function asOwner(statement: string, params: unknown[]) {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        const { rowCount } = await client.query(statement, params)
        return { rowCount }
      } catch (error) {
        return pgError(error)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    type Actor = { userId: number; role: string }
    class RolledBack extends Error {
      constructor(readonly rows: Record<string, unknown>[]) {
        super('rolled back on purpose')
      }
    }
    // As the APP's role (the restricted connection the running app uses),
    // with an actor's context set the way withRlsContext sets it. The
    // result is the statement's rows, or the error that stopped it. Always
    // rolled back.
    async function run(actor: Actor, statement: SQL) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true),
                       set_config('app.current_role', ${actor.role}, true)`,
          )
          throw new RolledBack((await tx.execute(statement)).rows)
        })
      } catch (error) {
        if (error instanceof RolledBack) return { rows: error.rows }
        return { error: pgError(error) }
      }
      throw new Error('unreachable: run() always rolls back')
    }
    const asA = (): Actor => ({ userId: practitionerAId, role: 'practitioner' })
    const asPatient = (): Actor => ({ userId: patientId, role: 'patient' })

    let program: Program
    let active: Exercise
    let retired: Exercise
    let sessionExerciseId: number
    beforeAll(async () => {
      program = await assign()
      active = program.exercises.find((e) => e.workoutId === workoutB(program))!
      retired = rowOf(program)
      const added = await practitionerA
        .post(`/assigned-programs/${program.id}/exercises`)
        .send({ exerciseId: plankExerciseId, workoutId: workoutA(program) })
      expect(added.status).toBe(201)
      const started = await startSession(program)
      expect(started.status).toBe(201)
      sessionExerciseId = bodyOf<SessionBody>(started).exercises.find(
        (e) => e.assignedProgramExerciseId === retired.id,
      )!.id
      const removed = await practitionerA.delete(
        `/assigned-programs/${program.id}/exercises/${retired.id}`,
      )
      expect((removed.body as Program).retiredExercises).toHaveLength(1)
    })

    it('makes retiring set both columns or neither (CHECK)', async () => {
      expect(
        await asOwner(
          'UPDATE assigned_program_exercises SET retired_at = now() WHERE id = $1',
          [active.id],
        ),
      ).toEqual({
        code: '23514',
        constraint: 'assigned_program_exercises_retired_together',
      })
    })

    // The title CHECKs (migration 0035): nothing visible = refused, on
    // both tables, whoever writes — the owner included, who bypasses row
    // security and the closed-program guard but never a CHECK.
    it.each([
      ['program_templates', 'program_templates_title_not_blank'],
      ['assigned_programs', 'assigned_programs_title_not_blank'],
    ])('refuses a blank title in %s (CHECK)', async (table, constraint) => {
      const id = table === 'program_templates' ? templateId : program.id
      for (const title of ['', '   ']) {
        expect(
          await asOwner(`UPDATE ${table} SET title = $2 WHERE id = $1`, [
            id,
            title,
          ]),
        ).toEqual({ code: '23514', constraint })
      }
      // The neighbour: spaces AROUND real words are a title. (rowCount 1:
      // the row was found and changed — then rolled back.)
      expect(
        await asOwner(`UPDATE ${table} SET title = '  Knee  ' WHERE id = $1`, [
          id,
        ]),
      ).toEqual({ rowCount: 1 })
    })

    it("keeps a session's exercise from being deleted (RESTRICT)", async () => {
      expect(
        await asOwner('DELETE FROM assigned_program_exercises WHERE id = $1', [
          retired.id,
        ]),
      ).toEqual({
        code: '23503',
        constraint: 'session_exercises_program_exercise_fk',
      })
    })

    // The care team can update the program's exercises (the UPDATE policy)
    // — but not a retired one, by any route.
    it('refuses any change to a retired exercise, for the app', async () => {
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_program_exercises SET sets = 5 WHERE id = ${retired.id}`,
        ),
      ).toEqual({
        error: {
          code: '23514',
          constraint: 'assigned_program_exercise_retired',
        },
      })
      // "Un-retiring" is a change like any other.
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_program_exercises SET retired_at = NULL, retired_by = NULL WHERE id = ${retired.id}`,
        ),
      ).toEqual({
        error: {
          code: '23514',
          constraint: 'assigned_program_exercise_retired',
        },
      })
    })

    // The neighbour: an ACTIVE exercise still takes changes, so the guard is
    // about retirement, not about updates in general.
    it('still lets the care team change an active exercise', async () => {
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_program_exercises SET sets = 5 WHERE id = ${active.id} RETURNING id`,
        ),
      ).toEqual({ rows: [{ id: active.id }] })
    })

    it('makes whoever retires an exercise sign it', async () => {
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_program_exercises
              SET retired_at = now(), retired_by = ${practitionerCId}
              WHERE id = ${active.id}`,
        ),
      ).toEqual({
        error: {
          code: '23514',
          constraint: 'assigned_program_exercise_retired_by',
        },
      })
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_program_exercises
              SET retired_at = now(), retired_by = ${practitionerAId}
              WHERE id = ${active.id} RETURNING id`,
        ),
      ).toEqual({ rows: [{ id: active.id }] })
    })

    it('exempts the owner (migrations, the seed, test set-up)', async () => {
      expect(
        await asOwner(
          'UPDATE assigned_program_exercises SET sets = 7 WHERE id = $1',
          [retired.id],
        ),
      ).toEqual({ rowCount: 1 })
    })

    // The patient updates their own checklist rows while doing the session
    // (the update policy) — what they DID, never what was prescribed.
    it("refuses the patient changing a session's copy of the prescription and description", async () => {
      // Every guarded column, one at a time — so dropping any one of them
      // from the trigger's comparison fails a case.
      for (const assignment of [
        sql`name = 'Easy'`,
        sql`sets = 9`,
        sql`reps = 9`,
        sql`duration_in_seconds = 9`,
        sql`weight = 1`,
        sql`weight_unit = 'lbs'`,
        sql`notes = 'skip'`,
        // The description's copy (2026-10-14, migration 0034).
        sql`primary_muscles = '{calves}'`,
        sql`secondary_muscles = '{calves}'`,
        sql`equipment = '{calves}'`,
        sql`instructions = '{Skip it}'`,
        sql`assigned_program_exercise_id = ${active.id}`,
        sql`session_id = session_id + 1000000`,
      ]) {
        expect(
          await run(
            asPatient(),
            sql`UPDATE session_exercises SET ${assignment} WHERE id = ${sessionExerciseId}`,
          ),
        ).toEqual({
          error: {
            code: '23514',
            constraint: 'session_exercise_prescription_fixed',
          },
        })
      }
    })

    it("exempts the owner from the session copy's guard too", async () => {
      expect(
        await asOwner('UPDATE session_exercises SET sets = 1 WHERE id = $1', [
          sessionExerciseId,
        ]),
      ).toEqual({ rowCount: 1 })
    })

    it('still lets the patient record what they did', async () => {
      // The id comes back as a STRING: a bigserial (64-bit) id read by a raw
      // query — node-postgres can't fit every 64-bit integer in a JavaScript
      // number. (Drizzle's typed queries convert it, as the schema says
      // `mode: 'number'`; a raw `execute` doesn't.)
      expect(
        await run(
          asPatient(),
          sql`UPDATE session_exercises
              SET completed = true, difficulty_rating = 6, feedback = 'Fine'
              WHERE id = ${sessionExerciseId} RETURNING id`,
        ),
      ).toEqual({ rows: [{ id: String(sessionExerciseId) }] })
    })
  })
})
