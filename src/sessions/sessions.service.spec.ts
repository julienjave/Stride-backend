import { Test } from '@nestjs/testing'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { SessionsService } from './sessions.service'
import { UsersService } from '../users/users.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { SessionStatus } from './dto/update-session.dto'
import { UserRole } from '../users/dto/create-user.dto'

describe('SessionsService.create', () => {
  let service: SessionsService
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      sessions: { findFirst: jest.Mock }
      sessionExercises: { findMany: jest.Mock }
    }
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        assignedPrograms: { findFirst: jest.fn() },
        sessions: {
          findFirst: jest.fn().mockResolvedValue({ id: 500, patientId: 20 }),
        },
        sessionExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      transaction: jest.fn(),
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
        { assignedProgramId: 999 },
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
        { assignedProgramId: 5 },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("creates the session and pre-populates it from the program's current exercises", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      id: 5,
      patientId: 20,
    })

    const sessionExerciseInserts: any[] = []
    db.transaction.mockImplementation((cb: any) =>
      cb({
        insert: jest.fn().mockImplementation(() => ({
          values: jest.fn().mockImplementation((values: any) => {
            if (
              values.assignedProgramId !== undefined &&
              values.status === 'pending'
            ) {
              return {
                returning: jest
                  .fn()
                  .mockResolvedValue([{ id: 500, ...values }]),
              }
            }
            sessionExerciseInserts.push(values)
            return Promise.resolve(undefined)
          }),
        })),
        query: {
          assignedProgramExercises: {
            findMany: jest.fn().mockResolvedValue([
              { id: 30, sortOrder: 0 },
              { id: 31, sortOrder: 1 },
            ]),
          },
        },
      }),
    )

    const result = await service.create(
      { id: 20, activeRole: UserRole.PATIENT },
      { assignedProgramId: 5 },
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
})

describe('SessionsService.assertCanView (via findOne)', () => {
  let service: SessionsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      sessions: { findFirst: jest.Mock }
      sessionExercises: { findMany: jest.Mock }
    }
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
