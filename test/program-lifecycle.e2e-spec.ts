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
import { CLOSED_PROGRAM_MESSAGE } from '../src/common/filters/http-exception.filter'
import { addDays, isoWeekday, utcToday } from '../src/common/calendar-date'

// A program's life after it's assigned (step 2b-iii, decisions §5, "Settled
// 2026-10-11"):
//   1. SWAPS — a session that does another day's workout and says so
//      (`countsFor`), checked when it starts, judged by the summary;
//   2. CLOSING — cancel (archive when nothing happened) and complete, the
//      end date they set, and a closed program being read-only;
//   3. ARCHIVING — refused once a program has sessions;
//   4. ASSIGN AGAIN — a new program continuing a closed one;
//   5. the database's own guarantees for the new columns.
//
// Its own file (not program-schedules.e2e-spec.ts) — first partly for the
// rate limit (60 requests a minute per route), off in the e2e suites since
// 2026-10-15 (test/support/e2e-env.ts). Dates come from the real clock
// (utcToday).
//
// Logins: 3 (practitioner A, practitioner C, the patient) — the admin's
// session comes from register-clinic.
describe('Program lifecycle (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb

  let admin: ReturnType<typeof request.agent>
  // On both patients' care team.
  let practitionerA: ReturnType<typeof request.agent>
  // Same clinic, NOT on the care team.
  let practitionerC: ReturnType<typeof request.agent>
  let patient: ReturnType<typeof request.agent>

  let patientId: number
  let practitionerAId: number
  // A second patient of A's, never logged in: "another patient's program".
  let otherPatientId: number
  // Two workouts: A ("Upper", one exercise) and B ("Lower", one exercise).
  let templateId: number

  const today = utcToday()
  const yesterday = addDays(today, -1)
  const tomorrow = addDays(today, 1)

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
      clinicName: 'Lifecycle E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Life',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(clinicRes.body)}`)
    }
    const clinicId: number = clinicRes.body.clinicId

    // Created by the admin; logged in only when an agent is given.
    async function createUser(
      body: Record<string, unknown>,
      agent?: ReturnType<typeof request.agent>,
    ): Promise<number> {
      const res = await admin.post('/users').send({ ...body, clinicId })
      if (res.status !== 201) {
        throw new Error(`Setup failed: ${JSON.stringify(res.body)}`)
      }
      if (agent) {
        await activateAccount(sessionPool, body.email as string)
        await agent
          .post('/auth/login')
          .send({ email: body.email, password: 'password123' })
      }
      return res.body.id
    }

    practitionerAId = await createUser(
      {
        email: `pa-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'A',
        licenseNumber: `LIFE-A-${stamp}`,
      },
      practitionerA,
    )
    await createUser(
      {
        email: `pc-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Practitioner',
        lastName: 'C',
        licenseNumber: `LIFE-C-${stamp}`,
      },
      practitionerC,
    )
    patientId = await createUser(
      {
        email: `patient-${stamp}@example.com`,
        role: 'patient',
        firstName: 'Life',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
      },
      patient,
    )
    otherPatientId = await createUser({
      email: `other-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Other',
      lastName: 'Patient',
      dateOfBirth: '1991-01-01',
    })
    // Practitioner A joins both care teams; C joins neither.
    for (const id of [patientId, otherPatientId]) {
      const join = await practitionerA.post(`/users/${id}/care-team`).send({})
      expect(join.status).toBe(201)
    }

    const exercise = await practitionerA.post('/exercises').send({
      name: 'Lifecycle E2E Row',
      primaryMuscles: ['back'],
      instructions: ['Pull'],
    })
    const exerciseId: number = exercise.body.id
    const created = await practitionerA
      .post('/programs')
      .send({ title: 'Lifecycle Template' })
    templateId = created.body.id
    // Read back with its workouts (a template starts with one, A).
    const template = await practitionerA.get(`/programs/${templateId}`)
    const renamed = await practitionerA
      .patch(`/programs/${templateId}/workouts/${template.body.workouts[0].id}`)
      .send({ name: 'Upper' })
    expect(renamed.status).toBe(200)
    const withB = await practitionerA
      .post(`/programs/${templateId}/workouts`)
      .send({ name: 'Lower' })
    expect(withB.status).toBe(201)
    for (const workoutId of [
      template.body.workouts[0].id,
      withB.body.workouts[1].id,
    ]) {
      const added = await practitionerA
        .post(`/programs/${templateId}/exercises`)
        .send({ exerciseId, sets: 2, reps: 10, sortOrder: 0, workoutId })
      expect(added.status).toBe(201)
    }
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  interface Program {
    id: number
    patientId: number
    status: string
    isArchived: boolean
    allowSwaps: boolean
    lateMakeUpDays: number | null
    startDate: string
    endDate: string | null
    basedOnTemplateId: number | null
    basedOnProgramId: number | null
    workouts: { id: number; name: string | null; sortOrder: number }[]
    exercises: {
      id: number
      exerciseId: number
      workoutId: number
      sets: number | null
    }[]
  }

  // Every day of the week scheduled: TODAY's weekday does A, every other
  // day B — so any day near today is a scheduled day, and yesterday's (and
  // tomorrow's) workout is B, not today's A.
  const EVERY_DAY = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      workoutIndex: weekday === isoWeekday(today) ? 0 : 1,
    })),
  }
  const TWICE_A_WEEK = { type: 'times_per_week', timesPerWeek: 2 }

  // A program for the patient from the two-workout template, started
  // YESTERDAY unless said otherwise — so its first program week runs from
  // yesterday to 5 days from now.
  async function createProgram(
    options: { startsIn?: number; schedule?: object; patient?: number } = {},
  ) {
    const res = await practitionerA.post('/assigned-programs').send({
      patientId: options.patient ?? patientId,
      basedOnTemplateId: templateId,
      title: 'Lifecycle Program',
      startDate: addDays(today, options.startsIn ?? -1),
      schedule: options.schedule ?? EVERY_DAY,
    })
    expect(res.status).toBe(201)
    return res.body as Program
  }

  // The patient starts a session today (with whatever body is given) —
  // optionally completing it.
  async function startSession(
    programId: number,
    body: Record<string, unknown> = {},
    complete = false,
  ) {
    const res = await patient
      .post('/sessions')
      .send({ assignedProgramId: programId, localDate: today, ...body })
    if (complete && res.status === 201) {
      const finished = await patient
        .post(`/sessions/${res.body.id}/complete`)
        .send({})
      expect(finished.status).toBe(200)
    }
    return res
  }

  // What audit_logs holds for one program, read as the owner. The generic
  // interceptor writes AFTER the response, fire-and-forget, so a short pause
  // first gives a duplicate the chance to appear.
  async function auditTrail(programId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<{
      action: string
      details: Record<string, unknown> | null
    }>(
      `SELECT action, details FROM audit_logs
       WHERE entity_type = 'assigned-programs' AND entity_id = $1 ORDER BY id`,
      [programId],
    )
    return rows
  }

  const close = (
    agent: ReturnType<typeof request.agent>,
    programId: number,
    action: 'cancel' | 'complete',
    day = today,
  ) =>
    agent.post(`/assigned-programs/${programId}/${action}`).send({ today: day })

  // --- 1. Swaps ------------------------------------------------------------------------------------------

  describe('swaps', () => {
    // Yesterday expected B and nothing was done: today's session for
    // yesterday does B (no workoutId needed). Today is a SCHEDULED day
    // (every day is, here), so it's half of a swap: the summary shows
    // yesterday as swapped — done late, today.
    it("records a swap with the counted day's workout, and the summary shows it", async () => {
      const program = await createProgram()
      const b = program.workouts[1].id

      const res = await startSession(program.id, { countsFor: yesterday }, true)
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ workoutId: b, countsFor: yesterday })

      const summary = await practitionerA.get(
        `/assigned-programs/${program.id}/summary?today=${today}`,
      )
      expect(summary.body.days[0]).toEqual({
        date: yesterday,
        workoutId: b,
        state: 'swapped',
        sessionId: null,
        madeUpBy: null,
        madeUpLateBy: null,
        doneEarlyBy: null,
        swappedBy: { sessionId: res.body.id, date: today },
        attempts: [],
      })
      // Today itself (A) is still to do: the swap didn't count for it.
      expect(summary.body.days[1]).toMatchObject({ date: today, state: 'due' })
      expect(summary.body.totals).toMatchObject({
        doneEarly: 0,
        swapped: 1,
        extra: 0,
      })
    })

    // Today is a FREE day (only tomorrow is scheduled, with B): a session
    // for tomorrow is DONE EARLY — not a swap, nothing is exchanged.
    it('records a session done early on a free day, and the summary says so', async () => {
      const program = await createProgram({
        schedule: {
          type: 'weekdays',
          days: [{ weekday: isoWeekday(tomorrow), workoutIndex: 1 }],
        },
      })
      const b = program.workouts[1].id

      const res = await startSession(program.id, { countsFor: tomorrow }, true)
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ workoutId: b, countsFor: tomorrow })

      const summary = await practitionerA.get(
        `/assigned-programs/${program.id}/summary?today=${today}`,
      )
      expect(summary.body.days[0]).toEqual({
        date: tomorrow,
        workoutId: b,
        state: 'done_early',
        sessionId: null,
        madeUpBy: null,
        madeUpLateBy: null,
        doneEarlyBy: { sessionId: res.body.id, date: today },
        swappedBy: null,
        attempts: [],
      })
      expect(summary.body.totals).toMatchObject({
        doneEarly: 1,
        swapped: 0,
        extra: 0,
      })
    })

    // A session done early is judged by the version in force on the day it
    // counts for — here one starting TOMORROW, which gives tomorrow A
    // instead of B. The service reads the versions up to the LATER of the
    // two days (reading up to today would miss it, and answer B).
    it("takes a later day's workout from a version that starts after today", async () => {
      const program = await createProgram()
      const [a] = program.workouts.map((w) => w.id)
      const change = await practitionerA
        .post(`/assigned-programs/${program.id}/schedules`)
        .send({
          type: 'weekdays',
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            workoutId: a,
          })),
          effectiveFrom: tomorrow,
        })
      expect(change.status).toBe(201)

      const res = await startSession(program.id, { countsFor: tomorrow })
      expect(res.status).toBe(201)
      expect(res.body.workoutId).toBe(a)
    })

    it.each<[string, () => Promise<Program>, Record<string, unknown>, string]>([
      [
        'naming another workout than the day’s',
        () => createProgram(),
        { countsFor: yesterday, workoutIdIndex: 0 },
        "isn't the workout scheduled on",
      ],
      [
        'a day of the next program week',
        () => createProgram(),
        { countsFor: addDays(today, 6) },
        'A session for another day stays within the program week: countsFor must be in the same week as today',
      ],
      // Tomorrow from a weekly-count day: done early, which the swap
      // switch governs.
      [
        'a weekly-count schedule',
        () => createProgram({ schedule: TWICE_A_WEEK }),
        { countsFor: tomorrow },
        'Only schedules with specific days can be rearranged: with a weekly count, any order within the week already counts',
      ],
      // Yesterday from a weekly-count day: a late make-up — none with a
      // weekly count (2026-10-16).
      [
        'a late make-up on a weekly-count schedule',
        () => createProgram({ schedule: TWICE_A_WEEK }),
        { countsFor: yesterday },
        'Only schedules with specific days have late make-ups: a weekly count starts again each week',
      ],
      // Today free, yesterday scheduled and still in its make-up window:
      // catching it up is an ordinary make-up, which needs no link (refused
      // as a link since 2026-10-12; since late make-ups, 2026-10-16, with
      // this answer).
      [
        'an earlier day still in its window, from a free day',
        () =>
          createProgram({
            schedule: {
              type: 'weekdays',
              days: [{ weekday: isoWeekday(yesterday), workoutIndex: 1 }],
            },
          }),
        { countsFor: yesterday },
        `${yesterday} can still be made up on time: start the session without countsFor, before the next scheduled day`,
      ],
      [
        'today itself',
        () => createProgram(),
        { countsFor: today },
        'countsFor must be another day: a session already counts for its own',
      ],
    ])(
      'refuses a swap: %s, recording nothing',
      async (_label, make, body, message) => {
        const program = await make()
        const { workoutIdIndex, ...rest } = body as { workoutIdIndex?: number }
        const res = await startSession(program.id, {
          ...rest,
          ...(workoutIdIndex !== undefined
            ? { workoutId: program.workouts[workoutIdIndex].id }
            : {}),
        })
        expect(res.status).toBe(400)
        expect((res.body.message as string[]).join()).toContain(message)
        const { rows } = await sessionPool.query(
          'SELECT 1 FROM sessions WHERE assigned_program_id = $1',
          [program.id],
        )
        expect(rows).toEqual([])
      },
    )

    // `countsFor` is a calendar date, checked like `localDate`.
    it('refuses a countsFor that is not a date', async () => {
      const program = await createProgram()
      const res = await startSession(program.id, { countsFor: 'yesterday' })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'countsFor must be a date written as YYYY-MM-DD',
      ])
    })

    // The day is judged by the version in force ON IT — the latest starting
    // on or before it — not today's, nor the program's first. Three
    // versions, yesterday's weekday doing B, then A (from yesterday), then
    // B again (from today): a swap for yesterday does A.
    it("takes the counted day's workout from the version in force that day", async () => {
      const program = await createProgram({ startsIn: -2 })
      const [a, b] = program.workouts.map((w) => w.id)
      const everyDay = (yesterdays: number) => ({
        type: 'weekdays',
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          workoutId: weekday === isoWeekday(yesterday) ? yesterdays : b,
        })),
      })
      for (const [from, workout] of [
        [yesterday, a],
        [today, b],
      ] as const) {
        const res = await practitionerA
          .post(`/assigned-programs/${program.id}/schedules`)
          .send({ ...everyDay(workout), effectiveFrom: from })
        expect(res.status).toBe(201)
      }

      const res = await startSession(program.id, { countsFor: yesterday })
      expect(res.status).toBe(201)
      expect(res.body.workoutId).toBe(a)
    })

    // The practitioner's switch: off → refused; and the change is audited
    // like any PATCH, before → after.
    it('refuses swaps once the practitioner turns them off', async () => {
      const program = await createProgram()
      expect(program.allowSwaps).toBe(true)

      const off = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ allowSwaps: false })
      expect(off.status).toBe(200)
      expect(off.body.allowSwaps).toBe(false)

      const res = await startSession(program.id, { countsFor: yesterday })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([
        'Rearranging the week is turned off for this program: do the workout scheduled today, or ask your practitioner',
      ])
      // An ordinary session still works.
      const ordinary = await startSession(program.id, {
        workoutId: program.workouts[0].id,
      })
      expect(ordinary.status).toBe(201)

      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_UPDATED',
      ])
      expect(trail[1].details).toEqual({
        changes: { allowSwaps: { from: true, to: false } },
      })
    })
  })

  // --- 1b. Late make-ups: the practitioner's setting (2026-10-16) ----------------------------------------

  describe('late make-ups: the setting', () => {
    // Off on a new program (opt-in); on and off again with a PATCH, each
    // change audited before → after; the creation records the defaults.
    it('is off on a new program, and the practitioner sets it, audited', async () => {
      const program = await createProgram()
      expect(program.lateMakeUpDays).toBeNull()

      const on = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ lateMakeUpDays: 7 })
      expect(on.status).toBe(200)
      expect(on.body.lateMakeUpDays).toBe(7)
      const off = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ lateMakeUpDays: null })
      expect(off.status).toBe(200)
      expect(off.body.lateMakeUpDays).toBeNull()

      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_UPDATED',
        'ASSIGNED_PROGRAM_UPDATED',
      ])
      expect(trail[0].details).toMatchObject({
        allowSwaps: true,
        lateMakeUpDays: null,
      })
      expect(trail[1].details).toEqual({
        changes: { lateMakeUpDays: { from: null, to: 7 } },
      })
      expect(trail[2].details).toEqual({
        changes: { lateMakeUpDays: { from: 7, to: null } },
      })
    })

    // The limits, at their edges: 1 and 28 kept, 0 / 29 / 1.5 refused —
    // and a refused value changes nothing.
    it('keeps 1 and 28', async () => {
      const program = await createProgram()
      for (const lateMakeUpDays of [1, 28]) {
        const res = await practitionerA
          .patch(`/assigned-programs/${program.id}`)
          .send({ lateMakeUpDays })
        expect(res.status).toBe(200)
        expect(res.body.lateMakeUpDays).toBe(lateMakeUpDays)
      }
    })

    it.each<[unknown, string]>([
      [0, 'lateMakeUpDays must be at least 1 (null turns late make-ups off)'],
      [29, 'lateMakeUpDays can be at most 28'],
      [1.5, 'lateMakeUpDays must be a whole number of days, or null'],
    ])('refuses %p, changing nothing', async (lateMakeUpDays, message) => {
      const program = await createProgram()
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ lateMakeUpDays })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual([message])
      const { rows } = await sessionPool.query<{
        late_make_up_days: number | null
      }>('SELECT late_make_up_days FROM assigned_programs WHERE id = $1', [
        program.id,
      ])
      expect(rows[0].late_make_up_days).toBeNull()
    })

    // The database's half (the CHECK), proved as the owner — no DTO in
    // front: its limits are the DTO's.
    it('is kept between 1 and 28 by the database too', async () => {
      const program = await createProgram()
      const tryValue = async (value: number) => {
        const client = await sessionPool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            'UPDATE assigned_programs SET late_make_up_days = $1 WHERE id = $2',
            [value, program.id],
          )
          return 'stored'
        } catch (error) {
          const { code, constraint } = error as {
            code?: string
            constraint?: string
          }
          return `${code} ${constraint}`
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      }
      const refused = '23514 assigned_programs_late_make_up_days_range'
      expect(await tryValue(0)).toBe(refused)
      expect(await tryValue(29)).toBe(refused)
      expect(await tryValue(1)).toBe('stored')
      expect(await tryValue(28)).toBe('stored')
    })
  })

  // --- 2. Closing ----------------------------------------------------------------------------------------

  describe('closing a program', () => {
    // Nothing happened clinically: cancelling = archiving. It disappears
    // from the list; one complete audit entry, no generic twin.
    it('archives a program cancelled before any session', async () => {
      const program = await createProgram({ startsIn: 3 })

      const res = await close(practitionerA, program.id, 'cancel')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ outcome: 'archived', program: null })

      const list = await practitionerA.get(
        `/assigned-programs?patientId=${patientId}`,
      )
      expect((list.body as Program[]).map((p) => p.id)).not.toContain(
        program.id,
      )
      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_ARCHIVED',
      ])
      expect(trail[1].details).toMatchObject({
        reason: 'cancelled before any session',
        program: { title: 'Lifecycle Program', status: 'active' },
      })
    })

    // A session — even one never finished — makes it part of the record:
    // cancelled, kept, ending yesterday (today isn't a missed day).
    it('cancels a program with a session, ending it yesterday', async () => {
      const program = await createProgram({ startsIn: -3 })
      const started = await startSession(program.id, {
        workoutId: program.workouts[0].id,
      })
      expect(started.status).toBe(201)

      const res = await close(practitionerA, program.id, 'cancel')
      expect(res.status).toBe(200)
      expect(res.body.outcome).toBe('cancelled')
      expect(res.body.program).toMatchObject({
        id: program.id,
        status: 'cancelled',
        isArchived: false,
        endDate: yesterday,
      })
      const trail = await auditTrail(program.id)
      expect(trail.map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_CANCELLED',
      ])
      expect(trail[1].details).toEqual({
        today,
        changes: {
          status: { from: 'active', to: 'cancelled' },
          endDate: { from: null, to: yesterday },
        },
        // The session still in progress was closed with the program (step
        // 1b) — its own entry is in sessions.e2e-spec.ts.
        closedSessionIds: [started.body.id],
      })
    })

    // A session COMPLETED today: today is part of the program.
    it('completes a program ending today when a session was completed today', async () => {
      const program = await createProgram({ startsIn: -3 })
      await startSession(
        program.id,
        { workoutId: program.workouts[0].id },
        true,
      )

      const res = await close(practitionerA, program.id, 'complete')
      expect(res.body).toMatchObject({
        outcome: 'completed',
        program: { status: 'completed', endDate: today },
      })
    })

    // Closed means read-only: every change, a new session, closing again.
    it('makes a closed program read-only', async () => {
      const program = await createProgram({ startsIn: -3 })
      await close(practitionerA, program.id, 'complete')
      const base = `/assigned-programs/${program.id}`

      const attempts = [
        practitionerA.patch(base).send({ title: 'Renamed' }),
        practitionerA
          .post(`${base}/schedules`)
          .send({ type: 'paused', effectiveFrom: today }),
        practitionerA.post(`${base}/workouts`).send({}),
        practitionerA
          .patch(`${base}/exercises/${program.exercises[0].id}`)
          .send({ sets: 9 }),
        close(practitionerA, program.id, 'cancel'),
        startSession(program.id, { workoutId: program.workouts[0].id }),
      ]
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(409)
      }
      const after = await practitionerA.get(base)
      expect(after.body).toMatchObject({
        status: 'completed',
        title: 'Lifecycle Program',
      })
      expect(after.body.exercises[0].sets).toBe(2)
    })

    it('no longer takes a status in a PATCH', async () => {
      const program = await createProgram()
      const res = await practitionerA
        .patch(`/assigned-programs/${program.id}`)
        .send({ status: 'completed' })
      expect(res.status).toBe(400)
      expect(res.body.message).toEqual(['property status should not exist'])
    })

    it('lets an admin close a program; not the patient (403) nor a colleague off the team (404)', async () => {
      const program = await createProgram({ startsIn: -3 })
      await startSession(program.id, { workoutId: program.workouts[0].id })

      expect((await close(patient, program.id, 'cancel')).status).toBe(403)
      expect((await close(practitionerC, program.id, 'cancel')).status).toBe(
        404,
      )
      expect((await close(admin, program.id, 'complete')).status).toBe(200)
    })

    it("refuses a today that isn't a date, or can't be today", async () => {
      const program = await createProgram()
      const notADate = await practitionerA
        .post(`/assigned-programs/${program.id}/cancel`)
        .send({ today: 'tomorrow' })
      expect(notADate.status).toBe(400)
      const tooEarly = await close(
        practitionerA,
        program.id,
        'cancel',
        addDays(today, -2),
      )
      expect(tooEarly.status).toBe(400)
      expect(tooEarly.body.message).toEqual([
        "today must be today's date in your time zone",
      ])
    })
  })

  describe('previewing a close', () => {
    // The answers' shapes, written out as a client sees them: typing the
    // bodies (instead of reading `any`) lets the compiler check every
    // field these tests read.
    interface ClosingPlanBody {
      outcome: string
      endDate: string | null
    }
    interface ClosingPreviewBody {
      cancel: ClosingPlanBody
      complete: ClosingPlanBody
      openSessions: number
    }
    interface CloseBody {
      outcome: string
      program: { endDate: string | null }
    }

    const preview = (
      agent: ReturnType<typeof request.agent>,
      programId: number,
      day = today,
    ) => agent.get(`/assigned-programs/${programId}/closing?today=${day}`)

    // No session yet: cancelling would archive (no end date — it's gone);
    // completing would end it yesterday.
    it('answers what cancelling and completing would do, with no session yet', async () => {
      const program = await createProgram({ startsIn: -3 })

      const res = await preview(practitionerA, program.id)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        cancel: { outcome: 'archived', endDate: null },
        complete: { outcome: 'completed', endDate: yesterday },
        openSessions: 0,
      })
    })

    // The case the screen can't see: a session started and never finished
    // still counts — and what the preview promises is what cancelling does.
    it('counts an unfinished session, and promises what cancelling then does', async () => {
      const program = await createProgram({ startsIn: -3 })
      await startSession(program.id, { workoutId: program.workouts[0].id })

      const promised = (await preview(practitionerA, program.id))
        .body as ClosingPreviewBody
      expect(promised.cancel).toEqual({
        outcome: 'cancelled',
        endDate: yesterday,
      })
      // …and warns that closing will close it too.
      expect(promised.openSessions).toBe(1)

      const done = (await close(practitionerA, program.id, 'cancel'))
        .body as CloseBody
      expect(done.outcome).toBe(promised.cancel.outcome)
      expect(done.program.endDate).toBe(promised.cancel.endDate)
    })

    // A session completed today: either action would end it today.
    it('ends today when a session was completed today', async () => {
      const program = await createProgram({ startsIn: -3 })
      await startSession(
        program.id,
        { workoutId: program.workouts[0].id },
        true,
      )

      const res = await preview(practitionerA, program.id)
      expect(res.body).toEqual({
        cancel: { outcome: 'cancelled', endDate: today },
        complete: { outcome: 'completed', endDate: today },
        openSessions: 0,
      })
    })

    // A read: it changes nothing — its only entries record the READS
    // (the preview, then the program read to check; the audit review's
    // step 2), no change.
    it('changes nothing, and records only that it was read', async () => {
      const program = await createProgram({ startsIn: -3 })
      await preview(practitionerA, program.id)

      const after = await practitionerA.get(`/assigned-programs/${program.id}`)
      expect(after.body).toMatchObject({ status: 'active', isArchived: false })
      expect((await auditTrail(program.id)).map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'PROGRAM_CLOSING_PREVIEWED',
        'PROGRAM_VIEWED',
      ])
    })

    // The same people as closing: an admin yes; the patient no (403); a
    // colleague off the team can't even see it (404).
    it('answers those who may close it, only', async () => {
      const program = await createProgram({ startsIn: -3 })
      expect((await preview(admin, program.id)).status).toBe(200)
      expect((await preview(patient, program.id)).status).toBe(403)
      expect((await preview(practitionerC, program.id)).status).toBe(404)
    })

    // A closed program has nothing to preview — closing it again is a 409.
    it("refuses a closed program (409), and a today that can't be today (400)", async () => {
      const program = await createProgram({ startsIn: -3 })
      expect(
        (await preview(practitionerA, program.id, 'tomorrow')).status,
      ).toBe(400)
      const tooEarly = await preview(
        practitionerA,
        program.id,
        addDays(today, -2),
      )
      expect(tooEarly.status).toBe(400)
      expect((tooEarly.body as { message: string[] }).message).toEqual([
        "today must be today's date in your time zone",
      ])

      await close(practitionerA, program.id, 'complete')
      expect((await preview(practitionerA, program.id)).status).toBe(409)
    })
  })

  // --- 3. Archiving ----------------------------------------------------------------------------------------

  describe('archiving', () => {
    it('refuses to delete a program with sessions', async () => {
      const program = await createProgram({ startsIn: -3 })
      await startSession(program.id, { workoutId: program.workouts[0].id })

      const res = await practitionerA.delete(`/assigned-programs/${program.id}`)
      expect(res.status).toBe(409)
      expect(res.body.message).toContain(
        "This program has sessions, so it is part of the patient's record and can't be deleted: cancel it instead",
      )
    })

    it('deletes (archives) a program with no session, with one audit entry', async () => {
      const program = await createProgram({ startsIn: 3 })

      const res = await practitionerA.delete(`/assigned-programs/${program.id}`)
      expect(res.status).toBe(200)
      expect(res.body.isArchived).toBe(true)
      expect((await auditTrail(program.id)).map((r) => r.action)).toEqual([
        'ASSIGNED_PROGRAM_CREATED',
        'ASSIGNED_PROGRAM_ARCHIVED',
      ])
    })
  })

  // --- 4. Assign again -----------------------------------------------------------------------------------

  describe('assigning again', () => {
    const assignAgain = (
      sourceId: number,
      extra: Record<string, unknown> = {},
    ) =>
      practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnProgramId: sourceId,
        title: 'Lifecycle Program — block 2',
        startDate: addDays(today, 7),
        schedule: TWICE_A_WEEK,
        ...extra,
      })

    // Continuing a program continues the practitioner's choices for this
    // patient (2026-10-16): rearranging the week and late make-ups — in the
    // new program and in its creation's audit entry.
    it("carries over the practitioner's settings", async () => {
      const source = await createProgram()
      const set = await practitionerA
        .patch(`/assigned-programs/${source.id}`)
        .send({ allowSwaps: false, lateMakeUpDays: 5 })
      expect(set.status).toBe(200)
      // A session, so cancelling keeps the program (cancelled, not archived).
      await startSession(source.id, { workoutId: source.workouts[0].id }, true)
      await close(practitionerA, source.id, 'cancel')

      const res = await assignAgain(source.id)
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ allowSwaps: false, lateMakeUpDays: 5 })
      const [created] = await auditTrail((res.body as Program).id)
      expect(created.details).toMatchObject({
        allowSwaps: false,
        lateMakeUpDays: 5,
      })
    })

    // The TAILORED program is what continues: B's sets were changed on the
    // program (5, the template says 2) — the copy has 5.
    it('copies the workouts and tailored exercises of a cancelled program', async () => {
      const source = await createProgram({ startsIn: -3 })
      const bExercise = source.exercises.find(
        (e) => e.workoutId === source.workouts[1].id,
      )!
      await practitionerA
        .patch(`/assigned-programs/${source.id}/exercises/${bExercise.id}`)
        .send({ sets: 5 })
      // A second exercise for A, added AFTER B's: by id the rows read A, B,
      // A — the copy must still be A's exercises, then B's.
      const addedToA = await practitionerA
        .post(`/assigned-programs/${source.id}/exercises`)
        .send({
          exerciseId: bExercise.exerciseId,
          sortOrder: 1,
          sets: 4,
          workoutId: source.workouts[0].id,
        })
      expect(addedToA.status).toBe(201)
      await startSession(source.id, { workoutId: source.workouts[0].id })
      await close(practitionerA, source.id, 'cancel')

      const res = await assignAgain(source.id)
      expect(res.status).toBe(201)
      const copy = res.body as Program
      expect(copy).toMatchObject({
        status: 'active',
        basedOnProgramId: source.id,
        basedOnTemplateId: templateId,
        startDate: addDays(today, 7),
      })
      expect(copy.workouts.map((w) => w.name)).toEqual(['Upper', 'Lower'])
      expect(copy.workouts.map((w) => w.id)).not.toContain(
        source.workouts[0].id,
      )
      expect(
        copy.exercises.map((e) => [
          copy.workouts.findIndex((w) => w.id === e.workoutId),
          e.sets,
        ]),
      ).toEqual([
        [0, 2],
        [0, 4],
        [1, 5],
      ])
      // Its rotation, suggested: every COPIED workout in order.
      expect(
        (res.body.schedules as { rotation: number[] }[])[0].rotation,
      ).toEqual(copy.workouts.map((w) => w.id))

      // The rows were inserted — and the audit entry lists them — in that
      // order too (the response alone is sorted when read, so it can't
      // tell).
      const [created] = await auditTrail(copy.id)
      expect(created.details).toMatchObject({ basedOnProgramId: source.id })
      expect(
        (
          created.details!.exercises as { workoutId: number; sets: number }[]
        ).map((e) => [
          copy.workouts.findIndex((w) => w.id === e.workoutId),
          e.sets,
        ]),
      ).toEqual([
        [0, 2],
        [0, 4],
        [1, 5],
      ])
    })

    it.each<
      [string, () => Promise<number>, Record<string, unknown>, number, string]
    >([
      [
        'an active program',
        async () => (await createProgram()).id,
        {},
        409,
        'Only a completed or cancelled program can be assigned again: this one is still active',
      ],
      [
        "another patient's program",
        async () => {
          const other = await createProgram({
            startsIn: -3,
            patient: otherPatientId,
          })
          await close(practitionerA, other.id, 'complete')
          return other.id
        },
        {},
        400,
        'belongs to another patient: a program is assigned again to the same patient',
      ],
      [
        'a template as well',
        async () => (await createProgram()).id,
        { basedOnTemplateId: 1 },
        400,
        'Give one source: basedOnTemplateId, basedOnProgramId or exercises',
      ],
      [
        'a program that doesn’t exist',
        () => Promise.resolve(999999),
        {},
        404,
        'Assigned program 999999 not found',
      ],
    ])('refuses %s', async (_label, sourceId, extra, status, message) => {
      const res = await assignAgain(await sourceId(), extra)
      expect(res.status).toBe(status)
      expect((res.body.message as string[]).join()).toContain(message)
    })
  })

  // --- 5. The database's own guarantees ----------------------------------------------------------------------

  describe('constraints', () => {
    // As the owner, in a transaction always rolled back; the error's code
    // and constraint, or {} when none.
    async function asOwner(statement: string, params: unknown[]) {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(statement, params)
        return {}
      } catch (error) {
        const { code, constraint } = error as {
          code?: string
          constraint?: string
        }
        return { code, constraint }
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    it('refuses a session that counts for its own day', async () => {
      const program = await createProgram()
      const session = await startSession(program.id, {
        workoutId: program.workouts[0].id,
      })
      expect(
        await asOwner(
          'UPDATE sessions SET counts_for = local_date WHERE id = $1',
          [session.body.id],
        ),
      ).toEqual({ code: '23514', constraint: 'sessions_counts_for_other_day' })
    })

    it('refuses a program based on itself', async () => {
      const program = await createProgram()
      expect(
        await asOwner(
          'UPDATE assigned_programs SET based_on_program_id = id WHERE id = $1',
          [program.id],
        ),
      ).toEqual({
        code: '23514',
        constraint: 'assigned_programs_not_based_on_itself',
      })
    })

    // A program another continues can't be deleted on its own (NO ACTION);
    // deleting both in one statement works — what the seed's reset does.
    it('keeps a continued program, unless its continuation goes with it', async () => {
      const source = await createProgram({ startsIn: -3 })
      await close(practitionerA, source.id, 'complete')
      const copy = await practitionerA.post('/assigned-programs').send({
        patientId,
        basedOnProgramId: source.id,
        title: 'Continuation',
        startDate: today,
        schedule: TWICE_A_WEEK,
      })
      expect(copy.status).toBe(201)

      // Their children first (workouts, exercises, schedules cascade from
      // the program; sessions don't exist here).
      expect(
        await asOwner('DELETE FROM assigned_programs WHERE id = $1', [
          source.id,
        ]),
      ).toEqual({
        code: '23503',
        constraint:
          'assigned_programs_based_on_program_id_assigned_programs_id_fk',
      })
      expect(
        await asOwner('DELETE FROM assigned_programs WHERE id = ANY($1)', [
          [source.id, copy.body.id],
        ]),
      ).toEqual({})
    })
  })

  // --- 6. The closed-program guard (migration 0031) ---------------------------------------------------------
  //
  // The database refuses what the service already refuses — for the app's
  // own role, whatever route (or direct query) tries. Statements run as the
  // app's role with an actor's context, the way withRlsContext sets it, in a
  // transaction always rolled back.
  describe('the closed-program guard', () => {
    class RolledBack extends Error {
      constructor(readonly rows: Record<string, unknown>[]) {
        super('rolled back on purpose')
      }
    }
    type Actor = { userId: number; role: string }
    const asA = (): Actor => ({ userId: practitionerAId, role: 'practitioner' })
    const asPatient = (): Actor => ({ userId: patientId, role: 'patient' })

    // The LAST statement's rows, or the error (code + constraint) that
    // stopped them.
    async function run(actor: Actor, statement: SQL) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true),
                       set_config('app.current_role', ${actor.role}, true)`,
          )
          const { rows } = await tx.execute<Record<string, unknown>>(statement)
          throw new RolledBack(rows)
        })
      } catch (error) {
        if (error instanceof RolledBack) return { rows: error.rows }
        let current: unknown = error
        while (current && typeof current === 'object') {
          const { code, constraint, cause } = current as {
            code?: unknown
            constraint?: unknown
            cause?: unknown
          }
          if (typeof code === 'string') return { error: { code, constraint } }
          current = cause
        }
        throw error
      }
      throw new Error('unreachable: run() always rolls back')
    }
    const refused = {
      error: { code: '23514', constraint: 'assigned_program_closed' },
    }

    // A CANCELLED program (with an unfinished session, so it isn't merely
    // archived) and an ACTIVE one, the control: the same statement must
    // succeed there, so a refusal is the guard's, not the statement's.
    let cancelled: Program
    // Archived (deleted with no session): closed too, whatever its status.
    let archived: Program
    let open: Program
    let unfinishedSessionId: number
    let unfinishedExerciseRowId: number
    beforeAll(async () => {
      cancelled = await createProgram({ startsIn: -3 })
      const started = await startSession(cancelled.id, {
        workoutId: cancelled.workouts[0].id,
      })
      unfinishedSessionId = started.body.id
      unfinishedExerciseRowId = started.body.exercises[0].id
      expect((await close(practitionerA, cancelled.id, 'cancel')).status).toBe(
        200,
      )
      archived = await createProgram({ startsIn: 3 })
      expect(
        (await practitionerA.delete(`/assigned-programs/${archived.id}`))
          .status,
      ).toBe(200)
      open = await createProgram({ startsIn: -3 })
    })

    // Workout B's exercise: the unfinished session (workout A) doesn't use
    // it, so deleting it meets no foreign key.
    const bExercise = (p: Program) =>
      p.exercises.find((e) => e.workoutId === p.workouts[1].id)!.id

    it.each<[string, (p: Program) => SQL]>([
      [
        'add a workout',
        (p) =>
          sql`INSERT INTO program_workouts (assigned_program_id, sort_order) VALUES (${p.id}, 9)`,
      ],
      [
        'change an exercise',
        (p) =>
          sql`UPDATE assigned_program_exercises SET sets = 9 WHERE assigned_program_id = ${p.id}`,
      ],
      [
        'remove an exercise',
        (p) =>
          sql`DELETE FROM assigned_program_exercises WHERE id = ${bExercise(p)}`,
      ],
      [
        'add a schedule version',
        (p) => sql`
          INSERT INTO program_schedules
            (assigned_program_id, type, times_per_week, effective_from, created_by)
          VALUES (${p.id}, 'paused', NULL, ${today}, ${practitionerAId})`,
      ],
      [
        'rename the program',
        (p) =>
          sql`UPDATE assigned_programs SET title = 'Renamed' WHERE id = ${p.id}`,
      ],
    ])(
      "refuses the care team's attempt to %s on a closed program",
      async (_label, statement) => {
        expect(await run(asA(), statement(cancelled))).toEqual(refused)
        expect(await run(asA(), statement(archived))).toEqual(refused)
        expect(await run(asA(), statement(open))).toHaveProperty('rows')
      },
    )

    // A SKIP (a new row that isn't open): the cancelled program still has
    // its session in progress (beforeAll), and a second OPEN one would be
    // refused by the one-open-per-program index first (2026-10-15) — this
    // test is about the guard.
    it("refuses the patient's new session on a closed program", async () => {
      const insert = (p: Program) => sql`
        INSERT INTO sessions
          (assigned_program_id, workout_id, patient_id, scheduled_date, local_date, status, ended_at, end_reason)
        VALUES (${p.id}, ${p.workouts[0].id}, ${patientId}, now(), ${today}, 'skipped', now(), 'other')`
      expect(await run(asPatient(), insert(cancelled))).toEqual(refused)
      expect(await run(asPatient(), insert(open))).toHaveProperty('rows')
    })

    // Decided with the person on 2026-10-15 (Phase 4 step 1b), replacing the
    // 2026-10-11 rule that a session in progress could still be finished: an
    // open session in a closed program makes no sense — cancelling CLOSED it
    // (incomplete, `program_closed`), so it is final like any finished one.
    it('closed the session that was in progress with the program', async () => {
      const read = await patient.get(`/sessions/${unfinishedSessionId}`)
      expect(read.body).toMatchObject({
        status: 'incomplete',
        endReason: 'program_closed',
      })
      const tick = await patient
        .patch(
          `/sessions/${unfinishedSessionId}/exercises/${unfinishedExerciseRowId}`,
        )
        .send({ completed: true })
      expect(tick.status).toBe(409)
      const finished = await patient
        .post(`/sessions/${unfinishedSessionId}/complete`)
        .send({})
      expect(finished.status).toBe(409)
    })

    // The program row: no way back to active; archiving a completed program
    // (is_archived and nothing else) is the one change left; an archived
    // program changes no more.
    it('keeps a closed program final, allowing only archiving', async () => {
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_programs SET status = 'active' WHERE id = ${cancelled.id}`,
        ),
      ).toEqual(refused)

      const completed = await createProgram({ startsIn: 3 })
      expect(
        (await close(practitionerA, completed.id, 'complete')).status,
      ).toBe(200)
      // Archiving means is_archived TRUE: "false" (here, no change at all)
      // isn't the one change allowed.
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_programs SET is_archived = false WHERE id = ${completed.id}`,
        ),
      ).toEqual(refused)
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_programs SET is_archived = true WHERE id = ${completed.id} RETURNING id`,
        ),
      ).toEqual({ rows: [{ id: completed.id }] })
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_programs SET is_archived = true, title = 'x' WHERE id = ${completed.id}`,
        ),
      ).toEqual(refused)

      const archived = await createProgram({ startsIn: 3 })
      expect(
        (await practitionerA.delete(`/assigned-programs/${archived.id}`))
          .status,
      ).toBe(200)
      expect(
        await run(
          asA(),
          sql`UPDATE assigned_programs SET is_archived = false WHERE id = ${archived.id}`,
        ),
      ).toEqual(refused)
    })

    // The tables' owner — migrations, the seed's reset — isn't guarded.
    it("doesn't guard the tables' owner", async () => {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        const { rowCount } = await client.query(
          "UPDATE assigned_programs SET title = 'Owner' WHERE id = $1",
          [cancelled.id],
        )
        expect(rowCount).toBe(1)
        // …nor on the program's children: the seed's reset deletes them,
        // closed programs included.
        const exercises = await client.query(
          'DELETE FROM assigned_program_exercises WHERE id = $1',
          [bExercise(cancelled)],
        )
        expect(exercises.rowCount).toBe(1)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    // The race the service alone couldn't close: the patient's request
    // passes the service's check (the program is still active), and its
    // INSERT reaches the database while a cancel holds the program's row
    // lock — as close() does (SELECT … FOR UPDATE). The insert's foreign-key
    // check waits for that lock; once the cancel commits, the guard, which
    // runs after that check, sees the program cancelled: 409, no session.
    it('refuses a session racing a cancel — once the cancel commits', async () => {
      const program = await createProgram({ startsIn: -3 })
      const canceller = await sessionPool.connect()
      try {
        await canceller.query('BEGIN')
        await canceller.query(
          'SELECT id FROM assigned_programs WHERE id = $1 FOR UPDATE',
          [program.id],
        )
        await canceller.query(
          "UPDATE assigned_programs SET status = 'cancelled', end_date = $2 WHERE id = $1",
          [program.id, yesterday],
        )

        let settled = false
        const pending = startSession(program.id, {
          workoutId: program.workouts[0].id,
        }).then((res) => {
          settled = true
          return res
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        // Still waiting for the cancel's lock.
        expect(settled).toBe(false)

        await canceller.query('COMMIT')
        const res = await pending
        expect(res.status).toBe(409)
        expect(res.body.message).toEqual([CLOSED_PROGRAM_MESSAGE])
      } finally {
        canceller.release()
      }
      const { rows } = await sessionPool.query(
        'SELECT 1 FROM sessions WHERE assigned_program_id = $1',
        [program.id],
      )
      expect(rows).toEqual([])
    })
  })

  // The new columns are part of every program returned.
  it('returns the new fields on a program', async () => {
    const program = await createProgram()
    expect(program).toMatchObject({
      allowSwaps: true,
      lateMakeUpDays: null,
      basedOnProgramId: null,
    })
  })
})
