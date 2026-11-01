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
import { asOwner, BLANK_VALUES } from './support/as-owner'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { NOT_A_DISCLOSURE_NOTICE_MESSAGE } from '../src/alerts/legal-disclosure-notices.service'
import {
  BLANK_RECIPIENT_MESSAGE,
  NO_PART_MESSAGE,
} from '../src/legal-disclosures/dto/make-legal-disclosure.dto'
import {
  EXPLANATION_ONLY_WITH_OTHER_MESSAGE,
  EXPLANATION_REQUIRED_MESSAGE,
  HOLD_IN_FUTURE_MESSAGE,
  PERIOD_ORDER_MESSAGE,
  RECEIVED_IN_FUTURE_MESSAGE,
  STATEMENT_ONLY_WITH_HOLD_MESSAGE,
  STATEMENT_REQUIRED_MESSAGE,
  dayOf,
} from '../src/legal-disclosures/legal-disclosure-rules'

// The legal disclosure (decisions §25, pass 3 of the post-Phase-6 tidy-up):
//   - an ADMIN records an order — the recipient, the legal basis, its
//     reference, the day it arrived — with the parts of the record it covers
//     (messages possible ONLY here) and a period, and gets ONE PDF, stamped
//     on every page;
//   - an agency may ask the clinic to hold it back from the patient for a
//     time (HIPAA 164.528(a)(2));
//   - the PATIENT finds it in their accounting of disclosures (GET
//     /legal-disclosures, their own export) once any hold is over;
//   - the patient's CARE TEAM is told in "For review": who, when, to whom —
//     never the basis, the parts or the reference.
// What these tests hold it to: the routes' answers and refusals, both audit
// entries, the copy's scope (parts AND period, each by its own date, in the
// copy's zone), that an admin still reads no clinical route (§16), and that
// the database keeps the same rules on its own — three audiences, three
// slices of one disclosure; the hold decided by the patient's own policy; a
// disclosure dated by the database, written in one transaction, never
// changed.
describe('Legal disclosures (e2e)', () => {
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
  let alex: Agent // on the patients' care teams BEFORE their disclosures
  let sam: Agent // joins a care team AFTER a disclosure
  let blake: Agent // on no care team here

  const ZONE = 'America/Montreal'
  // A complete order: the recipient, the basis, the reference, the day it
  // arrived — and every part, no period.
  const ORDER = {
    recipientName: 'Det. Jane Roe',
    recipientOrganisation: 'Montreal Police',
    legalBasis: 'court_order',
    orderReference: '500-17-123',
    receivedOn: '2026-10-01',
    parts: ['medical_file', 'programs', 'sessions', 'messages'],
    timeZone: ZONE,
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
      clinicName: 'Legal Disclosures E2E Clinic',
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
  // and a conversation with Alex holding one message — so a copy has
  // something of every kind in it.
  async function newPatient(lastName = 'Disclosed') {
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
    const conversation = await alex.post('/conversations').send({ userId: id })
    expect(conversation.status).toBe(201)
    const message = await sendMessage(
      alex,
      conversation.body.id as number,
      'Start with the lighter band.',
    )
    return {
      id,
      agent,
      entryId: entry.body.id as number,
      conversationId: conversation.body.id as number,
      messageId: message,
    }
  }

  async function sendMessage(
    who: Agent,
    conversationId: number,
    messageBody: string,
  ): Promise<number> {
    const res = await who
      .post(`/conversations/${conversationId}/messages`)
      .send({ messageBody })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  // POST …/legal-disclosures, the PDF kept as bytes (supertest parses only
  // text and JSON); a refusal's JSON is read with refusal() below.
  function disclose(
    patientId: number,
    body: Record<string, unknown> = ORDER,
    who: Agent = admin,
  ) {
    return who
      .post(`/users/${patientId}/legal-disclosures`)
      .send(body)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => done(null, Buffer.concat(chunks)))
      })
  }

  // The disclosure's id, from the file name its answer carries.
  function disclosureIdOf(res: request.Response): number {
    const match = /stride-disclosure-(\d+)-/.exec(
      String(res.headers['content-disposition']),
    )
    if (!match) throw new Error('no disclosure id in the file name')
    return Number(match[1])
  }

  async function makeDisclosure(
    patientId: number,
    body: Record<string, unknown> = ORDER,
    who: Agent = admin,
  ) {
    const res = await disclose(patientId, body, who)
    expect(res.status).toBe(201)
    return { id: disclosureIdOf(res), pdf: res.body as Buffer }
  }

  // The PDF's text as one string: the extractor answers a field's label and
  // its value as separate pieces ("Disclosed to: ", "Det. Jane Roe"), and a
  // wrapped paragraph as one piece per line.
  function textOf(pdf: Buffer): string {
    return pdfText(pdf).join('')
  }

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
      disclosure?: Record<string, unknown>
      review?: { id: number }
    }[]
  }

  async function disclosureNotices(who: Agent, patientId: number) {
    return (await alertsOf(who)).filter(
      (alert) =>
        alert.kind === 'legal_disclosure' && alert.patient.id === patientId,
    )
  }

  // As the tables' owner (no row security, no guard): what a test needs to
  // set up that no route may do — a row dated in the past.
  async function owner(text: string, params: unknown[]) {
    await sessionPool.query(text, params)
  }

  // Tomorrow, as a day in the zone the requests are made in.
  function tomorrow(): string {
    return dayOf(new Date(Date.now() + 24 * 60 * 60 * 1000), ZONE)
  }

  // =========================================================================

  describe('making a disclosure', () => {
    it('records the order and answers its one copy, stamped on every page', async () => {
      const patient = await newPatient()
      const res = await disclose(patient.id)

      expect(res.status).toBe(201)
      expect(res.headers['content-type']).toBe('application/pdf')
      expect(res.headers['cache-control']).toBe('no-store')
      const id = disclosureIdOf(res)
      expect(res.headers['content-disposition']).toMatch(
        new RegExp(
          `^attachment; filename="stride-disclosure-${id}-\\d{4}-\\d{2}-\\d{2}\\.pdf"$`,
        ),
      )
      const pdf = res.body as Buffer
      const text = textOf(pdf)
      expect(text).toContain('Health record — disclosed copy')
      expect(text).toContain('Disclosed to: Det. Jane Roe')
      expect(text).toContain('Order reference: 500-17-123')
      expect(text).toContain(
        'Parts included: Medical file, exercise programs, sessions and messages',
      )
      expect(text).toContain('Two sessions a week.')
      expect(text).toContain('Start with the lighter band.')
      const day = dayOf(new Date(), ZONE)
      const longDay = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(`${day}T00:00:00Z`))
      const stampLine = `Disclosed to Montreal Police under a court order (ref. 500-17-123) on ${longDay} · disclosure ${id}`
      const pages = pdfPages(pdf)
      expect(pages.length).toBeGreaterThan(1)
      for (const page of pages) expect(page).toContain(stampLine)

      // The admin's list: everything, the order included.
      const list = await admin.get(`/users/${patient.id}/legal-disclosures`)
      expect(list.status).toBe(200)
      expect(list.body).toStrictEqual([
        {
          id,
          madeAt: expect.any(String),
          recipientName: 'Det. Jane Roe',
          recipientOrganisation: 'Montreal Police',
          legalBasis: 'court_order',
          basisExplanation: null,
          parts: ['medical_file', 'programs', 'sessions', 'messages'],
          periodFrom: null,
          periodTo: null,
          madeBy: { id: adminId, firstName: 'Avery', lastName: 'Admin' },
          orderReference: '500-17-123',
          receivedOn: '2026-10-01',
          withheldUntil: null,
          shownToPatient: true,
          withholdingStatement: null,
        },
      ])

      // TWO entries, in one transaction: the disclosure (shown to admins)
      // and its copy's contents (clinical ids, withheld from them).
      expect(
        await entries(patient.id, ['legal_disclosures', 'records_exports']),
      ).toStrictEqual([
        {
          action: 'LEGAL_DISCLOSURE_MADE',
          performed_by: adminId,
          entity_type: 'legal_disclosures',
          entity_id: id,
          details: {
            recipientName: 'Det. Jane Roe',
            recipientOrganisation: 'Montreal Police',
            legalBasis: 'court_order',
            orderReference: '500-17-123',
            receivedOn: '2026-10-01',
            parts: ['medical_file', 'programs', 'sessions', 'messages'],
          },
        },
        {
          action: 'RECORDS_EXPORTED',
          performed_by: adminId,
          entity_type: 'records_exports',
          entity_id: null,
          details: {
            via: 'legal_disclosure',
            disclosureId: id,
            timeZone: ZONE,
            medicalFileEntryIds: [patient.entryId],
            romAssessmentIds: [],
            programIds: [],
            sessionIds: [],
            messageIds: [patient.messageId],
          },
        },
      ])
    })

    it('holds only the parts chosen — no messages key when they are left out', async () => {
      const patient = await newPatient()
      const onlyMessages = await makeDisclosure(patient.id, {
        ...ORDER,
        parts: ['messages'],
      })
      const text = textOf(onlyMessages.pdf)
      expect(text).toContain('Start with the lighter band.')
      expect(text).not.toContain('Two sessions a week.')
      expect(text).toContain(
        'Not included: medical file, exercise programs and sessions.',
      )

      const withoutMessages = await makeDisclosure(patient.id, {
        ...ORDER,
        parts: ['medical_file'],
      })
      expect(textOf(withoutMessages.pdf)).not.toContain(
        'Start with the lighter band.',
      )

      const copies = await entries(patient.id, ['records_exports'])
      expect(copies.map((entry) => entry.details)).toStrictEqual([
        {
          via: 'legal_disclosure',
          disclosureId: onlyMessages.id,
          timeZone: ZONE,
          medicalFileEntryIds: [],
          romAssessmentIds: [],
          programIds: [],
          sessionIds: [],
          messageIds: [patient.messageId],
        },
        {
          via: 'legal_disclosure',
          disclosureId: withoutMessages.id,
          timeZone: ZONE,
          medicalFileEntryIds: [patient.entryId],
          romAssessmentIds: [],
          programIds: [],
          sessionIds: [],
        },
      ])
    })

    it('holds only the period chosen — each moment read as a day in the copy’s zone', async () => {
      const patient = await newPatient()
      const conversation = patient.conversationId
      const march = await sendMessage(alex, conversation, 'A March message.')
      const edge = await sendMessage(alex, conversation, 'An edge message.')
      const april = await sendMessage(alex, conversation, 'An April message.')
      // 02:00 UTC on April 1 is still March 31 in Montreal, and April 1 in
      // Paris: the same message is in or out depending on the zone.
      await owner(
        `UPDATE messages SET sent_at = CASE id
           WHEN $1 THEN '2026-03-10T12:00:00Z'::timestamptz
           WHEN $2 THEN '2026-04-01T02:00:00Z'::timestamptz
           WHEN $3 THEN '2026-04-10T12:00:00Z'::timestamptz
           ELSE '2026-05-20T12:00:00Z'::timestamptz END
         WHERE conversation_id = $4`,
        [march, edge, april, conversation],
      )
      // The medical file entry: written in April.
      await owner(
        `UPDATE medical_files SET created_at = '2026-04-15T12:00:00Z' WHERE id = $1`,
        [patient.entryId],
      )
      const april2026 = {
        ...ORDER,
        parts: ['medical_file', 'messages'],
        periodFrom: '2026-04-01',
        periodTo: '2026-04-30',
      }

      const montreal = await makeDisclosure(patient.id, april2026)
      const paris = await makeDisclosure(patient.id, {
        ...april2026,
        timeZone: 'Europe/Paris',
      })
      const may = await makeDisclosure(patient.id, {
        ...april2026,
        periodFrom: '2026-05-01',
        periodTo: null,
      })

      const ids = (await entries(patient.id, ['records_exports'])).map(
        (entry) => [
          entry.details?.medicalFileEntryIds,
          entry.details?.messageIds,
        ],
      )
      expect(ids).toEqual([
        [[patient.entryId], [april]],
        [[patient.entryId], [edge, april]],
        // May onwards: only the first message (planted May 20); no note.
        [[], [patient.messageId]],
      ])
      expect(textOf(montreal.pdf)).toContain(
        'Period: April 1, 2026 to April 30, 2026 (days in America/Montreal time)',
      )
      expect(textOf(paris.pdf)).toContain('An edge message.')
      expect(textOf(may.pdf)).toContain(
        'Period: from May 1, 2026 (days in America/Montreal time)',
      )
    })

    it('says who wrote each message', async () => {
      const patient = await newPatient()
      await sendMessage(
        patient.agent,
        patient.conversationId,
        'Thanks, will do.',
      )
      const { pdf } = await makeDisclosure(patient.id, {
        ...ORDER,
        parts: ['messages'],
      })
      const text = textOf(pdf)
      // "who · when", then the text: Alex's message, then the patient's reply.
      expect(text).toMatch(/Alex Physio · [^·]+Start with the lighter band\./)
      expect(text).toMatch(/Pat Disclosed · [^·]+Thanks, will do\./)
    })

    it('shows a deleted message without its text', async () => {
      const patient = await newPatient()
      const deleted = await sendMessage(
        alex,
        patient.conversationId,
        'Sent to the wrong patient.',
      )
      expect(
        (
          await alex.delete(
            `/conversations/${patient.conversationId}/messages/${deleted}`,
          )
        ).status,
      ).toBe(200)
      const { pdf } = await makeDisclosure(patient.id, {
        ...ORDER,
        parts: ['messages'],
      })
      const text = textOf(pdf)
      expect(text).not.toContain('Sent to the wrong patient.')
      expect(text).toContain(
        "deleted by its sender before it was read; its text isn't shown.",
      )
    })

    it('refuses what the fields themselves forbid — and records nothing', async () => {
      const patient = await newPatient()
      const attempts: [Record<string, unknown>, string][] = [
        [{ ...ORDER, recipientName: '  ' }, BLANK_RECIPIENT_MESSAGE],
        [
          { ...ORDER, recipientOrganisation: ' ' },
          "The recipient's organisation can't be blank — leave it out if there is none",
        ],
        [
          { ...ORDER, legalBasis: 'curiosity' },
          'legalBasis must be one of the following values: court_order, subpoena, required_by_law, law_enforcement, health_oversight, coroner, other',
        ],
        [{ ...ORDER, parts: [] }, NO_PART_MESSAGE],
        [
          { ...ORDER, parts: ['medical_file', 'photos'] },
          'each value in parts must be one of the following values: medical_file, programs, sessions, messages',
        ],
        [
          { ...ORDER, parts: ['messages', 'messages'] },
          "All parts's elements must be unique",
        ],
        [
          { ...ORDER, receivedOn: '2026-02-30' },
          'receivedOn must be a date written as YYYY-MM-DD',
        ],
        [
          { ...ORDER, orderReference: 'r'.repeat(101) },
          'orderReference must be shorter than or equal to 100 characters',
        ],
        [
          { ...ORDER, timeZone: '+02:00' },
          'timeZone must be a time zone name, like Europe/Paris or America/Montreal',
        ],
      ]
      for (const [body, message] of attempts) {
        const res = await disclose(patient.id, body)
        expect(refusal(res)).toEqual({
          status: 400,
          message: expect.arrayContaining([message]),
        })
      }
      expect(
        await entries(patient.id, ['legal_disclosures', 'records_exports']),
      ).toEqual([])
    })

    it('refuses what the fields say together — each rule in its own words', async () => {
      const patient = await newPatient()
      const attempts: [Record<string, unknown>, string][] = [
        [{ ...ORDER, legalBasis: 'other' }, EXPLANATION_REQUIRED_MESSAGE],
        [
          { ...ORDER, basisExplanation: 'Because' },
          EXPLANATION_ONLY_WITH_OTHER_MESSAGE,
        ],
        [{ ...ORDER, receivedOn: '2099-01-01' }, RECEIVED_IN_FUTURE_MESSAGE],
        [
          { ...ORDER, periodFrom: '2026-05-01', periodTo: '2026-04-30' },
          PERIOD_ORDER_MESSAGE,
        ],
        [{ ...ORDER, withheldUntil: tomorrow() }, STATEMENT_REQUIRED_MESSAGE],
        [
          { ...ORDER, withholdingStatement: 'Ongoing investigation.' },
          STATEMENT_ONLY_WITH_HOLD_MESSAGE,
        ],
        [
          {
            ...ORDER,
            withheldUntil: dayOf(new Date(), ZONE),
            withholdingStatement: 'Ongoing investigation.',
          },
          HOLD_IN_FUTURE_MESSAGE,
        ],
      ]
      for (const [body, message] of attempts) {
        expect(refusal(await disclose(patient.id, body))).toEqual({
          status: 400,
          message: [message],
        })
      }
      expect(
        await entries(patient.id, ['legal_disclosures', 'records_exports']),
      ).toEqual([])
    })

    it('takes "other" with its explanation, and says it everywhere', async () => {
      const patient = await newPatient()
      const { id, pdf } = await makeDisclosure(patient.id, {
        ...ORDER,
        legalBasis: 'other',
        basisExplanation: 'A tribunal’s production order',
      })
      expect(textOf(pdf)).toContain(
        'Legal basis: Another legal basis: A tribunal’s production order',
      )
      const mine = await patient.agent.get('/legal-disclosures')
      expect(
        (mine.body as { id: number; basisExplanation: string }[]).map((row) => [
          row.id,
          row.basisExplanation,
        ]),
      ).toEqual([[id, 'A tribunal’s production order']])
    })

    it('refuses an unknown account (404) and one that is not a patient (400)', async () => {
      expect(refusal(await disclose(999999))).toEqual({
        status: 404,
        message: ['User 999999 not found'],
      })
      expect(refusal(await disclose(alexId))).toEqual({
        status: 400,
        message: ['Only a patient has a health record to disclose'],
      })
    })

    it('is for admins only — not the care team, not the patient', async () => {
      const patient = await newPatient()
      for (const who of [alex, patient.agent]) {
        expect((await disclose(patient.id, ORDER, who)).status).toBe(403)
        expect(
          (await who.get(`/users/${patient.id}/legal-disclosures`)).status,
        ).toBe(403)
      }
      expect(
        await entries(patient.id, ['legal_disclosures', 'records_exports']),
      ).toEqual([])
    })

    it('lists every disclosure to every admin, newest first', async () => {
      const patient = await newPatient()
      const first = await makeDisclosure(patient.id)
      const second = await makeDisclosure(patient.id, ORDER, otherAdmin)
      const res = await admin.get(`/users/${patient.id}/legal-disclosures`)
      expect(
        (res.body as { id: number; madeBy: { id: number } }[]).map((row) => [
          row.id,
          row.madeBy.id,
        ]),
      ).toEqual([
        [second.id, otherAdminId],
        [first.id, adminId],
      ])
    })

    it('opens no clinical route to the admin: file and messages stay closed (§16)', async () => {
      const patient = await newPatient()
      await makeDisclosure(patient.id)
      expect(
        (await admin.get('/medical-files').query({ patientId: patient.id }))
          .status,
      ).toBe(403)
      expect(
        (await admin.get(`/conversations/${patient.conversationId}/messages`))
          .status,
      ).toBe(403)
    })
  })

  // =========================================================================

  describe("the patient's accounting", () => {
    it('lists who, why, when, what — not the order’s details', async () => {
      const patient = await newPatient()
      const { id } = await makeDisclosure(patient.id, {
        ...ORDER,
        parts: ['sessions', 'medical_file'],
        periodFrom: '2026-01-01',
        periodTo: '2026-06-30',
      })
      const res = await patient.agent.get('/legal-disclosures')
      expect(res.status).toBe(200)
      expect(res.body).toStrictEqual([
        {
          id,
          madeAt: expect.any(String),
          recipientName: 'Det. Jane Roe',
          recipientOrganisation: 'Montreal Police',
          legalBasis: 'court_order',
          basisExplanation: null,
          // In the fixed order, whatever order was sent.
          parts: ['medical_file', 'sessions'],
          periodFrom: '2026-01-01',
          periodTo: '2026-06-30',
        },
      ])
    })

    it('lists it in the patient’s own export too', async () => {
      const patient = await newPatient()
      await makeDisclosure(patient.id)
      const res = await patient.agent
        .get('/records-export?timeZone=America/Montreal')
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => done(null, Buffer.concat(chunks)))
        })
      expect(res.status).toBe(200)
      const text = textOf(res.body as Buffer)
      expect(text).toContain('Disclosures of your record')
      expect(text).toContain('Given to: Det. Jane Roe')
      expect(text).toContain('Why: A court order')
    })

    it('keeps a held-back disclosure from the patient until its day — and only then', async () => {
      const patient = await newPatient()
      const until = tomorrow()
      const { id } = await makeDisclosure(patient.id, {
        ...ORDER,
        withheldUntil: until,
        withholdingStatement: 'Ongoing investigation — written request.',
      })

      // The hold starts at the START of that day in the admin's zone.
      const { rows } = await sessionPool.query<{
        expected: Date
        actual: Date
      }>(
        `SELECT ($1::date)::timestamp AT TIME ZONE $2 AS expected,
                withheld_until AS actual
         FROM legal_disclosures WHERE id = $3`,
        [until, ZONE, id],
      )
      expect(rows[0].actual.toISOString()).toBe(rows[0].expected.toISOString())

      const [listed] = (
        await admin.get(`/users/${patient.id}/legal-disclosures`)
      ).body as Record<string, unknown>[]
      expect(listed).toMatchObject({
        withheldUntil: rows[0].expected.toISOString(),
        shownToPatient: false,
        withholdingStatement: 'Ongoing investigation — written request.',
      })
      expect(
        (await entries(patient.id, ['legal_disclosures']))[0].details,
      ).toMatchObject({
        withheldUntil: rows[0].expected.toISOString(),
        withholdingStatement: 'Ongoing investigation — written request.',
      })
      expect((await patient.agent.get('/legal-disclosures')).body).toEqual([])

      // The day comes (moved by the owner — no route can).
      await owner(
        `UPDATE legal_disclosures SET withheld_until = now() - interval '1 minute' WHERE id = $1`,
        [id],
      )
      expect(
        (
          (await patient.agent.get('/legal-disclosures')).body as {
            id: number
          }[]
        ).map((row) => row.id),
      ).toEqual([id])
      expect(
        (
          (await admin.get(`/users/${patient.id}/legal-disclosures`)).body as {
            shownToPatient: boolean
          }[]
        )[0].shownToPatient,
      ).toBe(true)
    })

    it('shows a patient nobody else’s disclosures', async () => {
      const patient = await newPatient()
      const other = await newPatient('Other')
      await makeDisclosure(other.id)
      expect((await patient.agent.get('/legal-disclosures')).body).toEqual([])
    })

    it('is for patients only', async () => {
      for (const who of [admin, alex]) {
        expect((await who.get('/legal-disclosures')).status).toBe(403)
      }
    })
  })

  // =========================================================================

  describe("the care team's notice", () => {
    it('tells a member who was on the team: who, when, to whom — not the order', async () => {
      const patient = await newPatient()
      const { id } = await makeDisclosure(patient.id, {
        ...ORDER,
        withheldUntil: tomorrow(),
        withholdingStatement: 'Ongoing investigation.',
      })
      const [notice] = await disclosureNotices(alex, patient.id)
      expect(notice).toStrictEqual({
        kind: 'legal_disclosure',
        patient: {
          id: patient.id,
          firstName: 'Pat',
          lastName: 'Disclosed',
          avatarUrl: null,
        },
        disclosure: {
          id,
          madeBy: { id: adminId, firstName: 'Avery', lastName: 'Admin' },
          madeAt: expect.any(String),
          recipientName: 'Det. Jane Roe',
          recipientOrganisation: 'Montreal Police',
          withheldUntil: expect.any(String),
        },
      })
      // Not a word of the order in the whole answer.
      const body = JSON.stringify(await alertsOf(alex))
      for (const secret of [
        '500-17-123',
        'court_order',
        'Ongoing investigation',
      ]) {
        expect(body).not.toContain(secret)
      }
    })

    it('tells nothing to a member who joined after it, nor to anyone off the team', async () => {
      const patient = await newPatient()
      await makeDisclosure(patient.id)
      expect(
        (await sam.post(`/users/${patient.id}/care-team`).send({})).status,
      ).toBe(201)
      expect(await disclosureNotices(sam, patient.id)).toEqual([])
      expect(await disclosureNotices(blake, patient.id)).toEqual([])
      expect(await disclosureNotices(alex, patient.id)).toHaveLength(1)
    })

    it('drops a disclosure made more than 14 days ago', async () => {
      const patient = await newPatient()
      const { id } = await makeDisclosure(patient.id)
      // Alex's link must have started before the (backdated) disclosure.
      await owner(
        `UPDATE care_team_members SET started_at = now() - interval '30 days'
         WHERE patient_id = $1 AND practitioner_id = $2`,
        [patient.id, alexId],
      )
      await owner(
        `UPDATE legal_disclosures SET made_at = now() - interval '13 days' WHERE id = $1`,
        [id],
      )
      expect(await disclosureNotices(alex, patient.id)).toHaveLength(1)
      await owner(
        `UPDATE legal_disclosures SET made_at = now() - interval '15 days' WHERE id = $1`,
        [id],
      )
      expect(await disclosureNotices(alex, patient.id)).toEqual([])
    })

    it('takes it off the list once marked as reviewed — once, idempotently', async () => {
      const patient = await newPatient()
      const { id } = await makeDisclosure(patient.id)

      const first = await alex.post(`/alerts/legal-disclosures/${id}/review`)
      expect(first.status).toBe(200)
      expect(first.body).toStrictEqual({ reviewedAt: expect.any(String) })
      const again = await alex.post(`/alerts/legal-disclosures/${id}/review`)
      expect(again.body).toStrictEqual(first.body)
      expect(await disclosureNotices(alex, patient.id)).toEqual([])
      expect(
        await entries(patient.id, ['legal_disclosure_notice_reviews']),
      ).toStrictEqual([
        {
          action: 'LEGAL_DISCLOSURE_NOTICE_REVIEWED',
          performed_by: alexId,
          entity_type: 'legal_disclosure_notice_reviews',
          entity_id: expect.any(Number),
          details: { disclosureId: id, madeBy: adminId },
        },
      ])
    })

    it('refuses a review of a notice that isn’t mine (409), or of a disclosure I can’t see (404)', async () => {
      const patient = await newPatient()
      const { id } = await makeDisclosure(patient.id)
      expect(
        (await sam.post(`/users/${patient.id}/care-team`).send({})).status,
      ).toBe(201)
      const late = await sam.post(`/alerts/legal-disclosures/${id}/review`)
      expect([late.status, late.body.message]).toEqual([
        409,
        [NOT_A_DISCLOSURE_NOTICE_MESSAGE],
      ])
      const outsider = await blake.post(
        `/alerts/legal-disclosures/${id}/review`,
      )
      expect([outsider.status, outsider.body.message]).toEqual([
        404,
        [`Disclosure ${id} not found`],
      ])
      expect(
        await entries(patient.id, ['legal_disclosure_notice_reviews']),
      ).toEqual([])
    })

    it('lists disclosure and complaint review notices together, newest first', async () => {
      const patient = await newPatient()
      const { id } = await makeDisclosure(patient.id)
      const review = await admin
        .post(`/users/${patient.id}/complaint-reviews`)
        .send({ reason: 'A complaint about the program.' })
      expect(review.status).toBe(201)
      // The review opened a minute after the disclosure (moved later, not
      // the disclosure earlier: Alex's link must stay older than both).
      await owner(
        `UPDATE complaint_reviews SET opened_at = opened_at + interval '1 minute' WHERE id = $1`,
        [review.body.id],
      )
      const mine = (await alertsOf(alex)).filter(
        (alert) => alert.patient.id === patient.id,
      )
      const order = (alerts: typeof mine) =>
        alerts.map((alert) => [
          alert.kind,
          alert.kind === 'legal_disclosure'
            ? alert.disclosure?.id
            : alert.review?.id,
        ])
      expect(order(mine)).toEqual([
        ['complaint_review', review.body.id],
        ['legal_disclosure', id],
      ])
      // And the other way round: the disclosure moved after the review.
      await owner(
        `UPDATE legal_disclosures SET made_at = made_at + interval '2 minutes' WHERE id = $1`,
        [id],
      )
      expect(
        order(
          (await alertsOf(alex)).filter(
            (alert) => alert.patient.id === patient.id,
          ),
        ),
      ).toEqual([
        ['legal_disclosure', id],
        ['complaint_review', review.body.id],
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
    // always rolled back: the last statement's rows, or the refusal.
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

    let patientId: number
    let disclosureId: number
    let heldId: number

    beforeAll(async () => {
      asAdmin.userId = adminId
      const patient = await newPatient('Guarded')
      patientId = patient.id
      disclosureId = (await makeDisclosure(patientId)).id
      heldId = (
        await makeDisclosure(patientId, {
          ...ORDER,
          withheldUntil: tomorrow(),
          withholdingStatement: 'Ongoing investigation.',
        })
      ).id
    })

    // A disclosure row, as the owner would plant it — then each test writes
    // its companions as the app role.
    function insertDisclosure(madeBy: number, withheld = false) {
      return sql`INSERT INTO legal_disclosures (patient_id, made_by, recipient_name, withheld_until)
          VALUES (${patientId}, ${madeBy}, 'Someone', ${withheld ? sql`now() + interval '1 day'` : null})`
    }

    it('shows three slices of one disclosure to three audiences', async () => {
      const main = sql`SELECT id FROM legal_disclosures WHERE id = ${disclosureId}`
      const details = sql`SELECT disclosure_id FROM legal_disclosure_details WHERE disclosure_id = ${disclosureId}`
      const order = sql`SELECT disclosure_id FROM legal_disclosure_orders WHERE disclosure_id = ${disclosureId}`
      const alexActor = { userId: alexId, role: 'practitioner' }
      const patientActor = { userId: patientId, role: 'patient' }

      for (const query of [main, details, order]) {
        expect((await run(asAdmin, query)).rows).toHaveLength(1)
      }
      expect((await run(alexActor, main)).rows).toHaveLength(1)
      expect(await run(alexActor, details)).toStrictEqual({ rows: [] })
      expect(await run(alexActor, order)).toStrictEqual({ rows: [] })
      expect((await run(patientActor, main)).rows).toHaveLength(1)
      expect((await run(patientActor, details)).rows).toHaveLength(1)
      expect(await run(patientActor, order)).toStrictEqual({ rows: [] })
      // The patient's own id acting in another role sees nothing.
      expect(
        await run({ userId: patientId, role: 'practitioner' }, main),
      ).toStrictEqual({ rows: [] })
      for (const actor of [
        { userId: blakeId, role: 'practitioner' },
        { userId: alexId, role: 'patient' },
      ]) {
        expect(await run(actor, main)).toStrictEqual({ rows: [] })
        expect(await run(actor, details)).toStrictEqual({ rows: [] })
      }
    })

    it('hides a held-back disclosure from the patient — the row and its details', async () => {
      const patientActor = { userId: patientId, role: 'patient' }
      expect(
        await run(
          patientActor,
          sql`SELECT id FROM legal_disclosures WHERE id = ${heldId}`,
        ),
      ).toStrictEqual({ rows: [] })
      expect(
        await run(
          patientActor,
          sql`SELECT disclosure_id FROM legal_disclosure_details WHERE disclosure_id = ${heldId}`,
        ),
      ).toStrictEqual({ rows: [] })
      // The care team is told — it sees the row.
      expect(
        (
          await run(
            { userId: alexId, role: 'practitioner' },
            sql`SELECT id FROM legal_disclosures WHERE id = ${heldId}`,
          )
        ).rows,
      ).toHaveLength(1)
    })

    it('lets only an admin make one, in their own name', async () => {
      expect(
        await run(
          { userId: alexId, role: 'practitioner' },
          insertDisclosure(alexId),
        ),
      ).toStrictEqual(refusedByPolicy)
      expect(await run(asAdmin, insertDisclosure(otherAdminId))).toStrictEqual(
        refusedByPolicy,
      )
      expect(await run(asAdmin, insertDisclosure(adminId))).toStrictEqual({
        rows: [],
      })
    })

    it('dates a disclosure itself, and refuses a hold already over', async () => {
      expect(
        await run(
          asAdmin,
          sql`INSERT INTO legal_disclosures (patient_id, made_by, recipient_name, made_at)
              VALUES (${patientId}, ${adminId}, 'Someone', now() - interval '3 days')
              RETURNING made_at = now() AS stamped`,
        ),
      ).toStrictEqual({ rows: [{ stamped: true }] })
      expect(
        await run(
          asAdmin,
          sql`INSERT INTO legal_disclosures (patient_id, made_by, recipient_name, withheld_until)
              VALUES (${patientId}, ${adminId}, 'Someone', now() - interval '1 minute')`,
        ),
      ).toStrictEqual({
        error: { code: '23514', constraint: 'legal_disclosure_hold_in_future' },
      })
    })

    it('takes details and the order only from the maker, in the same transaction', async () => {
      const details = sql`INSERT INTO legal_disclosure_details
          (disclosure_id, legal_basis, includes_medical_file, includes_programs, includes_sessions, includes_messages)
          VALUES (currval('legal_disclosures_id_seq'), 'court_order', true, false, false, false)`
      const order = (statement: string | null) =>
        sql`INSERT INTO legal_disclosure_orders (disclosure_id, received_on, withholding_statement)
            VALUES (currval('legal_disclosures_id_seq'), '2026-10-01', ${statement})`

      expect(
        await run(asAdmin, insertDisclosure(adminId), details, order(null)),
      ).toStrictEqual({ rows: [] })
      // Another admin can't add to someone else's disclosure …
      const other = { userId: otherAdminId, role: 'admin' }
      await owner(
        `INSERT INTO legal_disclosures (patient_id, made_by, recipient_name) VALUES ($1, $2, 'Planted')`,
        [patientId, adminId],
      )
      const planted = sql`(SELECT max(id) FROM legal_disclosures WHERE recipient_name = 'Planted')`
      expect(
        await run(
          other,
          sql`INSERT INTO legal_disclosure_details
              (disclosure_id, legal_basis, includes_medical_file, includes_programs, includes_sessions, includes_messages)
              VALUES (${planted}, 'court_order', true, false, false, false)`,
        ),
      ).toStrictEqual(refusedByPolicy)
      // … nor its maker, in a LATER transaction (made_at = now() fails).
      expect(
        await run(
          asAdmin,
          sql`INSERT INTO legal_disclosure_orders (disclosure_id, received_on)
              VALUES (${planted}, '2026-10-01')`,
        ),
      ).toStrictEqual(refusedByPolicy)
    })

    it('requires the agency’s statement exactly with a hold', async () => {
      const order = (statement: string | null) =>
        sql`INSERT INTO legal_disclosure_orders (disclosure_id, received_on, withholding_statement)
            VALUES (currval('legal_disclosures_id_seq'), '2026-10-01', ${statement})`
      expect(
        await run(asAdmin, insertDisclosure(adminId, true), order(null)),
      ).toStrictEqual(refusedByPolicy)
      expect(
        await run(
          asAdmin,
          insertDisclosure(adminId, false),
          order('A statement'),
        ),
      ).toStrictEqual(refusedByPolicy)
      expect(
        await run(
          asAdmin,
          insertDisclosure(adminId, true),
          order('A statement'),
        ),
      ).toStrictEqual({ rows: [] })
    })

    it('never changes or removes a disclosure', async () => {
      for (const [table, column] of [
        ['legal_disclosures', 'id'],
        ['legal_disclosure_details', 'disclosure_id'],
        ['legal_disclosure_orders', 'disclosure_id'],
      ]) {
        // RETURNING: the admin passes every SELECT policy, so an empty answer
        // means no UPDATE / DELETE policy let the row through.
        expect(
          await run(
            asAdmin,
            sql`UPDATE ${sql.raw(table)} SET ${sql.raw(column)} = ${sql.raw(column)} WHERE ${sql.raw(column)} = ${disclosureId} RETURNING 1`,
          ),
        ).toStrictEqual({ rows: [] })
        expect(
          await run(
            asAdmin,
            sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(column)} = ${disclosureId} RETURNING 1`,
          ),
        ).toStrictEqual({ rows: [] })
      }
    })

    it('lets a care-team practitioner record their own "seen" only', async () => {
      const seen = (practitionerId: number) =>
        sql`INSERT INTO legal_disclosure_notice_reviews (disclosure_id, practitioner_id)
            VALUES (${disclosureId}, ${practitionerId})`
      const alexActor = { userId: alexId, role: 'practitioner' }
      // A backdated moment sent: the trigger writes the database's own.
      expect(
        await run(
          alexActor,
          sql`INSERT INTO legal_disclosure_notice_reviews (disclosure_id, practitioner_id, reviewed_at)
              VALUES (${disclosureId}, ${alexId}, now() - interval '3 days')
              RETURNING reviewed_at = now() AS stamped`,
        ),
      ).toStrictEqual({ rows: [{ stamped: true }] })
      // The refusals WITHOUT `RETURNING` (it would ask the SELECT policy).
      expect(await run(alexActor, seen(samId))).toStrictEqual(refusedByPolicy)
      expect(
        await run({ userId: blakeId, role: 'practitioner' }, seen(blakeId)),
      ).toStrictEqual(refusedByPolicy)
      // Own rows only, as a practitioner.
      expect(
        await run(
          alexActor,
          seen(alexId),
          sql`SELECT practitioner_id FROM legal_disclosure_notice_reviews WHERE disclosure_id = ${disclosureId}`,
        ),
      ).toStrictEqual({ rows: [{ practitioner_id: alexId }] })
      expect(
        await run(asAdmin, sql`SELECT id FROM legal_disclosure_notice_reviews`),
      ).toStrictEqual({ rows: [] })
    })
  })

  // The database's half of the DTO's `\S` rules (migration 0078), for the
  // five texts of a disclosure: as the owner — who bypasses row security,
  // never a CHECK — a text with nothing visible is refused, and the same
  // text with real words between the spaces is accepted (the neighbour, so
  // the test can't pass on a CHECK that refuses everything). Each try is
  // rolled back.
  describe('the not-blank CHECKs (as the owner)', () => {
    let disclosureId: number
    beforeAll(async () => {
      disclosureId = (await makeDisclosure((await newPatient('Blank')).id)).id
    })

    it.each([
      [
        'legal_disclosures',
        'recipient_name',
        'id',
        'legal_disclosures_recipient_name_not_blank',
      ],
      [
        'legal_disclosures',
        'recipient_organisation',
        'id',
        'legal_disclosures_recipient_organisation_not_blank',
      ],
      [
        'legal_disclosure_orders',
        'order_reference',
        'disclosure_id',
        'legal_disclosure_orders_reference_not_blank',
      ],
      // %s.%s names the test from the first two values: table.column.
    ])('refuses a blank %s.%s', async (table, column, key, constraint) => {
      const update = `UPDATE ${table} SET ${column} = $2 WHERE ${key} = $1`
      for (const value of BLANK_VALUES) {
        expect(
          await asOwner(sessionPool, update, [disclosureId, value]),
        ).toEqual({ code: '23514', constraint })
      }
      expect(
        await asOwner(sessionPool, update, [disclosureId, ' \tJane Roe\n']),
      ).toEqual({ rowCount: 1 })
    })

    // The explanation exists only with the basis "other" (another CHECK,
    // explanation_with_other): the basis is set in the same UPDATE, so the
    // only rule a blank value can break is the not-blank one.
    it('refuses a blank basis_explanation', async () => {
      const update = `UPDATE legal_disclosure_details SET legal_basis = 'other', basis_explanation = $2 WHERE disclosure_id = $1`
      for (const value of BLANK_VALUES) {
        expect(
          await asOwner(sessionPool, update, [disclosureId, value]),
        ).toEqual({
          code: '23514',
          constraint: 'legal_disclosure_details_explanation_not_blank',
        })
      }
      expect(
        await asOwner(sessionPool, update, [disclosureId, ' A statute\n']),
      ).toEqual({ rowCount: 1 })
    })

    // The statement is free of other rules on this table (the hold's date
    // is compared by the INSERT policy, which an UPDATE by the owner skips).
    it('refuses a blank withholding_statement', async () => {
      const update = `UPDATE legal_disclosure_orders SET withholding_statement = $2 WHERE disclosure_id = $1`
      for (const value of BLANK_VALUES) {
        expect(
          await asOwner(sessionPool, update, [disclosureId, value]),
        ).toEqual({
          code: '23514',
          constraint: 'legal_disclosure_orders_statement_not_blank',
        })
      }
      expect(
        await asOwner(sessionPool, update, [disclosureId, ' Hold it\n']),
      ).toEqual({ rowCount: 1 })
    })
  })
})
