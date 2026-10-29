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

// A possible duplicate patient, warned about at creation (decisions §27,
// pass 2): the same date of birth and the same name — written differently,
// or swapped — answers 409 `possible_duplicate`; `allowPossibleDuplicate`
// goes ahead and names the matches in the audit entry. What the 409 says
// depends on who asks: an admin sees every match; a practitioner sees only
// what their clinic directory would show, and THAT other matches exist.
//
// The world: two clinics (River, Harbour); Pia practises at River, Quinn at
// Harbour; patients at River: Zoë Dupont-Martin (active) and Cara Fox
// (deactivated); at Harbour: Léa Martin.

import 'dotenv/config'
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { InMemoryEmailTransport } from './support/in-memory-email-transport'
import { activateAccount } from './support/accounts'

describe('Possible duplicate patients (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  let admin: ReturnType<typeof request.agent>
  let pia: ReturnType<typeof request.agent>

  let river: { id: number; name: string }
  let harbour: { id: number; name: string }
  let zoeId: number
  let caraId: number
  let leaId: number
  let quinnId: number
  // Zoë's twin account, created "anyway" by Pia (below).
  let zoeTwinId: number

  const stamp = Date.now()
  let counter = 0
  const email = () => `p${stamp}-${(counter += 1)}@example.com`

  function bodyOf<T>(res: request.Response): T {
    return res.body as T
  }

  interface DuplicateBody {
    statusCode: number
    message: string[]
    reason: string
    inYourClinics?: {
      id: number
      firstName: string
      lastName: string
      avatarUrl: string | null
      dateOfBirth: string | null
      sharedClinics: { id: number; name: string }[]
      onMyCareTeam: boolean
    }[]
    elsewhere?: boolean
    matches?: {
      id: number
      firstName: string
      lastName: string
      isActive: boolean
      clinics: { id: number; name: string }[]
    }[]
  }
  interface AuditRow {
    action: string
    target_user_id: number
    details: Record<string, unknown>
  }

  // The 409's own fields — the filter adds `error`, `path`, `timestamp`.
  function duplicateAnswer(res: request.Response) {
    const { statusCode, message, reason, inYourClinics, elsewhere, matches } =
      bodyOf<DuplicateBody>(res)
    return {
      statusCode,
      message,
      reason,
      ...(inYourClinics !== undefined ? { inYourClinics } : {}),
      ...(elsewhere !== undefined ? { elsewhere } : {}),
      ...(matches !== undefined ? { matches } : {}),
    }
  }

  const MESSAGE = [
    'A patient with this name and date of birth may already be in Stride.',
  ]

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

    const { rows } = await sessionPool.query<{ current_database: string }>(
      'SELECT current_database()',
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
    pia = request.agent(app.getHttpServer())
    const quinn = request.agent(app.getHttpServer())

    const clinicRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'River Physio',
      clinicEmail: `river-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Admin',
    })
    expect(clinicRes.status).toBe(201)
    river = {
      id: bodyOf<{ clinicId: number }>(clinicRes).clinicId,
      name: 'River Physio',
    }
    const harbourRes = await admin.post('/clinics').send({
      name: 'Harbour Clinic',
      email: `harbour-${stamp}@example.com`,
      addressLine1: '1 Quay',
      addressCity: 'Halifax',
      addressPostalCode: 'B3H 1A1',
      addressCountry: 'CA',
    })
    if (harbourRes.status !== 201) {
      throw new Error(`Setup failed: ${JSON.stringify(harbourRes.body)}`)
    }
    harbour = {
      id: bodyOf<{ id: number }>(harbourRes).id,
      name: 'Harbour Clinic',
    }

    async function staff(
      firstName: string,
      clinicId: number,
      agent: ReturnType<typeof request.agent>,
    ) {
      const address = email()
      const res = await admin.post('/users').send({
        email: address,
        role: 'practitioner',
        firstName,
        lastName: 'Staff',
        licenseNumber: `LIC-${firstName}-${stamp}`,
        clinicId,
      })
      expect(res.status).toBe(201)
      await activateAccount(sessionPool, address)
      await agent
        .post('/auth/login')
        .send({ email: address, password: 'password123' })
      return bodyOf<{ id: number }>(res).id
    }
    await staff('Pia', river.id, pia)
    quinnId = await staff('Quinn', harbour.id, quinn)

    async function patient(
      firstName: string,
      lastName: string,
      dateOfBirth: string,
      clinicId: number,
    ) {
      const res = await admin.post('/users').send({
        email: email(),
        role: 'patient',
        firstName,
        lastName,
        dateOfBirth,
        clinicId,
      })
      expect(res.status).toBe(201)
      return bodyOf<{ id: number }>(res).id
    }
    zoeId = await patient('Zoë', 'Dupont-Martin', '1980-05-06', river.id)
    caraId = await patient('Cara', 'Fox', '1990-03-04', river.id)
    leaId = await patient('Léa', 'Martin', '1975-01-02', harbour.id)
    expect((await admin.delete(`/users/${caraId}`)).status).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // What a practitioner's creation sends: their own clinic, River.
  const asPia = (body: Record<string, unknown>) =>
    pia.post('/users').send({
      role: 'patient',
      email: email(),
      clinicId: river.id,
      ...body,
    })

  async function accountsNamed(lastName: string) {
    const { rows } = await sessionPool.query<{ count: string }>(
      'SELECT count(*) FROM users WHERE last_name = $1',
      [lastName],
    )
    return Number(rows[0].count)
  }

  async function lastEntry(action: string, targetUserId: number) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, target_user_id, details FROM audit_logs
       WHERE action = $1 AND target_user_id = $2 ORDER BY id DESC LIMIT 1`,
      [action, targetUserId],
    )
    return rows[0]
  }

  // --- a practitioner -------------------------------------------------------------------------------------

  describe('a practitioner creating a patient', () => {
    // Written differently: no accent, a space for the hyphen, other case.
    it('is shown a match from their own clinic as a directory row — and nothing is created', async () => {
      const res = await asPia({
        firstName: 'ZOE',
        lastName: 'dupont martin',
        dateOfBirth: '1980-05-06',
      })

      expect(res.status).toBe(409)
      expect(duplicateAnswer(res)).toStrictEqual({
        statusCode: 409,
        message: MESSAGE,
        reason: 'possible_duplicate',
        inYourClinics: [
          {
            id: zoeId,
            firstName: 'Zoë',
            lastName: 'Dupont-Martin',
            avatarUrl: null,
            dateOfBirth: '1980-05-06',
            sharedClinics: [river],
            onMyCareTeam: false,
          },
        ],
        elsewhere: false,
      })
      expect(await accountsNamed('dupont martin')).toBe(0)
    })

    // Léa is at Harbour: Pia learns only that SOMEONE matches.
    it('is told only that a match exists elsewhere — no name, no clinic, no id', async () => {
      const res = await asPia({
        // Swapped: first and last typed in each other's field.
        firstName: 'Martin',
        lastName: 'Lea',
        dateOfBirth: '1975-01-02',
      })

      expect(res.status).toBe(409)
      expect(duplicateAnswer(res)).toStrictEqual({
        statusCode: 409,
        message: MESSAGE,
        reason: 'possible_duplicate',
        inYourClinics: [],
        elsewhere: true,
      })
      const text = JSON.stringify(res.body)
      expect(text).not.toContain('Léa')
      expect(text).not.toContain('Harbour')
      // No other field than these (the filter's own three included): no
      // id or match list can ride along.
      expect(Object.keys(bodyOf<object>(res)).sort()).toEqual([
        'elsewhere',
        'error',
        'inYourClinics',
        'message',
        'path',
        'reason',
        'statusCode',
        'timestamp',
      ])
    })

    // A deactivated patient of Pia's own clinic isn't in her directory —
    // "check with an admin", like any match she can't see.
    it('counts a deactivated patient of their clinic as "elsewhere"', async () => {
      const res = await asPia({
        firstName: 'Cara',
        lastName: 'Fox',
        dateOfBirth: '1990-03-04',
      })

      expect(res.status).toBe(409)
      expect(duplicateAnswer(res)).toStrictEqual({
        statusCode: 409,
        message: MESSAGE,
        reason: 'possible_duplicate',
        inYourClinics: [],
        elsewhere: true,
      })
    })

    it('creates the patient when told to go ahead, naming the match in the entry', async () => {
      const res = await asPia({
        firstName: 'Zoe',
        lastName: 'Dupont Martin',
        dateOfBirth: '1980-05-06',
        allowPossibleDuplicate: true,
      })

      expect(res.status).toBe(201)
      const created = bodyOf<{ id: number }>(res).id
      zoeTwinId = created
      const entry = await lastEntry('USER_CREATED', created)
      expect(entry.details.possibleDuplicateOf).toEqual([zoeId])
      expect(
        (entry.details.record as Record<string, unknown>)
          .allowPossibleDuplicate,
      ).toBe(true)

      // The next one finds BOTH — the new one on Pia's care team (she
      // created it), Zoë not.
      const again = await asPia({
        firstName: 'Zoë',
        lastName: 'Dupont-Martin',
        dateOfBirth: '1980-05-06',
      })
      expect(again.status).toBe(409)
      const rows = bodyOf<DuplicateBody>(again).inYourClinics!
      expect(
        rows
          .map((row) => [row.id, row.onMyCareTeam])
          .sort((a, b) => Number(a[0]) - Number(b[0])),
      ).toEqual([
        [zoeId, false],
        [created, true],
      ])
      expect(bodyOf<DuplicateBody>(again).elsewhere).toBe(false)
    })

    // The same name, another birthday: two people — no warning, and the
    // entry keeps its usual shape.
    it('creates a patient with the same name but another date of birth without a word', async () => {
      const res = await asPia({
        firstName: 'Zoë',
        lastName: 'Dupont-Martin',
        dateOfBirth: '1980-05-07',
      })

      expect(res.status).toBe(201)
      const entry = await lastEntry(
        'USER_CREATED',
        bodyOf<{ id: number }>(res).id,
      )
      expect(entry.details).not.toHaveProperty('possibleDuplicateOf')
    })

    // The same birthday, another name: no warning either.
    it('creates a patient with the same date of birth but another name', async () => {
      const res = await asPia({
        firstName: 'Zoë',
        lastName: 'Durand',
        dateOfBirth: '1980-05-06',
      })
      expect(res.status).toBe(201)
    })

    // The other 409 of this route keeps its own words and has no reason.
    it('still answers an email already taken with its own 409', async () => {
      const taken = email()
      expect(
        (
          await asPia({
            email: taken,
            firstName: 'Una',
            lastName: 'Ng',
            dateOfBirth: '2000-01-01',
          })
        ).status,
      ).toBe(201)
      const res = await pia.post('/users').send({
        role: 'patient',
        email: taken,
        clinicId: river.id,
        firstName: 'Vic',
        lastName: 'Ng',
        dateOfBirth: '2001-01-01',
      })
      expect(res.status).toBe(409)
      expect(bodyOf<DuplicateBody>(res).reason).toBeUndefined()
    })
  })

  // --- an admin --------------------------------------------------------------------------------------------

  describe('an admin', () => {
    // Every match, active or not, any clinic — with what an admin needs to
    // open and compare them; the oldest account first.
    it('is shown every match, with its clinics and whether it is active', async () => {
      const res = await admin.post('/users').send({
        role: 'patient',
        email: email(),
        firstName: 'Lea',
        lastName: 'MARTIN',
        dateOfBirth: '1975-01-02',
        clinicId: river.id,
      })

      expect(res.status).toBe(409)
      expect(duplicateAnswer(res)).toStrictEqual({
        statusCode: 409,
        message: MESSAGE,
        reason: 'possible_duplicate',
        matches: [
          {
            id: leaId,
            firstName: 'Léa',
            lastName: 'Martin',
            isActive: true,
            clinics: [harbour],
          },
        ],
      })

      // A second match at ANOTHER clinic: each match lists its own clinics.
      const twin = await admin.post('/users').send({
        role: 'patient',
        email: email(),
        firstName: 'Léa',
        lastName: 'Martin',
        dateOfBirth: '1975-01-02',
        clinicId: river.id,
        allowPossibleDuplicate: true,
      })
      expect(twin.status).toBe(201)
      const both = await admin.post('/users').send({
        role: 'patient',
        email: email(),
        firstName: 'Lea',
        lastName: 'Martin',
        dateOfBirth: '1975-01-02',
      })
      expect(
        bodyOf<DuplicateBody>(both).matches!.map((m) => [m.id, m.clinics]),
      ).toEqual([
        [leaId, [harbour]],
        [bodyOf<{ id: number }>(twin).id, [river]],
      ])

      const deactivated = await admin.post('/users').send({
        role: 'patient',
        email: email(),
        firstName: 'Cara',
        lastName: 'Fox',
        dateOfBirth: '1990-03-04',
      })
      expect(bodyOf<DuplicateBody>(deactivated).matches).toEqual([
        {
          id: caraId,
          firstName: 'Cara',
          lastName: 'Fox',
          isActive: false,
          clinics: [river],
        },
      ])
    })

    // The oldest account first, whatever order the database meets them in:
    // rewriting Zoë's rows (an UPDATE writes a new row version, at the end of
    // the table) makes a scan reach her LAST — only the ORDER BY keeps her
    // first.
    it('lists the oldest account first', async () => {
      await sessionPool.query(
        'UPDATE patient_profiles SET date_of_birth = date_of_birth WHERE user_id = $1',
        [zoeId],
      )
      await sessionPool.query(
        'UPDATE users SET first_name = first_name WHERE id = $1',
        [zoeId],
      )
      const res = await admin.post('/users').send({
        role: 'patient',
        email: email(),
        firstName: 'Zoe',
        lastName: 'Dupont Martin',
        dateOfBirth: '1980-05-06',
        clinicId: river.id,
      })

      expect(res.status).toBe(409)
      expect(bodyOf<DuplicateBody>(res).matches!.map((m) => m.id)).toEqual([
        zoeId,
        zoeTwinId,
      ])
    })

    // Granting the patient role makes a new patient record: the same check.
    it('is warned when granting the patient role to a matching account, and may go ahead', async () => {
      const twin = await admin.post('/users').send({
        role: 'patient',
        email: email(),
        firstName: 'Quinn',
        lastName: 'Staff',
        dateOfBirth: '1985-09-09',
        clinicId: harbour.id,
      })
      expect(twin.status).toBe(201)
      const twinId = bodyOf<{ id: number }>(twin).id

      const refused = await admin
        .post(`/users/${quinnId}/roles`)
        .send({ role: 'patient', dateOfBirth: '1985-09-09' })
      expect(refused.status).toBe(409)
      expect(duplicateAnswer(refused)).toStrictEqual({
        statusCode: 409,
        message: MESSAGE,
        reason: 'possible_duplicate',
        matches: [
          {
            id: twinId,
            firstName: 'Quinn',
            lastName: 'Staff',
            isActive: true,
            clinics: [harbour],
          },
        ],
      })
      const { rows } = await sessionPool.query(
        "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'patient'",
        [quinnId],
      )
      expect(rows).toEqual([])

      const granted = await admin.post(`/users/${quinnId}/roles`).send({
        role: 'patient',
        dateOfBirth: '1985-09-09',
        allowPossibleDuplicate: true,
      })
      expect(granted.status).toBe(201)
      const entry = await lastEntry('USER_ROLE_GRANTED', quinnId)
      expect(entry.details).toStrictEqual({
        role: 'patient',
        profile: { dateOfBirth: '1985-09-09' },
        possibleDuplicateOf: [twinId],
      })
    })

    // Another role grant makes no patient record: nothing to compare.
    it('is not warned when granting another role', async () => {
      const res = await admin
        .post(`/users/${zoeId}/roles`)
        .send({ role: 'admin' })
      expect(res.status).toBe(201)
      const entry = await lastEntry('USER_ROLE_GRANTED', zoeId)
      expect(entry.details).toStrictEqual({
        role: 'admin',
        profile: { position: null },
      })
    })
  })
})
