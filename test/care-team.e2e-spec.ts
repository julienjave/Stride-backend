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
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'
import { CareTeamService } from '../src/care-team/care-team.service'

// The care team as the access rule (design decisions §3), tested against the
// real database — where the SQL half of the rule actually runs.
//
// The cast, all created by the admin (so NOBODY starts on a care team —
// a practitioner who creates a patient would be linked automatically):
//
//   clinic X: practitionerA, practitionerB, patient1
//   clinic Y: practitionerC, patient2
//
// practitionerA and practitionerB share a clinic with patient1: under the
// OLD rule both "managed" patient1. Under the new one, neither does until
// they join the care team. That's the case this file exists for:
// SAME CLINIC, NOT ON THE CARE TEAM → no clinical data.
describe('Care team (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool
  let db: DrizzleDb
  let careTeamService: CareTeamService

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitionerA: ReturnType<typeof agent>
  let practitionerB: ReturnType<typeof agent>
  let practitionerC: ReturnType<typeof agent>
  let patient1: ReturnType<typeof agent>

  let adminId: number
  let clinicXId: number
  let practitionerAId: number
  let practitionerBId: number
  let practitionerCId: number
  let patient1Id: number
  let patient2Id: number
  let exerciseId: number

  // Runs `query` as the app's database role (stride_app — RLS applies to it,
  // as in the running app) with the session context of `userId` acting as
  // `role`, exactly like withRlsContext() does for a request. What it
  // returns is what Postgres's policies let that person see.
  async function asUser<T extends Record<string, unknown>>(
    userId: number,
    role: string,
    query: SQL,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_user_id', ${String(userId)}, true)`,
      )
      await tx.execute(
        sql`SELECT set_config('app.current_role', ${role}, true)`,
      )
      return (await tx.execute<T>(query)).rows
    })
  }

  // Creates a user through the API (as the admin), activates the account
  // (test/support/accounts.ts — as if the invitation were accepted), and
  // logs them in on `who`.
  async function createUser(
    who: ReturnType<typeof agent>,
    fields: Record<string, unknown>,
  ) {
    const res = await admin.post('/users').send(fields)
    expect(res.status).toBe(201)
    await activateAccount(sessionPool, fields.email as string)
    await who
      .post('/auth/login')
      .send({ email: fields.email, password: 'password123' })
    return res.body.id as number
  }

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

    db = app.get<DrizzleDb>(DRIZZLE)
    careTeamService = app.get(CareTeamService)

    // Refuse to run anywhere but the test database (see users.e2e-spec.ts).
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    )
    if (rows[0].current_database !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${rows[0].current_database}" — expected "stride_test".`,
      )
    }
    // CASCADE also empties care_team_members (it references users).
    await sessionPool.query(
      'TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE',
    )

    admin = agent()
    practitionerA = agent()
    practitionerB = agent()
    practitionerC = agent()
    patient1 = agent()
    const patient2 = agent()
    const stamp = Date.now()

    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Care Team Clinic X',
      clinicEmail: `ct-x-${stamp}@example.com`,
      email: `ct-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Care',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    clinicXId = bootstrap.body.clinicId
    adminId = (await admin.get('/auth/me')).body.id

    const clinicY = await admin
      .post('/clinics')
      .send({ name: 'Care Team Clinic Y', email: `ct-y-${stamp}@example.com` })
    expect(clinicY.status).toBe(201)

    practitionerAId = await createUser(practitionerA, {
      email: `ct-pa-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Alice',
      lastName: 'Practitioner',
      licenseNumber: `CT-A-${stamp}`,
      clinicId: clinicXId,
    })
    practitionerBId = await createUser(practitionerB, {
      email: `ct-pb-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Bob',
      lastName: 'Practitioner',
      licenseNumber: `CT-B-${stamp}`,
      clinicId: clinicXId,
    })
    practitionerCId = await createUser(practitionerC, {
      email: `ct-pc-${stamp}@example.com`,
      role: 'practitioner',
      firstName: 'Carol',
      lastName: 'Practitioner',
      licenseNumber: `CT-C-${stamp}`,
      clinicId: clinicY.body.id,
    })
    patient1Id = await createUser(patient1, {
      email: `ct-patient1-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Marie',
      lastName: 'Martin',
      dateOfBirth: '1985-04-12',
      phone: '555-0100',
      clinicId: clinicXId,
    })
    patient2Id = await createUser(patient2, {
      email: `ct-patient2-${stamp}@example.com`,
      role: 'patient',
      firstName: 'Paul',
      lastName: 'Other',
      dateOfBirth: '1990-01-01',
      clinicId: clinicY.body.id,
    })

    // One medical file for patient1, inserted directly (as the owner, which
    // bypasses RLS): the database-level checks below need a clinical row to
    // be (in)visible.
    await sessionPool.query(
      'INSERT INTO medical_files (patient_id, created_by) VALUES ($1, $2)',
      [patient1Id, adminId],
    )

    const exercise = await practitionerA.post('/exercises').send({
      name: 'Care Team Squat',
      primaryMuscles: ['legs'],
      instructions: ['Step one'],
    })
    expect(exercise.status).toBe(201)
    exerciseId = exercise.body.id
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // The tests below run IN ORDER and build on each other: first nobody is
  // on patient1's care team, then practitionerA joins, adds a colleague,
  // leaves, and so on — the life of a real care team.

  describe('before anyone joins: same clinic is NOT enough', () => {
    it('refuses a same-clinic practitioner every clinical endpoint', async () => {
      const profile = await practitionerA.get(`/users/${patient1Id}`)
      expect(profile.status).toBe(403)

      const edit = await practitionerA
        .patch(`/users/${patient1Id}`)
        .send({ firstName: 'Nope' })
      expect(edit.status).toBe(403)

      const files = await practitionerA.get(
        `/medical-files?patientId=${patient1Id}`,
      )
      expect(files.status).toBe(403)

      const newFile = await practitionerA
        .post('/medical-files')
        .send({ patientId: patient1Id, clinicalData: { note: 'x' } })
      expect(newFile.status).toBe(403)

      const conversation = await practitionerA
        .post('/conversations')
        .send({ userId: patient1Id })
      expect(conversation.status).toBe(403)

      const program = await practitionerA.post('/assigned-programs').send({
        patientId: patient1Id,
        title: 'Knee rehab',
        startDate: '2026-10-01',
        schedule: { type: 'times_per_week', timesPerWeek: 3 },
        exercises: [{ exerciseId, sortOrder: 0 }],
      })
      expect(program.status).toBe(403)
    })

    it('leaves the patient out of "my patients"', async () => {
      const list = await practitionerA.get('/users')
      expect(list.status).toBe(200)
      expect(list.body.map((u: { id: number }) => u.id)).not.toContain(
        patient1Id,
      )
    })

    // RLS is the second line of defence: even a query that forgot the
    // service-level check can't read the rows.
    it('hides the clinical rows at the database level too', async () => {
      const rows = await asUser<{ count: string }>(
        practitionerAId,
        'practitioner',
        sql`SELECT count(*) FROM medical_files WHERE patient_id = ${patient1Id}`,
      )
      expect(rows[0].count).toBe('0')

      // …while the admin session (as a control) does see it: the row is there.
      const asAdmin = await asUser<{ count: string }>(
        adminId,
        'admin',
        sql`SELECT count(*) FROM medical_files WHERE patient_id = ${patient1Id}`,
      )
      expect(asAdmin[0].count).toBe('1')
    })
  })

  describe('the clinic directory (directory level)', () => {
    it("lists the practitioner's clinic patients, with directory data only", async () => {
      const res = await practitionerA.get('/directory/patients')
      expect(res.status).toBe(200)
      // patient1 (clinic X); not patient2 (clinic Y).
      expect(res.body).toEqual([
        {
          id: patient1Id,
          firstName: 'Marie',
          lastName: 'Martin',
          avatarUrl: null,
          dateOfBirth: '1985-04-12',
          sharedClinics: [{ id: clinicXId, name: 'Care Team Clinic X' }],
          onMyCareTeam: false,
        },
      ])
      // Nothing clinical, no contact details: the full toEqual above
      // already guarantees it (no email, phone, address…).
    })

    it('searches by first name, last name, or both', async () => {
      for (const search of ['mar', 'MARTIN', 'Marie Mar']) {
        const res = await practitionerA.get(
          `/directory/patients?search=${encodeURIComponent(search)}`,
        )
        expect(res.body.map((p: { id: number }) => p.id)).toEqual([patient1Id])
      }
      const none = await practitionerA.get('/directory/patients?search=zzz')
      expect(none.body).toEqual([])
    })

    it('treats LIKE wildcards in a search literally', async () => {
      const res = await practitionerA.get(
        `/directory/patients?search=${encodeURIComponent('%')}`,
      )
      expect(res.body).toEqual([])
    })

    it('is for practitioners only', async () => {
      expect((await patient1.get('/directory/patients')).status).toBe(403)
      expect((await admin.get('/directory/patients')).status).toBe(403)
    })
  })

  // "Add a colleague" (2026-10-09): who COULD be added. Placed before
  // anyone joins patient1's team, so every candidate starts "not on it".
  describe('care-team candidates', () => {
    it("lists the practitioners of the patient's clinics — directory fields only — and nobody else", async () => {
      const res = await practitionerA.get(`/users/${patient1Id}/care-team/candidates`)
      expect(res.status).toBe(200)
      // Alice and Bob work at clinic X (patient1's); Carol, at Y, is not a
      // candidate. Ordered by last name, then first name.
      expect(res.body.map((c: { id: number }) => c.id)).toEqual([
        practitionerAId,
        practitionerBId,
      ])
      // Exactly these fields — no email, phone or license number
      // (toStrictEqual fails on any extra key).
      expect(res.body[0]).toStrictEqual({
        id: practitionerAId,
        firstName: 'Alice',
        lastName: 'Practitioner',
        avatarUrl: null,
        specialties: [],
        sharedClinics: [{ id: clinicXId, name: 'Care Team Clinic X' }],
        onCareTeam: false,
      })
    })

    it("follows the PATIENT's clinics, not the caller's: a patient in two clinics brings in the other clinic's practitioners", async () => {
      const clinicYId = (await admin.get(`/users/${patient2Id}`)).body.clinics[0].id
      const created = await admin.post('/users').send({
        email: `ct-patient3-${Date.now()}@example.com`,
        role: 'patient',
        firstName: 'Robin',
        lastName: 'Both',
        dateOfBirth: '1992-01-05',
        clinicId: clinicXId,
      })
      expect(created.status).toBe(201)
      const patient3Id = created.body.id
      expect(
        (await admin.post(`/clinics/${clinicYId}/members`).send({ userId: patient3Id })).status,
      ).toBe(201)

      // Alice works at X only — and still sees Carol (Y), since patient3
      // attends both.
      const res = await practitionerA.get(`/users/${patient3Id}/care-team/candidates`)
      expect(res.status).toBe(200)
      const carol = res.body.find((c: { id: number }) => c.id === practitionerCId)
      expect(carol.sharedClinics).toEqual([{ id: clinicYId, name: 'Care Team Clinic Y' }])
      expect(res.body.map((c: { id: number }) => c.id).sort()).toEqual(
        [practitionerAId, practitionerBId, practitionerCId].sort(),
      )
      // And adding her is accepted: the rule checks the ADDED practitioner
      // against the patient, not against the one adding.
      const add = await practitionerA
        .post(`/users/${patient3Id}/care-team`)
        .send({ practitionerId: practitionerCId })
      expect(add.status).toBe(201)
      const after = await practitionerA.get(`/users/${patient3Id}/care-team/candidates`)
      expect(after.body.find((c: { id: number }) => c.id === practitionerCId).onCareTeam).toBe(true)

      // "On the team" means a CURRENT link: once ended (here by an admin, who
      // may end anyone's), Carol is a candidate again.
      expect(
        (await admin.post(`/users/${patient3Id}/care-team/${practitionerCId}/end`)).status,
      ).toBe(201)
      const ended = await practitionerA.get(`/users/${patient3Id}/care-team/candidates`)
      expect(ended.body.find((c: { id: number }) => c.id === practitionerCId).onCareTeam).toBe(false)
    })

    it("leaves out deactivated practitioners, and names only the clinics a practitioner shares WITH THE PATIENT", async () => {
      const stamp = Date.now()
      const clinicYId = (await admin.get(`/users/${patient2Id}`)).body.clinics[0].id
      // Dan works at X and Y; patient1 attends X only.
      const dan = await admin.post('/users').send({
        email: `ct-pd-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Dan',
        lastName: 'Twoclinics',
        licenseNumber: `CT-D-${stamp}`,
        clinicId: clinicXId,
      })
      expect(dan.status).toBe(201)
      await admin.post(`/clinics/${clinicYId}/members`).send({ userId: dan.body.id })
      // Eve works at X, but her account is deactivated.
      const eve = await admin.post('/users').send({
        email: `ct-pe-${stamp}@example.com`,
        role: 'practitioner',
        firstName: 'Eve',
        lastName: 'Gone',
        licenseNumber: `CT-E-${stamp}`,
        clinicId: clinicXId,
      })
      expect(eve.status).toBe(201)
      expect((await admin.delete(`/users/${eve.body.id}`)).status).toBe(200)

      const res = await practitionerA.get(`/users/${patient1Id}/care-team/candidates`)
      const ids = res.body.map((c: { id: number }) => c.id)
      expect(ids).toContain(dan.body.id)
      expect(ids).not.toContain(eve.body.id)
      expect(
        res.body.find((c: { id: number }) => c.id === dan.body.id).sharedClinics,
      ).toEqual([{ id: clinicXId, name: 'Care Team Clinic X' }])
    })

    it('is for an admin or a practitioner sharing a clinic with the patient — not another clinic, not the patient (403)', async () => {
      expect((await admin.get(`/users/${patient1Id}/care-team/candidates`)).status).toBe(200)
      for (const who of [practitionerC, patient1]) {
        const res = await who.get(`/users/${patient1Id}/care-team/candidates`)
        expect(res.status).toBe(403)
        expect(res.body.message).toEqual([
          "You can't add anyone to this patient's care team",
        ])
      }
    })

    it('404s for someone who is not a patient', async () => {
      const res = await admin.get(`/users/${practitionerAId}/care-team/candidates`)
      expect(res.status).toBe(404)
    })
  })

  describe('joining', () => {
    it('lets a same-clinic practitioner join, with no approval (break-glass)', async () => {
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team`)
        .send({ reason: 'First assessment' })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        patientId: patient1Id,
        practitioner: {
          id: practitionerAId,
          firstName: 'Alice',
          lastName: 'Practitioner',
          avatarUrl: null,
        },
        endsAt: null,
        isActive: true,
        reason: 'First assessment',
        createdBy: {
          id: practitionerAId,
          firstName: 'Alice',
          lastName: 'Practitioner',
        },
        endedBy: null,
      })

      // Accountability: the join is in the audit log.
      const { rows } = await sessionPool.query(
        `SELECT performed_by, action, target_user_id, details
           FROM audit_logs WHERE action = 'CARE_TEAM_JOINED'`,
      )
      expect(rows).toEqual([
        {
          performed_by: practitionerAId,
          action: 'CARE_TEAM_JOINED',
          target_user_id: patient1Id,
          details: {
            practitionerId: practitionerAId,
            endsAt: null,
            reason: 'First assessment',
          },
        },
      ])
    })

    it('opens the clinical data to them — API and database', async () => {
      expect((await practitionerA.get(`/users/${patient1Id}`)).status).toBe(200)
      expect(
        (await practitionerA.get(`/medical-files?patientId=${patient1Id}`))
          .status,
      ).toBe(200)
      const list = await practitionerA.get('/users')
      expect(list.body.map((u: { id: number }) => u.id)).toEqual([patient1Id])

      const rows = await asUser<{ count: string }>(
        practitionerAId,
        'practitioner',
        sql`SELECT count(*) FROM medical_files WHERE patient_id = ${patient1Id}`,
      )
      expect(rows[0].count).toBe('1')

      // Found by id, not by position: other tests add patients to clinic X
      // (the candidates tests' patient3 sorts before "Martin").
      const directory = await practitionerA.get('/directory/patients')
      expect(
        directory.body.find((p: { id: number }) => p.id === patient1Id).onMyCareTeam,
      ).toBe(true)
    })

    it('gives a 409 to a second join for the same period', async () => {
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team`)
        .send({})
      expect(res.status).toBe(409)
    })

    it('refuses a practitioner from another clinic (403)', async () => {
      const res = await practitionerC
        .post(`/users/${patient1Id}/care-team`)
        .send({})
      expect(res.status).toBe(403)
    })

    it("refuses adding a colleague who doesn't work at the patient's clinic (400)", async () => {
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team`)
        .send({ practitionerId: practitionerCId })
      expect(res.status).toBe(400)
    })

    it('refuses a planned end in the past (400), and a patient joining anything (403)', async () => {
      const past = await practitionerB
        .post(`/users/${patient1Id}/care-team`)
        .send({ endsAt: '2020-01-01T00:00:00Z' })
      expect(past.status).toBe(400)

      const byPatient = await patient1
        .post(`/users/${patient1Id}/care-team`)
        .send({ practitionerId: practitionerAId })
      expect(byPatient.status).toBe(403)
    })

    it('adds a colleague as planned cover: active now, with its end date', async () => {
      const endsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team`)
        .send({
          practitionerId: practitionerBId,
          endsAt,
          reason: 'Holiday cover',
        })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        practitioner: { id: practitionerBId },
        endsAt,
        isActive: true,
        createdBy: { id: practitionerAId },
      })
      expect((await practitionerB.get(`/users/${patient1Id}`)).status).toBe(200)
    })
  })

  describe('seeing the care team', () => {
    it('shows the team to the patient, the admin, and a same-clinic practitioner', async () => {
      for (const who of [patient1, admin, practitionerA]) {
        const res = await who.get(`/users/${patient1Id}/care-team`)
        expect(res.status).toBe(200)
        expect(
          res.body
            .map((e: { practitioner: { id: number } }) => e.practitioner.id)
            .sort(),
        ).toEqual([practitionerAId, practitionerBId].sort())
      }
    })

    it('hides it from a practitioner of another clinic', async () => {
      expect(
        (await practitionerC.get(`/users/${patient1Id}/care-team`)).status,
      ).toBe(403)
    })

    it('404s for someone who is not a patient', async () => {
      expect(
        (await admin.get(`/users/${practitionerAId}/care-team`)).status,
      ).toBe(404)
    })
  })

  describe('ending a membership', () => {
    it("refuses ending someone else's membership (403)", async () => {
      const res = await practitionerB
        .post(`/users/${patient1Id}/care-team/${practitionerAId}/end`)
        .send()
      expect(res.status).toBe(403)
    })

    it('ends their own: the history keeps it, marked as ended — and access is gone', async () => {
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team/${practitionerAId}/end`)
        .send()
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        isActive: false,
        endedBy: { id: practitionerAId },
      })
      expect(res.body.endsAt).not.toBeNull()

      expect((await practitionerA.get(`/users/${patient1Id}`)).status).toBe(403)

      // The patient sees only current members by default…
      const current = await patient1.get(`/users/${patient1Id}/care-team`)
      expect(
        current.body.map(
          (e: { practitioner: { id: number } }) => e.practitioner.id,
        ),
      ).toEqual([practitionerBId])
      // …and the ended one too when asking for the history, marked inactive.
      const history = await patient1.get(
        `/users/${patient1Id}/care-team?includeEnded=true`,
      )
      expect(
        history.body.map(
          (e: { practitioner: { id: number }; isActive: boolean }) => [
            e.practitioner.id,
            e.isActive,
          ],
        ),
      ).toEqual([
        [practitionerBId, true],
        [practitionerAId, false],
      ])
    })

    it('404s when there is nothing active left to end', async () => {
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team/${practitionerAId}/end`)
        .send()
      expect(res.status).toBe(404)
    })

    it('lets them join again later (a new period, not an overlap)', async () => {
      const res = await practitionerA
        .post(`/users/${patient1Id}/care-team`)
        .send({})
      expect(res.status).toBe(201)
      expect((await practitionerA.get(`/users/${patient1Id}`)).status).toBe(200)
    })
  })

  describe('leaving the clinic', () => {
    it("ends the practitioner's links there, and their access", async () => {
      const res = await admin.delete(
        `/clinics/${clinicXId}/members/${practitionerBId}`,
      )
      expect(res.status).toBe(200)

      expect((await practitionerB.get(`/users/${patient1Id}`)).status).toBe(403)
      const history = await admin.get(
        `/users/${patient1Id}/care-team?includeEnded=true`,
      )
      const bobs = history.body.filter(
        (e: { practitioner: { id: number } }) =>
          e.practitioner.id === practitionerBId,
      )
      expect(bobs).toHaveLength(1)
      expect(bobs[0]).toMatchObject({
        isActive: false,
        endedBy: { id: adminId },
      })
    })
  })

  describe('the database itself', () => {
    it('never deletes a link — even for an admin, a DELETE affects no rows', async () => {
      const before = await sessionPool.query<{ count: string }>(
        'SELECT count(*) FROM care_team_members',
      )
      await asUser(adminId, 'admin', sql`DELETE FROM care_team_members`)
      const after = await sessionPool.query<{ count: string }>(
        'SELECT count(*) FROM care_team_members',
      )
      expect(after.rows[0].count).toBe(before.rows[0].count)
      expect(Number(after.rows[0].count)).toBeGreaterThan(0)
    })

    // The insert policy records the real creator: a practitioner can't
    // write a link "created by" someone else (e.g. to hide who joined).
    it('refuses a link recorded as created by someone else', async () => {
      await expect(
        asUser(
          practitionerCId,
          'practitioner',
          sql`INSERT INTO care_team_members (patient_id, practitioner_id, created_by)
              VALUES (${patient2Id}, ${practitionerCId}, ${adminId})`,
        ),
      ).rejects.toMatchObject({
        // Drizzle wraps the driver's error (see src/database/pg-errors.ts);
        // the real one is in `cause`. 42501 = insufficient_privilege, the
        // SQLSTATE of a row-level security refusal.
        cause: expect.objectContaining({
          code: '42501',
          message: expect.stringMatching(/row-level security/),
        }),
      })
    })

    // The rule exists twice: CareTeamService.isOnCareTeam() (TypeScript,
    // behind every service check) and rls_care_team_member() (SQL, behind
    // every RLS policy). This asks both the same questions and requires the
    // same answers — so the two can never drift apart unnoticed.
    it('gives the same answer in TypeScript and in SQL, in every situation', async () => {
      // One more situation: a cover period that has already ended (set in
      // the past directly — the API only accepts future end dates).
      await sessionPool.query(
        `INSERT INTO care_team_members (patient_id, practitioner_id, created_by, started_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '1 day')`,
        [patient2Id, practitionerCId, adminId],
      )

      // And the case the shared-clinic half of the rule exists for: a link
      // still OPEN, but the two no longer share any clinic (possible with
      // data that predates the automatic ending in removeMember, or edited
      // by hand). Without this row, every "no shared clinic" situation above
      // also has an ended link, and a rule that forgot the clinic check
      // would still pass — a mutation check found exactly that gap.
      await sessionPool.query(
        `INSERT INTO care_team_members (patient_id, practitioner_id, created_by)
         VALUES ($1, $2, $3)`,
        [patient1Id, practitionerCId, adminId],
      )

      const situations: [string, number, number, boolean][] = [
        ['open link, but no shared clinic', practitionerCId, patient1Id, false],
        ['active link, shared clinic', practitionerAId, patient1Id, true],
        [
          'link ended when leaving the clinic',
          practitionerBId,
          patient1Id,
          false,
        ],
        ['cover that already ended', practitionerCId, patient2Id, false],
        ['never linked, same clinic', practitionerAId, patient2Id, false],
      ]
      for (const [label, practitionerId, patientId, expected] of situations) {
        const inTypeScript = await careTeamService.isOnCareTeam(
          practitionerId,
          patientId,
        )
        const [inSql] = await asUser<{ answer: boolean }>(
          practitionerId,
          'practitioner',
          sql`SELECT rls_care_team_member(${practitionerId}, ${patientId}) AS answer`,
        )
        expect({ label, inTypeScript, inSql: inSql.answer }).toEqual({
          label,
          inTypeScript: expected,
          inSql: expected,
        })
      }
    })
  })
})