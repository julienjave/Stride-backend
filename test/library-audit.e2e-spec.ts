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
import { getDatabaseUrl } from '../src/config/database-url'
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider'

// The audit review, Phase 6 — slice 1c: the exercise library and program
// templates. They hold no patient data, but follow the same convention as
// everything else (decided with the person 2026-10-21 — one kind of entry
// everywhere, and then no generic interceptor at all):
//   - ONE complete entry per request that changes something, in the change's
//     own transaction — before → after for edits, the record for creations,
//     the removed row for deletions;
//   - nothing written for a refused request, or one that changes nothing.
// The entries name the exercise or the TEMPLATE (entity_id) — a template's
// workout or exercise row is in the details — and no target user.
describe('Library and template audit trail (e2e)', () => {
  let app: INestApplication
  let sessionPool: Pool

  const agent = () => request.agent(app.getHttpServer())
  let admin: ReturnType<typeof agent>
  let practitioner: ReturnType<typeof agent>
  let colleague: ReturnType<typeof agent>
  let practitionerId: number
  const stamp = Date.now()

  interface AuditRow {
    action: string
    performed_by: number
    target_user_id: number | null
    details: Record<string, unknown> | null
  }

  // Every entry about one exercise or template, oldest first (as the owner:
  // audit_logs is admin-only under row security).
  async function trail(entityType: string, entityId: number) {
    const { rows } = await sessionPool.query<AuditRow>(
      `SELECT action, performed_by, target_user_id, details
         FROM audit_logs
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY id`,
      [entityType, entityId],
    )
    return rows
  }

  async function one<T>(query: string, params: unknown[]): Promise<T> {
    const { rows } = await sessionPool.query<{ value: T }>(query, params)
    return rows[0].value
  }

  // A custom exercise of the practitioner's.
  async function newExercise(name = 'Audit Squat') {
    const res = await practitioner.post('/exercises').send({
      name,
      primaryMuscles: ['legs'],
      instructions: ['Stand', 'Squat'],
    })
    expect(res.status).toBe(201)
    return res.body.id as number
  }

  // A template of the practitioner's, with its first workout's id.
  async function newTemplate(title = 'Audit Knee') {
    const res = await practitioner.post('/programs').send({ title })
    expect(res.status).toBe(201)
    // The create route answers with the template row alone; its first
    // workout (created with it) comes with the full template.
    const full = await practitioner.get(`/programs/${res.body.id}`)
    return {
      id: res.body.id as number,
      workoutId: full.body.workouts[0].id as number,
    }
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
    const db = app.get<DrizzleDb>(DRIZZLE)
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
    practitioner = agent()
    colleague = agent()
    const bootstrap = await admin.post('/auth/register-clinic').send({
      clinicName: 'Library Audit Clinic',
      clinicEmail: `la-clinic-${stamp}@example.com`,
      email: `la-admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Lib',
      lastName: 'Admin',
    })
    expect(bootstrap.status).toBe(201)
    const clinicId = bootstrap.body.clinicId as number

    for (const [who, label] of [
      [practitioner, 'p'],
      [colleague, 'c'],
    ] as const) {
      const email = `la-${label}-${stamp}@example.com`
      const created = await admin.post('/users').send({
        email,
        role: 'practitioner',
        firstName: 'Lib',
        lastName: label.toUpperCase(),
        licenseNumber: `LA-${label}-${stamp}`,
        clinicId,
      })
      expect(created.status).toBe(201)
      await activateAccount(sessionPool, email)
      const login = await who
        .post('/auth/login')
        .send({ email, password: 'password123' })
      expect(login.status).toBe(201)
      if (who === practitioner) practitionerId = created.body.id as number
    }
  })

  afterAll(async () => {
    await app.close()
    await sessionPool.end()
  })

  // === THE EXERCISE LIBRARY =================================================

  describe('the exercise library', () => {
    it('records a new exercise and an edit before → after — and nothing for an unchanged one', async () => {
      const id = await newExercise()
      const edits = [
        await practitioner
          .patch(`/exercises/${id}`)
          .send({ name: 'Audit Lunge' }),
        await practitioner
          .patch(`/exercises/${id}`)
          .send({ name: 'Audit Lunge' }),
      ]
      expect(edits.map((res) => res.status)).toEqual([200, 200])

      expect(await trail('exercises', id)).toEqual([
        {
          action: 'EXERCISE_CREATED',
          performed_by: practitionerId,
          target_user_id: null,
          details: {
            record: {
              name: 'Audit Squat',
              primaryMuscles: ['legs'],
              instructions: ['Stand', 'Squat'],
            },
          },
        },
        {
          action: 'EXERCISE_UPDATED',
          performed_by: practitionerId,
          target_user_id: null,
          details: {
            changes: { name: { from: 'Audit Squat', to: 'Audit Lunge' } },
          },
        },
      ])
    })

    it('records photos added, reordered and removed by storage key — once each', async () => {
      const id = await newExercise('Audit Press')
      const upload = await practitioner
        .post(`/exercises/${id}/images`)
        .attach('files', Buffer.from('fake-one'), {
          filename: 'one.png',
          contentType: 'image/png',
        })
        .attach('files', Buffer.from('fake-two'), {
          filename: 'two.png',
          contentType: 'image/png',
        })
      expect(upload.status).toBe(201)
      const keys = await one<string[]>(
        'SELECT media_urls AS value FROM exercises WHERE id = $1',
        [id],
      )
      expect(keys).toHaveLength(2)
      const responses = [
        await practitioner
          .patch(`/exercises/${id}/images`)
          .send({ order: [keys[1], keys[0]] }),
        // The order it now has: nothing changes, nothing is written.
        await practitioner
          .patch(`/exercises/${id}/images`)
          .send({ order: [keys[1], keys[0]] }),
        await practitioner
          .delete(`/exercises/${id}/images`)
          .send({ objectKey: keys[0] }),
        // Not this exercise's (any more): refused, nothing written.
        await practitioner
          .delete(`/exercises/${id}/images`)
          .send({ objectKey: keys[0] }),
      ]
      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 404])

      expect(
        (await trail('exercises', id))
          .slice(1)
          .map((e) => [e.action, e.details]),
      ).toEqual([
        ['EXERCISE_PHOTOS_ADDED', { added: keys }],
        [
          'EXERCISE_PHOTOS_REORDERED',
          { order: { from: keys, to: [keys[1], keys[0]] } },
        ],
        ['EXERCISE_PHOTO_REMOVED', { removed: keys[0] }],
      ])
    })

    it('records an archive once, and nothing for a refused edit', async () => {
      const id = await newExercise('Audit Plank')
      const responses = [
        // Not the colleague's exercise.
        await colleague.patch(`/exercises/${id}`).send({ name: 'Nope' }),
        await practitioner.delete(`/exercises/${id}`),
        await practitioner.delete(`/exercises/${id}`),
      ]
      expect(responses.map((res) => res.status)).toEqual([403, 200, 200])
      expect((await trail('exercises', id)).map((e) => e.action)).toEqual([
        'EXERCISE_CREATED',
        'EXERCISE_ARCHIVED',
      ])
    })
  })

  // === PROGRAM TEMPLATES ====================================================

  describe('program templates', () => {
    it('records a template with its first workout, and each change to its workouts', async () => {
      const template = await newTemplate()
      const added = await practitioner
        .post(`/programs/${template.id}/workouts`)
        .send({ name: 'Strength' })
      expect(added.status).toBe(201)
      const secondId = added.body.workouts[1].id as number
      const responses = [
        await practitioner
          .patch(`/programs/${template.id}/workouts/${secondId}`)
          .send({ name: 'Power' }),
        // The same name again: nothing.
        await practitioner
          .patch(`/programs/${template.id}/workouts/${secondId}`)
          .send({ name: 'Power' }),
        await practitioner
          .patch(`/programs/${template.id}/workouts`)
          .send({ order: [secondId, template.workoutId] }),
        // The order it now has: nothing.
        await practitioner
          .patch(`/programs/${template.id}/workouts`)
          .send({ order: [secondId, template.workoutId] }),
        await practitioner.delete(
          `/programs/${template.id}/workouts/${secondId}`,
        ),
      ]
      expect(responses.map((res) => res.status)).toEqual([
        200, 200, 200, 200, 200,
      ])

      expect(
        (await trail('program_templates', template.id)).map((e) => [
          e.action,
          e.details,
        ]),
      ).toEqual([
        [
          'TEMPLATE_CREATED',
          {
            record: { title: 'Audit Knee' },
            workout: { id: template.workoutId, name: null, sortOrder: 0 },
          },
        ],
        [
          'TEMPLATE_WORKOUT_ADDED',
          { workout: { id: secondId, name: 'Strength', sortOrder: 1 } },
        ],
        [
          'TEMPLATE_WORKOUT_RENAMED',
          { workoutId: secondId, name: { from: 'Strength', to: 'Power' } },
        ],
        [
          'TEMPLATE_WORKOUTS_REORDERED',
          {
            order: {
              from: [template.workoutId, secondId],
              to: [secondId, template.workoutId],
            },
          },
        ],
        [
          // What it WAS (name and position when it went: first, after the
          // reorder).
          'TEMPLATE_WORKOUT_REMOVED',
          { workout: { id: secondId, name: 'Power', sortOrder: 0 } },
        ],
      ])
    })

    it('records exercises added, edited, reordered and removed — with the row as it was', async () => {
      const template = await newTemplate('Audit Back')
      const exerciseId = await newExercise('Audit Bridge')
      const first = await practitioner
        .post(`/programs/${template.id}/exercises`)
        .send({ exerciseId, sets: 3, reps: 10, sortOrder: 0 })
      expect(first.status).toBe(201)
      const second = await practitioner
        .post(`/programs/${template.id}/exercises`)
        .send({ exerciseId, sets: 2, reps: 8, sortOrder: 1 })
      const [a, b] = (second.body.exercises as { id: number }[]).map(
        (row) => row.id,
      )
      const responses = [
        await practitioner
          .patch(`/programs/${template.id}/exercises/${a}`)
          .send({ sets: 4 }),
        // Unchanged: nothing.
        await practitioner
          .patch(`/programs/${template.id}/exercises/${a}`)
          .send({ sets: 4 }),
        await practitioner
          .patch(`/programs/${template.id}/exercises`)
          .send({ order: [b, a] }),
        // The order it now has: nothing.
        await practitioner
          .patch(`/programs/${template.id}/exercises`)
          .send({ order: [b, a] }),
        await practitioner.delete(`/programs/${template.id}/exercises/${b}`),
      ]
      expect(responses.map((res) => res.status)).toEqual([
        200, 200, 200, 200, 200,
      ])

      const row = (
        id: number,
        sets: number,
        reps: number,
        sortOrder: number,
      ) => ({
        id,
        workoutId: template.workoutId,
        exerciseId,
        sets,
        reps,
        durationInSeconds: null,
        weight: null,
        weightUnit: null,
        sortOrder,
        notes: null,
      })
      expect(
        (await trail('program_templates', template.id))
          .slice(1)
          .map((e) => [e.action, e.details]),
      ).toEqual([
        ['TEMPLATE_EXERCISE_ADDED', { exercise: row(a, 3, 10, 0) }],
        ['TEMPLATE_EXERCISE_ADDED', { exercise: row(b, 2, 8, 1) }],
        [
          'TEMPLATE_EXERCISE_UPDATED',
          { templateExerciseId: a, changes: { sets: { from: 3, to: 4 } } },
        ],
        [
          'TEMPLATE_EXERCISES_REORDERED',
          { workoutId: template.workoutId, from: [a, b], to: [b, a] },
        ],
        // Removed after the reorder: its position was then 0.
        ['TEMPLATE_EXERCISE_REMOVED', { exercise: row(b, 2, 8, 0) }],
      ])
    })

    it('records a rename, a duplicate (on the copy) and an archive — and nothing for the unchanged or the refused', async () => {
      const template = await newTemplate('Audit Hip')
      const responses = [
        await practitioner
          .patch(`/programs/${template.id}`)
          .send({ title: 'Audit Hips' }),
        await practitioner
          .patch(`/programs/${template.id}`)
          .send({ title: 'Audit Hips' }),
        await colleague
          .patch(`/programs/${template.id}`)
          .send({ title: 'Mine' }),
      ]
      expect(responses.map((res) => res.status)).toEqual([200, 200, 403])
      const copy = await colleague.post(`/programs/${template.id}/duplicate`)
      expect(copy.status).toBe(201)
      const archives = [
        await practitioner.delete(`/programs/${template.id}`),
        await practitioner.delete(`/programs/${template.id}`),
      ]
      expect(archives.map((res) => res.status)).toEqual([200, 200])

      expect(
        (await trail('program_templates', template.id))
          .slice(1)
          .map((e) => [e.action, e.details]),
      ).toEqual([
        [
          'TEMPLATE_UPDATED',
          { changes: { title: { from: 'Audit Hip', to: 'Audit Hips' } } },
        ],
        ['TEMPLATE_ARCHIVED', { title: 'Audit Hips' }],
      ])
      // The duplicate is recorded on the COPY (the source didn't change).
      expect(await trail('program_templates', copy.body.id as number)).toEqual([
        {
          action: 'TEMPLATE_DUPLICATED',
          performed_by: (await colleague.get('/auth/me')).body.id as number,
          target_user_id: null,
          details: {
            sourceTemplateId: template.id,
            title: 'Copy of Audit Hips',
          },
        },
      ])
    })

    // In the change's own transaction: a refused entry (a trigger planted
    // for the test) undoes the rename.
    it('undoes the change when its entry cannot be written', async () => {
      const template = await newTemplate('Audit Neck')
      await sessionPool.query(`
        CREATE FUNCTION la_refuse_template_updated() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'audit insert refused (test)';
          END $$;
        CREATE TRIGGER la_refuse_template_updated
          BEFORE INSERT ON audit_logs
          FOR EACH ROW WHEN (NEW.action = 'TEMPLATE_UPDATED')
          EXECUTE FUNCTION la_refuse_template_updated();
      `)
      try {
        const res = await practitioner
          .patch(`/programs/${template.id}`)
          .send({ title: 'Lost' })
        expect(res.status).toBe(500)
      } finally {
        await sessionPool.query(`
          DROP TRIGGER la_refuse_template_updated ON audit_logs;
          DROP FUNCTION la_refuse_template_updated();
        `)
      }
      expect(
        await one<string>(
          'SELECT title AS value FROM program_templates WHERE id = $1',
          [template.id],
        ),
      ).toBe('Audit Neck')
    })
  })
})
