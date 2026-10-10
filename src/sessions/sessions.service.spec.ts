import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { SessionsService, assertLocalDateIsToday } from './sessions.service'
import { UsersService } from '../users/users.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { SessionStatus } from './dto/update-session.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { addDays, utcToday } from '../common/calendar-date'

describe('SessionsService.create', () => {
  let service: SessionsService
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
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
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      id: 5,
      patientId: 20,
    })

    const sessionExerciseInserts: any[] = []
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      { id: 30, sortOrder: 0 },
      { id: 31, sortOrder: 1 },
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

    expect(sessionExerciseInserts).toHaveLength(2)
    expect(sessionExerciseInserts[0]).toEqual(
      expect.objectContaining({
        sessionId: 500,
        assignedProgramExerciseId: 30,
        completed: false,
      }),
    )
    expect(result).toEqual(expect.objectContaining({ id: 500 }))
  })

  // The session row carries the patient's own day, exactly as sent.
  it("stores the patient's local date on the session", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      id: 5,
      patientId: 20,
    })
    const sessionInserts: Record<string, unknown>[] = []
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
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
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      id: 5,
      patientId: 20,
    })

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