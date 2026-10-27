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
import {
  findLink,
  InMemoryEmailTransport,
} from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'
import { pdfText } from './support/pdf-text'
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { hashRecordsExportToken } from '../src/records-export/records-export-links.service'

// The records export, pass 2 (decisions §20): the EMAILED LINK, for a
// patient who can't sign in.
//   - POST /users/:id/records-export-links — an admin emails a link to the
//     patient's address (replacing the open one); GET lists them.
//   - POST /records-export/download — whoever opens the link types the
//     patient's date of birth; the right one downloads the record, ONCE,
//     within 72 hours; 5 wrong ones end the link.
// What these tests hold it to: only an admin sends, only to the address on
// file, only the newest link works, every send / copy / wrong date leaves
// its entry, concurrent requests can't spend a link twice or lose a
// failure — and the database keeps the same rules on its own (row security,
// the guard trigger). The PDF itself is pass 1's (records-export.e2e-spec).
describe('Records export links (e2e)', () => {
  let app: INestApplication
  let db: DrizzleDb
  let sessionPool: Pool
  let stamp: number
  let accountCounter = 0
  let clinicId: number
  let adminId: number
  let practitionerId: number
  const outbox = new InMemoryEmailTransport()

  type Agent = ReturnType<typeof request.agent>
  let admin: Agent
  let practitioner: Agent

  const DATE_OF_BIRTH = '1988-04-12'
  const SUBJECT = 'Your health record from Stride'
  const GUARD_MESSAGE = 'You do not have permission to access this resource'
  const WRONG_DATE = "This date of birth doesn't match the one on file."
  const LOCKED =
    'Too many wrong dates of birth: this link no longer works. Ask your clinic for a new one.'

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
      clinicName: 'Records Links E2E Clinic',
      clinicEmail: `clinic-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'RL',
      lastName: 'Admin',
    })
    if (clinicRes.status !== 201) {
      throw new Error(
        `Failed to bootstrap the founding admin: ${JSON.stringify(clinicRes.body)}`,
      )
    }
    clinicId = clinicRes.body.clinicId
    adminId = (await admin.get('/auth/me')).body.id

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
    practitionerId = res.body.id
    practitioner = await signIn(email)
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

  // A patient of the clinic. `signsIn`: the account gets a password (and a
  // signed-in agent); otherwise it is as created — invited, no password.
  async function newPatient(
    firstName: string,
    options: { signsIn?: boolean } = {},
  ) {
    const email = `pa-${++accountCounter}-${stamp}@example.com`
    const res = await admin.post('/users').send({
      email,
      role: 'patient',
      firstName,
      lastName: 'Linked',
      dateOfBirth: DATE_OF_BIRTH,
      clinicId,
    })
    expect(res.status).toBe(201)
    const id = res.body.id as number
    const agent = options.signsIn ? await signIn(email) : undefined
    return { id, email, agent }
  }

  // The records emails sent to an address (creating the account also sent
  // it an invitation).
  function recordsEmails(address: string) {
    return outbox.sentTo(address).filter((email) => email.subject === SUBJECT)
  }

  // Sends a link as the admin; answers the response and the token from the
  // email (as the patient would click it).
  async function sendLink(patient: { id: number; email: string }) {
    const res = await admin.post(`/users/${patient.id}/records-export-links`)
    expect(res.status).toBe(201)
    const token = findLink(
      outbox.lastSentTo(patient.email),
      '/records-download',
    ).searchParams.get('token')
    if (token === null) throw new Error('No token in the link')
    return { res, token, linkId: res.body.id as number }
  }

  // POST /records-export/download, the body kept as bytes (a PDF on
  // success). For a refusal, `refusal` is what the page reads: the status,
  // the message, and `reason` or `attemptsLeft` when there is one.
  async function download(body: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/records-export/download')
      .send(body)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => done(null, Buffer.concat(chunks)))
      })
    const bytes = res.body as Buffer
    let refusal: Record<string, unknown> | undefined
    if (/json/.test(String(res.headers['content-type']))) {
      const json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
      refusal = { status: res.status, message: json.message }
      if ('reason' in json) refusal.reason = json.reason
      if ('attemptsLeft' in json) refusal.attemptsLeft = json.attemptsLeft
    }
    return { status: res.status, headers: res.headers, bytes, refusal }
  }

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    entity_type: string
    entity_id: number | null
    details: Record<string, unknown> | null
  }

  // Every entry about this patient's exports and links, in order.
  async function entries(patientId: number): Promise<AuditRow[]> {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, entity_type,
              entity_id::int AS entity_id, details
       FROM audit_logs
       WHERE target_user_id = $1
         AND entity_type IN ('records_exports', 'records_export_links')
       ORDER BY id`,
      [patientId],
    )
    return rows
  }

  interface LinkRow {
    used: boolean
    replaced: boolean
    emailed: boolean
    dob_failures: number
  }

  async function linkRow(linkId: number): Promise<LinkRow> {
    const { rows } = await sessionPool.query<LinkRow>(
      `SELECT used_at IS NOT NULL AS used, replaced_at IS NOT NULL AS replaced,
              email_sent_at IS NOT NULL AS emailed, dob_failures
       FROM records_export_links WHERE id = $1`,
      [linkId],
    )
    return rows[0]
  }

  // Waits until another connection is BLOCKED on a lock in a statement
  // touching records_export_links — so a test knows its request has
  // reached the point it means to hold it at.
  async function waitForLockOnLinks(): Promise<void> {
    for (let tries = 0; tries < 100; tries++) {
      const { rows } = await sessionPool.query<{ count: string }>(
        `SELECT count(*) FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%records_export_links%'`,
      )
      if (Number(rows[0].count) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('No request ever waited on the link row')
  }

  // --- Sending ------------------------------------------------------------------

  it('emails a deactivated patient a link — and records where it went', async () => {
    const sam = await newPatient('Sam', { signsIn: true })
    expect((await admin.delete(`/users/${sam.id}`)).status).toBe(200)

    const { res, token, linkId } = await sendLink(sam)

    expect(res.body).toStrictEqual({
      id: linkId,
      status: 'open',
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      emailSentAt: expect.any(String),
      usedAt: null,
      replacedAt: null,
      dateOfBirthFailures: 0,
      sentBy: { id: adminId, firstName: 'RL', lastName: 'Admin' },
      emailSent: true,
    })
    // Exactly 72 hours, by the database's clock.
    const { rows } = await sessionPool.query<{ hours: string }>(
      `SELECT extract(epoch FROM expires_at - created_at) / 3600 AS hours
       FROM records_export_links WHERE id = $1`,
      [linkId],
    )
    expect(Number(rows[0].hours)).toBe(72)
    // The token's HASH is stored, never the token.
    const { rows: stored } = await sessionPool.query<{ token_hash: string }>(
      'SELECT token_hash FROM records_export_links WHERE id = $1',
      [linkId],
    )
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(stored[0].token_hash).toBe(hashRecordsExportToken(token))

    const emails = recordsEmails(sam.email)
    expect(emails).toHaveLength(1)
    expect(emails[0].text).toContain('Hello Sam,')
    expect(emails[0].text).toContain(
      'The link works once and expires in 72 hours; after 5 wrong dates of birth it stops working.',
    )
    // Deactivated: no "download it yourself" line — they can't sign in.
    expect(emails[0].text).not.toContain('My records')
    expect(emails[0].html).not.toContain('My records')

    expect(await entries(sam.id)).toStrictEqual([
      {
        action: 'RECORDS_EXPORT_LINK_SENT',
        performed_by: adminId,
        target_user_id: sam.id,
        entity_type: 'records_export_links',
        entity_id: linkId,
        details: {
          sentTo: sam.email,
          patientActive: false,
          expiresAt: res.body.expiresAt,
        },
      },
    ])
  })

  it('tells a patient who can sign in where to download it next time', async () => {
    const ivy = await newPatient('Ivy', { signsIn: true })

    await sendLink(ivy)

    const [email] = recordsEmails(ivy.email)
    expect(email.text).toContain(
      'You can also download a copy at any time, without asking, from My records once you sign in to Stride.',
    )
    expect(email.html).toContain(
      '<p>You can also download a copy at any time, without asking, from My records once you sign in to Stride.</p>',
    )
    expect((await entries(ivy.id))[0].details).toMatchObject({
      patientActive: true,
    })
  })

  // Active, but invited only — no password yet: can't sign in either.
  it("doesn't point a patient without a password to the app", async () => {
    const noa = await newPatient('Noa')

    await sendLink(noa)

    expect(recordsEmails(noa.email)[0].text).not.toContain('My records')
    expect((await entries(noa.id))[0].details).toMatchObject({
      patientActive: true,
    })
  })

  it('replaces the open link with a new one — only the newest works', async () => {
    const ari = await newPatient('Ari')
    const first = await sendLink(ari)
    const second = await sendLink(ari)

    const old = await download({
      token: first.token,
      dateOfBirth: DATE_OF_BIRTH,
    })
    expect(old.refusal).toStrictEqual({
      status: 410,
      message: [
        'This link was replaced by a newer one. Use the most recent email from your clinic.',
      ],
      reason: 'replaced',
    })

    const details = (await entries(ari.id)).map((entry) => entry.details)
    expect(details[0]).not.toHaveProperty('replacedLinkId')
    expect(details[1]).toHaveProperty('replacedLinkId', first.linkId)

    const list = await admin.get(`/users/${ari.id}/records-export-links`)
    expect(list.status).toBe(200)
    expect(
      (list.body as { id: number; status: string; replacedAt: unknown }[]).map(
        (link) => [link.id, link.status, link.replacedAt === null],
      ),
    ).toEqual([
      [second.linkId, 'open', true],
      [first.linkId, 'replaced', false],
    ])

    const current = await download({
      token: second.token,
      dateOfBirth: DATE_OF_BIRTH,
    })
    expect(current.status).toBe(200)
  })

  it('keeps the link when the email cannot be sent, and says so', async () => {
    const eli = await newPatient('Eli')
    outbox.failNext()

    const res = await admin.post(`/users/${eli.id}/records-export-links`)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ emailSent: false, emailSentAt: null })
    expect(recordsEmails(eli.email)).toHaveLength(0)
    expect(await linkRow(res.body.id as number)).toMatchObject({
      emailed: false,
      used: false,
    })
  })

  // Two sends at the same moment: the other one's new link is inserted but
  // not committed when this one inserts — the partial unique index makes
  // this one wait, then refuses it.
  it('turns two links sent at the same moment into a 409 for the second', async () => {
    const kai = await newPatient('Kai')
    const client = await sessionPool.connect()
    let res: request.Response
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO records_export_links (patient_id, token_hash, sent_by, expires_at)
         VALUES ($1, $2, $3, now() + interval '72 hours')`,
        [kai.id, 'f'.repeat(64), adminId],
      )
      const pending = admin
        .post(`/users/${kai.id}/records-export-links`)
        .then((answer) => answer)
      await waitForLockOnLinks()
      await client.query('COMMIT')
      res = await pending
    } finally {
      client.release()
    }

    expect([res.status, res.body.message]).toEqual([
      409,
      [
        'Another link for this patient was sent at the same moment. Refresh to see it.',
      ],
    ])
    expect(recordsEmails(kai.email)).toHaveLength(0)
    expect(await entries(kai.id)).toStrictEqual([])
  })

  it('refuses an unknown account and an account that is not a patient', async () => {
    const unknown = await admin.post('/users/999999/records-export-links')
    const staff = await admin.post(
      `/users/${practitionerId}/records-export-links`,
    )
    const unknownList = await admin.get('/users/999999/records-export-links')

    expect([unknown.status, unknown.body.message]).toEqual([
      404,
      ['User 999999 not found'],
    ])
    expect([staff.status, staff.body.message]).toEqual([
      400,
      ['Only a patient has a health record to send'],
    ])
    expect([unknownList.status, unknownList.body.message]).toEqual([
      404,
      ['User 999999 not found'],
    ])
    const { rows } = await sessionPool.query(
      'SELECT 1 FROM records_export_links WHERE patient_id IN (999999, $1)',
      [practitionerId],
    )
    expect(rows).toHaveLength(0)
  })

  it('lets only an admin send or list links', async () => {
    const lou = await newPatient('Lou', { signsIn: true })
    const path = `/users/${lou.id}/records-export-links`

    const answers = [
      await practitioner.post(path),
      await practitioner.get(path),
      await lou.agent!.post(path),
      await lou.agent!.get(path),
    ]
    const signedOut = await request(app.getHttpServer()).post(path)

    for (const answer of answers) {
      expect([answer.status, answer.body.message]).toEqual([
        403,
        [GUARD_MESSAGE],
      ])
    }
    expect(signedOut.status).toBe(401)
    expect(recordsEmails(lou.email)).toHaveLength(0)
  })

  // --- Downloading ----------------------------------------------------------------

  it('hands a deactivated patient their record for the right date of birth — once', async () => {
    const max = await newPatient('Max')
    expect(
      (await practitioner.post(`/users/${max.id}/care-team`).send({})).status,
    ).toBe(201)
    const note = await practitioner.post('/medical-files').send({
      patientId: max.id,
      entryType: 'progress_note',
      plan: 'Walk daily.',
    })
    expect(note.status).toBe(201)
    expect((await admin.delete(`/users/${max.id}`)).status).toBe(200)
    const { linkId, token } = await sendLink(max)

    const res = await download({
      token,
      dateOfBirth: DATE_OF_BIRTH,
      timeZone: 'Europe/Paris',
    })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="stride-health-record-\d{4}-\d{2}-\d{2}\.pdf"$/,
    )
    expect(res.headers['cache-control']).toBe('no-store')
    expect(Number(res.headers['content-length'])).toBe(res.bytes.length)
    expect(pdfText(res.bytes)).toEqual(
      expect.arrayContaining(['Max Linked', 'Walk daily.']),
    )
    expect(await linkRow(linkId)).toMatchObject({ used: true })

    const [, exported] = await entries(max.id)
    expect(exported).toStrictEqual({
      action: 'RECORDS_EXPORTED',
      performed_by: max.id,
      target_user_id: max.id,
      entity_type: 'records_exports',
      entity_id: null,
      details: {
        via: 'emailed_link',
        linkId,
        timeZone: 'Europe/Paris',
        medicalFileEntryIds: [note.body.id],
        programIds: [],
        sessionIds: [],
      },
    })

    // Once.
    const again = await download({ token, dateOfBirth: DATE_OF_BIRTH })
    expect(again.refusal).toStrictEqual({
      status: 410,
      message: [
        'This link has already been used. Ask your clinic for a new one if you need another copy.',
      ],
      reason: 'used',
    })
    expect(await entries(max.id)).toHaveLength(2)
  })

  it('counts wrong dates of birth, and ends the link at the fifth', async () => {
    const ren = await newPatient('Ren')
    const { linkId, token } = await sendLink(ren)

    for (const left of [4, 3, 2, 1]) {
      const wrong = await download({ token, dateOfBirth: '1988-12-04' })
      expect(wrong.refusal).toStrictEqual({
        status: 400,
        message: [WRONG_DATE],
        attemptsLeft: left,
      })
    }
    const fifth = await download({ token, dateOfBirth: '1988-12-04' })
    expect(fifth.refusal).toStrictEqual({
      status: 410,
      message: [LOCKED],
      reason: 'locked',
    })
    // Over: the right date no longer opens it.
    const right = await download({ token, dateOfBirth: DATE_OF_BIRTH })
    expect(right.refusal).toStrictEqual({
      status: 410,
      message: [LOCKED],
      reason: 'locked',
    })

    expect(await linkRow(linkId)).toMatchObject({
      dob_failures: 5,
      used: false,
    })
    expect(
      (await entries(ren.id))
        .slice(1)
        .map((entry) => [
          entry.action,
          entry.performed_by,
          entry.target_user_id,
          entry.entity_type,
          entry.entity_id,
          entry.details,
        ]),
    ).toEqual(
      [1, 2, 3, 4, 5].map((count) => [
        'RECORDS_EXPORT_LINK_REFUSED',
        ren.id,
        ren.id,
        'records_export_links',
        linkId,
        count === 5
          ? { wrongDatesOfBirth: 5, linkLocked: true }
          : { wrongDatesOfBirth: count },
      ]),
    )

    // The admin sees it, and a new link isn't held back by it: a locked
    // link is not open, so nothing is replaced.
    const list = await admin.get(`/users/${ren.id}/records-export-links`)
    expect(list.body[0]).toMatchObject({
      status: 'locked',
      dateOfBirthFailures: 5,
    })
    const fresh = await sendLink(ren)
    expect((await entries(ren.id)).at(-1)?.details).not.toHaveProperty(
      'replacedLinkId',
    )
    const works = await download({
      token: fresh.token,
      dateOfBirth: DATE_OF_BIRTH,
    })
    expect(works.status).toBe(200)
    // No zone sent: the copy is written in UTC.
    expect((await entries(ren.id)).at(-1)?.details).toMatchObject({
      via: 'emailed_link',
      linkId: fresh.linkId,
      timeZone: 'UTC',
    })
  })

  it('refuses an expired link before looking at the date — no try is spent', async () => {
    const tia = await newPatient('Tia')
    const { linkId, token } = await sendLink(tia)
    await sessionPool.query(
      `UPDATE records_export_links
       SET created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour'
       WHERE id = $1`,
      [linkId],
    )

    const wrong = await download({ token, dateOfBirth: '1990-01-01' })

    expect(wrong.refusal).toStrictEqual({
      status: 410,
      message: ['This link has expired. Ask your clinic for a new one.'],
      reason: 'expired',
    })
    expect(await linkRow(linkId)).toMatchObject({ dob_failures: 0 })
    const list = await admin.get(`/users/${tia.id}/records-export-links`)
    expect(list.body[0].status).toBe('expired')
  })

  it('answers a token that matches no link with a 404', async () => {
    const res = await download({
      token: 'a'.repeat(64),
      dateOfBirth: DATE_OF_BIRTH,
    })

    expect(res.refusal).toStrictEqual({
      status: 404,
      message: ['This download link is not valid'],
    })
  })

  it.each([
    [
      'a date with a time',
      { dateOfBirth: '1988-04-12T00:00:00Z' },
      ['dateOfBirth must be a date written as YYYY-MM-DD'],
    ],
    [
      'no token',
      { token: undefined },
      [
        'token must be shorter than or equal to 256 characters',
        'token must be a string',
      ],
    ],
    [
      'an unknown zone',
      { timeZone: 'Europe/Atlantis' },
      [
        'timeZone must be a time zone name, like Europe/Paris or America/Montreal',
      ],
    ],
    [
      'a field it does not know',
      { patientId: 1 },
      ['property patientId should not exist'],
    ],
  ])('refuses %s', async (_label, change, messages) => {
    const res = await download({
      token: 'b'.repeat(64),
      dateOfBirth: DATE_OF_BIRTH,
      ...change,
    })

    expect(res.refusal).toStrictEqual({ status: 400, message: messages })
  })

  // --- At the same moment ------------------------------------------------------------

  // REPEATABLE READ's price, paid: the download reads the link, then — while
  // another connection holds the row (here recording the email, as the
  // admin's send does right after its commit) — waits to spend it. That
  // change commits after the download's snapshot, so Postgres refuses the
  // spend (40001); the service runs the download again, from a fresh
  // snapshot, and it goes through.
  it('runs the download again when the link changed under it', async () => {
    const zoe = await newPatient('Zoe')
    const { linkId, token } = await sendLink(zoe)

    const client = await sessionPool.connect()
    let res: Awaited<ReturnType<typeof download>>
    try {
      await client.query('BEGIN')
      await client.query(
        'UPDATE records_export_links SET email_sent_at = now() WHERE id = $1',
        [linkId],
      )
      const pending = download({ token, dateOfBirth: DATE_OF_BIRTH })
      await waitForLockOnLinks()
      await client.query('COMMIT')
      res = await pending
    } finally {
      client.release()
    }

    expect(res.status).toBe(200)
    expect(await linkRow(linkId)).toMatchObject({ used: true })
    expect(
      (await entries(zoe.id)).filter(
        (entry) => entry.action === 'RECORDS_EXPORTED',
      ),
    ).toHaveLength(1)
  })

  // A link spent by ANOTHER TAB while this download waits to spend it: the
  // other tab committed after this one's snapshot, so the spend is refused
  // (40001); run again from a fresh snapshot, the download sees the link
  // used — a 410, not a second copy (and not the guard's 500, which is what
  // read committed would meet).
  it('tells a second tab the link has been used', async () => {
    const bea = await newPatient('Bea')
    const { linkId, token } = await sendLink(bea)

    const client = await sessionPool.connect()
    let res: Awaited<ReturnType<typeof download>>
    try {
      await client.query('BEGIN')
      await client.query(
        'UPDATE records_export_links SET used_at = now() WHERE id = $1',
        [linkId],
      )
      const pending = download({ token, dateOfBirth: DATE_OF_BIRTH })
      await waitForLockOnLinks()
      await client.query('COMMIT')
      res = await pending
    } finally {
      client.release()
    }

    expect(res.refusal).toMatchObject({ status: 410, reason: 'used' })
    expect((await entries(bea.id)).map((entry) => entry.action)).toEqual([
      'RECORDS_EXPORT_LINK_SENT',
    ])
  })

  // A wrong date of birth is counted AFTER its transaction rolled back — by
  // then the link may have ended (another tab spent it, a newer link
  // replaced it, tries made at the same moment locked it). The count waits
  // for that, finds nothing open, and says why.
  it.each([
    ['spent', 'used_at = now()', 'used'],
    ['replaced', 'replaced_at = now()', 'replaced'],
    ['locked', 'dob_failures = 5', 'locked'],
  ])(
    "doesn't count a wrong date on a link %s in the meantime",
    async (_label, change, reason) => {
      const ada = await newPatient('Ada')
      const { linkId, token } = await sendLink(ada)

      const client = await sessionPool.connect()
      let res: Awaited<ReturnType<typeof download>>
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE records_export_links SET ${change} WHERE id = $1`,
          [linkId],
        )
        const pending = download({ token, dateOfBirth: '1999-09-09' })
        await waitForLockOnLinks()
        await client.query('COMMIT')
        res = await pending
      } finally {
        client.release()
      }

      expect(res.refusal).toMatchObject({ status: 410, reason })
      expect((await entries(ada.id)).map((entry) => entry.action)).toEqual([
        'RECORDS_EXPORT_LINK_SENT',
      ])
    },
  )

  // --- The database's own rules ---------------------------------------------------------

  describe('row security and the guard (as the app role)', () => {
    type Actor = { userId?: number; role?: string; tokenHash?: string }

    class RolledBack extends Error {
      constructor(readonly rows: Record<string, unknown>[]) {
        super('rolled back on purpose')
      }
    }

    // Postgres's code and constraint, dug out of drizzle's wrapper (the pg
    // error is its `cause`) — as in invitations.e2e-spec.
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

    // As the app's role (row security applies), with `actor`'s settings, in
    // a transaction always rolled back: the rows of the statement, or the
    // database's refusal.
    async function run(
      actor: Actor,
      query: SQL,
    ): Promise<{
      rows?: Record<string, unknown>[]
      error?: ReturnType<typeof pgError>
    }> {
      try {
        await db.transaction(async (tx) => {
          if (actor.userId !== undefined && actor.role !== undefined) {
            await tx.execute(
              sql`SELECT set_config('app.current_user_id', ${String(actor.userId)}, true)`,
            )
            await tx.execute(
              sql`SELECT set_config('app.current_role', ${actor.role}, true)`,
            )
          }
          if (actor.tokenHash !== undefined) {
            await tx.execute(
              sql`SELECT set_config('app.records_export_token_hash', ${actor.tokenHash}, true)`,
            )
          }
          throw new RolledBack(
            (await tx.execute<Record<string, unknown>>(query)).rows,
          )
        })
      } catch (error) {
        if (error instanceof RolledBack) return { rows: error.rows }
        return { error: pgError(error) }
      }
      throw new Error('unreachable: run() always rolls back')
    }

    const asAdmin = (): Actor => ({ userId: adminId, role: 'admin' })
    const refusedByPolicy = { error: { code: '42501', constraint: undefined } }
    const guard = (constraint: string) => ({
      error: { code: '23514', constraint },
    })

    let patientId: number
    let linkId: number
    let tokenHash: string
    let otherLinkId: number

    beforeAll(async () => {
      const pat = await newPatient('Guarded', { signsIn: true })
      patientId = pat.id
      const sent = await sendLink(pat)
      linkId = sent.linkId
      tokenHash = hashRecordsExportToken(sent.token)
      otherLinkId = (await sendLink(await newPatient('Other'))).linkId
    })

    const asToken = (): Actor => ({ tokenHash })

    it('shows the links to an admin, one link to its token, none to anyone else', async () => {
      const ids = sql`SELECT id FROM records_export_links
                      WHERE id IN (${linkId}, ${otherLinkId}) ORDER BY id`

      expect(await run(asAdmin(), ids)).toStrictEqual({
        rows: [{ id: linkId }, { id: otherLinkId }],
      })
      expect(await run(asToken(), ids)).toStrictEqual({
        rows: [{ id: linkId }],
      })
      expect(
        await run({ userId: practitionerId, role: 'practitioner' }, ids),
      ).toStrictEqual({ rows: [] })
      expect(
        await run({ userId: patientId, role: 'patient' }, ids),
      ).toStrictEqual({ rows: [] })
    })

    it('lets only an admin insert a link, recorded as its sender', async () => {
      const insert = (sentBy: number) =>
        sql`INSERT INTO records_export_links (patient_id, token_hash, sent_by, expires_at)
            VALUES (${patientId}, ${'c'.repeat(64)}, ${sentBy}, now() + interval '1 hour')`

      expect(
        await run(
          { userId: practitionerId, role: 'practitioner' },
          insert(practitionerId),
        ),
      ).toStrictEqual(refusedByPolicy)
      // An admin naming someone else as the sender.
      expect(await run(asAdmin(), insert(practitionerId))).toStrictEqual(
        refusedByPolicy,
      )
      // A token can use a link, never create one.
      expect(await run(asToken(), insert(adminId))).toStrictEqual(
        refusedByPolicy,
      )
    })

    it('stamps a new link with the database moment, and refuses one born closed', async () => {
      const patient = await newPatient('Fresh')
      const insert = (columns: SQL, values: SQL) =>
        sql`INSERT INTO records_export_links (patient_id, token_hash, sent_by, expires_at ${columns})
            VALUES (${patient.id}, ${'d'.repeat(64)}, ${adminId}, now() + interval '1 hour' ${values})
            RETURNING created_at = now() AS stamped`

      expect(
        await run(
          asAdmin(),
          insert(sql`, created_at`, sql`, now() - interval '1 day'`),
        ),
      ).toStrictEqual({ rows: [{ stamped: true }] })
      for (const [column, value] of [
        [sql`, used_at`, sql`, now()`],
        [sql`, replaced_at`, sql`, now()`],
        [sql`, email_sent_at`, sql`, now()`],
        [sql`, dob_failures`, sql`, 1`],
      ]) {
        expect(await run(asAdmin(), insert(column, value))).toStrictEqual(
          guard('records_export_link_starts_open'),
        )
      }
    })

    it('keeps what a link is fixed', async () => {
      for (const change of [
        sql`token_hash = ${'e'.repeat(64)}`,
        sql`patient_id = ${practitionerId}`,
        sql`sent_by = ${practitionerId}`,
        sql`expires_at = expires_at + interval '1 day'`,
        sql`created_at = created_at - interval '1 hour'`,
      ]) {
        expect(
          await run(
            asAdmin(),
            sql`UPDATE records_export_links SET ${change} WHERE id = ${linkId}`,
          ),
        ).toStrictEqual(guard('records_export_link_fixed'))
      }
    })

    it('records the email once, at the database moment', async () => {
      // The link was emailed by the send: a second time is refused…
      expect(
        await run(
          asAdmin(),
          sql`UPDATE records_export_links SET email_sent_at = now() WHERE id = ${linkId}`,
        ),
      ).toStrictEqual(guard('records_export_link_emailed_once'))
      // …so is taking it back.
      expect(
        await run(
          asAdmin(),
          sql`UPDATE records_export_links SET email_sent_at = NULL WHERE id = ${linkId}`,
        ),
      ).toStrictEqual(guard('records_export_link_emailed_once'))
      // A link whose email failed: recorded, with the database's moment
      // whatever the client sends.
      const patient = await newPatient('Unmailed')
      outbox.failNext()
      const unmailed = await admin.post(
        `/users/${patient.id}/records-export-links`,
      )
      expect(
        await run(
          asAdmin(),
          sql`UPDATE records_export_links SET email_sent_at = now() - interval '1 day'
              WHERE id = ${unmailed.body.id as number}
              RETURNING email_sent_at = now() AS stamped`,
        ),
      ).toStrictEqual({ rows: [{ stamped: true }] })
      // Even on a link already CLOSED: the email goes out after the send's
      // commit, and a newer link (or the patient, quick on the link) may
      // have closed this one in between.
      const quick = await newPatient('Quick')
      outbox.failNext()
      const spent = await admin.post(`/users/${quick.id}/records-export-links`)
      await sessionPool.query(
        'UPDATE records_export_links SET used_at = now() WHERE id = $1',
        [spent.body.id],
      )
      expect(
        await run(
          asAdmin(),
          sql`UPDATE records_export_links SET email_sent_at = now()
              WHERE id = ${spent.body.id as number}
              RETURNING email_sent_at IS NOT NULL AS emailed`,
        ),
      ).toStrictEqual({ rows: [{ emailed: true }] })
    })

    it('counts a wrong date of birth one at a time, through the link only', async () => {
      const count = (by: SQL) =>
        sql`UPDATE records_export_links SET dob_failures = dob_failures + ${by}
            WHERE id = ${linkId} RETURNING dob_failures`

      expect(await run(asToken(), count(sql`1`))).toStrictEqual({
        rows: [{ dob_failures: 1 }],
      })
      expect(await run(asToken(), count(sql`2`))).toStrictEqual(
        guard('records_export_link_failure_counted'),
      )
      expect(await run(asToken(), count(sql`-1`))).toStrictEqual(
        guard('records_export_link_failure_counted'),
      )
      expect(await run(asAdmin(), count(sql`1`))).toStrictEqual(
        guard('records_export_link_failure_counted'),
      )
    })

    it('spends a link only through it, before it expires, at the database moment', async () => {
      const spend = sql`UPDATE records_export_links SET used_at = now() - interval '1 day'
                        WHERE id = ${linkId} RETURNING used_at = now() AS stamped`

      expect(await run(asToken(), spend)).toStrictEqual({
        rows: [{ stamped: true }],
      })
      expect(await run(asAdmin(), spend)).toStrictEqual(
        guard('records_export_link_used_by_link'),
      )

      const patient = await newPatient('Late')
      const late = await sendLink(patient)
      await sessionPool.query(
        `UPDATE records_export_links
         SET created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour'
         WHERE id = $1`,
        [late.linkId],
      )
      expect(
        await run(
          { tokenHash: hashRecordsExportToken(late.token) },
          sql`UPDATE records_export_links SET used_at = now() WHERE id = ${late.linkId}`,
        ),
      ).toStrictEqual(guard('records_export_link_not_expired'))
    })

    it('lets only an admin replace a link, at the database moment', async () => {
      const replace = sql`UPDATE records_export_links SET replaced_at = now() - interval '1 day'
                          WHERE id = ${linkId} RETURNING replaced_at = now() AS stamped`

      expect(await run(asAdmin(), replace)).toStrictEqual({
        rows: [{ stamped: true }],
      })
      expect(await run(asToken(), replace)).toStrictEqual(
        guard('records_export_link_replaced_by_admin'),
      )
    })

    it('keeps a closed link closed — used, or locked', async () => {
      const patient = await newPatient('Closed')
      const used = await sendLink(patient)
      expect(
        (await download({ token: used.token, dateOfBirth: DATE_OF_BIRTH }))
          .status,
      ).toBe(200)

      expect(
        await run(
          asAdmin(),
          sql`UPDATE records_export_links SET replaced_at = now() WHERE id = ${used.linkId}`,
        ),
      ).toStrictEqual(guard('records_export_link_closed'))
      expect(
        await run(
          asAdmin(),
          sql`UPDATE records_export_links SET used_at = NULL WHERE id = ${used.linkId}`,
        ),
      ).toStrictEqual(guard('records_export_link_closed'))

      // Locked by five wrong dates (planted by the owner): the link itself
      // can no longer be spent.
      const lockedPatient = await newPatient('Locked')
      const locked = await sendLink(lockedPatient)
      await sessionPool.query(
        'UPDATE records_export_links SET dob_failures = 5 WHERE id = $1',
        [locked.linkId],
      )
      expect(
        await run(
          { tokenHash: hashRecordsExportToken(locked.token) },
          sql`UPDATE records_export_links SET used_at = now() WHERE id = ${locked.linkId}`,
        ),
      ).toStrictEqual(guard('records_export_link_closed'))
    })

    it('lets no one but an admin or the token holder change a link', async () => {
      const touch = sql`UPDATE records_export_links SET email_sent_at = now()
                        WHERE id = ${otherLinkId} RETURNING id`

      expect(
        await run({ userId: practitionerId, role: 'practitioner' }, touch),
      ).toStrictEqual({ rows: [] })
      expect(
        await run({ userId: patientId, role: 'patient' }, touch),
      ).toStrictEqual({ rows: [] })
      // Another link's token reaches only its own link.
      expect(await run(asToken(), touch)).toStrictEqual({ rows: [] })
    })

    it('never deletes a link', async () => {
      expect(
        await run(
          asAdmin(),
          sql`DELETE FROM records_export_links WHERE id = ${linkId} RETURNING id`,
        ),
      ).toStrictEqual({ rows: [] })
    })
  })
})
