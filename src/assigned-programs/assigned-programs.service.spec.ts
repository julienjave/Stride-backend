import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { AssignedProgramsService } from './assigned-programs.service'
import { UsersService } from '../users/users.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'

describe('AssignedProgramsService.create', () => {
  let service: AssignedProgramsService
  let usersService: {
    isPatientManagedBy: jest.Mock
    findPatientsForPractitioner: jest.Mock
  }
  let db: {
    query: {
      templateExercises: { findMany: jest.Mock }
      assignedPrograms: { findFirst: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
    }
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = {
      isPatientManagedBy: jest.fn(),
      findPatientsForPractitioner: jest.fn(),
    }
    db = {
      query: {
        templateExercises: { findMany: jest.fn() },
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 900, patientId: 20, isArchived: false }),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      insert: jest.fn(),
      // withRlsContext() runs every query through db.transaction(), setting
      // two session GUCs via tx.execute() before invoking the callback —
      // tx === db here, so the callback's queries resolve against the same
      // mocks configured above.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  it('refuses to assign a program to a patient the practitioner does not manage', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: 'Rehab Plan',
          startDate: '2026-01-01',
          exercises: [{ exerciseId: 1, sortOrder: 0 }],
        },
      ),
    ).rejects.toThrow(ForbiddenException)

    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('rejects when neither basedOnTemplateId nor an inline exercises array is provided', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { patientId: 20, title: 'Rehab Plan', startDate: '2026-01-01' },
      ),
    ).rejects.toThrow(BadRequestException)
  })

  it('throws NotFoundException when the source template has no exercises to copy', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.templateExercises.findMany.mockResolvedValue([])

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: 'Rehab Plan',
          startDate: '2026-01-01',
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(NotFoundException)
  })

  it('copies the template exercises into independent rows, not references to the template', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.templateExercises.findMany.mockResolvedValue([
      {
        exerciseId: 1,
        sets: 3,
        reps: 10,
        durationInSeconds: null,
        sortOrder: 0,
        notes: null,
      },
    ])

    const inserted: any[] = []
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: any) => {
        inserted.push(values)
        return {
          returning: jest.fn().mockResolvedValue([{ id: 900, ...values }]),
        }
      }),
    }))

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        patientId: 20,
        title: 'Rehab Plan',
        startDate: '2026-01-01',
        basedOnTemplateId: 55,
      },
    )

    // One insert for the program itself, one for the copied exercise row —
    // this row is a brand-new record, never an FK back to templateExercises.
    expect(inserted).toHaveLength(2)
    expect(inserted[1]).toEqual(
      expect.objectContaining({
        assignedProgramId: 900,
        exerciseId: 1,
        sets: 3,
        reps: 10,
      }),
    )
  })

  it('uses the inline exercises array directly when no template is referenced', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)

    const inserted: any[] = []
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: any) => {
        inserted.push(values)
        return {
          returning: jest.fn().mockResolvedValue([{ id: 901, ...values }]),
        }
      }),
    }))

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        patientId: 20,
        title: 'Ad-hoc Plan',
        startDate: '2026-01-01',
        exercises: [{ exerciseId: 3, sortOrder: 0 }],
      },
    )

    expect(db.query.templateExercises.findMany).not.toHaveBeenCalled()
    expect(inserted[1]).toEqual(expect.objectContaining({ exerciseId: 3 }))
  })
})

describe('AssignedProgramsService.findAllForCurrentUser', () => {
  let service: AssignedProgramsService
  let usersService: {
    isPatientManagedBy: jest.Mock
    findPatientsForPractitioner: jest.Mock
  }
  let db: {
    query: { assignedPrograms: { findMany: jest.Mock } }
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = {
      isPatientManagedBy: jest.fn(),
      findPatientsForPractitioner: jest.fn(),
    }
    db = {
      query: {
        assignedPrograms: {
          findMany: jest.fn().mockResolvedValue([{ id: 1 }]),
        },
      },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  it('returns every program for an admin', async () => {
    await service.findAllForCurrentUser({ id: 1, activeRole: UserRole.ADMIN })
    expect(db.query.assignedPrograms.findMany).toHaveBeenCalled()
    expect(usersService.findPatientsForPractitioner).not.toHaveBeenCalled()
  })

  it("returns only the patient's own programs for a patient", async () => {
    await service.findAllForCurrentUser({
      id: 20,
      activeRole: UserRole.PATIENT,
    })
    expect(db.query.assignedPrograms.findMany).toHaveBeenCalled()
    expect(usersService.findPatientsForPractitioner).not.toHaveBeenCalled()
  })

  it('returns an empty list for a practitioner managing no patients, without querying programs', async () => {
    usersService.findPatientsForPractitioner.mockResolvedValue([])

    const result = await service.findAllForCurrentUser({
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(result).toEqual([])
  })

  it("returns only managed patients' programs for a practitioner", async () => {
    usersService.findPatientsForPractitioner.mockResolvedValue([
      { id: 20 },
      { id: 21 },
    ])

    await service.findAllForCurrentUser({
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(db.query.assignedPrograms.findMany).toHaveBeenCalled()
  })
})

describe('AssignedProgramsService.assertCanView (via findOne)', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
    }
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() }
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({ id: 900, patientId: 20 }),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  it('allows an admin to view any program', async () => {
    await expect(
      service.findOne(900, { id: 1, activeRole: UserRole.ADMIN }),
    ).resolves.toBeDefined()
  })

  it('allows the owning patient to view their own program', async () => {
    await expect(
      service.findOne(900, { id: 20, activeRole: UserRole.PATIENT }),
    ).resolves.toBeDefined()
  })

  it('rejects a different patient viewing a program that is not theirs', async () => {
    await expect(
      service.findOne(900, { id: 999, activeRole: UserRole.PATIENT }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows a managing practitioner to view the program', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    await expect(
      service.findOne(900, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).resolves.toBeDefined()
  })

  it('rejects a non-managing practitioner from viewing the program', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)
    await expect(
      service.findOne(900, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('AssignedProgramsService.assertCanManage (via update)', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: { assignedPrograms: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() }
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({ id: 900, patientId: 20 }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 900 }]),
          }),
        }),
      }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  it('rejects the owning PATIENT from managing their own program', async () => {
    // The single most important distinction of assertCanManage vs
    // assertCanView: a patient can look, never touch.
    await expect(
      service.update(
        900,
        { id: 20, activeRole: UserRole.PATIENT },
        { title: 'New Title' },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows the managing practitioner to update the program', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    await expect(
      service.update(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { title: 'New Title' },
      ),
    ).resolves.toEqual({ id: 900 })
  })

  it('rejects a non-managing practitioner from updating the program', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)
    await expect(
      service.update(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { title: 'New Title' },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows an admin to update any program', async () => {
    await expect(
      service.update(
        900,
        { id: 1, activeRole: UserRole.ADMIN },
        { title: 'New Title' },
      ),
    ).resolves.toEqual({ id: 900 })
  })
})

describe('AssignedProgramsService.reorderExercises', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
    }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }
  let txUpdate: jest.Mock

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) }
    txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    })

    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({ id: 900, patientId: 20 }),
        },
        // Two calls happen per successful reorder: reorderExercises' own
        // transaction (the permutation-check read), then
        // findProgramWithExercises' read of real post-write state once
        // that transaction has committed. Both default to the same three
        // rows unless a test targets the first call specifically via
        // mockResolvedValueOnce.
        assignedProgramExercises: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]),
        },
      },
      update: txUpdate,
      // withRlsContext() wraps EVERY query in its own db.transaction() call
      // now (findProgramOrThrow, reorderExercises' own read-validate-write,
      // and findProgramWithExercises' two reads) — tx === db throughout, so
      // all of them resolve against the mocks configured above.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  it('accepts an exact permutation of the current exercise rows', async () => {
    await service.reorderExercises(
      900,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [3, 1, 2],
    )
    expect(db.transaction).toHaveBeenCalled()
    expect(txUpdate).toHaveBeenCalledTimes(3)
  })

  it('rejects an order that does not match the current set of rows, without writing anything', async () => {
    await expect(
      service.reorderExercises(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [1, 2],
      ),
    ).rejects.toThrow(BadRequestException)
    // The permutation check now runs inside the transaction (alongside the
    // read it validates against), so the transaction IS entered — it just
    // never reaches the update loop before throwing.
    expect(db.transaction).toHaveBeenCalled()
    expect(txUpdate).not.toHaveBeenCalled()
  })

  // Regression coverage for the TOCTOU fix — see the matching test in
  // programs.service.spec.ts for the full rationale: the permutation check
  // must validate against the read taken INSIDE reorderExercises' own
  // transaction. findProgramOrThrow's assignedPrograms.findFirst is a
  // separate, prior call, so the very first assignedProgramExercises.findMany
  // call is unambiguously that transaction's own read — mockResolvedValueOnce
  // targets exactly it, independent of the default the later
  // findProgramWithExercises call still sees.
  it("validates the permutation against the transaction's own read", async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValueOnce([
      { id: 1 },
      { id: 2 },
    ])

    await expect(
      service.reorderExercises(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [1, 2, 3],
      ),
    ).rejects.toThrow(BadRequestException)
    expect(txUpdate).not.toHaveBeenCalled()
  })
})
