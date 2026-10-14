import { Test } from '@nestjs/testing'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import {
  SessionsService,
  assertLocalDateIsToday,
  chooseSessionWorkout,
} from './sessions.service'
import { UsersService } from '../users/users.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { SessionStatus } from './dto/update-session.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { addDays, utcToday } from '../common/calendar-date'

// An active program of patient 20 — the only kind that takes a new session
// (a completed, cancelled or archived one is closed: program-state.ts).
const OPEN_PROGRAM = {
  id: 5,
  patientId: 20,
  status: 'active',
  isArchived: false,
}

describe('SessionsService.create', () => {
  let service: SessionsService
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      sessions: { findFirst: jest.Mock }
      sessionExercises: { findMany: jest.Mock }
    }
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        assignedPrograms: { findFirst: jest.fn() },
        // A one-workout program (workout 950) with one exercise, unless a
        // test says otherwise.
        programWorkouts: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 950, name: null, sortOrder: 0 }]),
        },
        assignedProgramExercises: {
          findMany: jest.fn().mockResolvedValue([{ id: 30, sortOrder: 0 }]),
        },
        sessions: {
          findFirst: jest.fn().mockResolvedValue({ id: 500, patientId: 20 }),
        },
        sessionExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      insert: jest.fn(),
      // withRlsContext() now wraps both the assignedPrograms lookup and the
      // session-creation transaction in db.transaction()/db.execute() —
      // tx === db here, so both resolve against the mocks above.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()

    service = moduleRef.get(SessionsService)
  })

  it('throws NotFoundException when the assigned program does not exist', async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(undefined)

    await expect(
      service.create(
        { id: 20, activeRole: UserRole.PATIENT },
        { assignedProgramId: 999, localDate: utcToday() },
      ),
    ).rejects.toThrow(NotFoundException)
  })

  it('refuses to create a session for a program that belongs to a different patient', async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      id: 5,
      patientId: 21,
    })

    await expect(
      service.create(
        { id: 20, activeRole: UserRole.PATIENT },
        { assignedProgramId: 5, localDate: utcToday() },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("creates the session and pre-populates it from the program's current exercises", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)

    const sessionExerciseInserts: any[] = []
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      {
        id: 30,
        sortOrder: 0,
        name: 'Squat',
        sets: 3,
        reps: 10,
        durationInSeconds: null,
        weight: 20,
        weightUnit: 'kg',
        notes: 'Slowly',
        primaryMuscles: ['quadriceps'],
        secondaryMuscles: ['glutes'],
        equipment: ['barbell'],
        instructions: ['Stand tall.', 'Sit back.'],
        // Not part of the copy: which workout, and retirement, belong to
        // the program exercise — toStrictEqual below proves they're left out.
        workoutId: 3,
        retiredAt: null,
      },
      {
        id: 31,
        sortOrder: 1,
        name: 'Plank',
        sets: null,
        reps: null,
        durationInSeconds: 45,
        weight: null,
        weightUnit: null,
        notes: null,
        primaryMuscles: ['abdominals'],
        secondaryMuscles: [],
        equipment: [],
        instructions: ['Hold.'],
        workoutId: 3,
        retiredAt: null,
      },
    ])
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: any) => {
        if (
          values.assignedProgramId !== undefined &&
          values.status === 'pending'
        ) {
          return {
            returning: jest.fn().mockResolvedValue([{ id: 500, ...values }]),
          }
        }
        sessionExerciseInserts.push(values)
        return Promise.resolve(undefined)
      }),
    }))

    const result = await service.create(
      { id: 20, activeRole: UserRole.PATIENT },
      { assignedProgramId: 5, localDate: utcToday() },
    )

    // Each checklist row: which program exercise, a COPY of its name and
    // prescription (step 3b-0) and description (2026-10-14) as they are now,
    // nothing done yet, its place.
    // toStrictEqual: no field more, none less.
    expect(sessionExerciseInserts).toStrictEqual([
      {
        sessionId: 500,
        assignedProgramExerciseId: 30,
        name: 'Squat',
        sets: 3,
        reps: 10,
        durationInSeconds: null,
        weight: 20,
        weightUnit: 'kg',
        notes: 'Slowly',
        primaryMuscles: ['quadriceps'],
        secondaryMuscles: ['glutes'],
        equipment: ['barbell'],
        instructions: ['Stand tall.', 'Sit back.'],
        completed: false,
        sortOrder: 0,
      },
      {
        sessionId: 500,
        assignedProgramExerciseId: 31,
        name: 'Plank',
        sets: null,
        reps: null,
        durationInSeconds: 45,
        weight: null,
        weightUnit: null,
        notes: null,
        primaryMuscles: ['abdominals'],
        secondaryMuscles: [],
        equipment: [],
        instructions: ['Hold.'],
        completed: false,
        sortOrder: 1,
      },
    ])
    expect(result).toEqual(expect.objectContaining({ id: 500 }))
  })

  // The race of step 3b-0: the practitioner DELETED an exercise of this
  // checklist (never used, so really deleted) between the read above and
  // the insert. The checklist row's foreign key refuses it: the patient is
  // told to start again — a 409, not a 500.
  it('answers 409 when an exercise of the checklist was deleted meanwhile', async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)
    db.insert.mockImplementation(() => ({
      values: jest
        .fn()
        .mockImplementation((values: Record<string, unknown>) => {
          if (values.status === 'pending') {
            return {
              returning: jest.fn().mockResolvedValue([{ id: 500, ...values }]),
            }
          }
          return Promise.reject(
            new DrizzleQueryError(
              'insert into "session_exercises" ...',
              [],
              Object.assign(new Error('fk'), {
                code: '23503',
                constraint: 'session_exercises_program_exercise_fk',
              }),
            ),
          )
        }),
    }))

    await expect(
      service.create(
        { id: 20, activeRole: UserRole.PATIENT },
        { assignedProgramId: 5, localDate: utcToday() },
      ),
    ).rejects.toThrow(
      new ConflictException(
        'Your program was just changed: start the session again',
      ),
    )
  })

  // Any other failure of the insert is not that race: unchanged.
  it('lets any other insert failure through unchanged', async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)
    const other = Object.assign(new Error('fk'), {
      code: '23503',
      constraint: 'session_exercises_session_id_sessions_id_fk',
    })
    db.insert.mockImplementation(() => ({
      values: jest
        .fn()
        .mockImplementation((values: Record<string, unknown>) =>
          values.status === 'pending'
            ? {
                returning: jest
                  .fn()
                  .mockResolvedValue([{ id: 500, ...values }]),
              }
            : Promise.reject(other),
        ),
    }))

    await expect(
      service.create(
        { id: 20, activeRole: UserRole.PATIENT },
        { assignedProgramId: 5, localDate: utcToday() },
      ),
    ).rejects.toBe(other)
  })

  // No workoutId sent, one workout: the session records that one.
  it("records the program's only workout on the session", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)
    const sessionInserts: Record<string, unknown>[] = []
    db.insert.mockImplementation(() => ({
      values: jest
        .fn()
        .mockImplementation((values: Record<string, unknown>) => {
          if (values.status === 'pending') {
            sessionInserts.push(values)
            return {
              returning: jest.fn().mockResolvedValue([{ id: 500, ...values }]),
            }
          }
          return Promise.resolve(undefined)
        }),
    }))

    await service.create(
      { id: 20, activeRole: UserRole.PATIENT },
      { assignedProgramId: 5, localDate: utcToday() },
    )

    expect(sessionInserts).toHaveLength(1)
    expect(sessionInserts[0].workoutId).toBe(950)
  })

  // A workout emptied by its practitioner: no session with nothing in it.
  it('refuses a workout with no exercises, before writing', async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)
    db.query.assignedProgramExercises.findMany.mockResolvedValue([])

    await expect(
      service.create(
        { id: 20, activeRole: UserRole.PATIENT },
        { assignedProgramId: 5, localDate: utcToday() },
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'This workout has no exercises yet: ask your practitioner',
      ),
    )
    expect(db.insert).not.toHaveBeenCalled()
  })

  // The session row carries the patient's own day, exactly as sent.
  it("stores the patient's local date on the session", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)
    const sessionInserts: Record<string, unknown>[] = []
    db.insert.mockImplementation(() => ({
      values: jest
        .fn()
        .mockImplementation((values: Record<string, unknown>) => {
          if (values.status === 'pending') {
            sessionInserts.push(values)
            return {
              returning: jest.fn().mockResolvedValue([{ id: 500, ...values }]),
            }
          }
          return Promise.resolve(undefined)
        }),
    }))
    // Tomorrow in UTC: today for someone east of UTC late in the evening —
    // allowed, and stored as sent (not replaced by the server's own day).
    const tomorrow = addDays(utcToday(), 1)

    await service.create(
      { id: 20, activeRole: UserRole.PATIENT },
      { assignedProgramId: 5, localDate: tomorrow },
    )

    expect(sessionInserts).toHaveLength(1)
    expect(sessionInserts[0].localDate).toBe(tomorrow)
  })

  it('refuses a local date that cannot be today anywhere, before writing', async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue(OPEN_PROGRAM)

    await expect(
      service.create(
        { id: 20, activeRole: UserRole.PATIENT },
        { assignedProgramId: 5, localDate: addDays(utcToday(), -2) },
      ),
    ).rejects.toThrow(
      new BadRequestException(
        "localDate must be today's date in the patient's time zone",
      ),
    )
    expect(db.insert).not.toHaveBeenCalled()
  })
})

// Which workout a new session does. Pure, so every case is a plain call.
describe('chooseSessionWorkout', () => {
  // Read back out of position order (B's row first), as a database may.
  const twoWorkouts = [
    { id: 12, name: 'Lower body', sortOrder: 1 },
    { id: 11, name: null, sortOrder: 0 },
  ]

  it("takes the workout asked for, when it is one of the program's", () => {
    expect(chooseSessionWorkout(12, twoWorkouts)).toBe(12)
  })

  it('refuses a workout of another program', () => {
    expect(() => chooseSessionWorkout(99, twoWorkouts)).toThrow(
      new BadRequestException('Workout 99 is not part of this program'),
    )
  })

  it('takes the only workout when none is asked for — absent or null', () => {
    const one = [{ id: 11, name: null, sortOrder: 0 }]
    expect(chooseSessionWorkout(undefined, one)).toBe(11)
    expect(chooseSessionWorkout(null, one)).toBe(11)
  })

  // Guessing would file the session under the wrong workout — and the
  // schedule would judge the wrong day by it.
  it('refuses to guess between several workouts', () => {
    expect(() => chooseSessionWorkout(undefined, twoWorkouts)).toThrow(
      new BadRequestException(
        'This program has 2 workouts (A, B): say which one this session is (workoutId)',
      ),
    )
  })
})

// Pinned clock: 2031-06-15 at 12:00 UTC. Every time zone's date is then the
// 14th, 15th or 16th — exactly the accepted range. Deliberately FAR from
// the day the tests were written: pinned to that day (2026-10-09), a
// version of the function that ignored `now` and read the real clock
// passed every test, the day it was written (a mutation check caught it).
describe('assertLocalDateIsToday', () => {
  const now = new Date('2031-06-15T12:00:00Z')

  it.each(['2031-06-14', '2031-06-15', '2031-06-16'])('accepts %s', (day) => {
    expect(() => assertLocalDateIsToday(day, now)).not.toThrow()
  })

  // One day past each edge: the boundaries are inclusive, and no further.
  it.each(['2031-06-13', '2031-06-17', '2030-06-15'])('refuses %s', (day) => {
    expect(() => assertLocalDateIsToday(day, now)).toThrow(
      new BadRequestException(
        "localDate must be today's date in the patient's time zone",
      ),
    )
  })
})

describe('SessionsService.assertCanView (via findOne)', () => {
  let service: SessionsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      sessions: { findFirst: jest.Mock }
      sessionExercises: { findMany: jest.Mock }
    }
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() }
    db = {
      query: {
        sessions: {
          findFirst: jest.fn().mockResolvedValue({ id: 500, patientId: 20 }),
        },
        sessionExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      // withRlsContext() wraps every query in db.transaction(), setting two
      // session GUCs via tx.execute() before invoking the callback — tx ===
      // db here, so the callback's queries resolve against the mocks above.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(SessionsService)
  })

  it('allows an admin to view any session', async () => {
    await expect(
      service.findOne(500, { id: 1, activeRole: UserRole.ADMIN }),
    ).resolves.toBeDefined()
  })

  it('allows the owning patient to view their own session', async () => {
    await expect(
      service.findOne(500, { id: 20, activeRole: UserRole.PATIENT }),
    ).resolves.toBeDefined()
  })

  it('rejects a different patient viewing a session that is not theirs', async () => {
    await expect(
      service.findOne(500, { id: 999, activeRole: UserRole.PATIENT }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows a managing practitioner to view the session', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    await expect(
      service.findOne(500, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).resolves.toBeDefined()
  })

  it('rejects a non-managing practitioner from viewing the session', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)
    await expect(
      service.findOne(500, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('SessionsService.update (state machine + assertIsOwner)', () => {
  let service: SessionsService
  let db: {
    query: { sessions: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }
  let setArgs: any

  beforeEach(async () => {
    setArgs = undefined
    db = {
      query: { sessions: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((values: any) => {
          setArgs = values
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 500, ...values }]),
            }),
          }
        }),
      }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()

    service = moduleRef.get(SessionsService)
  })

  it('rejects a managing practitioner from writing to a session, even one they can view', async () => {
    db.query.sessions.findFirst.mockResolvedValue({
      id: 500,
      patientId: 20,
      startedAt: null,
    })

    await expect(
      service.update(
        500,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { status: SessionStatus.IN_PROGRESS },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects an admin from writing to a session too — assertIsOwner has no admin override', async () => {
    db.query.sessions.findFirst.mockResolvedValue({
      id: 500,
      patientId: 20,
      startedAt: null,
    })

    await expect(
      service.update(
        500,
        { id: 1, activeRole: UserRole.ADMIN },
        { status: SessionStatus.IN_PROGRESS },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects a different patient from writing to a session that is not theirs', async () => {
    db.query.sessions.findFirst.mockResolvedValue({
      id: 500,
      patientId: 20,
      startedAt: null,
    })

    await expect(
      service.update(
        500,
        { id: 999, activeRole: UserRole.PATIENT },
        { status: SessionStatus.IN_PROGRESS },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('server-sets startedAt on the pending -> in_progress transition', async () => {
    db.query.sessions.findFirst.mockResolvedValue({
      id: 500,
      patientId: 20,
      startedAt: null,
    })

    await service.update(
      500,
      { id: 20, activeRole: UserRole.PATIENT },
      { status: SessionStatus.IN_PROGRESS },
    )

    expect(setArgs.startedAt).toBeInstanceOf(Date)
  })

  it('does not overwrite an already-set startedAt on a repeated in_progress update', async () => {
    const existingStartedAt = new Date('2026-01-01T00:00:00Z')
    db.query.sessions.findFirst.mockResolvedValue({
      id: 500,
      patientId: 20,
      startedAt: existingStartedAt,
    })

    await service.update(
      500,
      { id: 20, activeRole: UserRole.PATIENT },
      { status: SessionStatus.IN_PROGRESS },
    )

    expect(setArgs.startedAt).toBeUndefined()
  })

  it('server-sets completedAt on the -> completed transition', async () => {
    db.query.sessions.findFirst.mockResolvedValue({
      id: 500,
      patientId: 20,
      startedAt: new Date(),
    })

    await service.update(
      500,
      { id: 20, activeRole: UserRole.PATIENT },
      { status: SessionStatus.COMPLETED },
    )

    expect(setArgs.completedAt).toBeInstanceOf(Date)
  })
})

describe('SessionsService IDOR check (updateExercise)', () => {
  let service: SessionsService
  let db: {
    query: {
      sessions: { findFirst: jest.Mock }
      sessionExercises: { findFirst: jest.Mock }
    }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        sessions: {
          findFirst: jest.fn().mockResolvedValue({ id: 500, patientId: 20 }),
        },
        sessionExercises: { findFirst: jest.fn() },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 30 }]),
          }),
        }),
      }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()

    service = moduleRef.get(SessionsService)
  })

  it('throws NotFoundException when the exercise row does not belong to this session', async () => {
    db.query.sessionExercises.findFirst.mockResolvedValue(undefined)

    await expect(
      service.updateExercise(
        500,
        999,
        { id: 20, activeRole: UserRole.PATIENT },
        { completed: true },
      ),
    ).rejects.toThrow(NotFoundException)
  })

  it('updates the row once it is confirmed to belong to this session', async () => {
    db.query.sessionExercises.findFirst.mockResolvedValue({
      id: 30,
      sessionId: 500,
    })

    await expect(
      service.updateExercise(
        500,
        30,
        { id: 20, activeRole: UserRole.PATIENT },
        { completed: true },
      ),
    ).resolves.toEqual({ id: 30 })
  })
})

// Step 2b-iii: a closed program takes no session, and a swap's workout is the
// one scheduled on the day it counts for. The swap RULES are tested in
// swap-rules.spec.ts; here, that the service reads the right version and
// days, passes them, and stores what comes back.
describe('SessionsService.create — closed programs and swaps', () => {
  let service: SessionsService
  let sessionInserts: Record<string, unknown>[]
  // What the two queries of a session for another day answer: the
  // program's versions up to the later day, then their days (each with its
  // version's id). Each test can change them.
  let versionRows: { id: number; type: string; effectiveFrom: string }[]
  let dayRows: { scheduleId: number; weekday: number; workoutId: number }[]
  let versionWhere: jest.Mock
  let db: {
    query: Record<string, { findFirst?: jest.Mock; findMany?: jest.Mock }>
    select: jest.Mock
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  const patient = { id: 20, activeRole: UserRole.PATIENT }
  const today = utcToday()
  // A program started 2 days ago — so yesterday is in today's program week —
  // with workouts A (950) and B (951).
  const program = {
    ...OPEN_PROGRAM,
    startDate: addDays(today, -2),
    endDate: null,
    allowSwaps: true,
  }

  beforeEach(async () => {
    sessionInserts = []
    versionRows = [
      { id: 77, type: 'weekdays', effectiveFrom: program.startDate },
    ]
    dayRows = []
    versionWhere = jest.fn(() => Promise.resolve(versionRows))
    db = {
      query: {
        assignedPrograms: { findFirst: jest.fn().mockResolvedValue(program) },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue([
            { id: 950, name: null, sortOrder: 0 },
            { id: 951, name: null, sortOrder: 1 },
          ]),
        },
        assignedProgramExercises: {
          findMany: jest.fn().mockResolvedValue([{ id: 30, sortOrder: 0 }]),
        },
        sessions: { findFirst: jest.fn().mockResolvedValue({ id: 500 }) },
        sessionExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      // The first select is the versions query, the second the days query
      // (each awaited after where()).
      select: jest
        .fn()
        .mockImplementationOnce(() => ({
          from: () => ({ where: versionWhere }),
        }))
        .mockImplementation(() => ({
          from: () => ({ where: () => Promise.resolve(dayRows) }),
        })),
      insert: jest.fn(() => ({
        values: jest.fn((values: Record<string, unknown>) => {
          if (values.status === 'pending') sessionInserts.push(values)
          return {
            returning: jest.fn().mockResolvedValue([{ id: 500 }]),
          }
        }),
      })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()
    service = moduleRef.get(SessionsService)
  })

  it.each([
    ['completed', { status: 'completed', isArchived: false }],
    ['cancelled', { status: 'cancelled', isArchived: false }],
    ['archived', { status: 'active', isArchived: true }],
  ])(
    'refuses a session on a %s program, before writing',
    async (_label, state) => {
      db.query.assignedPrograms.findFirst!.mockResolvedValue({
        ...program,
        ...state,
      })

      await expect(
        service.create(patient, {
          assignedProgramId: 5,
          localDate: today,
          workoutId: 950,
        }),
      ).rejects.toThrow(ConflictException)
      expect(db.insert).not.toHaveBeenCalled()
    },
  )

  // Yesterday's workout was B, and today is a scheduled day (A): a swap's
  // second half for yesterday, with no workoutId, is recorded as B and
  // keeps the day it counts for.
  it("records a swap with the counted day's workout", async () => {
    const yesterday = addDays(today, -1)
    dayRows = [
      { scheduleId: 77, weekday: isoWeekdayOf(yesterday), workoutId: 951 },
      { scheduleId: 77, weekday: isoWeekdayOf(today), workoutId: 950 },
    ]

    await service.create(patient, {
      assignedProgramId: 5,
      localDate: today,
      countsFor: yesterday,
    })

    expect(sessionInserts).toEqual([
      expect.objectContaining({ workoutId: 951, countsFor: yesterday }),
    ])
    expect(versionWhere).toHaveBeenCalledTimes(1)
  })

  // An ordinary session stores no swap — and reads no schedule.
  it('stores countsFor null for an ordinary session, reading no schedule', async () => {
    await service.create(patient, {
      assignedProgramId: 5,
      localDate: today,
      workoutId: 950,
    })

    expect(sessionInserts).toEqual([
      expect.objectContaining({ workoutId: 950, countsFor: null }),
    ])
    expect(db.select).not.toHaveBeenCalled()
  })

  // The swap rules' refusal reaches the patient, and nothing is written.
  it('refuses a swap for a day the schedule has no workout on, before writing', async () => {
    dayRows = []

    await expect(
      service.create(patient, {
        assignedProgramId: 5,
        localDate: today,
        countsFor: addDays(today, -1),
      }),
    ).rejects.toThrow(BadRequestException)
    expect(sessionInserts).toEqual([])
  })

  // Today is a FREE day: counting for yesterday would be catching up a
  // missed day — a make-up, not a link. The rule needs today's schedule,
  // which the service reads with the counted day's.
  it('refuses a session on a free day for an earlier day, before writing', async () => {
    const yesterday = addDays(today, -1)
    dayRows = [
      { scheduleId: 77, weekday: isoWeekdayOf(yesterday), workoutId: 951 },
    ]

    await expect(
      service.create(patient, {
        assignedProgramId: 5,
        localDate: today,
        countsFor: yesterday,
      }),
    ).rejects.toThrow(
      new BadRequestException(
        `A session can count for an earlier day only when it's done on a scheduled day, as a swap. To catch up ${yesterday}, do its workout before the next scheduled day: it counts as a make-up`,
      ),
    )
    expect(sessionInserts).toEqual([])
  })

  // Each version gets ITS days: the rows are matched by scheduleId. Two
  // versions, the newer (from today) scheduling B tomorrow; the older one
  // A. A session done early for tomorrow does B.
  it("gives each version its own days, so the counted day's version decides", async () => {
    const tomorrow = addDays(today, 1)
    versionRows = [
      { id: 77, type: 'weekdays', effectiveFrom: program.startDate },
      { id: 78, type: 'weekdays', effectiveFrom: today },
    ]
    dayRows = [
      { scheduleId: 77, weekday: isoWeekdayOf(tomorrow), workoutId: 950 },
      { scheduleId: 78, weekday: isoWeekdayOf(tomorrow), workoutId: 951 },
    ]

    await service.create(patient, {
      assignedProgramId: 5,
      localDate: today,
      countsFor: tomorrow,
    })

    expect(sessionInserts).toEqual([
      expect.objectContaining({ workoutId: 951, countsFor: tomorrow }),
    ])
  })

  // No version at all (not possible inside a program): no days query.
  it('reads no days when there is no version', async () => {
    versionRows = []

    await expect(
      service.create(patient, {
        assignedProgramId: 5,
        localDate: today,
        countsFor: addDays(today, 1),
      }),
    ).rejects.toThrow(BadRequestException)
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  // The days of THE version in force — its type passed on: a weekly-count
  // version means no rearranging at all.
  it('refuses a swap under a weekly-count version, whatever its days', async () => {
    versionRows = [
      { id: 78, type: 'times_per_week', effectiveFrom: program.startDate },
    ]

    await expect(
      service.create(patient, {
        assignedProgramId: 5,
        localDate: today,
        countsFor: addDays(today, -1),
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Only schedules with specific days can be rearranged: with a weekly count, any order within the week already counts',
      ),
    )
  })
})

// The ISO weekday (1 = Monday) of a calendar date, for building day rows.
function isoWeekdayOf(day: string): number {
  return ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
}