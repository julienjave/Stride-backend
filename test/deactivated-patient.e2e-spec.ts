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

// What a deactivated patient's care team may still WRITE (decided
// 2026-10-27, design decisions §22). Their care team stays (§18) and can
// still read everything; what changes:
//   - programs: no new one, no change to an open one (409) — closing stays;
//   - messages: read-only (409), decided by the database (0063) — the
//     conversation list says so (canSend false, readOnlyReason);
//   - the To-do: no attendance alerts — session alerts stay;
//   - My patients: listed again with ?includeInactive=true.
// And reactivating the account undoes all of it.
//
// One story, in order: Dee (deactivated mid-file) and Pia (active, the
// control), both on Rory's care team.

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
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount, TEST_PASSWORD } from './support/accounts'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { addDays, utcToday } from '../src/common/calendar-date'
import { DEACTIVATED_PATIENT_PROGRAM_MESSAGE } from '../src/assigned-programs/program-state'
import {
  DEACTIVATED_PATIENT_MESSAGING_MESSAGE,
  READ_ONLY_CONVERSATION_MESSAGE,
} from '../src/messaging/message-rules'

describe("A deactivated patient's care team: what it may still write (e2e)", () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let rory: ReturnType<typeof agent>
  let sue: ReturnType<typeof agent>
  const stamp = Date.now()
  const today = utcToday()
  const ids: Record<string, number> = {}
  let clinicId: number
  let exerciseId: number

  interface Program {
    id: number
    patientId: number
    title: string
    workouts: { id: number }[]
  }
  interface Summary {
    id: number
    canSend: boolean
    readOnlyReason: string | null
  }

  // Every day scheduled: N days without a session are N misses in a row
  // (the alerts e2e's EVERY_DAY).
  const EVERY_DAY = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      workoutIndex: 0,
    })),
  }

  async function newPractitioner(key: string) {
    const email = `deapat-${key}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'practitioner',
      firstName: key[0].toUpperCase() + key.slice(1),
      lastName: 'Test',
      licenseNumber: `DEAPAT-${key}-${stamp}`,
      clinicId,
    })
    expect(res.status).toBe(201)
    ids[key] = res.body.id as number
    await activateAccount(sessionPool, email)
    const who = agent()
    const login = await who
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD })
    expect(login.status).toBe(201)
    return who
  }

  // Created by Rory, who so joins the care team (the real path).
  async function newPatient(key: string) {
    const email = `deapat-${key}-${stamp}@example.com`
    const res = await rory.post('/users').send({
      email,
      role: 'patient',
      firstName: key[0].toUpperCase() + key.slice(1),
      lastName: 'Test',
      dateOfBirth: '1980-02-03',
      clinicId,
    })
    expect(res.status).toBe(201)
    ids[key] = res.body.id as number
    await activateAccount(sessionPool, email)
  }

  async function newProgram(patient: string, startsDaysAgo: number) {
    const res = await rory.post('/assigned-programs').send({
      patientId: ids[patient],
      title: `${patient} program`,
      startDate: addDays(today, -startsDaysAgo),
      schedule: EVERY_DAY,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    expect(res.status).toBe(201)
    return res.body as Program
  }

  // A finished session on an earlier day, with feedback written (a reason
  // to review it), as only the owner can write it — the alerts e2e's
  // plantSession, reduced to what this file needs.
  async function plantSession(program: Program, daysAgo: number) {
    const moment = `($4::date - $5::int) + time '18:00'`
    const { rows } = await sessionPool.query<{ id: string }>(
      `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
         scheduled_date, local_date, status, started_at, completed_at,
         session_feedback)
       VALUES ($1, $2, $3, ${moment}, ($4::date - $5::int), 'completed',
               ${moment}, ${moment} + interval '30 minutes', 'My knee hurt')
       RETURNING id`,
      [program.id, program.workouts[0].id, program.patientId, today, daysAgo],
    )
    // A bigint: node-postgres answers it as a string.
    return Number(rows[0].id)
  }

  async function programRow(id: number) {
    const { rows } = await sessionPool.query<{
      title: string
      status: string
      workouts: string
    }>(
      `SELECT title, status::text,
              (SELECT count(*) FROM program_workouts w
               WHERE w.assigned_program_id = p.id)::text AS workouts
       FROM assigned_programs p WHERE id = $1`,
      [id],
    )
    return rows[0]
  }
  async function programsOf(patient: string) {
    const { rows } = await sessionPool.query<{ count: string }>(
      'SELECT count(*) FROM assigned_programs WHERE patient_id = $1',
      [ids[patient]],
    )
    return Number(rows[0].count)
  }
  async function messagesIn(conversationId: number) {
    const { rows } = await sessionPool.query<{ count: string }>(
      'SELECT count(*) FROM messages WHERE conversation_id = $1',
      [conversationId],
    )
    return Number(rows[0].count)
  }
  async function conversationsOf(patient: string) {
    const { rows } = await sessionPool.query<{ count: string }>(
      'SELECT count(*) FROM conversations WHERE patient_id = $1',
      [ids[patient]],
    )
    return Number(rows[0].count)
  }

  // A statement as the APP's role, with the context withRlsContext sets —
  // the database's own answer, without the service. Always rolled back:
  // its result, or the error's code.
  class RolledBack extends Error {
    constructor(readonly rows: unknown[]) {
      super('rolled back')
    }
  }
  async function asActor(userId: number, role: string, statement: SQL) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_user_id', ${String(userId)}, true),
                     set_config('app.current_role', ${role}, true)`,
        )
        const result = await tx.execute(statement)
        throw new RolledBack(result.rows)
      })
    } catch (error) {
      if (error instanceof RolledBack) return { rows: error.rows }
      const cause = (error as { cause?: { code?: string } }).cause
      return { code: cause?.code ?? (error as { code?: string }).code }
    }
    throw new Error('unreachable: asActor() always rolls back')
  }

  async function summaryOf(conversationId: number) {
    const res = await rory.get(`/conversations/${conversationId}`)
    expect(res.status).toBe(200)
    return res.body as Summary
  }
  async function alertsFor(program: Program) {
    const res = await rory.get(`/alerts?today=${today}`)
    expect(res.status).toBe(200)
    return (res.body as { kind: string; program: { id: number } }[])
      .filter((alert) => alert.program.id === program.id)
      .map((alert) => alert.kind)
  }
  async function myPatients(query = '') {
    const res = await rory.get(`/users${query}`)
    expect(res.status).toBe(200)
    return (res.body as { id: number; isActive: boolean }[])
      .map((user) => [user.id, user.isActive] as const)
      .sort((a, b) => a[0] - b[0])
  }

  // Set in beforeAll, before Dee's deactivation.
  let deeOpen: Program // open, eight days without a session
  let deeClosing: Program // open, to be completed after the deactivation
  let deeDone: Program // completed, with a recent session; to "assign again"
  let piaOpen: Program
  let deeConversation: number
  let eveConversation: number
  let deeSession: number

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
    // Same session setup as main.ts (see users.e2e-spec.ts for why).
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

    // Refuse to run anywhere but the test database (see users.e2e-spec.ts).
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

    admin = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Main Clinic',
      clinicEmail: `deapat-main-${stamp}@example.com`,
      email: `deapat-admin-${stamp}@example.com`,
      password: TEST_PASSWORD,
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicId = bootstrap.body.clinicId as number

    rory = await newPractitioner('rory')
    // Sue: same clinic, on nobody's care team here.
    sue = await newPractitioner('sue')
    await newPatient('dee')
    await newPatient('pia')
    // Eve: deactivated too, but Rory has also left her care team.
    await newPatient('eve')

    const exercise = await rory.post('/exercises').send({
      name: `Deactivated E2E Squat ${stamp}`,
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    expect(exercise.status).toBe(201)
    exerciseId = exercise.body.id as number

    // Eight days without a session: an attendance alert for each.
    deeOpen = await newProgram('dee', 8)
    piaOpen = await newProgram('pia', 8)
    deeClosing = await newProgram('dee', 1)
    deeDone = await newProgram('dee', 3)
    deeSession = await plantSession(deeDone, 2)
    const completed = await rory
      .post(`/assigned-programs/${deeDone.id}/complete`)
      .send({ today })
    expect(completed.status).toBe(200)

    const started = await rory.post('/conversations').send({ userId: ids.dee })
    expect(started.status).toBe(201)
    deeConversation = started.body.id as number
    const sent = await rory
      .post(`/conversations/${deeConversation}/messages`)
      .send({ messageBody: 'See you Monday' })
    expect(sent.status).toBe(201)

    // Before: everything open, as for any patient.
    expect(await alertsFor(deeOpen)).toEqual(['attendance'])
    expect(await alertsFor(deeDone)).toEqual(['session'])
    expect((await summaryOf(deeConversation)).canSend).toBe(true)

    const withEve = await rory.post('/conversations').send({ userId: ids.eve })
    expect(withEve.status).toBe(201)
    eveConversation = withEve.body.id as number

    // Deactivated through the API — the real path.
    expect((await admin.delete(`/users/${ids.dee}`)).status).toBe(200)
    const left = await rory.post(`/users/${ids.eve}/care-team/${ids.rory}/end`)
    expect(left.status).toBe(201)
    expect((await admin.delete(`/users/${ids.eve}`)).status).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  describe('programs', () => {
    it('refuses a new program, from a list or "assign again" — nothing written', async () => {
      const before = await programsOf('dee')

      const fresh = await rory.post('/assigned-programs').send({
        patientId: ids.dee,
        title: 'New',
        startDate: today,
        schedule: EVERY_DAY,
        exercises: [{ exerciseId, sortOrder: 0 }],
      })
      const again = await rory.post('/assigned-programs').send({
        patientId: ids.dee,
        title: 'Again',
        startDate: today,
        schedule: EVERY_DAY,
        basedOnProgramId: deeDone.id,
      })

      for (const res of [fresh, again]) {
        expect(res.status).toBe(409)
        expect(res.body.message).toEqual([DEACTIVATED_PATIENT_PROGRAM_MESSAGE])
      }
      expect(await programsOf('dee')).toBe(before)
    })

    it('refuses every kind of change to an open program — nothing written', async () => {
      const base = `/assigned-programs/${deeOpen.id}`
      const answers = [
        await rory.patch(base).send({ title: 'Changed' }),
        await rory.post(`${base}/workouts`).send({}),
        await rory.post(`${base}/exercises`).send({ exerciseId, sortOrder: 1 }),
        await rory
          .post(`${base}/schedules`)
          .send({ type: 'paused', effectiveFrom: today }),
      ]

      for (const res of answers) {
        expect(res.status).toBe(409)
        expect(res.body.message).toEqual([DEACTIVATED_PATIENT_PROGRAM_MESSAGE])
      }
      expect(await programRow(deeOpen.id)).toEqual({
        title: 'dee program',
        status: 'active',
        workouts: '1',
      })
    })

    // The 403 before the 409: Sue (same clinic, not on the team) learns
    // nothing about the account.
    it('still answers a stranger with the 403', async () => {
      const res = await sue.post('/assigned-programs').send({
        patientId: ids.dee,
        title: 'New',
        startDate: today,
        schedule: EVERY_DAY,
        exercises: [{ exerciseId, sortOrder: 0 }],
      })
      expect(res.status).toBe(403)
    })

    it('still reads them, and still closes one', async () => {
      expect((await rory.get(`/assigned-programs/${deeOpen.id}`)).status).toBe(
        200,
      )
      const done = await rory
        .post(`/assigned-programs/${deeClosing.id}/complete`)
        .send({ today })
      expect(done.status).toBe(200)
      expect((await programRow(deeClosing.id)).status).toBe('completed')
    })
  })

  describe('messages', () => {
    it('lists the conversation as read-only, saying why — the history kept', async () => {
      expect(await summaryOf(deeConversation)).toMatchObject({
        canSend: false,
        readOnlyReason: 'patient_deactivated',
      })
      const history = await rory.get(
        `/conversations/${deeConversation}/messages`,
      )
      expect(history.status).toBe(200)
      expect(
        (history.body as { messages: { messageBody: string }[] }).messages.map(
          (m) => m.messageBody,
        ),
      ).toEqual(['See you Monday'])
    })

    it('refuses a message and a new start with the 409 — nothing written', async () => {
      const before = await messagesIn(deeConversation)

      const sent = await rory
        .post(`/conversations/${deeConversation}/messages`)
        .send({ messageBody: 'Still there?' })
      const started = await rory
        .post('/conversations')
        .send({ userId: ids.dee })

      for (const res of [sent, started]) {
        expect(res.status).toBe(409)
        expect(res.body.message).toEqual([
          DEACTIVATED_PATIENT_MESSAGING_MESSAGE,
        ])
      }
      expect(await messagesIn(deeConversation)).toBe(before)
      expect(await conversationsOf('dee')).toBe(1)
    })

    // Both reasons at once: the ended link is the answer — reactivating
    // Eve wouldn't let Rory write to her.
    it('names the ended care team first, when there is one', async () => {
      expect(await summaryOf(eveConversation)).toMatchObject({
        canSend: false,
        readOnlyReason: 'care_team_ended',
      })
      const sent = await rory
        .post(`/conversations/${eveConversation}/messages`)
        .send({ messageBody: 'Hello?' })
      expect(sent.status).toBe(403)
      expect(sent.body.message).toEqual([READ_ONLY_CONVERSATION_MESSAGE])
      const started = await rory
        .post('/conversations')
        .send({ userId: ids.eve })
      expect(started.status).toBe(403)
    })

    // The rule is the database's, not only the service's: written as Rory
    // directly, past every TypeScript check, the INSERT is refused (42501,
    // messages_insert / conversations_insert) — while the same statements
    // for Pia pass.
    it('is refused by the database itself', async () => {
      const message = (conversationId: number) =>
        sql`INSERT INTO messages (conversation_id, sender_id, message_body)
            VALUES (${conversationId}, ${ids.rory}, 'Direct') RETURNING id`
      const conversation = (patientId: number) =>
        sql`INSERT INTO conversations (practitioner_id, patient_id)
            VALUES (${ids.rory}, ${patientId}) RETURNING id`

      expect(
        await asActor(ids.rory, 'practitioner', message(deeConversation)),
      ).toEqual({ code: '42501' })
      // The pair already has a conversation, so this INSERT would also
      // break the UNIQUE constraint — the 42501 shows the policy is checked
      // first. (For Pia, there is none yet: it passes, rolled back.)
      expect(
        await asActor(ids.rory, 'practitioner', conversation(ids.dee)),
      ).toEqual({ code: '42501' })
      const forPia = await asActor(
        ids.rory,
        'practitioner',
        conversation(ids.pia),
      )
      expect(forPia).toHaveProperty('rows')

      const { rows } = await sessionPool.query<{
        dee: boolean
        pia: boolean
        dee_team: boolean
      }>(
        `SELECT rls_can_message($1, $2) AS dee, rls_can_message($1, $3) AS pia,
                rls_care_team_member($1, $2) AS dee_team`,
        [ids.rory, ids.dee, ids.pia],
      )
      expect(rows[0]).toEqual({ dee: false, pia: true, dee_team: true })
    })
  })

  describe('the To-do', () => {
    it("drops the attendance alert, keeps the session to review — Pia's untouched", async () => {
      expect(await alertsFor(deeOpen)).toEqual([])
      expect(await alertsFor(deeDone)).toEqual(['session'])
      expect(await alertsFor(piaOpen)).toEqual(['attendance'])
    })

    it('still takes a review of that session', async () => {
      const res = await rory.post(`/sessions/${deeSession}/review`)
      expect(res.status).toBe(200)
      expect(await alertsFor(deeDone)).toEqual([])
    })
  })

  describe('My patients', () => {
    it('leaves Dee out by default, and lists her with ?includeInactive=true', async () => {
      expect(await myPatients()).toEqual([[ids.pia, true]])
      expect(await myPatients('?includeInactive=true')).toEqual(
        [
          [ids.dee, false],
          [ids.pia, true],
        ].sort((a, b) => (a[0] as number) - (b[0] as number)),
      )
      expect(await myPatients('?includeInactive=false')).toEqual([
        [ids.pia, true],
      ])
    })

    // The flag widens the account filter, never whose patients.
    it("never lists another practitioner's patients", async () => {
      const res = await sue.get('/users?includeInactive=true')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })
  })

  // Last: reactivating undoes everything above.
  describe('after reactivation', () => {
    beforeAll(async () => {
      const res = await admin.post(`/users/${ids.dee}/reactivate`)
      expect(res.status).toBe(201)
    })

    it('opens the programs, the conversation and the alerts again', async () => {
      const changed = await rory
        .patch(`/assigned-programs/${deeOpen.id}`)
        .send({ title: 'Changed' })
      expect(changed.status).toBe(200)

      expect(await summaryOf(deeConversation)).toMatchObject({
        canSend: true,
        readOnlyReason: null,
      })
      const sent = await rory
        .post(`/conversations/${deeConversation}/messages`)
        .send({ messageBody: 'Welcome back' })
      expect(sent.status).toBe(201)

      expect(await alertsFor(deeOpen)).toEqual(['attendance'])
    })
  })
})
