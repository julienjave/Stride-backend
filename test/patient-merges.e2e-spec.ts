import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common'
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
import { WRONG_PASSWORD_MESSAGE } from '../src/common/current-password'
import { MERGED_ACCOUNT_REACTIVATION_MESSAGE } from '../src/users/users.service'
import {
  ALREADY_MERGED_MESSAGE,
  MERGE_INTO_ITSELF_MESSAGE,
  MERGED_IS_STAFF_MESSAGE,
  NOT_PATIENTS_MESSAGE,
  SURVIVOR_DEACTIVATED_MESSAGE,
} from '../src/patient-merges/patient-merge-rules'
import { NOT_A_MERGE_NOTICE_MESSAGE } from '../src/alerts/patient-merge-notices.service'

// Merging two accounts of the same patient (decisions §27, pass 3):
// POST /users/:id/merge { intoUserId, currentPassword }. The account in the
// address is merged AWAY into the one the admin keeps. The rows are read
// back as the database's owner (`sessionPool`) — the admin's own row
// security hides clinical rows, which is the whole reason the merge runs in
// a SECURITY DEFINER function (migration 0072).
describe('Patient merges (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let stamp: number
  let counter = 0
  let clinicId: number
  let otherClinicId: number
  let alexId: number
  let samId: number
  let exerciseId: number
  const outbox = new InMemoryEmailTransport()

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  let alex: Agent
  let sam: Agent

  const today = new Date().toISOString().slice(0, 10)
  const EVERY_DAY = {
    type: 'weekdays',
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      workoutIndex: 0,
    })),
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue(outbox)
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
    if (rows[0].current_database !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${rows[0].current_database}" — expected "stride_test".`,
      )
    }
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = request.agent(app.getHttpServer())
    stamp = Date.now()
    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Patient Merges E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Avery',
      lastName: 'Admin',
    })
    expect(clinicRes.status).toBe(201)
    clinicId = clinicRes.body.clinicId
    const other = await admin.post('/clinics').send({
      name: 'Patient Merges E2E Harbour',
      email: `harbour-${stamp}@example.com`,
    })
    expect(other.status).toBe(201)
    otherClinicId = other.body.id

    ;({ id: alexId, agent: alex } = await newPractitioner('Alex'))
    ;({ id: samId, agent: sam } = await newPractitioner('Sam'))
    const exercise = await alex.post('/exercises').send({
      name: 'Merge E2E Bridge',
      primaryMuscles: ['glutes'],
      instructions: ['Lift the hips'],
    })
    expect(exercise.status).toBe(201)
    exerciseId = exercise.body.id
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- Fixtures ---

  async function newAccount(fields: Record<string, unknown>, activate = true) {
    const email = `acct-${++counter}-${stamp}@example.com`
    const res = await admin
      .post('/users')
      .send({ email, allowPossibleDuplicate: true, ...fields })
    expect(res.status).toBe(201)
    const agent = request.agent(app.getHttpServer())
    if (activate) {
      await activateAccount(sessionPool, email)
      expect(
        (
          await agent
            .post('/auth/login')
            .send({ email, password: 'password123' })
        ).status,
      ).toBe(201)
    }
    return { id: res.body.id as number, agent, email }
  }

  function newPractitioner(firstName: string) {
    return newAccount({
      role: 'practitioner',
      firstName,
      lastName: 'Physio',
      licenseNumber: `PT-${firstName}-${stamp}`,
      clinicId,
    })
  }

  function newPatient(
    lastName: string,
    options: { clinic?: number; activate?: boolean } = {},
  ) {
    return newAccount(
      {
        role: 'patient',
        firstName: 'Pat',
        lastName,
        dateOfBirth: '1988-04-12',
        clinicId: options.clinic ?? clinicId,
      },
      options.activate ?? true,
    )
  }

  async function join(who: Agent, patientId: number) {
    expect(
      (await who.post(`/users/${patientId}/care-team`).send({})).status,
    ).toBe(201)
  }

  async function startConversation(patientId: number): Promise<number> {
    const res = await alex.post('/conversations').send({ userId: patientId })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  async function send(who: Agent, conversationId: number, text: string) {
    const res = await who
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody: text })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  function merge(
    mergedId: number,
    intoUserId: number,
    body: Record<string, unknown> = {},
    who: Agent = admin,
  ) {
    return who
      .post(`/users/${mergedId}/merge`)
      .send({ intoUserId, currentPassword: 'password123', ...body })
  }

  async function ownerRows<T extends object>(
    text: string,
    values: unknown[],
  ): Promise<T[]> {
    return (await sessionPool.query<T>(text, values)).rows
  }

  async function entriesAbout(survivorId: number) {
    return ownerRows<{
      action: string
      performed_by: number
      entity_type: string
      entity_id: number
      details: Record<string, unknown>
    }>(
      `SELECT action, performed_by, entity_type, entity_id::int AS entity_id, details
         FROM audit_logs
        WHERE target_user_id = $1 AND entity_type LIKE 'patient_merge%'
        ORDER BY id`,
      [survivorId],
    )
  }

  // --- The merge ---

  describe('moving the record', () => {
    // One person, two accounts: Pat Twin (kept) and Pat Twin (a duplicate
    // invited under another address). The duplicate has a program with a
    // completed session, a medical file entry and its amendment, and a
    // thread with Alex; the survivor has its own thread with Alex.
    let survivor: { id: number; agent: Agent; email: string }
    let duplicate: { id: number; agent: Agent; email: string }
    let programId: number
    let sessionId: number
    let entryId: number
    let amendmentId: number
    let assessmentId: number
    let assessmentAmendmentId: number
    let survivorConversation: number
    let duplicateConversation: number
    let fromAlex: number
    let fromDuplicate: number
    let fromSurvivor: number
    let sessionsBefore: number
    let res: request.Response

    beforeAll(async () => {
      survivor = await newPatient('Twin')
      duplicate = await newPatient('Twin')
      await join(alex, survivor.id)
      await join(alex, duplicate.id)

      const program = await alex.post('/assigned-programs').send({
        patientId: duplicate.id,
        title: 'Knee block',
        startDate: today,
        schedule: EVERY_DAY,
        exercises: [{ exerciseId, sortOrder: 0, sets: 3, reps: 10 }],
      })
      expect(program.status).toBe(201)
      programId = program.body.id
      const started = await duplicate.agent
        .post('/sessions')
        .send({ assignedProgramId: programId, localDate: today, painBefore: 4 })
      expect(started.status).toBe(201)
      sessionId = started.body.id
      expect(
        (
          await duplicate.agent
            .post(`/sessions/${sessionId}/complete`)
            .send({ painAfter: 2 })
        ).status,
      ).toBe(200)

      const entry = await alex.post('/medical-files').send({
        patientId: duplicate.id,
        entryType: 'progress_note',
        plan: 'Left knee.',
      })
      expect(entry.status).toBe(201)
      entryId = entry.body.id
      const amendment = await alex.post('/medical-files').send({
        patientId: duplicate.id,
        entryType: 'progress_note',
        plan: 'Right knee.',
        amendsId: entryId,
        amendmentReason: 'The wrong knee was recorded',
      })
      expect(amendment.status).toBe(201)
      amendmentId = amendment.body.id

      // Range of motion (0077): an assessment LINKED to the note's first
      // version, and its correction linked to the same note — the move must
      // carry the note and both assessments in one statement, or the
      // composite keys (note, patient) and (amends, patient) break.
      const assessment = await alex.post('/range-of-motion').send({
        patientId: duplicate.id,
        measuredOn: today,
        medicalFileEntryId: entryId,
        measurements: [
          {
            movement: 'knee_flexion',
            side: 'right',
            mode: 'active',
            degrees: 90,
          },
        ],
      })
      expect(assessment.status).toBe(201)
      assessmentId = assessment.body.id
      const assessmentAmendment = await alex.post('/range-of-motion').send({
        patientId: duplicate.id,
        measuredOn: today,
        medicalFileEntryId: entryId,
        amendsId: assessmentId,
        amendmentReason: 'Misread',
        measurements: [
          {
            movement: 'knee_flexion',
            side: 'right',
            mode: 'active',
            degrees: 95,
          },
        ],
      })
      expect(assessmentAmendment.status).toBe(201)
      assessmentAmendmentId = assessmentAmendment.body.id

      survivorConversation = await startConversation(survivor.id)
      duplicateConversation = await startConversation(duplicate.id)
      fromAlex = await send(alex, duplicateConversation, 'Start light.')
      fromDuplicate = await send(duplicate.agent, duplicateConversation, 'OK!')
      fromSurvivor = await send(survivor.agent, survivorConversation, 'Hello')

      // Read just before: the session table outlives each suite, and ids
      // restart — an earlier suite's sessions can carry this user's id too
      // (deferred-improvements.md, "the session table outlives each suite").
      const [count] = await ownerRows<{ n: number }>(
        `SELECT count(*)::int AS n FROM session
          WHERE (sess::jsonb)->'passport'->'user'->>'id' = $1`,
        [String(duplicate.id)],
      )
      sessionsBefore = count.n
      outbox.sent.length = 0
      res = await merge(duplicate.id, survivor.id)
    })

    it('answers the merge and the two accounts — nothing of what moved', async () => {
      expect(res.status).toBe(200)
      const [record] = await ownerRows<{ id: number }>(
        'SELECT id FROM patient_merges WHERE merged_id = $1',
        [duplicate.id],
      )
      expect(res.body).toStrictEqual({
        mergeId: record.id,
        mergedId: duplicate.id,
        survivorId: survivor.id,
      })
    })

    it('moves the program, its session and the medical file — amendment chain intact', async () => {
      const owners = await ownerRows<{
        kind: string
        id: number
        patient_id: number
      }>(
        `SELECT 'program' AS kind, id, patient_id FROM assigned_programs WHERE id = $1
         UNION ALL SELECT 'session', id::int, patient_id FROM sessions WHERE id = $2
         UNION ALL SELECT 'entry', id, patient_id FROM medical_files WHERE id = ANY($3)
         ORDER BY kind, id`,
        [programId, sessionId, [entryId, amendmentId]],
      )
      expect(owners).toStrictEqual([
        { kind: 'entry', id: entryId, patient_id: survivor.id },
        { kind: 'entry', id: amendmentId, patient_id: survivor.id },
        { kind: 'program', id: programId, patient_id: survivor.id },
        { kind: 'session', id: sessionId, patient_id: survivor.id },
      ])
      // …and the survivor sees them as their own, through the API.
      const programs = await survivor.agent.get('/assigned-programs')
      expect(programs.status).toBe(200)
      expect(
        (programs.body as { id: number }[]).map((program) => program.id),
      ).toContain(programId)
    })

    it('moves the range of motion with its note — link, chain and values intact', async () => {
      const owners = await ownerRows<{
        id: number
        patient_id: number
        medical_file_entry_id: number
        amends_id: number | null
        degrees: number[]
      }>(
        `SELECT a.id, a.patient_id, a.medical_file_entry_id, a.amends_id,
                array_agg(m.degrees ORDER BY m.id) AS degrees
         FROM rom_assessments a JOIN rom_measurements m ON m.assessment_id = a.id
         WHERE a.id = ANY($1) GROUP BY a.id ORDER BY a.id`,
        [[assessmentId, assessmentAmendmentId]],
      )
      expect(owners).toStrictEqual([
        {
          id: assessmentId,
          patient_id: survivor.id,
          medical_file_entry_id: entryId,
          amends_id: null,
          degrees: [90],
        },
        {
          id: assessmentAmendmentId,
          patient_id: survivor.id,
          medical_file_entry_id: entryId,
          amends_id: assessmentId,
          degrees: [95],
        },
      ])
      // …and the survivor reads them as their own.
      const rom = await survivor.agent.get('/range-of-motion')
      expect(rom.status).toBe(200)
      expect((rom.body as { id: number }[]).map((one) => one.id)).toStrictEqual(
        [assessmentAmendmentId, assessmentId],
      )
    })

    it('combines the two threads with Alex into one, in date order, sent by the survivor', async () => {
      const threads = await ownerRows<{ id: number }>(
        'SELECT id FROM conversations WHERE practitioner_id = $1 AND patient_id = ANY($2) ORDER BY id',
        [alexId, [survivor.id, duplicate.id]],
      )
      expect(threads).toStrictEqual([{ id: survivorConversation }])
      const messages = await ownerRows<{ id: number; sender_id: number }>(
        'SELECT id::int AS id, sender_id FROM messages WHERE conversation_id = $1 ORDER BY sent_at, id',
        [survivorConversation],
      )
      expect(messages).toStrictEqual([
        { id: fromAlex, sender_id: alexId },
        { id: fromDuplicate, sender_id: survivor.id },
        { id: fromSurvivor, sender_id: survivor.id },
      ])
    })

    it('deactivates the duplicate and signs it out', async () => {
      const [row] = await ownerRows<{ is_active: boolean }>(
        'SELECT is_active FROM users WHERE id = $1',
        [duplicate.id],
      )
      expect(row.is_active).toBe(false)
      expect((await duplicate.agent.get('/auth/me')).status).toBe(401)
      // The survivor stays signed in.
      expect((await survivor.agent.get('/auth/me')).status).toBe(200)
    })

    it('writes two entries: the account half for admins, the records half withheld', async () => {
      const [mergeRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM patient_merges WHERE merged_id = $1',
        [duplicate.id],
      )
      const [account, records] = await entriesAbout(survivor.id)
      expect(account.action).toBe('PATIENT_MERGED')
      expect(account.entity_type).toBe('patient_merges')
      expect(account.entity_id).toBe(mergeRow.id)
      expect(Object.keys(account.details).sort()).toStrictEqual(
        [
          'addedClinicIds',
          'closedExportLinkIds',
          'complaintReviewIds',
          'endedCareTeamLinkIds',
          'endedComplaintReviewIds',
          'filledFields',
          'legalDisclosureIds',
          'mergeId',
          'mergedId',
          'movedCareTeamLinkIds',
          'newCareTeamLinkIds',
          'revokedInvitationIds',
          'signedOutSessions',
          'survivorId',
          'wasActive',
        ].sort(),
      )
      expect(sessionsBefore).toBeGreaterThan(0)
      expect(account.details.signedOutSessions).toBe(sessionsBefore)
      expect(account.details.wasActive).toBe(true)
      // Neither account had a phone, an address or a photo: nothing filled.
      expect(account.details.filledFields).toStrictEqual([])

      expect(records.action).toBe('PATIENT_MERGE_RECORDS_MOVED')
      expect(records.entity_type).toBe('patient_merge_records')
      expect(records.details).toStrictEqual({
        mergeId: mergeRow.id,
        mergedId: duplicate.id,
        survivorId: survivor.id,
        assignedProgramIds: [programId],
        sessionIds: [sessionId],
        medicalFileIds: [entryId, amendmentId],
        romAssessmentIds: [assessmentId, assessmentAmendmentId],
        movedConversationIds: [],
        combinedConversations: [
          {
            from: duplicateConversation,
            into: survivorConversation,
            messageIds: [fromAlex, fromDuplicate],
          },
        ],
      })

      // Through the viewer, an admin reads the account half and NOT the
      // records half (patient_merge_records is a clinical area).
      const viewer = await admin
        .get('/audit-logs')
        .query({ targetUserId: survivor.id })
      expect(viewer.status).toBe(200)
      const shown = (
        viewer.body as { data: { action: string; details: unknown }[] }
      ).data
        .filter((item) => item.action.startsWith('PATIENT_MERGE'))
        .map((item) => [item.action, item.details === null])
        .sort()
      expect(shown).toStrictEqual([
        ['PATIENT_MERGED', false],
        ['PATIENT_MERGE_RECORDS_MOVED', true],
      ])
    })

    it('emails the survivor, and only the survivor', () => {
      expect(outbox.sent.map((mail) => [mail.to, mail.subject])).toStrictEqual([
        [survivor.email, 'Your Stride accounts were combined'],
      ])
    })

    it('refuses to reactivate the merged account', async () => {
      const res = await admin.post(`/users/${duplicate.id}/reactivate`)
      expect(res.status).toBe(409)
      expect(res.body.message).toStrictEqual([
        MERGED_ACCOUNT_REACTIVATION_MESSAGE,
      ])
    })

    it('refuses a second merge of the same account, and a merge INTO it', async () => {
      const again = await merge(duplicate.id, survivor.id)
      expect(again.status).toBe(409)
      expect(again.body.message).toStrictEqual([ALREADY_MERGED_MESSAGE])
      const third = await newPatient('Twin')
      const into = await merge(third.id, duplicate.id)
      expect(into.status).toBe(409)
      expect(into.body.message).toStrictEqual([ALREADY_MERGED_MESSAGE])
    })

    it('leaves the merged account out of the next duplicate warning', async () => {
      const res = await admin.post('/users').send({
        email: `again-${stamp}@example.com`,
        role: 'patient',
        firstName: 'Pat',
        lastName: 'Twin',
        dateOfBirth: '1988-04-12',
        clinicId,
      })
      expect(res.status).toBe(409)
      const ids = (res.body.matches as { id: number }[]).map((m) => m.id)
      expect(ids).toContain(survivor.id)
      expect(ids).not.toContain(duplicate.id)
    })
  })

  describe('care-team links', () => {
    it('moves a link the survivor has no overlap with — same id', async () => {
      const survivor = await newPatient('Links-A')
      const duplicate = await newPatient('Links-A')
      // The survivor's own link is to ANOTHER practitioner: overlapping in
      // time, but no conflict — the rule is per practitioner.
      await join(alex, survivor.id)
      await join(sam, duplicate.id)
      const [link] = await ownerRows<{ id: number }>(
        'SELECT id FROM care_team_members WHERE patient_id = $1',
        [duplicate.id],
      )

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const rows = await ownerRows<{ id: number; patient_id: number }>(
        'SELECT id, patient_id FROM care_team_members WHERE practitioner_id = $1 AND patient_id = ANY($2)',
        [samId, [survivor.id, duplicate.id]],
      )
      expect(rows).toStrictEqual([{ id: link.id, patient_id: survivor.id }])
    })

    it('covers only what the survivor lacks when two links overlap, and ends the original', async () => {
      const survivor = await newPatient('Links-B')
      const duplicate = await newPatient('Links-B')
      // Alex joined the DUPLICATE first, then the survivor: both open, the
      // duplicate's starting earlier.
      await join(alex, duplicate.id)
      await join(alex, survivor.id)
      const before = await ownerRows<{
        id: number
        patient_id: number
        started_at: Date
      }>(
        'SELECT id, patient_id, started_at FROM care_team_members WHERE practitioner_id = $1 AND patient_id = ANY($2) ORDER BY id',
        [alexId, [survivor.id, duplicate.id]],
      )
      const [original, survivorLink] = before

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const after = await ownerRows<{
        id: number
        patient_id: number
        started_at: Date
        ends_at: Date | null
        ended_by: number | null
      }>(
        'SELECT id, patient_id, started_at, ends_at, ended_by FROM care_team_members WHERE practitioner_id = $1 AND patient_id = ANY($2) ORDER BY id',
        [alexId, [survivor.id, duplicate.id]],
      )
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )
      expect(after).toHaveLength(3)
      // The original stays on the merged account, ended by the admin.
      expect(after[0].id).toBe(original.id)
      expect(after[0].patient_id).toBe(duplicate.id)
      expect(after[0].ends_at).not.toBeNull()
      expect(after[0].ended_by).toBe(adminRow.id)
      // The survivor's own link is untouched.
      expect(after[1]).toStrictEqual({
        id: survivorLink.id,
        patient_id: survivor.id,
        started_at: survivorLink.started_at,
        ends_at: null,
        ended_by: null,
      })
      // The piece the survivor lacked: from the original's start to the
      // survivor's own — nobody ended it, the survivor's link took over.
      expect(after[2]).toStrictEqual({
        id: after[2].id,
        patient_id: survivor.id,
        started_at: original.started_at,
        ends_at: survivorLink.started_at,
        ended_by: null,
      })
      const [account] = await entriesAbout(survivor.id)
      expect(account.details.newCareTeamLinkIds).toStrictEqual([after[2].id])
      expect(account.details.endedCareTeamLinkIds).toStrictEqual([original.id])
      expect(account.details.movedCareTeamLinkIds).toStrictEqual([])
    })

    it('keeps who ended a link only on the piece that ends where the original did', async () => {
      const survivor = await newPatient('Links-C')
      const duplicate = await newPatient('Links-C')
      // Alex: on the duplicate's team from T0, on the survivor's from T1,
      // leaves the survivor's at T2, then the duplicate's at T3. What the
      // survivor lacks: [T0, T1) and [T2, T3).
      await join(alex, duplicate.id)
      await join(alex, survivor.id)
      const leave = async (patientId: number) =>
        expect(
          (await alex.post(`/users/${patientId}/care-team/${alexId}/end`))
            .status,
        ).toBeLessThan(300)
      await leave(survivor.id)
      await leave(duplicate.id)
      const [original, survivorLink] = await ownerRows<{
        id: number
        started_at: Date
        ends_at: Date
      }>(
        'SELECT id, started_at, ends_at FROM care_team_members WHERE practitioner_id = $1 AND patient_id = ANY($2) ORDER BY id',
        [alexId, [survivor.id, duplicate.id]],
      )

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const pieces = await ownerRows<{
        started_at: Date
        ends_at: Date
        ended_by: number | null
      }>(
        'SELECT started_at, ends_at, ended_by FROM care_team_members WHERE practitioner_id = $1 AND patient_id = $2 AND id <> $3 ORDER BY started_at',
        [alexId, survivor.id, survivorLink.id],
      )
      expect(pieces).toStrictEqual([
        // Cut short by the survivor's own link: nobody ended it.
        {
          started_at: original.started_at,
          ends_at: survivorLink.started_at,
          ended_by: null,
        },
        // Ends where the original did: Alex ended it.
        {
          started_at: survivorLink.ends_at,
          ends_at: original.ends_at,
          ended_by: alexId,
        },
      ])
      // Already over, the original isn't ended a second time.
      const [still] = await ownerRows<{ ends_at: Date; ended_by: number }>(
        'SELECT ends_at, ended_by FROM care_team_members WHERE id = $1',
        [original.id],
      )
      expect(still).toStrictEqual({
        ends_at: original.ends_at,
        ended_by: alexId,
      })
      const [account] = await entriesAbout(survivor.id)
      expect(account.details.endedCareTeamLinkIds).toStrictEqual([])
    })
  })

  describe('clinics, profile, invitations, record access', () => {
    it("adds the duplicate's clinics, fills the survivor's EMPTY fields only, revokes its invitation", async () => {
      const survivor = await newPatient('Profile')
      // Invited at another clinic, never signed in: its invitation is
      // still pending.
      const duplicate = await newPatient('Profile', {
        clinic: otherClinicId,
        activate: false,
      })
      await sessionPool.query(
        `UPDATE users SET phone = '555-0101', address_line1 = '1 Quay St',
                address_city = 'Harbour', address_country = 'CA',
                avatar_path = 'avatars/merge-e2e/photo.png'
          WHERE id = $1`,
        [duplicate.id],
      )

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const clinics = await ownerRows<{ clinic_id: number }>(
        'SELECT clinic_id FROM user_clinics WHERE user_id = $1 ORDER BY clinic_id',
        [survivor.id],
      )
      expect(clinics).toStrictEqual([
        { clinic_id: clinicId },
        { clinic_id: otherClinicId },
      ])
      const people = await ownerRows<{
        id: number
        phone: string | null
        address_line1: string | null
        address_city: string | null
        address_country: string | null
        avatar_path: string | null
      }>(
        `SELECT id, phone, address_line1, address_city, address_country, avatar_path
           FROM users WHERE id = ANY($1) ORDER BY id`,
        [[survivor.id, duplicate.id]],
      )
      expect(people[0]).toStrictEqual({
        id: survivor.id,
        phone: '555-0101',
        address_line1: '1 Quay St',
        address_city: 'Harbour',
        address_country: 'CA',
        avatar_path: 'avatars/merge-e2e/photo.png',
      })
      // The photo now belongs to the survivor only.
      expect(people[1].avatar_path).toBeNull()
      const invitations = await ownerRows<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM invitations WHERE user_id = $1',
        [duplicate.id],
      )
      expect(invitations).toHaveLength(1)
      expect(invitations[0].revoked_at).not.toBeNull()
      const [account] = await entriesAbout(survivor.id)
      expect(account.details.filledFields).toStrictEqual([
        'phone',
        'address',
        'avatar',
      ])
      expect(account.details.addedClinicIds).toStrictEqual([otherClinicId])
      expect(account.details.wasActive).toBe(true)
    })

    it("keeps the survivor's own values — a partial address is not mixed with the other's", async () => {
      const survivor = await newPatient('Keeps')
      const duplicate = await newPatient('Keeps')
      await sessionPool.query(
        `UPDATE users SET phone = '555-0001', address_city = 'Riverside',
                avatar_path = 'avatars/merge-e2e/kept.png' WHERE id = $1`,
        [survivor.id],
      )
      await sessionPool.query(
        `UPDATE users SET phone = '555-0202', address_line1 = '9 Elm St', address_city = 'Harbour',
                avatar_path = 'avatars/merge-e2e/other.png' WHERE id = $1`,
        [duplicate.id],
      )
      // A duplicate already deactivated — a former account, a common case.
      expect((await admin.delete(`/users/${duplicate.id}`)).status).toBe(200)

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const [row] = await ownerRows<{
        phone: string
        address_line1: string | null
        address_city: string
        avatar_path: string
      }>(
        'SELECT phone, address_line1, address_city, avatar_path FROM users WHERE id = $1',
        [survivor.id],
      )
      expect(row).toStrictEqual({
        phone: '555-0001',
        address_line1: null,
        address_city: 'Riverside',
        avatar_path: 'avatars/merge-e2e/kept.png',
      })
      const [account] = await entriesAbout(survivor.id)
      expect(account.details.filledFields).toStrictEqual([])
      expect(account.details.wasActive).toBe(false)
    })

    it('moves its legal disclosures and closes its open records-export link', async () => {
      const survivor = await newPatient('Disclosed')
      const duplicate = await newPatient('Disclosed')
      const disclosed = await admin
        .post(`/users/${duplicate.id}/legal-disclosures`)
        .send({
          recipientName: 'Det. Jane Roe',
          legalBasis: 'court_order',
          receivedOn: today,
          parts: ['programs'],
          timeZone: 'America/Montreal',
        })
      expect(disclosed.status).toBe(201)
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )
      const [link] = await ownerRows<{ id: number }>(
        `INSERT INTO records_export_links (patient_id, token_hash, sent_by, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
        [duplicate.id, `merge-e2e-${stamp}`.padEnd(64, '0'), adminRow.id],
      )

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const disclosures = await ownerRows<{ patient_id: number }>(
        'SELECT patient_id FROM legal_disclosures WHERE patient_id = ANY($1)',
        [[survivor.id, duplicate.id]],
      )
      expect(disclosures).toStrictEqual([{ patient_id: survivor.id }])
      const [closed] = await ownerRows<{ replaced_at: Date | null }>(
        'SELECT replaced_at FROM records_export_links WHERE id = $1',
        [link.id],
      )
      expect(closed.replaced_at).not.toBeNull()
      const [account] = await entriesAbout(survivor.id)
      expect(account.details.closedExportLinkIds).toStrictEqual([link.id])
    })

    it('ends an open complaint review before moving it with the record', async () => {
      const survivor = await newPatient('Review')
      const duplicate = await newPatient('Review')
      const opened = await admin
        .post(`/users/${duplicate.id}/complaint-reviews`)
        .send({ reason: 'A complaint about the knee program' })
      expect(opened.status).toBe(201)

      expect((await merge(duplicate.id, survivor.id)).status).toBe(200)

      const reviews = await ownerRows<{
        patient_id: number
        ended_at: Date | null
      }>(
        'SELECT patient_id, ended_at FROM complaint_reviews WHERE patient_id = ANY($1)',
        [[survivor.id, duplicate.id]],
      )
      expect(reviews).toHaveLength(1)
      expect(reviews[0].patient_id).toBe(survivor.id)
      expect(reviews[0].ended_at).not.toBeNull()
    })
  })

  // --- Refusals ---

  describe('refusals', () => {
    it('refuses the same account twice, a missing account, and non-patients', async () => {
      const pat = await newPatient('Refused')
      const self = await merge(pat.id, pat.id)
      expect([self.status, self.body.message]).toStrictEqual([
        400,
        [MERGE_INTO_ITSELF_MESSAGE],
      ])
      const missing = await merge(999999, pat.id)
      expect([missing.status, missing.body.message]).toStrictEqual([
        404,
        ['User 999999 not found'],
      ])
      const intoStaff = await merge(pat.id, alexId)
      expect([intoStaff.status, intoStaff.body.message]).toStrictEqual([
        409,
        [NOT_PATIENTS_MESSAGE],
      ])
    })

    it('refuses to merge away an account that is also staff', async () => {
      const pat = await newPatient('Staff')
      const both = await newPatient('Staff')
      expect(
        (
          await admin.post(`/users/${both.id}/roles`).send({
            role: 'admin',
          })
        ).status,
      ).toBe(201)
      const res = await merge(both.id, pat.id)
      expect([res.status, res.body.message]).toStrictEqual([
        409,
        [MERGED_IS_STAFF_MESSAGE],
      ])
    })

    it('refuses a deactivated survivor', async () => {
      const kept = await newPatient('Asleep')
      const dup = await newPatient('Asleep')
      expect((await admin.delete(`/users/${kept.id}`)).status).toBe(200)
      const res = await merge(dup.id, kept.id)
      expect([res.status, res.body.message]).toStrictEqual([
        409,
        [SURVIVOR_DEACTIVATED_MESSAGE],
      ])
    })

    it('a wrong password changes nothing and is recorded as a failed step-up', async () => {
      const kept = await newPatient('Password')
      const dup = await newPatient('Password')
      const res = await merge(dup.id, kept.id, { currentPassword: 'nope' })
      expect([res.status, res.body.message]).toStrictEqual([
        400,
        [WRONG_PASSWORD_MESSAGE],
      ])
      expect(
        await ownerRows('SELECT 1 FROM patient_merges WHERE merged_id = $1', [
          dup.id,
        ]),
      ).toStrictEqual([])
      const failures = await ownerRows<{ details: { purpose: string } }>(
        `SELECT details FROM audit_logs WHERE action = 'STEP_UP_FAILED' ORDER BY id DESC LIMIT 1`,
        [],
      )
      expect(failures[0].details.purpose).toBe('patient_merge')
    })

    it('is for admins only', async () => {
      const kept = await newPatient('Admins')
      const dup = await newPatient('Admins')
      expect((await merge(dup.id, kept.id, {}, alex)).status).toBe(403)
    })
  })

  // --- The database's half ---

  describe('merge_patients() called directly', () => {
    // As the app's own role, with a context set by hand — what a bug in a
    // future route could do. The function checks the caller itself.
    async function callAs(
      context: { id: number; role: string } | null,
      mergedId: number,
      survivorId: number,
    ) {
      const client = await sessionPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `SET LOCAL ROLE ${client.escapeIdentifier(process.env.POSTGRES_APP_USER ?? 'stride_app')}`,
        )
        if (context) {
          await client.query(
            "SELECT set_config('app.current_user_id', $1, true), set_config('app.current_role', $2, true)",
            [String(context.id), context.role],
          )
        }
        await client.query('SELECT merge_patients($1, $2)', [
          mergedId,
          survivorId,
        ])
        return 'merged'
      } catch (error) {
        const { code, constraint } = error as {
          code?: string
          constraint?: string
        }
        return `${code}${constraint ? `:${constraint}` : ''}`
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    it('refuses a caller without an admin context, or whose account is not an admin', async () => {
      const kept = await newPatient('Direct')
      const dup = await newPatient('Direct')
      expect(await callAs(null, dup.id, kept.id)).toBe('42501')
      expect(
        await callAs({ id: alexId, role: 'practitioner' }, dup.id, kept.id),
      ).toBe('42501')
      // Claiming "admin" in the context isn't enough: Alex holds no admin
      // role.
      expect(await callAs({ id: alexId, role: 'admin' }, dup.id, kept.id)).toBe(
        '42501',
      )
      // Nor is HOLDING the admin role: the session must be acting as admin.
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )
      expect(
        await callAs(
          { id: adminRow.id, role: 'practitioner' },
          dup.id,
          kept.id,
        ),
      ).toBe('42501')
    })

    it('checks what may be merged again — a deactivated survivor is refused', async () => {
      const kept = await newPatient('Direct-B')
      const dup = await newPatient('Direct-B')
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )
      await sessionPool.query(
        'UPDATE users SET is_active = false WHERE id = $1',
        [kept.id],
      )
      expect(
        await callAs({ id: adminRow.id, role: 'admin' }, dup.id, kept.id),
      ).toBe('23514:patient_merge_allowed')
      // And a real admin context works (rolled back by callAs).
      await sessionPool.query(
        'UPDATE users SET is_active = true WHERE id = $1',
        [kept.id],
      )
      expect(
        await callAs({ id: adminRow.id, role: 'admin' }, dup.id, kept.id),
      ).toBe('merged')
    })

    it('refuses, by itself, everything the service refuses first', async () => {
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )
      const asAdmin = { id: adminRow.id, role: 'admin' }
      const kept = await newPatient('Direct-C')
      const staff = await newPatient('Direct-C')
      expect(
        (await admin.post(`/users/${staff.id}/roles`).send({ role: 'admin' }))
          .status,
      ).toBe(201)
      const merged = await newPatient('Direct-C')
      const other = await newPatient('Direct-C')
      expect((await merge(merged.id, other.id)).status).toBe(200)
      const refused = '23514:patient_merge_allowed'
      expect(await callAs(asAdmin, kept.id, kept.id)).toBe(refused)
      expect(await callAs(asAdmin, 999999, kept.id)).toBe(refused)
      expect(await callAs(asAdmin, kept.id, alexId)).toBe(refused)
      expect(await callAs(asAdmin, alexId, kept.id)).toBe(refused)
      expect(await callAs(asAdmin, staff.id, kept.id)).toBe(refused)
      expect(await callAs(asAdmin, merged.id, kept.id)).toBe(refused)
      expect(await callAs(asAdmin, kept.id, merged.id)).toBe(refused)
      // A merged account reactivated by hand (the API refuses it) is still
      // no account to merge INTO.
      await sessionPool.query(
        'UPDATE users SET is_active = true WHERE id = $1',
        [merged.id],
      )
      expect(await callAs(asAdmin, kept.id, merged.id)).toBe(refused)
    })

    it('cannot be executed by PUBLIC', async () => {
      const [row] = await ownerRows<{ public_can: boolean }>(
        `SELECT has_function_privilege('public', 'merge_patients(integer, integer)', 'EXECUTE') AS public_can`,
        [],
      )
      expect(row.public_can).toBe(false)
    })
  })

  // --- Pass 4: the list for admins, the care team's notice ---

  describe('GET /patient-merges', () => {
    it('lists every merge for admins, newest first, naming who merged', async () => {
      const kept = await newPatient('Listed')
      const dup = await newPatient('Listed')
      const merged = await merge(dup.id, kept.id)
      expect(merged.status).toBe(200)
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )

      const res = await admin.get('/patient-merges')
      expect(res.status).toBe(200)
      const list = res.body as {
        id: number
        mergedId: number
        survivorId: number
        mergedAt: string
        mergedBy: { id: number; firstName: string; lastName: string }
      }[]
      expect(list[0]).toStrictEqual({
        id: merged.body.mergeId,
        mergedId: dup.id,
        survivorId: kept.id,
        mergedAt: list[0].mergedAt,
        mergedBy: { id: adminRow.id, firstName: 'Avery', lastName: 'Admin' },
      })
      // Newest first.
      const times = list.map((row) => Date.parse(row.mergedAt))
      expect(times).toStrictEqual([...times].sort((a, b) => b - a))
    })

    it('is for admins only', async () => {
      expect((await alex.get('/patient-merges')).status).toBe(403)
    })
  })

  describe("the care team's notice", () => {
    async function alertsOf(who: Agent) {
      const res = await who.get('/alerts').query({ today })
      expect(res.status).toBe(200)
      return (res.body as { kind: string; merge?: { id: number } }[]).filter(
        (alert) => alert.kind === 'patient_merge',
      )
    }

    it('tells a member who was on the team, until they mark it reviewed — once', async () => {
      const kept = await newPatient('Noticed')
      const dup = await newPatient('Noticed')
      await join(alex, kept.id)
      const merged = await merge(dup.id, kept.id)
      expect(merged.status).toBe(200)
      const mergeId = merged.body.mergeId as number
      const [adminRow] = await ownerRows<{ id: number }>(
        'SELECT id FROM users WHERE email = $1',
        [`admin-${stamp}@example.com`],
      )

      const notices = await alertsOf(alex)
      const mine = notices.filter((alert) => alert.merge?.id === mergeId)
      expect(mine).toStrictEqual([
        {
          kind: 'patient_merge',
          patient: {
            id: kept.id,
            firstName: 'Pat',
            lastName: 'Noticed',
            avatarUrl: null,
          },
          merge: {
            id: mergeId,
            mergedBy: {
              id: adminRow.id,
              firstName: 'Avery',
              lastName: 'Admin',
            },
            mergedAt: (mine[0] as unknown as { merge: { mergedAt: string } })
              .merge.mergedAt,
          },
        },
      ])

      const first = await alex.post(`/alerts/patient-merges/${mergeId}/review`)
      expect(first.status).toBe(200)
      const again = await alex.post(`/alerts/patient-merges/${mergeId}/review`)
      expect(again.status).toBe(200)
      expect(again.body).toStrictEqual(first.body)
      expect(
        (await alertsOf(alex)).some((alert) => alert.merge?.id === mergeId),
      ).toBe(false)
      const entries = await ownerRows<{ action: string; details: unknown }>(
        `SELECT action, details FROM audit_logs
          WHERE action = 'PATIENT_MERGE_NOTICE_REVIEWED' AND target_user_id = $1`,
        [kept.id],
      )
      expect(entries).toStrictEqual([
        {
          action: 'PATIENT_MERGE_NOTICE_REVIEWED',
          details: { mergeId, mergedBy: adminRow.id },
        },
      ])
    })

    it('says nothing to a practitioner who joined after the merge (409), and hides it from one off the team (404)', async () => {
      const kept = await newPatient('Later')
      const dup = await newPatient('Later')
      const merged = await merge(dup.id, kept.id)
      const mergeId = merged.body.mergeId as number

      const outsider = await sam.post(
        `/alerts/patient-merges/${mergeId}/review`,
      )
      expect(outsider.status).toBe(404)

      await join(sam, kept.id)
      expect(
        (await alertsOf(sam)).some((alert) => alert.merge?.id === mergeId),
      ).toBe(false)
      const late = await sam.post(`/alerts/patient-merges/${mergeId}/review`)
      expect([late.status, late.body.message]).toStrictEqual([
        409,
        [NOT_A_MERGE_NOTICE_MESSAGE],
      ])
    })
  })

  // The survivor's notice is best effort: a failed one is LOGGED — by the
  // SURVIVOR's id (the account told), never an address (decisions §32: the
  // logs leave the server). The merge itself is done.
  it("logs a failed notice by the survivor's id", async () => {
    const kept = await newPatient('Unsent')
    const dup = await newPatient('Unsent')
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)
    try {
      outbox.failNext()
      const res = await merge(dup.id, kept.id)
      expect(res.status).toBe(200)
      await new Promise((resolve) => setImmediate(resolve))
      const lines = logged.mock.calls.map((call) => String(call[0]))
      expect(lines).toStrictEqual([
        expect.stringMatching(
          new RegExp(
            `^Failed to send the accounts-combined notice to user ${kept.id}: `,
          ),
        ) as string,
      ])
    } finally {
      logged.mockRestore()
    }
  })
})
