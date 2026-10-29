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
import { activateAccount } from './support/accounts'
import { pdfPages, pdfText } from './support/pdf-text'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { ONLY_THE_OPENER_MESSAGE } from '../src/complaint-reviews/complaint-reviews.service'
import { NOT_A_REVIEW_NOTICE_MESSAGE } from '../src/alerts/complaint-review-notices.service'
import {
  BLANK_CASE_REFERENCE_MESSAGE,
  BLANK_REASON_MESSAGE,
} from '../src/complaint-reviews/dto/open-complaint-review.dto'

// The complaint review (decisions §25, pass 2 of the post-Phase-6 tidy-up):
//   - an ADMIN opens a review of one patient's record — a required reason,
//     an optional case reference, 7 days, endable early by any admin;
//   - while it is open, the admin who opened it downloads review copies —
//     the records export's PDF, stamped on every page — each one recorded;
//   - the patient's CARE TEAM is told in "For review": who, when, until —
//     never why.
// What these tests hold it to: the routes' answers and refusals, every
// step's audit entry, that an admin still reads no clinical route (§16), and
// that the database keeps the same rules on its own — the reason hidden from
// the care team down to the row, the 7 days written by the database, an
// ending signed and final.
describe('Complaint reviews (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let stamp: number
  let counter = 0
  let clinicId: number
  let adminId: number
  let otherAdminId: number
  let alexId: number
  let samId: number
  let blakeId: number
  const outbox = new InMemoryEmailTransport()

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  let otherAdmin: Agent
  let alex: Agent // on the patients' care teams BEFORE their reviews open
  let sam: Agent // joins a care team AFTER a review opened
  let blake: Agent // on no care team here

  const REASON = 'Patient says her knee got worse after the March program.'
  const HOURS_168 = 168 * 60 * 60 * 1000

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
      clinicName: 'Complaint Reviews E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Avery',
      lastName: 'Admin',
    })
    expect(clinicRes.status).toBe(201)
    clinicId = clinicRes.body.clinicId
    adminId = (await admin.get('/auth/me')).body.id

    const second = await newAccount({
      role: 'admin',
      firstName: 'Olive',
      lastName: 'Other',
    })
    otherAdminId = second.id
    otherAdmin = second.agent
    ;({ id: alexId, agent: alex } = await newPractitioner('Alex'))
    ;({ id: samId, agent: sam } = await newPractitioner('Sam'))
    ;({ id: blakeId, agent: blake } = await newPractitioner('Blake'))
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // --- Helpers ----------------------------------------------------------------

  async function newAccount(fields: Record<string, unknown>) {
    const email = `acct-${++counter}-${stamp}@example.com`
    // Many patients with one name and birthday, on purpose: the
    // possible-duplicate warning has its own suite (possible-duplicates).
    const res = await admin
      .post('/users')
      .send({ email, allowPossibleDuplicate: true, ...fields })
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, email)
    const agent = request.agent(app.getHttpServer())
    expect(
      (await agent.post('/auth/login').send({ email, password: 'password123' }))
        .status,
    ).toBe(201)
    return { id: res.body.id as number, agent }
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

  // A patient on Alex's care team (Alex joins), with one medical file entry
  // — so a copy has something of the record in it.
  async function newPatient(lastName = 'Reviewed') {
    const { id, agent } = await newAccount({
      role: 'patient',
      firstName: 'Pat',
      lastName,
      dateOfBirth: '1988-04-12',
      clinicId,
    })
    expect((await alex.post(`/users/${id}/care-team`).send({})).status).toBe(
      201,
    )
    const entry = await alex.post('/medical-files').send({
      patientId: id,
      entryType: 'progress_note',
      plan: 'Two sessions a week.',
    })
    expect(entry.status).toBe(201)
    return { id, agent, entryId: entry.body.id as number }
  }

  async function openReview(
    patientId: number,
    body: Record<string, unknown> = { reason: REASON },
    who: Agent = admin,
  ) {
    const res = await who
      .post(`/users/${patientId}/complaint-reviews`)
      .send(body)
    expect(res.status).toBe(201)
    return res.body as { id: number; openedAt: string; expiresAt: string }
  }

  // GET …/copy, the PDF kept as bytes (supertest parses only text and JSON).
  function copy(
    who: Agent,
    patientId: number,
    reviewId: number,
    query = '?timeZone=America/Toronto',
  ) {
    return who
      .get(`/users/${patientId}/complaint-reviews/${reviewId}/copy${query}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => done(null, Buffer.concat(chunks)))
      })
  }

  // A refusal's JSON from a route answered as bytes.
  function refusal(res: request.Response) {
    return {
      status: res.status,
      message: (
        JSON.parse((res.body as Buffer).toString('utf8')) as {
          message: unknown
        }
      ).message,
    }
  }

  interface AuditRow {
    action: string
    performed_by: number
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  async function entries(
    patientId: number,
    types: string[],
  ): Promise<AuditRow[]> {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, entity_type, entity_id::int AS entity_id, details
       FROM audit_logs
       WHERE target_user_id = $1 AND entity_type = ANY($2)
       ORDER BY id`,
      [patientId, types],
    )
    return rows
  }

  async function alertsOf(who: Agent) {
    const today = new Date().toISOString().slice(0, 10)
    const res = await who.get('/alerts').query({ today })
    expect(res.status).toBe(200)
    return res.body as {
      kind: string
      patient: { id: number }
      review?: Record<string, unknown>
      link?: { id: number }
    }[]
  }

  async function reviewNotices(who: Agent, patientId: number) {
    return (await alertsOf(who)).filter(
      (alert) =>
        alert.kind === 'complaint_review' && alert.patient.id === patientId,
    )
  }

  // As the tables' owner (no row security, no guard): what a test needs to
  // set up that no route may do — a review backdated or past its expiry.
  async function ownerSet(reviewId: number, assignments: string) {
    await sessionPool.query(
      `UPDATE complaint_reviews SET ${assignments} WHERE id = $1`,
      [reviewId],
    )
  }

  // =========================================================================

  describe('opening a review', () => {
    it('opens one for 7 days exactly, with its reason, and records it', async () => {
      const patient = await newPatient()
      const res = await admin
        .post(`/users/${patient.id}/complaint-reviews`)
        .send({ reason: REASON, caseReference: 'CR-2026-14' })

      expect(res.status).toBe(201)
      expect(res.body).toStrictEqual({
        id: expect.any(Number),
        status: 'open',
        reason: REASON,
        caseReference: 'CR-2026-14',
        openedBy: { id: adminId, firstName: 'Avery', lastName: 'Admin' },
        openedAt: expect.any(String),
        expiresAt: expect.any(String),
        endedAt: null,
        endedBy: null,
      })
      expect(
        Date.parse(res.body.expiresAt) - Date.parse(res.body.openedAt),
      ).toBe(HOURS_168)
      expect(await entries(patient.id, ['complaint_reviews'])).toStrictEqual([
        {
          action: 'COMPLAINT_REVIEW_OPENED',
          performed_by: adminId,
          entity_type: 'complaint_reviews',
          entity_id: res.body.id,
          details: {
            reason: REASON,
            caseReference: 'CR-2026-14',
            expiresAt: res.body.expiresAt,
          },
        },
      ])
    })

    it('leaves the case reference out of the entry when there is none', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      const [entry] = await entries(patient.id, ['complaint_reviews'])
      expect(entry.details).toStrictEqual({
        reason: REASON,
        expiresAt: review.expiresAt,
      })
    })

    it('refuses a blank or missing reason, a blank or long case reference', async () => {
      const patient = await newPatient()
      const attempts: [Record<string, unknown>, string][] = [
        [{ reason: '   ' }, BLANK_REASON_MESSAGE],
        [{}, BLANK_REASON_MESSAGE],
        [
          { reason: 'x'.repeat(1001) },
          'reason must be shorter than or equal to 1000 characters',
        ],
        [{ reason: REASON, caseReference: ' ' }, BLANK_CASE_REFERENCE_MESSAGE],
        [
          { reason: REASON, caseReference: 'c'.repeat(101) },
          'caseReference must be shorter than or equal to 100 characters',
        ],
      ]
      for (const [body, message] of attempts) {
        const res = await admin
          .post(`/users/${patient.id}/complaint-reviews`)
          .send(body)
        expect([res.status, res.body.message]).toEqual([
          400,
          expect.arrayContaining([message]),
        ])
      }
      expect(await entries(patient.id, ['complaint_reviews'])).toEqual([])
    })

    it('refuses an unknown account (404) and one that is not a patient (400)', async () => {
      const unknown = await admin
        .post('/users/999999/complaint-reviews')
        .send({ reason: REASON })
      expect([unknown.status, unknown.body.message]).toEqual([
        404,
        ['User 999999 not found'],
      ])
      const practitioner = await admin
        .post(`/users/${alexId}/complaint-reviews`)
        .send({ reason: REASON })
      expect([practitioner.status, practitioner.body.message]).toEqual([
        400,
        ['Only a patient has a health record to review'],
      ])
    })

    it('is for admins only — not the care team, not the patient', async () => {
      const patient = await newPatient()
      for (const who of [alex, patient.agent]) {
        const opened = await who
          .post(`/users/${patient.id}/complaint-reviews`)
          .send({ reason: REASON })
        expect(opened.status).toBe(403)
        expect(
          (await who.get(`/users/${patient.id}/complaint-reviews`)).status,
        ).toBe(403)
      }
    })

    it('lists a patient’s reviews to every admin, newest first, reasons included', async () => {
      const patient = await newPatient()
      const first = await openReview(patient.id, { reason: 'First' })
      const second = await openReview(
        patient.id,
        { reason: 'Second' },
        otherAdmin,
      )
      const res = await admin.get(`/users/${patient.id}/complaint-reviews`)
      expect(res.status).toBe(200)
      expect(
        (
          res.body as { id: number; reason: string; openedBy: { id: number } }[]
        ).map((review) => [review.id, review.reason, review.openedBy.id]),
      ).toEqual([
        [second.id, 'Second', otherAdminId],
        [first.id, 'First', adminId],
      ])
    })
  })

  // =========================================================================

  describe('review copies', () => {
    it('hands the opener a stamped copy of the record, recorded with what went in', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id, {
        reason: REASON,
        caseReference: 'CR-7',
      })

      const res = await copy(admin, patient.id, review.id)

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('application/pdf')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['content-disposition']).toMatch(
        new RegExp(
          `^attachment; filename="stride-review-copy-${review.id}-\\d{4}-\\d{2}-\\d{2}\\.pdf"$`,
        ),
      )
      const pdf = res.body as Buffer
      const text = pdfText(pdf)
      expect(text).toContain('Health record — review copy')
      expect(text).toContain(REASON)
      expect(text).toContain('CR-7')
      expect(text).toContain('Two sessions a week.')
      // The stamp on EVERY page, beside that page's footer.
      const stampLine = `Review copy — made by Avery Admin for complaint review ${review.id} (case CR-7)`
      const pages = pdfPages(pdf)
      expect(pages.length).toBeGreaterThan(1)
      for (const page of pages) expect(page).toContain(stampLine)

      expect(await entries(patient.id, ['records_exports'])).toStrictEqual([
        {
          action: 'RECORDS_EXPORTED',
          performed_by: adminId,
          entity_type: 'records_exports',
          entity_id: null,
          details: {
            via: 'complaint_review',
            reviewId: review.id,
            timeZone: 'America/Toronto',
            medicalFileEntryIds: [patient.entryId],
            programIds: [],
            sessionIds: [],
          },
        },
      ])
    })

    it('makes as many copies as asked, each with its own entry', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      expect((await copy(admin, patient.id, review.id)).status).toBe(200)
      expect((await copy(admin, patient.id, review.id)).status).toBe(200)
      expect(
        (await entries(patient.id, ['records_exports'])).map(
          (entry) => entry.performed_by,
        ),
      ).toEqual([adminId, adminId])
    })

    it('refuses another admin (403), another patient’s URL (404) — and records nothing', async () => {
      const patient = await newPatient()
      const other = await newPatient('Other')
      const review = await openReview(patient.id)

      expect(refusal(await copy(otherAdmin, patient.id, review.id))).toEqual({
        status: 403,
        message: [ONLY_THE_OPENER_MESSAGE],
      })
      expect(refusal(await copy(admin, other.id, review.id))).toEqual({
        status: 404,
        message: [`Complaint review ${review.id} not found`],
      })
      expect(await entries(patient.id, ['records_exports'])).toEqual([])
      expect(await entries(other.id, ['records_exports'])).toEqual([])
    })

    it('refuses a copy once the review has ended or expired (410)', async () => {
      const patient = await newPatient()
      const ended = await openReview(patient.id)
      expect(
        (
          await otherAdmin.post(
            `/users/${patient.id}/complaint-reviews/${ended.id}/end`,
          )
        ).status,
      ).toBe(200)
      expect(refusal(await copy(admin, patient.id, ended.id))).toEqual({
        status: 410,
        message: [
          'This review has ended. Open a new one, with its reason, to make another copy.',
        ],
      })

      const expired = await openReview(patient.id)
      await ownerSet(
        expired.id,
        `opened_at = now() - interval '8 days', expires_at = now() - interval '1 day'`,
      )
      expect(refusal(await copy(admin, patient.id, expired.id))).toEqual({
        status: 410,
        message: [
          'This review has expired. Open a new one, with its reason, to make another copy.',
        ],
      })
      expect(await entries(patient.id, ['records_exports'])).toEqual([])
    })

    it('opens no clinical route to the admin: the medical file stays closed (§16)', async () => {
      const patient = await newPatient()
      await openReview(patient.id)
      expect(
        (await admin.get('/medical-files').query({ patientId: patient.id }))
          .status,
      ).toBe(403)
      expect(
        (await admin.get(`/medical-files/${patient.entryId}`)).status,
      ).toBe(403)
    })

    it('refuses the care team and the patient', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      for (const who of [alex, patient.agent]) {
        expect((await copy(who, patient.id, review.id)).status).toBe(403)
      }
    })
  })

  // =========================================================================

  describe('ending a review early', () => {
    it('lets any admin end it, signed and recorded', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)

      const res = await otherAdmin.post(
        `/users/${patient.id}/complaint-reviews/${review.id}/end`,
      )

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        id: review.id,
        status: 'ended',
        endedAt: expect.any(String),
        endedBy: { id: otherAdminId, firstName: 'Olive', lastName: 'Other' },
      })
      const trail = await entries(patient.id, ['complaint_reviews'])
      expect(trail.map((entry) => entry.action)).toEqual([
        'COMPLAINT_REVIEW_OPENED',
        'COMPLAINT_REVIEW_ENDED',
      ])
      expect(trail[1]).toMatchObject({
        performed_by: otherAdminId,
        entity_id: review.id,
        details: { openedBy: adminId, expiresAt: review.expiresAt },
      })
    })

    it('refuses to end one already over (409), or another patient’s (404)', async () => {
      const patient = await newPatient()
      const other = await newPatient('Other')
      const review = await openReview(patient.id)
      const end = (patientId: number) =>
        admin.post(`/users/${patientId}/complaint-reviews/${review.id}/end`)

      expect((await end(other.id)).status).toBe(404)
      expect((await end(patient.id)).status).toBe(200)
      const again = await end(patient.id)
      expect([again.status, again.body.message]).toEqual([
        409,
        ['This review has already ended.'],
      ])

      const expired = await openReview(patient.id)
      await ownerSet(
        expired.id,
        `opened_at = now() - interval '8 days', expires_at = now() - interval '1 day'`,
      )
      const late = await admin.post(
        `/users/${patient.id}/complaint-reviews/${expired.id}/end`,
      )
      expect([late.status, late.body.message]).toEqual([
        409,
        ['This review has already expired.'],
      ])
      expect(
        (await entries(patient.id, ['complaint_reviews'])).map(
          (entry) => entry.action,
        ),
      ).toEqual([
        'COMPLAINT_REVIEW_OPENED',
        'COMPLAINT_REVIEW_ENDED',
        'COMPLAINT_REVIEW_OPENED',
      ])
    })

    it('shows the review as ended in the list, ending kept over expiry', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      await admin.post(
        `/users/${patient.id}/complaint-reviews/${review.id}/end`,
      )
      // Later, its 7 days would also be over: it still reads "ended".
      await sessionPool.query(
        `ALTER TABLE complaint_reviews DISABLE TRIGGER complaint_review_guard`,
      )
      try {
        await ownerSet(
          review.id,
          `opened_at = opened_at - interval '8 days', expires_at = expires_at - interval '8 days', ended_at = ended_at - interval '8 days'`,
        )
      } finally {
        await sessionPool.query(
          `ALTER TABLE complaint_reviews ENABLE TRIGGER complaint_review_guard`,
        )
      }
      const [listed] = (
        await admin.get(`/users/${patient.id}/complaint-reviews`)
      ).body as { status: string }[]
      expect(listed.status).toBe('ended')
    })
  })

  // =========================================================================

  describe("the care team's notice", () => {
    it('tells a member who was on the team: who, when, until — never why', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id, {
        reason: REASON,
        caseReference: 'CR-9',
      })

      const notices = await reviewNotices(alex, patient.id)

      expect(notices).toStrictEqual([
        {
          kind: 'complaint_review',
          patient: {
            id: patient.id,
            firstName: 'Pat',
            lastName: 'Reviewed',
            avatarUrl: null,
          },
          review: {
            id: review.id,
            openedBy: { id: adminId, firstName: 'Avery', lastName: 'Admin' },
            openedAt: review.openedAt,
            expiresAt: review.expiresAt,
            endedAt: null,
          },
        },
      ])
      // The words of the reason appear nowhere in the answer.
      expect(JSON.stringify(await alertsOf(alex))).not.toContain('knee')
    })

    it('tells nothing to a member who joined after it opened, nor to anyone off the team', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      expect(
        (await sam.post(`/users/${patient.id}/care-team`).send({})).status,
      ).toBe(201)

      expect(await reviewNotices(sam, patient.id)).toEqual([])
      expect(await reviewNotices(blake, patient.id)).toEqual([])

      const late = await sam.post(
        `/alerts/complaint-reviews/${review.id}/review`,
      )
      expect([late.status, late.body.message]).toEqual([
        409,
        [NOT_A_REVIEW_NOTICE_MESSAGE],
      ])
      const outsider = await blake.post(
        `/alerts/complaint-reviews/${review.id}/review`,
      )
      expect([outsider.status, outsider.body.message]).toEqual([
        404,
        [`Complaint review ${review.id} not found`],
      ])
    })

    it('still tells of a review once it has ended, saying when', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      const ended = await admin.post(
        `/users/${patient.id}/complaint-reviews/${review.id}/end`,
      )
      const [notice] = await reviewNotices(alex, patient.id)
      expect(notice.review).toMatchObject({ endedAt: ended.body.endedAt })
    })

    it('drops a review opened more than 14 days ago', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)
      // Alex's link must have started before it, too.
      await sessionPool.query(
        `UPDATE care_team_members SET started_at = now() - interval '30 days'
         WHERE patient_id = $1`,
        [patient.id],
      )
      await ownerSet(
        review.id,
        `opened_at = now() - interval '15 days', expires_at = now() - interval '8 days'`,
      )
      expect(await reviewNotices(alex, patient.id)).toEqual([])
    })

    it('takes it off the list once marked as reviewed — once, idempotently', async () => {
      const patient = await newPatient()
      const review = await openReview(patient.id)

      const first = await alex.post(
        `/alerts/complaint-reviews/${review.id}/review`,
      )
      expect(first.status).toBe(200)
      expect(first.body).toStrictEqual({ reviewedAt: expect.any(String) })
      const second = await alex.post(
        `/alerts/complaint-reviews/${review.id}/review`,
      )
      expect(second.body).toStrictEqual(first.body)

      expect(await reviewNotices(alex, patient.id)).toEqual([])
      expect(
        await entries(patient.id, ['complaint_review_notice_reviews']),
      ).toStrictEqual([
        {
          action: 'COMPLAINT_REVIEW_NOTICE_REVIEWED',
          performed_by: alexId,
          entity_type: 'complaint_review_notice_reviews',
          entity_id: expect.any(Number),
          details: { complaintReviewId: review.id, openedBy: adminId },
        },
      ])
    })

    it('lists review and join notices together, newest first', async () => {
      const patient = await newPatient('Ordered')
      const first = await openReview(patient.id)
      // Sam joins after it: a join notice for Alex, newer…
      const joined = await sam.post(`/users/${patient.id}/care-team`).send({})
      expect(joined.status).toBe(201)
      // … and a second review, newer still. Neither list's own order (joins
      // first, then reviews) gives review, join, review: only the merge does.
      const second = await openReview(patient.id)

      const mine = (await alertsOf(alex)).filter(
        (alert) => alert.patient.id === patient.id,
      )
      expect(
        mine.map((alert) => [
          alert.kind,
          alert.kind === 'care_team_join' ? alert.link?.id : alert.review?.id,
        ]),
      ).toEqual([
        ['complaint_review', second.id],
        ['care_team_join', expect.any(Number)],
        ['complaint_review', first.id],
      ])
    })
  })

  // =========================================================================

  describe('row security and the guard (as the app role)', () => {
    type Actor = { userId: number; role: string }

    class RolledBack extends Error {
      constructor(readonly rows: Record<string, unknown>[]) {
        super('rolled back on purpose')
      }
    }

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
            constraint:
              typeof fields.constraint === 'string'
                ? fields.constraint
                : undefined,
          }
        }
        current = fields.cause
      }
      return {}
    }

    // As the app's role (row security applies), as `actor`, in a transaction
    // always rolled back: the last statement's rows, or the refusal. Several
    // statements run in order, in ONE transaction (`queries`).
    async function run(
      actor: Actor,
      ...queries: SQL[]
    ): Promise<{
      rows?: Record<string, unknown>[]
      error?: ReturnType<typeof pgError>
    }> {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true)`,
          )
          await tx.execute(
            sql`SELECT set_config('app.current_role', ${actor.role}, true)`,
          )
          let rows: Record<string, unknown>[] = []
          for (const query of queries) {
            rows = (await tx.execute<Record<string, unknown>>(query)).rows
          }
          throw new RolledBack(rows)
        })
      } catch (error) {
        if (error instanceof RolledBack) return { rows: error.rows }
        return { error: pgError(error) }
      }
      throw new Error('unreachable: run() always rolls back')
    }

    const asAdmin: Actor = { userId: 0, role: 'admin' }
    const refusedByPolicy = { error: { code: '42501', constraint: undefined } }
    const guard = (constraint: string) => ({
      error: { code: '23514', constraint },
    })

    let patientId: number
    let reviewId: number

    beforeAll(async () => {
      asAdmin.userId = adminId
      const patient = await newPatient('Guarded')
      patientId = patient.id
      reviewId = (await openReview(patientId)).id
    })

    it('shows a review to admins and the care team — its reason to admins only', async () => {
      const review = sql`SELECT id FROM complaint_reviews WHERE id = ${reviewId}`
      const reason = sql`SELECT review_id FROM complaint_review_reasons WHERE review_id = ${reviewId}`
      const alexActor = { userId: alexId, role: 'practitioner' }

      expect(await run(asAdmin, review)).toStrictEqual({
        rows: [{ id: reviewId }],
      })
      expect(await run(asAdmin, reason)).toStrictEqual({
        rows: [{ review_id: reviewId }],
      })
      expect(await run(alexActor, review)).toStrictEqual({
        rows: [{ id: reviewId }],
      })
      expect(await run(alexActor, reason)).toStrictEqual({ rows: [] })
      for (const actor of [
        { userId: blakeId, role: 'practitioner' },
        { userId: patientId, role: 'patient' },
      ]) {
        expect(await run(actor, review)).toStrictEqual({ rows: [] })
        expect(await run(actor, reason)).toStrictEqual({ rows: [] })
      }
    })

    it('lets only an admin open one, in their own name', async () => {
      const insert = (openedBy: number) =>
        sql`INSERT INTO complaint_reviews (patient_id, opened_by, expires_at)
            VALUES (${patientId}, ${openedBy}, now() + interval '1 hour')`
      expect(
        await run({ userId: alexId, role: 'practitioner' }, insert(alexId)),
      ).toStrictEqual(refusedByPolicy)
      expect(await run(asAdmin, insert(otherAdminId))).toStrictEqual(
        refusedByPolicy,
      )
    })

    it('writes the opening moment and the 7 days itself, whatever is sent', async () => {
      const result = await run(
        asAdmin,
        sql`INSERT INTO complaint_reviews (patient_id, opened_by, opened_at, expires_at)
            VALUES (${patientId}, ${adminId}, now() - interval '1 year', now() + interval '1 year')
            RETURNING opened_at = now() AS stamped,
                      expires_at - opened_at = interval '168 hours' AS week`,
      )
      expect(result).toStrictEqual({ rows: [{ stamped: true, week: true }] })
      expect(
        await run(
          asAdmin,
          sql`INSERT INTO complaint_reviews (patient_id, opened_by, expires_at, ended_at, ended_by)
              VALUES (${patientId}, ${adminId}, now() + interval '1 hour', now(), ${adminId})`,
        ),
      ).toStrictEqual(guard('complaint_review_starts_open'))
    })

    it('takes a reason only from the opener, in the opening transaction', async () => {
      const reasonFor = (id: SQL) =>
        sql`INSERT INTO complaint_review_reasons (review_id, reason) VALUES (${id}, 'Why')`
      const opened = sql`(SELECT max(id) FROM complaint_reviews)`
      const open = (by: number) =>
        sql`INSERT INTO complaint_reviews (patient_id, opened_by, expires_at)
            VALUES (${patientId}, ${by}, now() + interval '1 hour')`

      // The opener, same transaction: accepted.
      expect(
        await run(asAdmin, open(adminId), reasonFor(opened)),
      ).toStrictEqual({ rows: [] })
      // Another admin, in the SAME transaction as the opening (the session
      // switched to them after the review was opened): "the opening
      // transaction" holds, so only "the opener" can refuse this one.
      expect(
        await run(
          asAdmin,
          open(adminId),
          sql`SELECT set_config('app.current_user_id', ${String(otherAdminId)}, true)`,
          reasonFor(opened),
        ),
      ).toStrictEqual(refusedByPolicy)
      // The opener, but later: the existing review was opened in ANOTHER
      // transaction (its reason row exists already too — the policy is
      // checked first).
      const lonely = await sessionPool.query<{ id: number }>(
        `INSERT INTO complaint_reviews (patient_id, opened_by, expires_at)
         VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
        [patientId, adminId],
      )
      expect(
        await run(asAdmin, reasonFor(sql`${lonely.rows[0].id}`)),
      ).toStrictEqual(refusedByPolicy)
      // A practitioner, never.
      expect(
        await run(
          { userId: alexId, role: 'practitioner' },
          reasonFor(sql`${lonely.rows[0].id}`),
        ),
      ).toStrictEqual(refusedByPolicy)
    })

    it('keeps what a review is, and makes an ending signed and final', async () => {
      const update = (assignments: SQL) =>
        sql`UPDATE complaint_reviews SET ${assignments} WHERE id = ${reviewId} RETURNING id`

      expect(
        await run(
          asAdmin,
          update(sql`expires_at = expires_at + interval '1 day'`),
        ),
      ).toStrictEqual(guard('complaint_review_fixed'))
      expect(
        await run(asAdmin, update(sql`patient_id = ${alexId}`)),
      ).toStrictEqual(guard('complaint_review_fixed'))
      expect(
        await run(
          asAdmin,
          update(sql`ended_by = ${otherAdminId}, ended_at = now()`),
        ),
      ).toStrictEqual(guard('complaint_review_ended_by_self'))
      // Ended once, it can't be ended again.
      expect(
        await run(
          asAdmin,
          update(sql`ended_by = ${adminId}`),
          update(sql`ended_by = ${otherAdminId}`),
        ),
      ).toStrictEqual(guard('complaint_review_closed'))
      // The care team can't touch it at all; nobody can delete it.
      expect(
        await run(
          { userId: alexId, role: 'practitioner' },
          update(sql`ended_by = ${alexId}`),
        ),
      ).toStrictEqual({ rows: [] })
      expect(
        await run(
          asAdmin,
          sql`DELETE FROM complaint_reviews WHERE id = ${reviewId} RETURNING id`,
        ),
      ).toStrictEqual({ rows: [] })
    })

    it('refuses to end an expired review, and stamps the ending itself', async () => {
      const ended = await run(
        asAdmin,
        sql`UPDATE complaint_reviews SET ended_by = ${adminId}, ended_at = now() - interval '1 year'
            WHERE id = ${reviewId} RETURNING ended_at = now() AS stamped`,
      )
      expect(ended).toStrictEqual({ rows: [{ stamped: true }] })

      const expired = await sessionPool.query<{ id: number }>(
        `INSERT INTO complaint_reviews (patient_id, opened_by, opened_at, expires_at)
         VALUES ($1, $2, now() - interval '8 days', now() - interval '1 day') RETURNING id`,
        [patientId, adminId],
      )
      expect(
        await run(
          asAdmin,
          sql`UPDATE complaint_reviews SET ended_by = ${adminId} WHERE id = ${expired.rows[0].id}`,
        ),
      ).toStrictEqual(guard('complaint_review_closed'))
    })

    it('lets a care-team practitioner record their own "seen" only', async () => {
      const seen = (practitionerId: number) =>
        sql`INSERT INTO complaint_review_notice_reviews (complaint_review_id, practitioner_id, reviewed_at)
            VALUES (${reviewId}, ${practitionerId}, now() - interval '1 year')`

      expect(
        await run(
          { userId: alexId, role: 'practitioner' },
          sql`${seen(alexId)} RETURNING reviewed_at = now() AS stamped`,
        ),
      ).toStrictEqual({ rows: [{ stamped: true }] })
      // The refusals WITHOUT `RETURNING`: Postgres checks returned rows
      // against the SELECT policy too (own rows only), which would refuse
      // them before the INSERT policy is ever the reason.
      //   - in a colleague's name;
      expect(
        await run({ userId: alexId, role: 'practitioner' }, seen(samId)),
      ).toStrictEqual(refusedByPolicy)
      //   - off the care team (the review is hidden from Blake as well);
      expect(
        await run({ userId: blakeId, role: 'practitioner' }, seen(blakeId)),
      ).toStrictEqual(refusedByPolicy)
      //   - an admin, who SEES every review: only the care-team condition
      //     stops them.
      expect(await run(asAdmin, seen(adminId))).toStrictEqual(refusedByPolicy)
    })
  })
})
