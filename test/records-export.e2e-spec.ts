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
import { pdfText } from './support/pdf-text'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { addDays, utcToday } from '../src/common/calendar-date'

// The records export, pass 1 (decisions §20): GET /records-export — a
// patient downloads a PDF copy of their own record. What these tests hold
// the route to:
//   - the copy is the patient's WHOLE record and nobody else's (the medical
//     file with its corrections, the programs, the sessions);
//   - it is a file the browser saves and no cache keeps;
//   - RECORDS_EXPORTED says exactly which rows went in, and no copy leaves
//     without it;
//   - the record is read at ONE moment (repeatable read);
//   - only a patient, acting as one, gets it.
// The words and the layout are the unit specs' (record-content.spec.ts,
// record-pdf.spec.ts); here the PDF is read back (support/pdf-text.ts) only
// to see WHOSE data it holds.
describe('Records export (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let stamp: number
  let accountCounter = 0
  let exerciseId: number
  let squatId: number
  let clinicId: number

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  let practitioner: Agent

  const GUARD_MESSAGE = 'You do not have permission to access this resource'
  const today = utcToday()

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

    db = app.get<DrizzleDb>(DRIZZLE)
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

    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = request.agent(app.getHttpServer())
    stamp = Date.now()
    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Records Export E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'RE',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }

    clinicId = clinicRes.body.clinicId
    const email = `pr-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'practitioner',
      firstName: 'Alex',
      lastName: 'Chen',
      licenseNumber: `PT-${stamp}`,
      clinicId,
    })
    expect(res.status).toBe(201)
    practitioner = await signIn(email)

    const exerciseRes = await practitioner.post('/exercises').send({
      name: 'Export E2E Bridge',
      primaryMuscles: ['glutes'],
      instructions: ['Lift the hips'],
    })
    expect(exerciseRes.status).toBe(201)
    exerciseId = exerciseRes.body.id
    const squatRes = await practitioner.post('/exercises').send({
      name: 'Export E2E Squat',
      primaryMuscles: ['legs'],
      instructions: ['Bend the knees'],
    })
    expect(squatRes.status).toBe(201)
    squatId = squatRes.body.id
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- Helpers ----------------------------------------------------------------

  async function signIn(email: string): Promise<Agent> {
    await activateAccount(sessionPool, email)
    const agent = request.agent(app.getHttpServer())
    expect(
      (await agent.post('/auth/login').send({ email, password: 'password123' }))
        .status,
    ).toBe(201)
    return agent
  }

  // A patient of the clinic, on the practitioner's care team (joining one
  // needs a shared clinic), signed in.
  async function newPatient(firstName: string) {
    const email = `pa-${++accountCounter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      // Many patients with one name and birthday, on purpose: the
      // possible-duplicate warning has its own suite (possible-duplicates).
      allowPossibleDuplicate: true,
      firstName,
      lastName: 'Export',
      dateOfBirth: '1988-04-12',
      clinicId,
    })
    expect(res.status).toBe(201)
    const id = res.body.id as number
    expect(
      (await practitioner.post(`/users/${id}/care-team`).send({})).status,
    ).toBe(201)
    return { agent: await signIn(email), id, email }
  }

  async function addEntry(patientId: number, fields: Record<string, unknown>) {
    const res = await practitioner
      .post('/medical-files')
      .send({ patientId, entryType: 'progress_note', ...fields })
    expect(res.status).toBe(201)
    return res.body as { id: number }
  }

  // A program for the patient (every day, from a week ago), with today's
  // session completed through the real routes, and an EARLIER completed
  // session written by the owner (the API only files a session under
  // today). Returns the ids, sessions in date order.
  async function programWithSessions(
    patient: { agent: Agent; id: number },
    title: string,
    feedback: string,
  ) {
    const programRes = await practitioner.post('/assigned-programs').send({
      patientId: patient.id,
      title,
      startDate: addDays(today, -7),
      schedule: {
        type: 'weekdays',
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          workoutIndex: 0,
        })),
      },
      exercises: [{ exerciseId, sortOrder: 0, sets: 3, reps: 10 }],
    })
    expect(programRes.status).toBe(201)
    const program = programRes.body as {
      id: number
      workouts: { id: number }[]
    }

    const {
      rows: [earlier],
    } = await sessionPool.query<{ id: string }>(
      `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
         scheduled_date, local_date, status, started_at, completed_at,
         pain_before, pain_after)
       VALUES ($1, $2, $3, now() - interval '2 days', $4::date, 'completed',
               now() - interval '2 days', now() - interval '2 days', 5, 3)
       RETURNING id`,
      [program.id, program.workouts[0].id, patient.id, addDays(today, -2)],
    )
    await sessionPool.query(
      `INSERT INTO session_exercises
         (session_id, assigned_program_exercise_id, name, sets, reps,
          duration_in_seconds, weight, weight_unit, notes, primary_muscles,
          secondary_muscles, equipment, instructions, completed, sort_order,
          feedback)
       SELECT $1, pe.id, pe.name, pe.sets, pe.reps, pe.duration_in_seconds,
              pe.weight, pe.weight_unit, pe.notes, pe.primary_muscles,
              pe.secondary_muscles, pe.equipment, pe.instructions, true, 0, $3
       FROM assigned_program_exercises pe WHERE pe.assigned_program_id = $2`,
      [earlier.id, program.id, feedback],
    )

    const started = await patient.agent
      .post('/sessions')
      .send({ assignedProgramId: program.id, localDate: today, painBefore: 4 })
    expect(started.status).toBe(201)
    const completed = await patient.agent
      .post(`/sessions/${started.body.id}/complete`)
      .send({ painAfter: 2, sessionFeedback: `${title}: a good day` })
    expect(completed.status).toBe(200)

    return {
      programId: program.id,
      sessionIds: [Number(earlier.id), started.body.id as number],
    }
  }

  // GET /records-export, the PDF kept as bytes (supertest parses only text
  // and JSON by itself).
  function download(
    agent: Agent | request.SuperTest<request.Test>,
    query = '',
  ) {
    return agent
      .get(`/records-export${query}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => done(null, Buffer.concat(chunks)))
      })
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  async function exportEntries(patientId: number): Promise<AuditRow[]> {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type, entity_id, details
       FROM audit_logs WHERE entity_type = 'records_exports' AND target_user_id = $1
       ORDER BY id`,
      [patientId],
    )
    return rows
  }

  async function exportCount(): Promise<number> {
    const { rows } = await sessionPool.query<{ count: string }>(
      `SELECT count(*) FROM audit_logs WHERE action = 'RECORDS_EXPORTED'`,
    )
    return Number(rows[0].count)
  }

  // --- The copy -----------------------------------------------------------------

  it('hands a patient their own whole record as a PDF, and records exactly what went in', async () => {
    const pat = await newPatient('Pat')
    const original = await addEntry(pat.id, {
      objective: 'Left knee flexion 110°.',
    })
    const correction = await addEntry(pat.id, {
      objective: 'Right knee flexion 110°.',
      amendsId: original.id,
      amendmentReason: 'The wrong knee was recorded.',
    })
    const later = await addEntry(pat.id, { plan: 'Review in two weeks.' })
    const knee = await programWithSessions(pat, 'Knee Rehab', 'Easy today 😊')
    // Range of motion (Phase 7): measured at the visit of the last note.
    const rom = await practitioner.post('/range-of-motion').send({
      patientId: pat.id,
      measuredOn: today,
      medicalFileEntryId: later.id,
      measurements: [
        {
          movement: 'knee_flexion',
          side: 'right',
          mode: 'active',
          degrees: 95,
        },
      ],
    })
    expect(rom.status).toBe(201)

    // Someone else's record, in the same clinic, by the same practitioner.
    const jo = await newPatient('Jo')
    await addEntry(jo.id, { plan: 'Jo’s own plan.' })
    await programWithSessions(jo, 'Shoulder Rehab', 'Jo’s feedback')

    const res = await download(pat.agent, '?timeZone=America/Montreal')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="stride-health-record-\d{4}-\d{2}-\d{2}\.pdf"$/,
    )
    expect(res.headers['cache-control']).toBe('no-store')
    const pdf = res.body as Buffer
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(Number(res.headers['content-length'])).toBe(pdf.length)

    const text = pdfText(pdf)
    expect(text).toEqual(
      expect.arrayContaining([
        'Name: ',
        'Pat Export',
        'Right knee flexion 110°.',
        // The replaced version stays in the copy, under its correction.
        'Left knee flexion 110°.',
        'The wrong knee was recorded.',
        'Review in two weeks.',
        'Knee Rehab',
        'Knee Rehab: a good day',
        'Range of motion',
      ]),
    )
    expect(text.join('\n')).toContain(
      'Knee flexion, right, active: 95° (typical 135°)',
    )
    // The patient's emoji, drawn in the emoji font: a piece of its own.
    expect(text.join('\n')).toContain('Easy today ')
    expect(text).toContain('😊')
    // Nothing of Jo's.
    expect(text.join('\n')).not.toMatch(/Jo’s|Shoulder Rehab|Jo Export/)

    expect(await exportEntries(pat.id)).toStrictEqual([
      {
        action: 'RECORDS_EXPORTED',
        performed_by: pat.id,
        target_user_id: pat.id,
        entity_type: 'records_exports',
        entity_id: null,
        details: {
          via: 'app',
          timeZone: 'America/Montreal',
          // Newest first, as the file is read.
          medicalFileEntryIds: [later.id, correction.id, original.id],
          romAssessmentIds: [rom.body.id],
          programIds: [knee.programId],
          sessionIds: knee.sessionIds,
        },
      },
    ])
    expect(await exportEntries(jo.id)).toStrictEqual([])
  })

  // The loader's own order — every one set up so that the order the rows
  // were WRITTEN in differs from the order they must be SHOWN in.
  it('writes programs newest first, and each one in its own order', async () => {
    const ana = await newPatient('Ana')
    const everyDay = {
      type: 'weekdays',
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        workoutIndex: 0,
      })),
    }
    // The OLDER program written first: the database's own order would put
    // it first.
    const earlier = await practitioner.post('/assigned-programs').send({
      patientId: ana.id,
      title: 'Earlier block',
      startDate: addDays(today, -20),
      schedule: everyDay,
      exercises: [{ exerciseId, sortOrder: 0 }],
    })
    expect(earlier.status).toBe(201)
    const later = await practitioner.post('/assigned-programs').send({
      patientId: ana.id,
      title: 'Later block',
      startDate: addDays(today, -3),
      schedule: everyDay,
      // Given Bridge first, but Squat is first in the workout.
      exercises: [
        { exerciseId, sortOrder: 1 },
        { exerciseId: squatId, sortOrder: 0 },
      ],
    })
    expect(later.status).toBe(201)
    // A second workout, then moved before the first: B is now A.
    const strength = await practitioner
      .post(`/assigned-programs/${later.body.id}/workouts`)
      .send({ name: 'Strength' })
    expect(strength.status).toBe(201)
    const workoutIds = (
      strength.body as { workouts: { id: number; name: string | null }[] }
    ).workouts.map((workout) => workout.id)
    expect(workoutIds).toHaveLength(2)
    const reordered = await practitioner
      .patch(`/assigned-programs/${later.body.id}/workouts`)
      .send({ order: [workoutIds[1], workoutIds[0]] })
    expect(reordered.status).toBe(200)

    // A session of the later block whose exercise rows are WRITTEN in the
    // reverse of their sort order (Bridge, then Squat).
    const {
      rows: [planted],
    } = await sessionPool.query<{ id: string }>(
      `INSERT INTO sessions (assigned_program_id, workout_id, patient_id,
         scheduled_date, local_date, status, started_at, completed_at)
       VALUES ($1, $2, $3, now() - interval '1 day', $4::date, 'completed',
               now() - interval '1 day', now() - interval '1 day')
       RETURNING id`,
      [later.body.id, workoutIds[0], ana.id, addDays(today, -1)],
    )
    await sessionPool.query(
      `INSERT INTO session_exercises
         (session_id, assigned_program_exercise_id, name, sets, reps,
          primary_muscles, secondary_muscles, equipment, instructions,
          completed, sort_order)
       SELECT $1, pe.id, pe.name, pe.sets, pe.reps, pe.primary_muscles,
              pe.secondary_muscles, pe.equipment, pe.instructions, true,
              pe.sort_order
       FROM assigned_program_exercises pe WHERE pe.assigned_program_id = $2
       ORDER BY pe.sort_order DESC`,
      [planted.id, later.body.id],
    )

    const text = pdfText((await download(ana.agent)).body as Buffer)

    const at = (piece: string) => {
      expect(text).toContain(piece)
      return text.indexOf(piece)
    }
    expect(at('Later block')).toBeLessThan(at('Earlier block'))
    expect(at('Workout A · Strength')).toBeLessThan(at('Workout B'))
    expect(at('Export E2E Squat')).toBeLessThan(at('Export E2E Bridge'))
    expect(at('Done: Export E2E Squat')).toBeLessThan(
      at('Done: Export E2E Bridge'),
    )
  })

  // An exercise taken out of a workout that already had sessions with it is
  // RETIRED, not deleted: no longer prescribed, still in the sessions that
  // included it (from their own copy).
  it('leaves a retired exercise out of the prescription, and keeps it in its sessions', async () => {
    const max = await newPatient('Max')
    const { programId } = await programWithSessions(max, 'Ankle', 'Fine')
    const {
      rows: [row],
    } = await sessionPool.query<{ id: number }>(
      'SELECT id FROM assigned_program_exercises WHERE assigned_program_id = $1',
      [programId],
    )
    const removed = await practitioner.delete(
      `/assigned-programs/${programId}/exercises/${row.id}`,
    )
    expect(removed.status).toBe(200)
    const { rows: retired } = await sessionPool.query(
      'SELECT 1 FROM assigned_program_exercises WHERE id = $1 AND retired_at IS NOT NULL',
      [row.id],
    )
    expect(retired).toHaveLength(1)

    const text = pdfText((await download(max.agent)).body as Buffer)

    // The workout's prescription is empty; both sessions still list it —
    // the earlier one ticked, today's not (completed without ticking).
    expect(text).toContain('No exercises.')
    expect(text).not.toContain('Export E2E Bridge — 3 × 10')
    expect(
      text.filter((piece) => /^(Done|Not done): Export E2E Bridge/.test(piece)),
    ).toEqual([
      'Done: Export E2E Bridge — 3 × 10 · “Fine”',
      'Not done: Export E2E Bridge — 3 × 10',
    ])
  })

  it('copies an empty record too — and says so', async () => {
    const robin = await newPatient('Robin')

    const res = await download(robin.agent)

    expect(res.status).toBe(200)
    expect(pdfText(res.body as Buffer)).toEqual(
      expect.arrayContaining([
        // Robin's own name — not the first patient's in the table.
        'Robin Export',
        'Your medical file has no entries.',
        'No range of motion has been recorded.',
        'You have no exercise programs.',
      ]),
    )
    expect((await exportEntries(robin.id))[0].details).toStrictEqual({
      via: 'app',
      // No zone sent: UTC, and the copy says so.
      timeZone: 'UTC',
      medicalFileEntryIds: [],
      romAssessmentIds: [],
      programIds: [],
      sessionIds: [],
    })
    expect(pdfText(res.body as Buffer).join('\n')).toContain('(UTC time)')
  })

  // --- One moment ----------------------------------------------------------------

  // The copy reads the record in several statements. Another connection
  // locks session_exercises and changes an exercise's feedback, uncommitted:
  // the export reads everything before that table, then WAITS on the lock.
  // The change commits while it waits. Under read committed, the export's
  // next statement would see it; under repeatable read, every statement sees
  // the database as it was at the first one — the copy shows the old words.
  // A second copy, made afterwards, shows the new ones (the check can see
  // them).
  it('reads the whole record at one moment, even when it changes half-way', async () => {
    const sky = await newPatient('Sky')
    await programWithSessions(sky, 'Hip Rehab', 'Before the change')

    const client = await sessionPool.connect()
    let waited: boolean
    let res: request.Response
    try {
      await client.query('BEGIN')
      await client.query(
        'LOCK TABLE session_exercises IN ACCESS EXCLUSIVE MODE',
      )
      await client.query(
        `UPDATE session_exercises SET feedback = 'After the change'
         WHERE feedback = 'Before the change'`,
      )
      let answered = false
      const pending = download(sky.agent).then((answer) => {
        answered = true
        return answer
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      waited = !answered
      await client.query('COMMIT')
      res = await pending
    } finally {
      client.release()
    }

    expect(waited).toBe(true)
    expect(res.status).toBe(200)
    const during = pdfText(res.body as Buffer).join('\n')
    expect(during).toContain('Before the change')
    expect(during).not.toContain('After the change')

    const after = pdfText((await download(sky.agent)).body as Buffer).join('\n')
    expect(after).toContain('After the change')
  })

  // --- No copy without its trace ------------------------------------------------

  // The audit entry is written in the copy's transaction, before a byte is
  // sent: an entry that can't be written means no copy at all.
  it('sends nothing when the audit entry cannot be written', async () => {
    const kim = await newPatient('Kim')
    await sessionPool.query(`
      CREATE FUNCTION test_refuse_export_entry() RETURNS trigger
        LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'RECORDS_EXPORTED' THEN
          RAISE EXCEPTION 'audit insert refused by the test';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_refuse_export_entry BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_refuse_export_entry();
    `)
    let res: request.Response
    try {
      res = await download(kim.agent)
    } finally {
      await sessionPool.query(`
        DROP TRIGGER test_refuse_export_entry ON audit_logs;
        DROP FUNCTION test_refuse_export_entry();
      `)
    }

    expect(res.status).toBe(500)
    expect(res.headers['content-type']).not.toBe('application/pdf')
    expect(await exportEntries(kim.id)).toStrictEqual([])
  })

  // --- The time zone ---------------------------------------------------------------

  it.each([
    ['an unknown zone', 'Europe/Atlantis'],
    ['an offset', '%2B02:00'],
  ])('refuses %s, and records nothing', async (_label, zone) => {
    const lee = await newPatient('Lee')

    const res = await lee.agent.get(`/records-export?timeZone=${zone}`)

    expect(res.status).toBe(400)
    expect(res.body.message).toEqual([
      'timeZone must be a time zone name, like Europe/Paris or America/Montreal',
    ])
    expect(await exportEntries(lee.id)).toStrictEqual([])
  })

  it('refuses a parameter it does not know', async () => {
    const lee = await newPatient('Lee')

    const res = await lee.agent.get('/records-export?patientId=1')

    expect(res.status).toBe(400)
    expect(res.body.message).toEqual(['property patientId should not exist'])
  })

  // --- Who ----------------------------------------------------------------------------

  it('keeps the route from practitioners and admins, and from anyone signed out', async () => {
    const before = await exportCount()

    const asPractitioner = await practitioner.get('/records-export')
    const asAdmin = await admin.get('/records-export')
    const signedOut = await request(app.getHttpServer()).get('/records-export')

    expect([asPractitioner.status, asPractitioner.body.message]).toEqual([
      403,
      [GUARD_MESSAGE],
    ])
    expect([asAdmin.status, asAdmin.body.message]).toEqual([
      403,
      [GUARD_MESSAGE],
    ])
    expect([signedOut.status, signedOut.body.message]).toEqual([
      401,
      ['You must be logged in to access this resource'],
    ])
    expect(await exportCount()).toBe(before)
  })
})
