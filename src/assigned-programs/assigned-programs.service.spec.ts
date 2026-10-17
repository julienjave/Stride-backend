import { Test } from '@nestjs/testing'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import {
  AssignedProgramsService,
  assertScheduleDayAllowed,
  planRemoval,
} from './assigned-programs.service'
import { addDays, utcToday } from '../common/calendar-date'
import { AuditService } from '../audit/audit.service'
import { StorageService } from '../storage/storage.service'

// The audit entries written by create / update / addScheduleVersion
// (AuditService.logInTransaction) — shared by every test module below, and
// cleared before each test.
const auditService = {
  logInTransaction: jest.fn().mockResolvedValue(undefined),
}
beforeEach(() => {
  auditService.logInTransaction.mockReset()
  auditService.logInTransaction.mockResolvedValue(undefined)
})

// Signs the library photos a program exercise shows (findProgramWithExercises).
// A fake signer: the "URL" names its key, so a test can see WHICH photos, in
// WHICH order, reached the response — no storage, no clock.
const storageService = {
  getPresignedUrl: jest.fn((key: string) => Promise.resolve(`signed:${key}`)),
  // The writes of program-specific photos (2026-10-17): each test that
  // reaches them gives them their behaviour (the "own photos" tests).
  upload: jest.fn(),
  copy: jest.fn(),
  deleteUnreferenced: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
}
import { UsersService } from '../users/users.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'
import { ScheduleType } from './dto/schedule-input.dto'

// Every program has at least one workout, and the full program (what most
// writes answer with) includes them. Most tests here use a one-workout
// program; their exercise rows predate workouts (no workoutId), which
// orderExercisesByWorkout handles by keeping their own order.
// What every program mock carries unless a test says otherwise: an active,
// not archived program — the only kind that may change (program-state.ts).
const OPEN_STATE = { status: 'active', isArchived: false } as const

const PROGRAM_WORKOUTS = [
  { id: 950, assignedProgramId: 900, name: null, sortOrder: 0 },
]

// A schedule for the create() calls that aren't about schedules — the DTO
// requires one. Deliberately NOT in order ([5, 1, 3]): create() must sort it.
// Days given by workout POSITION (0 = A), as when assigning — and
// deliberately not in weekday order (Friday first): create() must sort them.
const MWF = {
  type: ScheduleType.WEEKDAYS,
  days: [
    { weekday: 5, workoutIndex: 0 },
    { weekday: 1, workoutIndex: 0 },
    { weekday: 3, workoutIndex: 0 },
  ],
}

describe('AssignedProgramsService.create', () => {
  let service: AssignedProgramsService
  let usersService: {
    isPatientManagedBy: jest.Mock
    findPatientsForPractitioner: jest.Mock
  }
  let db: {
    query: {
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
      programTemplates: { findFirst: jest.Mock }
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
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
        // The template's workouts: one (id 70), like most templates.
        templateWorkouts: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 70, templateId: 55, name: null, sortOrder: 0 },
            ]),
        },
        templateExercises: { findMany: jest.fn() },
        // The template row, read before its exercises (archived check).
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 55, isArchived: false }),
        },
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 900, patientId: 20, isArchived: false }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
        // Used by fetchExerciseSnapshots, now called by BOTH branches of
        // resolveSourceExercises (copying from a template, and an inline
        // exercises array) — every test in this block that reaches
        // either branch needs this populated with whatever exercises it
        // references, or the snapshot lookup finds nothing and throws
        // NotFoundException.
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
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
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
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
          schedule: MWF,
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
        {
          patientId: 20,
          title: 'Rehab Plan',
          startDate: '2026-01-01',
          schedule: MWF,
        },
      ),
    ).rejects.toThrow(BadRequestException)
  })

  // A 400, no longer a 404: the template exists (it was found), so "not
  // found" would describe the wrong problem.
  it('refuses a template that has no exercises to copy', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.templateExercises.findMany.mockResolvedValue([])

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: 'Rehab Plan',
          startDate: '2026-01-01',
          schedule: MWF,
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(
      new BadRequestException('Program template 55 has no exercises to copy'),
    )
  })

  it("refuses a template that doesn't exist", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.programTemplates.findFirst.mockResolvedValue(undefined)

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: 'Rehab Plan',
          startDate: '2026-01-01',
          schedule: MWF,
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(new NotFoundException('Program template 55 not found'))
  })

  // The gap from deferred-improvements.md. The template still HAS its
  // exercises (archiving doesn't remove them) — which is exactly why the
  // old code, reading only the exercises, let it through.
  it('refuses an archived template, without creating anything', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 55,
      isArchived: true,
    })
    db.query.templateExercises.findMany.mockResolvedValue([
      { exerciseId: 1, sortOrder: 0 },
    ])

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: 'Rehab Plan',
          startDate: '2026-01-01',
          schedule: MWF,
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(
      new BadRequestException('Archived program templates cannot be assigned'),
    )
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('copies the template exercises into independent rows, not references to the template', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.templateExercises.findMany.mockResolvedValue([
      {
        exerciseId: 1,
        workoutId: 70,
        sets: 3,
        reps: 10,
        durationInSeconds: null,
        weight: 62.5,
        weightUnit: 'kg',
        sortOrder: 0,
        notes: null,
      },
    ])
    // The exercise's CURRENT data at the moment of copy — this is what
    // fetchExerciseSnapshots reads to build the snapshot.
    db.query.exercises.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Squat',
        primaryMuscles: ['legs'],
        secondaryMuscles: ['core'],
        equipment: ['barbell'],
        instructions: ['Step one'],
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
        schedule: MWF,
        basedOnTemplateId: 55,
      },
    )

    // One insert for the program itself, one for its copy of the template's
    // workout, one for the copied exercise row — this row is a brand-new
    // record, never an FK back to templateExercises — and two for the
    // program's first schedule version: the version, then its days (tested
    // below).
    expect(inserted).toHaveLength(5)
    expect(inserted[1]).toEqual({
      assignedProgramId: 900,
      name: null,
      sortOrder: 0,
    })
    // Full equality, not objectContaining — a partial match is exactly
    // what let weight/weightUnit go silently missing from this copy the
    // first time (objectContaining only checks the properties you
    // remember to list, so a field the copy logic drops just never gets
    // caught). Every field the source row and the referenced exercise
    // carried must survive the copy.
    expect(inserted[2]).toEqual({
      assignedProgramId: 900,
      // The PROGRAM's copy of the workout (every insert in these mocks
      // answers with id 900), never the template's workout 70.
      workoutId: 900,
      exerciseId: 1,
      name: 'Squat',
      primaryMuscles: ['legs'],
      secondaryMuscles: ['core'],
      equipment: ['barbell'],
      instructions: ['Step one'],
      sets: 3,
      reps: 10,
      // undefined, not null — resolveSourceExercises converts a
      // template row's null optional fields to undefined (`?? undefined`)
      // before they reach this insert; Drizzle treats an undefined
      // column the same as "not provided" (the column's own default,
      // effectively NULL for a nullable column with none set), so this
      // is the real value this insert actually receives, not a mistake
      // in this test's fixture.
      durationInSeconds: undefined,
      weight: 62.5,
      weightUnit: 'kg',
      sortOrder: 0,
      // From a template: the library's photos, no own ones (the column
      // defaults, written out).
      useLibraryImages: true,
      mediaUrls: [],
      notes: undefined,
    })
  })

  it("uses the inline exercises array directly when no template is referenced, snapshotting each exercise's current details", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.exercises.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Lunge',
        primaryMuscles: ['legs'],
        secondaryMuscles: [],
        equipment: [],
        instructions: ['Step one'],
      },
    ])

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
        schedule: MWF,
        exercises: [{ exerciseId: 3, sortOrder: 0 }],
      },
    )

    expect(db.query.templateExercises.findMany).not.toHaveBeenCalled()
    // An inline list is one unnamed workout...
    expect(inserted[1]).toEqual({
      assignedProgramId: 901,
      name: null,
      sortOrder: 0,
    })
    // ...holding the exercise.
    expect(inserted[2]).toEqual(
      expect.objectContaining({ exerciseId: 3, name: 'Lunge', workoutId: 901 }),
    )
  })

  it('rejects an inline exercises array referencing an exercise that does not exist — a real validation gap closed by snapshotting', async () => {
    // Before snapshotting made fetching each exercise unavoidable, this
    // path never checked existence at all — an inline exerciseId that
    // didn't exist would have been silently inserted anyway.
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.exercises.findMany.mockResolvedValue([]) // nothing found

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: 'Ad-hoc Plan',
          startDate: '2026-01-01',
          schedule: MWF,
          exercises: [{ exerciseId: 999, sortOrder: 0 }],
        },
      ),
    ).rejects.toThrow(NotFoundException)
  })

  // --- schedule and dates ---

  // Records every insert, in order; each answers like .returning() would.
  // Typed rows rather than any[]: what's read back from them stays
  // type-checked (and lint-clean).
  function recordInserts() {
    const inserted: Record<string, unknown>[] = []
    db.insert.mockImplementation(() => ({
      values: jest
        .fn()
        .mockImplementation((values: Record<string, unknown>) => {
          inserted.push(values)
          return {
            returning: jest.fn().mockResolvedValue([{ id: 900, ...values }]),
          }
        }),
    }))
    return inserted
  }

  const inlineProgram = {
    patientId: 20,
    title: 'Rehab Plan',
    startDate: '2026-10-15',
    exercises: [{ exerciseId: 3, sortOrder: 0 }],
  }

  function knownExercise() {
    db.query.exercises.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Lunge',
        primaryMuscles: [],
        secondaryMuscles: [],
        equipment: [],
        instructions: [],
      },
    ])
  }

  // toStrictEqual: timesPerWeek must be an explicit null (the database's
  // fields-match-type check needs it NULL) and nothing extra may sneak in.
  // The inserts, in order: program, workout, exercise, the VERSION, then its
  // days (one multi-row insert). MWF is sent Friday first: the days are
  // written in weekday order, each with the program's new workout (every
  // insert in these mocks answers with id 900).
  it("saves the schedule as the program's first version with its days, in weekday order", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    knownExercise()
    const inserted = recordInserts()

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { ...inlineProgram, schedule: MWF },
    )

    expect(inserted[inserted.length - 2]).toStrictEqual({
      assignedProgramId: 900,
      type: 'weekdays',
      timesPerWeek: null,
      effectiveFrom: '2026-10-15',
      createdBy: 7,
    })
    expect(inserted[inserted.length - 1]).toStrictEqual(
      [1, 3, 5].map((weekday) => ({
        scheduleId: 900,
        assignedProgramId: 900,
        weekday,
        workoutId: 900,
      })),
    )
  })

  it("doesn't reorder the caller's own days while sorting", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    knownExercise()
    recordInserts()
    const schedule = structuredClone(MWF)

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { ...inlineProgram, schedule },
    )

    expect(schedule.days.map((day) => day.weekday)).toEqual([5, 1, 3])
  })

  // No rotation sent: every workout in order — here the inline list's one.
  it('saves a times-per-week schedule with its rotation and no days', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    knownExercise()
    const inserted = recordInserts()

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        ...inlineProgram,
        schedule: { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 3 },
      },
    )

    expect(inserted[inserted.length - 2]).toStrictEqual({
      assignedProgramId: 900,
      type: 'times_per_week',
      timesPerWeek: 3,
      effectiveFrom: '2026-10-15',
      createdBy: 7,
    })
    expect(inserted[inserted.length - 1]).toStrictEqual([
      { scheduleId: 900, assignedProgramId: 900, position: 0, workoutId: 900 },
    ])
  })

  // The position is resolved once the workouts exist: one the inline list
  // (one workout) doesn't have is refused — inside the transaction, so the
  // program, workout and exercise already inserted roll back with it.
  it("refuses a workout position the program doesn't have", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    knownExercise()
    recordInserts()

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          ...inlineProgram,
          schedule: {
            type: ScheduleType.WEEKDAYS,
            days: [{ weekday: 1, workoutIndex: 1 }],
          },
        },
      ),
    ).rejects.toThrow(
      new BadRequestException(
        "workoutIndex 1 doesn't exist: the program has 1 workout (A)",
      ),
    )
  })

  // The whole prescription as assigned, in ONE entry written in the
  // program's own transaction: dates, the first schedule version, every
  // exercise with its prescription — what the patient was given, by whom.
  it('audits the program as assigned: dates, schedule and every exercise', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.exercises.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Lunge',
        primaryMuscles: [],
        secondaryMuscles: [],
        equipment: [],
        instructions: [],
      },
    ])
    recordInserts()

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        ...inlineProgram,
        endDate: '2026-12-15',
        exercises: [{ exerciseId: 3, sortOrder: 0, sets: 3, reps: 12 }],
        schedule: MWF,
      },
    )

    expect(auditService.logInTransaction).toHaveBeenCalledTimes(1)
    // Typed: a jest mock's recorded arguments are `any` otherwise.
    const [tx, entry] = auditService.logInTransaction.mock.calls[0] as [
      unknown,
      unknown,
    ]
    // Through the transaction the program was written in (tx === db in
    // these mocks, as withRlsContext passes it on).
    expect(tx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: 7,
      action: 'ASSIGNED_PROGRAM_CREATED',
      targetUserId: 20,
      entityType: 'assigned-programs',
      entityId: 900,
      details: {
        title: 'Rehab Plan',
        startDate: '2026-10-15',
        endDate: '2026-12-15',
        basedOnTemplateId: null,
        basedOnProgramId: null,
        // The practitioner's settings, as the row holds them. An ordinary
        // assignment inserts neither — the column defaults apply (swaps on,
        // late make-ups off) — and this mock's row holds only what was
        // inserted; "Assign again" copying them is an e2e test.
        allowSwaps: undefined,
        lateMakeUpDays: undefined,
        // What .returning() gave back for the schedule row (the mock
        // answers every insert with id 900 and no createdAt).
        schedule: {
          id: 900,
          type: 'weekdays',
          timesPerWeek: null,
          days: [1, 3, 5].map((weekday) => ({ weekday, workoutId: 900 })),
          rotation: [],
          effectiveFrom: '2026-10-15',
          createdBy: 7,
          createdAt: undefined,
        },
        workouts: [{ id: 900, name: null, sortOrder: 0 }],
        exercises: [
          {
            workoutId: 900,
            exerciseId: 3,
            name: 'Lunge',
            sets: 3,
            reps: 12,
            durationInSeconds: null,
            weight: null,
            weightUnit: null,
            sortOrder: 0,
            notes: null,
            useLibraryImages: true,
            ownPhotos: [],
          },
        ],
      },
    })
  })

  it('refuses an end date before the start date, before writing anything', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    knownExercise()

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { ...inlineProgram, endDate: '2026-10-14', schedule: MWF },
      ),
    ).rejects.toThrow(
      new BadRequestException("The end date can't be before the start date"),
    )
    expect(db.transaction).not.toHaveBeenCalled()
  })

  // The boundary: a one-day program is legitimate (>=, not >).
  it('accepts an end date on the start date', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    knownExercise()
    recordInserts()

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { ...inlineProgram, endDate: '2026-10-15', schedule: MWF },
      ),
    ).resolves.toBeDefined()
  })
})

describe('AssignedProgramsService.findAllForCurrentUser', () => {
  let service: AssignedProgramsService
  let usersService: {
    isPatientManagedBy: jest.Mock
    findPatientsForPractitioner: jest.Mock
  }
  // The assigners' names come from ONE select().from().where() chain;
  // `assignerRows` is what that query answers, `assignerWhere` records it.
  let assignerRows: { id: number; firstName: string; lastName: string }[]
  let assignerWhere: jest.Mock
  let db: {
    query: {
      assignedPrograms: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
    }
    select: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = {
      isPatientManagedBy: jest.fn(),
      findPatientsForPractitioner: jest.fn(),
    }
    assignerRows = [{ id: 7, firstName: 'Alex', lastName: 'Moreau' }]
    assignerWhere = jest.fn(() => Promise.resolve(assignerRows))
    db = {
      query: {
        assignedPrograms: {
          findMany: jest.fn().mockResolvedValue([{ id: 1, assignedBy: 7 }]),
        },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
        programWorkouts: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn(() => ({ from: () => ({ where: assignerWhere }) })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
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
    // Nothing to name either: no query for assigners.
    expect(db.select).not.toHaveBeenCalled()
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

  it("adds each program's assigner, all looked up in ONE query", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([
      { id: 1, assignedBy: 7 },
      { id: 2, assignedBy: 8 },
      { id: 3, assignedBy: 7 },
    ])
    assignerRows = [
      { id: 7, firstName: 'Alex', lastName: 'Moreau' },
      { id: 8, firstName: 'Sam', lastName: 'Okafor' },
    ]

    const result = await service.findAllForCurrentUser({
      id: 1,
      activeRole: UserRole.ADMIN,
    })

    expect(result).toEqual([
      {
        id: 1,
        assignedBy: 7,
        assigner: { id: 7, firstName: 'Alex', lastName: 'Moreau' },
        schedules: [],
        workouts: [],
      },
      {
        id: 2,
        assignedBy: 8,
        assigner: { id: 8, firstName: 'Sam', lastName: 'Okafor' },
        schedules: [],
        workouts: [],
      },
      {
        id: 3,
        assignedBy: 7,
        assigner: { id: 7, firstName: 'Alex', lastName: 'Moreau' },
        schedules: [],
        workouts: [],
      },
    ])
    // One query for three programs — not one per program.
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  // The naive version — one query per program — would give the same result
  // here; the call count is what tells them apart. Program 2's versions are
  // deliberately interleaved with program 1's in the query's answer: grouping
  // must follow assignedProgramId, not the rows' positions.
  it("adds each program's schedule versions, grouped by program, from ONE query", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([
      { id: 1, assignedBy: 7 },
      { id: 2, assignedBy: 7 },
      { id: 3, assignedBy: 7 },
    ])
    db.query.programSchedules.findMany.mockResolvedValue([
      { id: 10, assignedProgramId: 1, effectiveFrom: '2026-10-01' },
      { id: 20, assignedProgramId: 2, effectiveFrom: '2026-10-02' },
      { id: 11, assignedProgramId: 1, effectiveFrom: '2026-10-12' },
    ])

    const result = await service.findAllForCurrentUser({
      id: 1,
      activeRole: UserRole.ADMIN,
    })

    expect(result.map((p) => [p.id, p.schedules.map((v) => v.id)])).toEqual([
      [1, [10, 11]],
      [2, [20]],
      // A program with no version in the answer gets [], never undefined.
      [3, []],
    ])
    expect(db.query.programSchedules.findMany).toHaveBeenCalledTimes(1)
  })

  it("doesn't look for schedules or workouts when there are no programs", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([])

    await expect(
      service.findAllForCurrentUser({ id: 1, activeRole: UserRole.ADMIN }),
    ).resolves.toEqual([])
    expect(db.query.programSchedules.findMany).not.toHaveBeenCalled()
    expect(db.query.programWorkouts.findMany).not.toHaveBeenCalled()
  })

  // As for the versions: the query's answer interleaves the programs AND
  // lists each program's workouts out of order — grouping must follow
  // assignedProgramId, and each program's list must be put in order
  // (position, then id on a tie: 51 and 52 share position 1).
  it("adds each program's workouts, grouped and in order, from ONE query", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([
      { id: 1, assignedBy: 7 },
      { id: 2, assignedBy: 7 },
      { id: 3, assignedBy: 7 },
    ])
    db.query.programWorkouts.findMany.mockResolvedValue([
      { id: 52, assignedProgramId: 1, name: null, sortOrder: 1 },
      { id: 60, assignedProgramId: 2, name: 'Strength', sortOrder: 0 },
      { id: 50, assignedProgramId: 1, name: 'Mobility', sortOrder: 0 },
      { id: 51, assignedProgramId: 1, name: null, sortOrder: 1 },
    ])

    const result = await service.findAllForCurrentUser({
      id: 1,
      activeRole: UserRole.ADMIN,
    })

    expect(result.map((p) => [p.id, p.workouts.map((w) => w.id)])).toEqual([
      [1, [50, 51, 52]],
      [2, [60]],
      // None in the answer → [], never undefined.
      [3, []],
    ])
    // The rows themselves, untouched (names included).
    expect(result[1].workouts).toStrictEqual([
      { id: 60, assignedProgramId: 2, name: 'Strength', sortOrder: 0 },
    ])
    expect(db.query.programWorkouts.findMany).toHaveBeenCalledTimes(1)
  })

  describe('with patientId', () => {
    it("lets a practitioner on the care team list that patient's programs", async () => {
      usersService.isPatientManagedBy.mockResolvedValue(true)

      const result = await service.findAllForCurrentUser(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        20,
      )

      expect(usersService.isPatientManagedBy).toHaveBeenCalledWith(20, 7)
      expect(result).toHaveLength(1)
      // Not the whole roster: the patient's list replaces it.
      expect(usersService.findPatientsForPractitioner).not.toHaveBeenCalled()
    })

    it('refuses a practitioner who is not on the care team, without querying programs', async () => {
      usersService.isPatientManagedBy.mockResolvedValue(false)

      await expect(
        service.findAllForCurrentUser(
          { id: 7, activeRole: UserRole.PRACTITIONER },
          20,
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to view this assigned program',
        ),
      )
      expect(db.query.assignedPrograms.findMany).not.toHaveBeenCalled()
    })

    it("refuses a patient asking for someone else's programs", async () => {
      await expect(
        service.findAllForCurrentUser(
          { id: 20, activeRole: UserRole.PATIENT },
          21,
        ),
      ).rejects.toThrow(ForbiddenException)
    })
  })
})

describe('AssignedProgramsService.assertCanView (via findOne)', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
    }
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() }
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...OPEN_STATE, id: 900, patientId: 20 }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
      },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
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

// "Exercise image upload", settled 2026-10-14: a program exercise shows its
// LIBRARY exercise's photos, read live — the program copies the text (the
// clinical record), not the illustrations. findOne goes through
// findProgramWithExercises, which every program answer uses.
describe("AssignedProgramsService.findOne — the library's photos", () => {
  let service: AssignedProgramsService
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
    execute: jest.Mock
    transaction: jest.Mock
  }
  const admin = { id: 1, activeRole: UserRole.ADMIN }

  // A program exercise row, with only what the read and the ordering use —
  // showing the library's photos, with no own ones, unless a test says so.
  const row = (
    id: number,
    exerciseId: number,
    sortOrder: number,
    retiredAt: Date | null = null,
    photos: { useLibraryImages: boolean; mediaUrls: string[] } = {
      useLibraryImages: true,
      mediaUrls: [],
    },
  ) => ({
    id,
    assignedProgramId: 900,
    workoutId: 950,
    exerciseId,
    sortOrder,
    retiredAt,
    ...photos,
  })

  beforeEach(async () => {
    storageService.getPresignedUrl.mockClear()
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...OPEN_STATE, id: 900, patientId: 20 }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
        // The library rows, as the column-limited query returns them.
        exercises: {
          findMany: jest.fn().mockResolvedValue([
            { id: 5, mediaUrls: ['exercises/5/b.jpg', 'exercises/5/a.jpg'] },
            { id: 6, mediaUrls: [] },
            { id: 7, mediaUrls: ['exercises/7/x.jpg'] },
          ]),
        },
      },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: { isPatientManagedBy: jest.fn() } },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()
    service = moduleRef.get(AssignedProgramsService)
  })

  // Each exercise gets its OWN library exercise's photos, signed, in the
  // library's order (the first is the cover: b before a, as stored). The
  // object key itself is not sent — toStrictEqual fails on any extra key.
  it("gives each exercise its library exercise's photos, signed, in the library's order", async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      row(31, 5, 0),
      row(32, 6, 1),
      row(33, 7, 2),
    ])
    const program = await service.findOne(900, admin)
    expect(
      program.exercises.map((exercise) => [exercise.id, exercise.images]),
    ).toStrictEqual([
      [
        31,
        [
          { url: 'signed:exercises/5/b.jpg' },
          { url: 'signed:exercises/5/a.jpg' },
        ],
      ],
      [32, []],
      [33, [{ url: 'signed:exercises/7/x.jpg' }]],
    ])
  })

  // Program-specific photos (2026-10-17): a row that doesn't use the
  // library's shows its OWN — even when its library exercise has photos
  // (exercise 5 here) — and every row lists its own photos WITH their keys
  // in `ownImages`, whichever is chosen (switching back keeps them).
  it("shows a row's own photos when it doesn't use the library's, and lists them with keys either way", async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      row(31, 5, 0, null, {
        useLibraryImages: false,
        mediaUrls: ['patients/20/b.png', 'patients/20/a.png'],
      }),
      row(32, 7, 1, null, {
        useLibraryImages: true,
        mediaUrls: ['patients/20/kept.png'],
      }),
      // "No photos", chosen: not the library's, and none of its own.
      row(33, 5, 2, null, { useLibraryImages: false, mediaUrls: [] }),
    ])
    const program = await service.findOne(900, admin)
    expect(
      program.exercises.map(({ id, images, ownImages }) => ({
        id,
        images,
        ownImages,
      })),
    ).toStrictEqual([
      {
        id: 31,
        images: [
          { url: 'signed:patients/20/b.png' },
          { url: 'signed:patients/20/a.png' },
        ],
        ownImages: [
          { objectKey: 'patients/20/b.png', url: 'signed:patients/20/b.png' },
          { objectKey: 'patients/20/a.png', url: 'signed:patients/20/a.png' },
        ],
      },
      {
        id: 32,
        images: [{ url: 'signed:exercises/7/x.jpg' }],
        ownImages: [
          {
            objectKey: 'patients/20/kept.png',
            url: 'signed:patients/20/kept.png',
          },
        ],
      },
      { id: 33, images: [], ownImages: [] },
    ])
    // The raw column is never sent.
    expect(
      program.exercises.map((exercise) => 'mediaUrls' in exercise),
    ).toEqual([false, false, false])
  })

  // Only rows that SHOW the library's photos need them: when none does,
  // the library isn't queried at all.
  it("doesn't read the library when no row shows its photos", async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      row(31, 5, 0, null, { useLibraryImages: false, mediaUrls: [] }),
    ])
    await service.findOne(900, admin)
    expect(db.query.exercises.findMany).not.toHaveBeenCalled()
  })

  // A removed (retired) exercise is still the record of what sessions did —
  // the program exercise page can show it, photos included.
  it('gives retired exercises their photos too', async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      row(31, 5, 0),
      row(34, 7, 1, new Date('2031-01-05T10:00:00Z')),
    ])
    const program = await service.findOne(900, admin)
    expect(
      program.retiredExercises.map((exercise) => exercise.images),
    ).toStrictEqual([[{ url: 'signed:exercises/7/x.jpg' }]])
  })

  // The same library exercise in two workouts (a copied warm-up): both rows
  // show its photos — and the library is read ONCE for the whole program.
  it('reads the library once for the whole program, even with an exercise used twice', async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      row(31, 5, 0),
      row(35, 5, 1),
    ])
    const program = await service.findOne(900, admin)
    expect(program.exercises.map((exercise) => exercise.images.length)).toEqual(
      [2, 2],
    )
    expect(db.query.exercises.findMany).toHaveBeenCalledTimes(1)
  })

  // No exercise at all: no library query (Drizzle refuses `IN ()`).
  it("doesn't read the library for a program with no exercises", async () => {
    const program = await service.findOne(900, admin)
    expect(program.exercises).toEqual([])
    expect(db.query.exercises.findMany).not.toHaveBeenCalled()
    expect(storageService.getPresignedUrl).not.toHaveBeenCalled()
  })

  // Only TypeScript's case (a foreign key guarantees the library row): a row
  // the library query didn't return shows no photos rather than failing.
  it("shows no photos for an exercise the library query didn't return", async () => {
    db.query.assignedProgramExercises.findMany.mockResolvedValue([
      row(36, 99, 0),
    ])
    const program = await service.findOne(900, admin)
    expect(program.exercises[0].images).toStrictEqual([])
  })
})

describe('AssignedProgramsService.assertCanManage (via update)', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
    }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }
  // What reached .set() — the PATCH's own fields, nothing else.
  let setValues: jest.Mock

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() }
    setValues = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    })
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            ...OPEN_STATE,
            id: 900,
            patientId: 20,
            startDate: '2026-10-01',
            endDate: '2026-12-31',
          }),
        },
        // update() answers with the full program (exercises, schedules).
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn().mockReturnValue({ set: setValues }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
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
    ).resolves.toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      workouts: PROGRAM_WORKOUTS,
      exercises: [],
      retiredExercises: [],
      schedules: [],
    })
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
    ).resolves.toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      workouts: PROGRAM_WORKOUTS,
      exercises: [],
      retiredExercises: [],
      schedules: [],
    })
  })
})

// --- The four exercise routes (step 3b-0) -------------------------------------------------------------
//
// Add, edit / move, reorder, remove: each writes ONE complete audit entry in
// its own transaction, writes nothing when nothing changes, and answers with
// the full program. One flexible mock database for all of them:
//   - `writes` records every write IN ORDER — [kind, details] — so a test can
//     say "the UPDATE, then its audit entry" or "nothing at all";
//   - `lockedRow` is what lockProgramExercise's SELECT … FOR UPDATE reads;
//   - `positions` what nextExercisePosition reads (the workout's
//     exercises' positions);
//   - `sessionCount` what the removal preview counts;
//   - `deleteError` makes the DELETE fail (a foreign key refusing it);
//   - `depth` is how many db.transaction() calls are open (the mock's tx IS
//     db): 1 inside withRlsContext, 2 inside a nested one — a SAVEPOINT. The
//     DELETE and the retiring UPDATE record the depth they ran at.
// Real behaviour against Postgres — the savepoint, the foreign key, the
// trigger — is proven in test/program-exercises.e2e-spec.ts; these pin the
// service's own decisions.
describe('AssignedProgramsService — the exercise routes (step 3b-0)', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let writes: [string, unknown][]
  let lockedRow: Record<string, unknown> | undefined
  let positions: { sortOrder: number }[]
  let sessionCount: number
  let deleteError: Error | undefined
  let forCalls: string[]
  let depth: number
  let depthOf: Record<string, number>
  let db: Record<string, unknown> & {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      exercises: { findFirst: jest.Mock; findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
    }
    transaction: jest.Mock
  }

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER }
  // Two workouts: A (950) and B (951).
  const workouts = [
    { id: 950, assignedProgramId: 900, name: null, sortOrder: 0 },
    { id: 951, assignedProgramId: 900, name: 'Strength', sortOrder: 1 },
  ]
  // Exercise row 31 as stored: in A, at position 1, 3 × 10.
  const storedRow = {
    id: 31,
    assignedProgramId: 900,
    workoutId: 950,
    exerciseId: 5,
    name: 'Squat',
    primaryMuscles: ['legs'],
    secondaryMuscles: [],
    equipment: [],
    instructions: ['Stand', 'Sit'],
    sets: 3,
    reps: 10,
    durationInSeconds: null,
    weight: null,
    weightUnit: null,
    sortOrder: 1,
    notes: null,
    retiredAt: null,
    retiredBy: null,
    useLibraryImages: true,
    mediaUrls: [] as string[],
  }
  // A stored row as a program ANSWER shows it (findProgramWithExercises):
  // the raw `mediaUrls` replaced by `ownImages` (none here), and `images` —
  // the library's photos, none in these mocks.
  const answered = <T extends { mediaUrls: string[] }>({
    mediaUrls: _mediaUrls,
    ...row
  }: T) => ({ ...row, images: [], ownImages: [] })
  // What the row as an audit entry records (exerciseForAudit): everything
  // but the program id and the retirement columns.
  const storedRowForAudit = {
    id: 31,
    workoutId: 950,
    exerciseId: 5,
    name: 'Squat',
    primaryMuscles: ['legs'],
    secondaryMuscles: [],
    equipment: [],
    instructions: ['Stand', 'Sit'],
    sets: 3,
    reps: 10,
    durationInSeconds: null,
    weight: null,
    weightUnit: null,
    sortOrder: 1,
    notes: null,
    useLibraryImages: true,
    ownPhotos: [],
  }

  beforeEach(async () => {
    writes = []
    lockedRow = { ...storedRow }
    positions = []
    sessionCount = 0
    deleteError = undefined
    forCalls = []
    depth = 0
    depthOf = {}
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) }
    auditService.logInTransaction.mockImplementation(
      (_tx: unknown, entry: unknown) => {
        writes.push(['audit', entry])
        return Promise.resolve(undefined)
      },
    )
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...OPEN_STATE, id: 900, patientId: 20 }),
        },
        programWorkouts: { findMany: jest.fn().mockResolvedValue(workouts) },
        exercises: {
          findFirst: jest.fn().mockResolvedValue({
            id: 5,
            name: 'Squat',
            primaryMuscles: ['legs'],
            secondaryMuscles: ['core'],
            equipment: ['barbell'],
            instructions: ['Step one'],
          }),
          // The library photos findProgramWithExercises reads (none here —
          // these tests are about the exercise routes, not photos).
          findMany: jest.fn().mockResolvedValue([]),
        },
        // findProgramWithExercises' read (and reorder's own read, which
        // tests override with mockResolvedValueOnce).
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
      },
      // One select chain serves every read, told apart by the fields asked
      // for: `{ sessionCount }` → the preview's count; `{ sortOrder }` → the
      // positions (nextExercisePosition); none (the whole row) → the
      // exercise row (lockProgramExercise) — awaited directly when read
      // without a lock, through .for("update") when locked.
      select: jest.fn((fields?: Record<string, unknown>) => ({
        from: () => ({
          where: () => {
            if (fields && 'sessionCount' in fields) {
              return Promise.resolve([{ sessionCount }])
            }
            const row = lockedRow ? [lockedRow] : []
            return Object.assign(Promise.resolve(fields ? positions : row), {
              for: jest.fn((strength: string) => {
                forCalls.push(strength)
                return Promise.resolve(row)
              }),
            })
          },
        }),
      })),
      insert: jest.fn(() => ({
        values: jest.fn((values: Record<string, unknown>) => {
          writes.push(['insert', values])
          return {
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 40, retiredAt: null, ...values }]),
          }
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn((values: unknown) => ({
          where: jest.fn(() => {
            writes.push(['update', values])
            depthOf.update = depth
            return Promise.resolve(undefined)
          }),
        })),
      })),
      delete: jest.fn(() => ({
        where: jest.fn(() => {
          depthOf.delete = depth
          if (deleteError) return Promise.reject(deleteError)
          writes.push(['delete', null])
          return Promise.resolve(undefined)
        }),
      })),
      execute: jest.fn().mockResolvedValue(undefined),
      // Like Drizzle's: the callback's result (or rejection) is the
      // transaction's; `depth` tracks the nesting while it runs.
      transaction: jest.fn(async (fn: (tx: unknown) => unknown) => {
        depth += 1
        try {
          return await fn(db)
        } finally {
          depth -= 1
        }
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()
    service = moduleRef.get(AssignedProgramsService)
  })

  // The audit entry common to every route: who, the patient, the program.
  const entry = (action: string, details: unknown) => ({
    performedBy: 7,
    action,
    targetUserId: 20,
    entityType: 'assigned-programs',
    entityId: 900,
    details,
  })

  describe('addExercise', () => {
    it('throws NotFoundException when the referenced exercise does not exist, writing nothing', async () => {
      db.query.exercises.findFirst.mockResolvedValue(undefined)

      await expect(
        service.addExercise(900, practitioner, { exerciseId: 999 }),
      ).rejects.toThrow(new NotFoundException('Exercise 999 not found'))
      expect(writes).toEqual([])
    })

    it('rejects a non-managing practitioner before ever checking the exercise exists', async () => {
      usersService.isPatientManagedBy.mockResolvedValue(false)

      await expect(
        service.addExercise(900, practitioner, { exerciseId: 5 }),
      ).rejects.toThrow(ForbiddenException)
      expect(db.query.exercises.findFirst).not.toHaveBeenCalled()
    })

    it("inserts every provided field and the exercise's snapshot, then its audit entry", async () => {
      await service.addExercise(900, practitioner, {
        exerciseId: 5,
        workoutId: 951,
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: 'kg',
        notes: 'Go slow',
        sortOrder: 4,
      })

      const values = {
        assignedProgramId: 900,
        workoutId: 951,
        exerciseId: 5,
        name: 'Squat',
        primaryMuscles: ['legs'],
        secondaryMuscles: ['core'],
        equipment: ['barbell'],
        instructions: ['Step one'],
        sets: 3,
        reps: 10,
        durationInSeconds: undefined,
        weight: 62.5,
        weightUnit: 'kg',
        // Asked for explicitly: used as is.
        sortOrder: 4,
        notes: 'Go slow',
      }
      expect(writes).toEqual([
        ['insert', values],
        [
          'audit',
          entry('ASSIGNED_PROGRAM_EXERCISE_ADDED', {
            exercise: {
              id: 40,
              workoutId: 951,
              exerciseId: 5,
              name: 'Squat',
              primaryMuscles: ['legs'],
              secondaryMuscles: ['core'],
              equipment: ['barbell'],
              instructions: ['Step one'],
              sets: 3,
              reps: 10,
              durationInSeconds: undefined,
              weight: 62.5,
              weightUnit: 'kg',
              sortOrder: 4,
              notes: 'Go slow',
            },
          }),
        ],
      ])
    })

    // Positions 0 and 2 (one was removed in between): a count would say 2 —
    // already taken. The last position + 1 is 3.
    it("appends after the workout's last exercise when no position is given", async () => {
      positions = [{ sortOrder: 0 }, { sortOrder: 2 }]

      await service.addExercise(900, practitioner, { exerciseId: 5 })

      expect(writes[0]).toEqual([
        'insert',
        expect.objectContaining({ workoutId: 950, sortOrder: 3 }),
      ])
    })

    it('starts an empty workout at position 0', async () => {
      await service.addExercise(900, practitioner, { exerciseId: 5 })

      expect(writes[0]).toEqual([
        'insert',
        expect.objectContaining({ sortOrder: 0 }),
      ])
    })

    // It used to answer with the bare inserted row: a screen writing that
    // into the program's cache would have lost every other exercise.
    it('answers with the full program', async () => {
      db.query.assignedProgramExercises.findMany.mockResolvedValue([
        { ...storedRow },
      ])

      const result = await service.addExercise(900, practitioner, {
        exerciseId: 5,
      })

      expect(result).toEqual({
        ...OPEN_STATE,
        id: 900,
        patientId: 20,
        workouts,
        // Every exercise carries its library photos (none in these mocks).
        exercises: [answered(storedRow)],
        retiredExercises: [],
        schedules: [],
      })
    })
  })

  describe('updateExercise', () => {
    it('locks the row, updates only what changed, and records before → after', async () => {
      await service.updateExercise(900, 31, practitioner, {
        sets: 4,
        // Re-sent with the stored value: not a change.
        reps: 10,
        // An array re-sent with the same items: not a change either (a new
        // array object — `===` alone would call it one).
        primaryMuscles: ['legs'],
      })

      expect(forCalls).toEqual(['update'])
      expect(writes).toEqual([
        ['update', { sets: 4, reps: 10, primaryMuscles: ['legs'] }],
        [
          'audit',
          entry('ASSIGNED_PROGRAM_EXERCISE_UPDATED', {
            exerciseRowId: 31,
            name: 'Squat',
            changes: { sets: { from: 3, to: 4 } },
          }),
        ],
      ])
    })

    // Same length, other items: still a change (comparing lengths alone
    // would miss it).
    it('records an array whose items changed, at the same length', async () => {
      await service.updateExercise(900, 31, practitioner, {
        primaryMuscles: ['glutes'],
      })

      expect(writes[1]).toEqual([
        'audit',
        entry('ASSIGNED_PROGRAM_EXERCISE_UPDATED', {
          exerciseRowId: 31,
          name: 'Squat',
          changes: { primaryMuscles: { from: ['legs'], to: ['glutes'] } },
        }),
      ])
    })

    it('records an array that really changed', async () => {
      await service.updateExercise(900, 31, practitioner, {
        primaryMuscles: ['legs', 'glutes'],
      })

      expect(writes[1]).toEqual([
        'audit',
        entry('ASSIGNED_PROGRAM_EXERCISE_UPDATED', {
          exerciseRowId: 31,
          name: 'Squat',
          changes: {
            primaryMuscles: { from: ['legs'], to: ['legs', 'glutes'] },
          },
        }),
      ])
    })

    // A form re-sending what's stored: no UPDATE, no entry.
    it('writes nothing when nothing changes', async () => {
      await service.updateExercise(900, 31, practitioner, {
        sets: 3,
        workoutId: 950,
      })

      expect(writes).toEqual([])
    })

    it('moves to the end of another workout, recorded as workout and position changes', async () => {
      positions = [{ sortOrder: 0 }, { sortOrder: 5 }]

      await service.updateExercise(900, 31, practitioner, { workoutId: 951 })

      expect(writes).toEqual([
        ['update', { workoutId: 951, sortOrder: 6 }],
        [
          'audit',
          entry('ASSIGNED_PROGRAM_EXERCISE_UPDATED', {
            exerciseRowId: 31,
            name: 'Squat',
            changes: {
              workoutId: { from: 950, to: 951 },
              sortOrder: { from: 1, to: 6 },
            },
          }),
        ],
      ])
    })

    it('refuses a retired exercise, writing nothing', async () => {
      lockedRow = { ...storedRow, retiredAt: new Date(), retiredBy: 7 }

      await expect(
        service.updateExercise(900, 31, practitioner, { sets: 4 }),
      ).rejects.toThrow(
        new ConflictException(
          'This exercise was removed from the program, so it can no longer change',
        ),
      )
      expect(writes).toEqual([])
    })

    it("answers 404 for a row the program doesn't have", async () => {
      lockedRow = undefined

      await expect(
        service.updateExercise(900, 99, practitioner, { sets: 4 }),
      ).rejects.toThrow(
        new NotFoundException('Exercise 99 not found in this assigned program'),
      )
      expect(writes).toEqual([])
    })

    // The gap from deferred-improvements.md (fixed in step 1): it used to
    // answer with the one updated row.
    it('answers with the full program — every exercise and the schedules — not the updated row', async () => {
      db.query.assignedProgramExercises.findMany.mockResolvedValue([
        { ...storedRow, id: 30, sets: 2 },
        { ...storedRow, sets: 4 },
      ])

      const result = await service.updateExercise(900, 31, practitioner, {
        sets: 4,
      })

      expect(result).toEqual({
        ...OPEN_STATE,
        id: 900,
        patientId: 20,
        workouts,
        exercises: [
          answered({ ...storedRow, id: 30, sets: 2 }),
          answered({ ...storedRow, sets: 4 }),
        ],
        retiredExercises: [],
        schedules: [],
      })
    })
  })

  describe('removeExercise', () => {
    // Drizzle's wrapping of node-postgres's error, as the service receives
    // it.
    const foreignKeyError = (constraint: string) =>
      new DrizzleQueryError(
        'delete from "assigned_program_exercises" ...',
        [],
        Object.assign(new Error('fk'), { code: '23503', constraint }),
      )

    it('deletes an exercise no session used, inside a savepoint, and records it whole', async () => {
      await service.removeExercise(900, 31, practitioner)

      expect(forCalls).toEqual(['update'])
      expect(writes).toEqual([
        ['delete', null],
        [
          'audit',
          entry('ASSIGNED_PROGRAM_EXERCISE_REMOVED', {
            exercise: storedRowForAudit,
          }),
        ],
      ])
    })

    // The DELETE runs in a nested transaction — a SAVEPOINT — so that its
    // failure doesn't abort the transaction; the retiring UPDATE then runs
    // in the outer one, after the savepoint is rolled back. (Without the
    // savepoint, Postgres would refuse that UPDATE: "current transaction is
    // aborted" — the e2e test proves it for real.)
    it('deletes inside a savepoint, and retires in the outer transaction', async () => {
      deleteError = foreignKeyError('session_exercises_program_exercise_fk')

      await service.removeExercise(900, 31, practitioner)

      expect(depthOf).toEqual({ delete: 2, update: 1 })
    })

    it("retires it when a session's foreign key refuses the delete", async () => {
      deleteError = foreignKeyError('session_exercises_program_exercise_fk')

      await service.removeExercise(900, 31, practitioner)

      expect(writes).toHaveLength(2)
      // now() from the database (an SQL fragment), and the remover's id.
      const [kind, values] = writes[0] as [string, Record<string, unknown>]
      expect(kind).toBe('update')
      expect(values.retiredBy).toBe(7)
      expect(values.retiredAt).toBeDefined()
      expect(values.retiredAt).not.toBeInstanceOf(Date)
      expect(Object.keys(values).sort()).toEqual(['retiredAt', 'retiredBy'])
      expect(writes[1]).toEqual([
        'audit',
        entry('ASSIGNED_PROGRAM_EXERCISE_RETIRED', {
          exercise: storedRowForAudit,
        }),
      ])
    })

    // Only THAT foreign key means "a session used it": any other failure is
    // not a reason to retire, and goes up unchanged.
    it.each([
      ['another foreign key', foreignKeyError('some_other_fk')],
      ['any other error', new Error('connection lost')],
    ])(
      'lets %s through without retiring or auditing',
      async (_label, error) => {
        deleteError = error

        await expect(
          service.removeExercise(900, 31, practitioner),
        ).rejects.toBe(error)
        expect(writes).toEqual([])
      },
    )

    it('refuses an exercise already retired, writing nothing', async () => {
      lockedRow = { ...storedRow, retiredAt: new Date(), retiredBy: 7 }

      await expect(
        service.removeExercise(900, 31, practitioner),
      ).rejects.toThrow(
        new ConflictException(
          'This exercise was already removed from the program',
        ),
      )
      expect(writes).toEqual([])
    })

    it("answers 404 for a row the program doesn't have", async () => {
      lockedRow = undefined

      await expect(
        service.removeExercise(900, 99, practitioner),
      ).rejects.toThrow(NotFoundException)
      expect(writes).toEqual([])
    })

    it('refuses a closed program before touching the row', async () => {
      db.query.assignedPrograms.findFirst.mockResolvedValue({
        id: 900,
        patientId: 20,
        status: 'cancelled',
        isArchived: false,
      })

      await expect(
        service.removeExercise(900, 31, practitioner),
      ).rejects.toThrow(ConflictException)
      expect(forCalls).toEqual([])
    })

    // The answer: the full program, the retired exercise apart from the
    // active ones, retired ones in the order they were removed.
    it('answers with the full program, retired exercises listed apart', async () => {
      const early = {
        ...storedRow,
        id: 33,
        retiredAt: new Date('2031-01-02T10:00:00Z'),
        retiredBy: 7,
      }
      const late = {
        ...storedRow,
        id: 32,
        retiredAt: new Date('2031-01-05T10:00:00Z'),
        retiredBy: 7,
      }
      db.query.assignedProgramExercises.findMany.mockResolvedValue([
        late,
        { ...storedRow, id: 30 },
        early,
      ])

      const result = await service.removeExercise(900, 31, practitioner)

      expect(result.exercises).toEqual([answered({ ...storedRow, id: 30 })])
      expect(result.retiredExercises).toEqual([answered(early), answered(late)])
    })
  })

  // The removal preview (3b-1): what removing WOULD do, read-only.
  describe('removalPreview', () => {
    it('says DELETED when no session used it — reading without a lock, writing nothing', async () => {
      await expect(
        service.removalPreview(900, 31, practitioner),
      ).resolves.toStrictEqual({ outcome: 'deleted', sessionCount: 0 })
      expect(forCalls).toEqual([])
      expect(writes).toEqual([])
    })

    it('says RETIRED, with how many sessions used it', async () => {
      sessionCount = 3

      await expect(
        service.removalPreview(900, 31, practitioner),
      ).resolves.toStrictEqual({ outcome: 'retired', sessionCount: 3 })
    })

    it("refuses an exercise already removed, in the removal's words", async () => {
      lockedRow = { ...storedRow, retiredAt: new Date(), retiredBy: 7 }

      await expect(
        service.removalPreview(900, 31, practitioner),
      ).rejects.toThrow(
        new ConflictException(
          'This exercise was already removed from the program',
        ),
      )
    })

    it("answers 404 for a row the program doesn't have", async () => {
      lockedRow = undefined

      await expect(
        service.removalPreview(900, 99, practitioner),
      ).rejects.toThrow(
        new NotFoundException('Exercise 99 not found in this assigned program'),
      )
    })

    it('refuses a closed program before reading the exercise', async () => {
      db.query.assignedPrograms.findFirst.mockResolvedValue({
        id: 900,
        patientId: 20,
        status: 'completed',
        isArchived: false,
      })

      await expect(
        service.removalPreview(900, 31, practitioner),
      ).rejects.toThrow(ConflictException)
      expect(db.select).not.toHaveBeenCalled()
    })

    it("refuses someone who couldn't remove it", async () => {
      usersService.isPatientManagedBy.mockResolvedValue(false)

      await expect(
        service.removalPreview(900, 31, practitioner),
      ).rejects.toThrow(
        new ForbiddenException(
          'You do not have permission to manage this assigned program',
        ),
      )
      expect(db.select).not.toHaveBeenCalled()
    })
  })

  // --- Program-specific photos (decided 2026-10-17) --------------------------------------------------------
  //
  // The ORDER of storage calls and database writes is the point here: files
  // stored before the transaction, the room checked before storing AND under
  // the lock, a file deleted only after the row stopped pointing at it, and
  // every stored file deleted again when the transaction fails. The storage
  // mocks record into `writes` too, so one list shows the whole sequence.
  // The real thing — moto, Postgres, the triggers — is
  // test/program-exercise-photos.e2e-spec.ts.
  describe('own photos', () => {
    const KEY =
      /^patients\/20\/exercise-photos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\./
    const file = (name: string, mimetype: string) =>
      ({
        originalname: name,
        mimetype,
        buffer: Buffer.from(name),
      }) as Express.Multer.File
    const own = (count: number) =>
      Array.from({ length: count }, (_, index) => `patients/20/p${index}.png`)
    // What a storage call recorded: [kind, key].
    const stored = (kind: string) =>
      writes.filter(([k]) => k === kind).map(([, key]) => key as string)

    beforeEach(() => {
      storageService.upload.mockReset()
      storageService.upload.mockImplementation((key: string) => {
        writes.push(['upload', key])
        return Promise.resolve(key)
      })
      storageService.copy.mockReset()
      storageService.copy.mockImplementation((source: string, key: string) => {
        writes.push(['copy', [source, key]])
        return Promise.resolve(key)
      })
      storageService.deleteUnreferenced.mockReset()
      storageService.deleteUnreferenced.mockImplementation((key: string) => {
        writes.push(['deleteFile', key])
        return Promise.resolve()
      })
      lockedRow = { ...storedRow, mediaUrls: own(1) }
    })

    describe('addImages', () => {
      it('stores each file under a new key of the patient, THEN appends them under the lock, with one entry', async () => {
        await service.addImages(900, 31, practitioner, [
          file('chair.png', 'image/png'),
          file('band.jpg', 'image/jpeg'),
        ])

        const keys = stored('upload')
        expect(keys).toHaveLength(2)
        // The extension from the CHECKED type, never the file's own name.
        expect(keys[0]).toMatch(new RegExp(KEY.source + 'png$'))
        expect(keys[1]).toMatch(new RegExp(KEY.source + 'jpg$'))
        expect(storageService.upload).toHaveBeenCalledWith(
          keys[0],
          Buffer.from('chair.png'),
          'image/png',
        )
        expect(writes).toEqual([
          ['upload', keys[0]],
          ['upload', keys[1]],
          ['update', { mediaUrls: ['patients/20/p0.png', ...keys] }],
          [
            'audit',
            entry('ASSIGNED_PROGRAM_EXERCISE_PHOTOS_ADDED', {
              exerciseRowId: 31,
              name: 'Squat',
              added: keys,
              source: 'upload',
            }),
          ],
        ])
        // Read once without a lock (before storing), then once locked.
        expect(forCalls).toEqual(['update'])
      })

      it('refuses past the limit BEFORE storing anything', async () => {
        lockedRow = { ...storedRow, mediaUrls: own(9) }

        await expect(
          service.addImages(900, 31, practitioner, [
            file('a.png', 'image/png'),
            file('b.png', 'image/png'),
          ]),
        ).rejects.toThrow(
          new ConflictException(
            'A program exercise can have at most 10 photos: this one has 9, so 1 more can be added',
          ),
        )
        expect(writes).toEqual([])
      })

      it('refuses a retired exercise before storing anything', async () => {
        lockedRow = { ...storedRow, retiredAt: new Date(), retiredBy: 7 }

        await expect(
          service.addImages(900, 31, practitioner, [
            file('a.png', 'image/png'),
          ]),
        ).rejects.toThrow(
          new ConflictException(
            'This exercise was removed from the program, so it can no longer change',
          ),
        )
        expect(writes).toEqual([])
      })

      // Another addition took the room WHILE this one was uploading: the
      // check under the lock refuses, and the files just stored are deleted
      // — nothing will ever point at them.
      it('checks again under the lock, and deletes its files when the room is gone', async () => {
        storageService.upload.mockImplementation((key: string) => {
          writes.push(['upload', key])
          lockedRow = { ...storedRow, mediaUrls: own(10) }
          return Promise.resolve(key)
        })

        await expect(
          service.addImages(900, 31, practitioner, [
            file('a.png', 'image/png'),
          ]),
        ).rejects.toThrow(ConflictException)
        const [key] = stored('upload')
        expect(writes).toEqual([
          ['upload', key],
          ['deleteFile', key],
        ])
      })

      // Removed (retired) WHILE the files were uploading: the check under the
      // lock refuses, and the files go.
      it('checks the exercise is still in the program under the lock', async () => {
        storageService.upload.mockImplementation((key: string) => {
          writes.push(['upload', key])
          lockedRow = { ...storedRow, retiredAt: new Date(), retiredBy: 7 }
          return Promise.resolve(key)
        })

        await expect(
          service.addImages(900, 31, practitioner, [
            file('a.png', 'image/png'),
          ]),
        ).rejects.toThrow(
          new ConflictException(
            'This exercise was removed from the program, so it can no longer change',
          ),
        )
        const [key] = stored('upload')
        expect(writes).toEqual([
          ['upload', key],
          ['deleteFile', key],
        ])
      })

      // A failure INSIDE the transaction (here its audit entry; for real, a
      // trigger refusing a program closed meanwhile): rolled back, files
      // deleted, the error goes on.
      it('deletes its files when the transaction fails', async () => {
        const failure = new Error('refused')
        auditService.logInTransaction.mockRejectedValue(failure)

        await expect(
          service.addImages(900, 31, practitioner, [
            file('a.png', 'image/png'),
          ]),
        ).rejects.toBe(failure)
        const [key] = stored('upload')
        expect(stored('deleteFile')).toEqual([key])
      })

      // The second upload fails: the first file is deleted, nothing is
      // written, and the storage error reaches the client (a 500 — storage
      // being down is not the request's fault).
      it('deletes the files already stored when an upload fails', async () => {
        const failure = new Error('storage down')
        storageService.upload
          .mockImplementationOnce((key: string) => {
            writes.push(['upload', key])
            return Promise.resolve(key)
          })
          .mockImplementationOnce(() => Promise.reject(failure))

        await expect(
          service.addImages(900, 31, practitioner, [
            file('a.png', 'image/png'),
            file('b.png', 'image/png'),
          ]),
        ).rejects.toBe(failure)
        const [key] = stored('upload')
        expect(writes).toEqual([
          ['upload', key],
          ['deleteFile', key],
        ])
      })
    })

    describe('addLibraryImages', () => {
      it("copies the library's photos in its order, with their extensions, and records where each came from", async () => {
        db.query.exercises.findFirst.mockResolvedValue({
          mediaUrls: ['exercises/5/1.jpg', 'exercises/5/0.webp'],
        })

        await service.addLibraryImages(900, 31, practitioner)

        const copies = stored('copy') as unknown as [string, string][]
        expect(copies.map(([source]) => source)).toEqual([
          'exercises/5/1.jpg',
          'exercises/5/0.webp',
        ])
        const keys = copies.map(([, key]) => key)
        expect(keys[0]).toMatch(new RegExp(KEY.source + 'jpg$'))
        expect(keys[1]).toMatch(new RegExp(KEY.source + 'webp$'))
        expect(writes.slice(2)).toEqual([
          ['update', { mediaUrls: ['patients/20/p0.png', ...keys] }],
          [
            'audit',
            entry('ASSIGNED_PROGRAM_EXERCISE_PHOTOS_ADDED', {
              exerciseRowId: 31,
              name: 'Squat',
              added: keys,
              source: 'library',
              copiedFrom: ['exercises/5/1.jpg', 'exercises/5/0.webp'],
            }),
          ],
        ])
        // The LIBRARY exercise of this row — its id, as the row stores it.
        expect(db.query.exercises.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ columns: { mediaUrls: true } }),
        )
      })

      it('refuses when the library has no photos, copying nothing', async () => {
        db.query.exercises.findFirst.mockResolvedValue({ mediaUrls: [] })

        await expect(
          service.addLibraryImages(900, 31, practitioner),
        ).rejects.toThrow(
          new ConflictException(
            'This exercise has no photos in the library to copy',
          ),
        )
        expect(writes).toEqual([])
      })

      it('refuses past the limit before copying', async () => {
        lockedRow = { ...storedRow, mediaUrls: own(9) }
        db.query.exercises.findFirst.mockResolvedValue({
          mediaUrls: ['exercises/5/0.jpg', 'exercises/5/1.jpg'],
        })

        await expect(
          service.addLibraryImages(900, 31, practitioner),
        ).rejects.toThrow(
          new ConflictException(
            'A program exercise can have at most 10 photos: this one has 9, so 1 more can be added',
          ),
        )
        expect(writes).toEqual([])
      })
    })

    describe('reorderImages', () => {
      beforeEach(() => {
        lockedRow = { ...storedRow, mediaUrls: own(3) }
      })

      it('writes the new order with the old one in its entry', async () => {
        const order = [
          'patients/20/p2.png',
          'patients/20/p0.png',
          'patients/20/p1.png',
        ]

        await service.reorderImages(900, 31, practitioner, order)

        expect(forCalls).toEqual(['update'])
        expect(writes).toEqual([
          ['update', { mediaUrls: order }],
          [
            'audit',
            entry('ASSIGNED_PROGRAM_EXERCISE_PHOTOS_REORDERED', {
              exerciseRowId: 31,
              name: 'Squat',
              from: own(3),
              to: order,
            }),
          ],
        ])
      })

      it('writes nothing for the order it already has', async () => {
        await service.reorderImages(900, 31, practitioner, own(3))

        expect(writes).toEqual([])
      })

      it('refuses a list that is not the same photos', async () => {
        await expect(
          service.reorderImages(900, 31, practitioner, own(2)),
        ).rejects.toThrow(BadRequestException)
        expect(writes).toEqual([])
      })
    })

    describe('removeImage', () => {
      beforeEach(() => {
        lockedRow = { ...storedRow, mediaUrls: own(3) }
      })

      it('stops listing the photo, records it, and only THEN deletes its file', async () => {
        await service.removeImage(900, 31, practitioner, 'patients/20/p1.png')

        expect(writes).toEqual([
          [
            'update',
            { mediaUrls: ['patients/20/p0.png', 'patients/20/p2.png'] },
          ],
          [
            'audit',
            entry('ASSIGNED_PROGRAM_EXERCISE_PHOTO_REMOVED', {
              exerciseRowId: 31,
              name: 'Squat',
              objectKey: 'patients/20/p1.png',
            }),
          ],
          ['deleteFile', 'patients/20/p1.png'],
        ])
      })

      it("refuses a photo that isn't one of the row's own, deleting nothing", async () => {
        await expect(
          service.removeImage(900, 31, practitioner, 'exercises/5/0.jpg'),
        ).rejects.toThrow(NotFoundException)
        expect(writes).toEqual([])
      })

      // The transaction failed: the row still lists the photo, so its file
      // must still exist.
      it('keeps the file when the transaction fails', async () => {
        auditService.logInTransaction.mockRejectedValue(new Error('refused'))

        await expect(
          service.removeImage(900, 31, practitioner, 'patients/20/p1.png'),
        ).rejects.toThrow('refused')
        expect(stored('deleteFile')).toEqual([])
      })
    })

    describe('removing the exercise', () => {
      beforeEach(() => {
        lockedRow = { ...storedRow, mediaUrls: own(2) }
      })

      it('deletes its own files AFTER a DELETE, and the entry lists them', async () => {
        await service.removeExercise(900, 31, practitioner)

        expect(writes).toEqual([
          ['delete', null],
          [
            'audit',
            entry('ASSIGNED_PROGRAM_EXERCISE_REMOVED', {
              exercise: { ...storedRowForAudit, ownPhotos: own(2) },
            }),
          ],
          ['deleteFile', 'patients/20/p0.png'],
          ['deleteFile', 'patients/20/p1.png'],
        ])
      })

      // Retired: the row stays for its sessions, and so do its photos.
      it('keeps them when the exercise is RETIRED', async () => {
        deleteError = new DrizzleQueryError(
          'delete from "assigned_program_exercises" ...',
          [],
          Object.assign(new Error('fk'), {
            code: '23503',
            constraint: 'session_exercises_program_exercise_fk',
          }),
        )

        await service.removeExercise(900, 31, practitioner)

        expect(stored('deleteFile')).toEqual([])
      })
    })
  })
})

describe('AssignedProgramsService.reorderExercises', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
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
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...OPEN_STATE, id: 900, patientId: 20 }),
        },
        // Two calls happen per successful reorder: reorderExercises' own
        // transaction (the permutation-check read), then
        // findProgramWithExercises' read of real post-write state once
        // that transaction has committed. Both default to the same three
        // rows unless a test targets the first call specifically via
        // mockResolvedValueOnce.
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: {
          findMany: jest.fn().mockResolvedValue(
            [1, 2, 3].map((id) => ({
              id,
              useLibraryImages: true,
              mediaUrls: [],
            })),
          ),
        },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
        // The library photos findProgramWithExercises reads (none here).
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
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
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
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

  // Step 3b-0: the audit convention — which workout, and the order before →
  // after, as row ids (the first workout, as none was named).
  it('records the workout and its order before → after', async () => {
    await service.reorderExercises(
      900,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [3, 1, 2],
    )
    expect(auditService.logInTransaction).toHaveBeenCalledTimes(1)
    expect(auditService.logInTransaction).toHaveBeenCalledWith(db, {
      performedBy: 7,
      action: 'ASSIGNED_PROGRAM_EXERCISES_REORDERED',
      targetUserId: 20,
      entityType: 'assigned-programs',
      entityId: 900,
      details: { workoutId: 950, from: [1, 2, 3], to: [3, 1, 2] },
    })
  })

  // The order it already has: nothing to write, nothing to record.
  it('writes nothing for the order it already has', async () => {
    await service.reorderExercises(
      900,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [1, 2, 3],
    )
    expect(txUpdate).not.toHaveBeenCalled()
    expect(auditService.logInTransaction).not.toHaveBeenCalled()
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

// --- Schedule versions ---------------------------------------------------------------------------------

// A pure function: the program's dates and a pinned clock in, a 400 or
// nothing out. `now` is 2026-10-09 at 12:00 UTC, so UTC's today is the 9th
// and the earliest allowed day (one day of slack) is the 8th.
describe('assertScheduleDayAllowed', () => {
  const now = new Date('2026-10-09T12:00:00Z')
  const program = { startDate: '2026-10-01', endDate: '2026-12-31' }

  it.each([
    ['today', '2026-10-09'],
    ['yesterday in UTC — today for someone west of UTC', '2026-10-08'],
    ['a day in the future', '2026-11-02'],
    ["the program's last day", '2026-12-31'],
  ])('allows %s', (_label, day) => {
    expect(() => assertScheduleDayAllowed(day, program, now)).not.toThrow()
  })

  it.each([
    [
      'two days ago (past the one day of slack)',
      '2026-10-07',
      program,
      "A schedule change can't apply to a day in the past",
    ],
    [
      'a day after the program ends',
      '2027-01-01',
      program,
      "A schedule change can't apply after the program ends (2026-12-31)",
    ],
    [
      'a day before the program starts — even a future one',
      '2026-10-20',
      { startDate: '2026-11-01', endDate: null },
      "A schedule change can't apply before the program starts (2026-11-01)",
    ],
  ])('refuses %s', (_label, day, dates, message) => {
    expect(() => assertScheduleDayAllowed(day, dates, now)).toThrow(
      new BadRequestException(message),
    )
  })

  // endDate null = open-ended: no upper limit at all.
  it('allows any later day for an open-ended program', () => {
    expect(() =>
      assertScheduleDayAllowed(
        '2030-01-01',
        { startDate: '2026-10-01', endDate: null },
        now,
      ),
    ).not.toThrow()
  })

  // Uses the CLOCK, not a fixed date: the same day is allowed at one moment
  // and refused two days later.
  it("judges 'the past' by the clock it's given", () => {
    const later = new Date('2026-10-11T12:00:00Z')
    expect(() =>
      assertScheduleDayAllowed('2026-10-09', program, now),
    ).not.toThrow()
    expect(() =>
      assertScheduleDayAllowed('2026-10-09', program, later),
    ).toThrow(
      new BadRequestException(
        "A schedule change can't apply to a day in the past",
      ),
    )
  })
})

describe('AssignedProgramsService.addScheduleVersion', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  // Every write, in the order it happened: [kind, details, transaction #].
  let writes: [string, unknown, number][]
  // Which db.transaction() call is running (each withRlsContext opens one).
  let currentTransaction: number
  let insertValues: jest.Mock
  // What the insert's RETURNING answers (a test can make it fail).
  let insertReturning: jest.Mock
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
    }
    delete: jest.Mock
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  // Dates relative to the real clock (the service reads it), so the tests
  // don't depend on the day they run.
  const today = utcToday()
  const programStart = addDays(today, -30)

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) }
    writes = []
    currentTransaction = 0
    insertReturning = jest.fn()
    insertValues = jest.fn((values: Record<string, unknown>) => {
      writes.push(['insert', values, currentTransaction])
      insertReturning.mockResolvedValue([
        { id: 99, createdAt: new Date('2026-10-10T10:00:00Z'), ...values },
      ])
      return { returning: insertReturning }
    })
    auditService.logInTransaction.mockImplementation(
      (_tx: unknown, entry: unknown) => {
        writes.push(['audit', entry, currentTransaction])
        return Promise.resolve(undefined)
      },
    )
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            ...OPEN_STATE,
            id: 900,
            patientId: 20,
            startDate: programStart,
            endDate: null,
          }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: {
          findMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
        },
      },
      delete: jest.fn(() => ({
        where: jest.fn((condition: unknown) => {
          writes.push(['delete', condition, currentTransaction])
          return Promise.resolve(undefined)
        }),
      })),
      insert: jest.fn(() => ({ values: insertValues })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => {
        currentTransaction += 1
        return fn(db)
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER }

  // Delete FIRST, then insert: the other way round, the new version would
  // be deleted by its own "from that day on" clean-up (its effective_from
  // is that day). Which rows the delete reaches is tested against a real
  // database in the e2e suite; here, the order and the inserted values.
  // …and the version's days come right after it (sent Thursday first,
  // written in weekday order), naming the program's workout (950).
  it('replaces the versions from that day on, then inserts the new one and its days', async () => {
    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.WEEKDAYS,
      days: [
        { weekday: 4, workoutId: 950 },
        { weekday: 2, workoutId: 950 },
      ],
      effectiveFrom: today,
    })

    expect(writes.map(([kind]) => kind)).toEqual([
      'delete',
      'insert',
      'insert',
      'audit',
    ])
    expect(writes[1][1]).toStrictEqual({
      assignedProgramId: 900,
      type: 'weekdays',
      timesPerWeek: null,
      effectiveFrom: today,
      createdBy: 7,
    })
    expect(writes[2][1]).toStrictEqual(
      [2, 4].map((weekday) => ({
        scheduleId: 99,
        assignedProgramId: 900,
        weekday,
        workoutId: 950,
      })),
    )
    // All in the SAME transaction: otherwise a failed insert would leave
    // the program with its versions deleted and nothing in their place —
    // and the audit entry could describe a change that never happened, or
    // the change happen with no entry.
    expect(new Set(writes.map(([, , tx]) => tx)).size).toBe(1)
  })

  // Checked before anything is deleted: a workout of another program.
  it("refuses another program's workout, before writing anything", async () => {
    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.WEEKDAYS,
        days: [{ weekday: 1, workoutId: 12345 }],
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new NotFoundException('Workout 12345 not found in this program'),
    )
    expect(writes).toEqual([])
  })

  // A pause on the start date would replace the first version: the program
  // would begin paused (decided 2026-10-11).
  it("refuses a pause from the program's first day", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: today,
      endDate: null,
    })
    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.PAUSED,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new BadRequestException(
        "A program can't start paused: choose its start date for when it begins",
      ),
    )
    expect(writes).toEqual([])
  })

  // A pause is a version with nothing else: no days, no rotation.
  it('writes a pause as a version alone', async () => {
    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.PAUSED,
      effectiveFrom: today,
    })
    expect(writes.map(([kind]) => kind)).toEqual(['delete', 'insert', 'audit'])
    expect(writes[1][1]).toMatchObject({ type: 'paused', timesPerWeek: null })
  })

  it('answers with the full program: exercises and every schedule version', async () => {
    const result = await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.TIMES_PER_WEEK,
      timesPerWeek: 2,
      effectiveFrom: today,
    })

    expect(result).toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: programStart,
      endDate: null,
      workouts: PROGRAM_WORKOUTS,
      exercises: [],
      retiredExercises: [],
      schedules: [
        { id: 1, days: [], rotation: [] },
        { id: 2, days: [], rotation: [] },
      ],
    })
  })

  // The audit entry: what was set, from when, and every version it
  // replaced — after this transaction the replaced versions exist nowhere
  // else, so the entry must carry them whole.
  // The replaced versions are READ before the delete, with their content:
  // here a times-per-week version planned for next week, whose rotation is
  // the program's one workout. (The first read is the service's own; later
  // reads — the full program it answers with — get the defaults.) An older
  // version, before the day, is not replaced and not in the entry.
  it('audits the new version and every version it replaced', async () => {
    db.query.programSchedules.findMany.mockResolvedValueOnce([
      {
        id: 3,
        assignedProgramId: 900,
        type: 'weekdays',
        timesPerWeek: null,
        effectiveFrom: programStart,
        createdBy: 4,
        createdAt: new Date('2026-09-01T08:00:00Z'),
      },
      // Set earlier for today itself: replaced too — "from D on" includes
      // D.
      {
        id: 6,
        assignedProgramId: 900,
        type: 'paused',
        timesPerWeek: null,
        effectiveFrom: today,
        createdBy: 4,
        createdAt: new Date('2026-10-01T08:00:00Z'),
      },
      {
        id: 7,
        assignedProgramId: 900,
        type: 'times_per_week',
        timesPerWeek: 3,
        effectiveFrom: addDays(today, 7),
        createdBy: 4,
        createdAt: new Date('2026-10-02T08:00:00Z'),
      },
    ])
    db.query.programScheduleRotation.findMany.mockResolvedValueOnce([
      { scheduleId: 7, assignedProgramId: 900, position: 0, workoutId: 950 },
    ])

    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.WEEKDAYS,
      days: [
        { weekday: 5, workoutId: 950 },
        { weekday: 1, workoutId: 950 },
      ],
      effectiveFrom: today,
    })

    const [, entry] = writes.find(([kind]) => kind === 'audit')!
    expect(entry).toStrictEqual({
      performedBy: 7,
      action: 'ASSIGNED_PROGRAM_SCHEDULE_SET',
      targetUserId: 20,
      entityType: 'assigned-programs',
      entityId: 900,
      details: {
        effectiveFrom: today,
        added: {
          id: 99,
          type: 'weekdays',
          timesPerWeek: null,
          days: [
            { weekday: 1, workoutId: 950 },
            { weekday: 5, workoutId: 950 },
          ],
          rotation: [],
          effectiveFrom: today,
          createdBy: 7,
          createdAt: new Date('2026-10-10T10:00:00Z'),
        },
        replaced: [
          {
            id: 6,
            type: 'paused',
            timesPerWeek: null,
            days: [],
            rotation: [],
            effectiveFrom: today,
            createdBy: 4,
            createdAt: new Date('2026-10-01T08:00:00Z'),
          },
          {
            id: 7,
            type: 'times_per_week',
            timesPerWeek: 3,
            days: [],
            rotation: [950],
            effectiveFrom: addDays(today, 7),
            createdBy: 4,
            createdAt: new Date('2026-10-02T08:00:00Z'),
          },
        ],
      },
    })
  })

  // A failed change writes no entry: the insert fails before the audit
  // call, and the transaction rolls everything back.
  it('writes no audit entry when the change fails', async () => {
    insertValues.mockImplementationOnce(() => ({
      returning: () =>
        Promise.reject(
          pgError('23505', 'program_schedules_program_effective_from_unique'),
        ),
    }))

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(ConflictException)
    expect(auditService.logInTransaction).not.toHaveBeenCalled()
  })

  it("refuses someone who can't manage the program, before writing anything", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        'You do not have permission to manage this assigned program',
      ),
    )
    expect(writes).toEqual([])
  })

  it("refuses a day the rules don't allow, before writing anything", async () => {
    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: addDays(programStart, -1),
      }),
    ).rejects.toThrow(
      new BadRequestException(
        `A schedule change can't apply before the program starts (${programStart})`,
      ),
    )
    expect(writes).toEqual([])
  })

  // What node-postgres throws, wrapped the way Drizzle wraps it (the
  // driver's error in `cause`) — the shape isUniqueViolation looks through.
  function pgError(code: string, constraint: string) {
    return Object.assign(new Error('query failed'), {
      cause: { code, constraint },
    })
  }

  it('turns a same-day race (the unique constraint) into a 409', async () => {
    insertValues.mockImplementationOnce(() => ({
      returning: () =>
        Promise.reject(
          pgError('23505', 'program_schedules_program_effective_from_unique'),
        ),
    }))

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new ConflictException(
        'Someone else changed this schedule at the same moment. Reload the program and try again.',
      ),
    )
  })

  // Only THAT constraint means "a race on the same day"; anything else is
  // a real failure and must surface as itself, not as a misleading 409.
  it('lets any other database error through unchanged', async () => {
    const other = pgError('23505', 'some_other_unique')
    insertValues.mockImplementationOnce(() => ({
      returning: () => Promise.reject(other),
    }))

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toBe(other)
  })
})

describe('AssignedProgramsService.update — dates, start-date moves, audit', () => {
  let service: AssignedProgramsService
  // Every write in order: [kind, details].
  let writes: [string, unknown][]
  let setValues: jest.Mock
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programWorkouts: { findMany: jest.Mock }
      assignedProgramExercises: { findMany: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
    }
    update: jest.Mock
    delete: jest.Mock
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  // Relative to the real clock (the service reads it): a program that
  // hasn't started yet — the only kind whose start date may move.
  const today = utcToday()
  const start = addDays(today, 10)
  const end = addDays(today, 90)
  // Version 51: Monday, Wednesday, Friday — all workout 950, the program's
  // only workout (its days are the programScheduleDays rows below).
  const firstVersion = {
    id: 51,
    assignedProgramId: 900,
    type: 'weekdays',
    timesPerWeek: null,
    effectiveFrom: start,
    createdBy: 3,
    createdAt: new Date('2026-10-01T09:00:00Z'),
  }
  const firstVersionDays = [1, 3, 5].map((weekday) => ({
    scheduleId: 51,
    assignedProgramId: 900,
    weekday,
    workoutId: 950,
  }))
  const mwf = [
    { weekday: 1, workoutId: 950 },
    { weekday: 3, workoutId: 950 },
    { weekday: 5, workoutId: 950 },
  ]

  beforeEach(async () => {
    writes = []
    auditService.logInTransaction.mockImplementation(
      (_tx: unknown, entry: unknown) => {
        writes.push(['audit', entry])
        return Promise.resolve(undefined)
      },
    )
    setValues = jest.fn((values: unknown) => {
      writes.push(['update', values])
      return { where: jest.fn().mockResolvedValue(undefined) }
    })
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            ...OPEN_STATE,
            id: 900,
            patientId: 20,
            title: 'Knee Rehab',
            startDate: start,
            endDate: end,
          }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: {
          findMany: jest.fn().mockResolvedValue(firstVersionDays),
        },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: {
          findMany: jest.fn().mockResolvedValue([firstVersion]),
        },
      },
      update: jest.fn().mockReturnValue({ set: setValues }),
      // The DELETE is awaited as is (its rows were read before it).
      delete: jest.fn(() => ({
        where: jest.fn(() => {
          writes.push(['delete', null])
          return Promise.resolve(undefined)
        }),
      })),
      // An INSERT is either awaited as is (days, rotation) or through
      // .returning() (the version row, which gets id 52): a Promise with a
      // `returning` method serves both.
      insert: jest.fn(() => ({
        values: jest.fn((values: unknown) => {
          writes.push(['insert', values])
          return Object.assign(Promise.resolve(undefined), {
            returning: jest.fn().mockResolvedValue([
              {
                id: 52,
                createdAt: new Date('2026-10-10T10:00:00Z'),
                ...(values as Record<string, unknown>),
              },
            ]),
          })
        }),
      })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: { isPatientManagedBy: jest.fn() } },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  const admin = { id: 1, activeRole: UserRole.ADMIN }

  // Each case sends only ONE of the two dates: the check must combine it
  // with the stored other one. Checking only what was sent would pass all
  // three refusals.
  it.each([
    ['an end date before the stored start', { endDate: addDays(start, -1) }],
    ['a start date after the stored end', { startDate: addDays(end, 1) }],
    [
      'both, in the wrong order',
      { startDate: addDays(today, 20), endDate: addDays(today, 19) },
    ],
  ])('refuses %s, without writing', async (_label, dto) => {
    await expect(service.update(900, admin, dto)).rejects.toThrow(
      new BadRequestException("The end date can't be before the start date"),
    )
    expect(writes).toEqual([])
  })

  // null = "no end date any more": the program becomes open-ended, and a
  // start after the OLD end is then fine. Treating null like "not sent"
  // (keeping the stored end) would refuse this.
  it('accepts clearing the end date together with a later start', async () => {
    const later = addDays(end, 5)
    await service.update(900, admin, { startDate: later, endDate: null })

    expect(setValues).toHaveBeenCalledWith({ startDate: later, endDate: null })
  })

  it('refuses moving the start of a program that has started, without writing', async () => {
    const started = addDays(today, -5)
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: started,
      endDate: null,
    })

    await expect(
      service.update(900, admin, { startDate: addDays(today, 3) }),
    ).rejects.toThrow(
      new BadRequestException(
        `The start date can't change once the program has started (it started on ${started})`,
      ),
    )
    expect(writes).toEqual([])
  })

  // Sending the start date it already has isn't a move: no rule, no
  // schedule work (a form re-sending every field must keep working on a
  // program that has started).
  it('treats the same start date as no move', async () => {
    const started = addDays(today, -5)
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      title: 'Knee Rehab',
      startDate: started,
      endDate: null,
    })

    await service.update(900, admin, { startDate: started, title: 'Knee' })

    expect(writes.map(([kind]) => kind)).toEqual(['update', 'audit'])
  })

  // Step 3b-0 — the end date never moves into the past (end-date.ts has the
  // rule's own table; these check the service applies it, and only to a
  // real change).
  describe('the end date of a started program', () => {
    const started = addDays(today, -30)
    beforeEach(() => {
      db.query.assignedPrograms.findFirst.mockResolvedValue({
        ...OPEN_STATE,
        id: 900,
        patientId: 20,
        title: 'Knee Rehab',
        startDate: started,
        endDate: addDays(today, 10),
      })
    })

    it('refuses moving it into the past, without writing', async () => {
      await expect(
        service.update(900, admin, { endDate: addDays(today, -5) }),
      ).rejects.toThrow(
        new BadRequestException(
          "The end date can't be moved into the past: to end the program now, complete or cancel it",
        ),
      )
      expect(writes).toEqual([])
    })

    // Shortening to a day still ahead is a change of plan, not of history.
    it('accepts shortening it to today', async () => {
      await service.update(900, admin, { endDate: today })

      expect(setValues).toHaveBeenCalledWith({ endDate: today })
    })

    // A program whose end has passed but that nobody completed yet: a form
    // re-sending every field, the end date as stored, must keep working —
    // re-sending isn't moving.
    it('lets the stored end date be re-sent even when it has passed', async () => {
      const passed = addDays(today, -3)
      db.query.assignedPrograms.findFirst.mockResolvedValue({
        ...OPEN_STATE,
        id: 900,
        patientId: 20,
        title: 'Knee Rehab',
        startDate: started,
        endDate: passed,
      })

      await service.update(900, admin, { endDate: passed, title: 'Knee' })

      expect(writes.map(([kind]) => kind)).toEqual(['update', 'audit'])
    })
  })

  // The program row, then its schedule (via planStartDateMove: here the one
  // version moves — its row AND its days), then the audit entry — all in
  // that order, in one transaction.
  it('moves the schedule with the start date, and audits both', async () => {
    const newStart = addDays(today, 14)

    await service.update(900, admin, { startDate: newStart })

    expect(writes.map(([kind]) => kind)).toEqual([
      'update',
      'delete',
      'insert',
      'insert',
      'audit',
    ])
    expect(writes[2][1]).toStrictEqual({
      assignedProgramId: 900,
      type: 'weekdays',
      timesPerWeek: null,
      effectiveFrom: newStart,
      createdBy: 1,
    })
    // The same days, now belonging to the new version 52.
    expect(writes[3][1]).toStrictEqual(
      [1, 3, 5].map((weekday) => ({
        scheduleId: 52,
        assignedProgramId: 900,
        weekday,
        workoutId: 950,
      })),
    )
    expect(writes[4][1]).toStrictEqual({
      performedBy: 1,
      action: 'ASSIGNED_PROGRAM_UPDATED',
      targetUserId: 20,
      entityType: 'assigned-programs',
      entityId: 900,
      details: {
        changes: { startDate: { from: start, to: newStart } },
        scheduleVersions: {
          replaced: [
            {
              id: 51,
              type: 'weekdays',
              timesPerWeek: null,
              days: mwf,
              rotation: [],
              effectiveFrom: start,
              createdBy: 3,
              createdAt: new Date('2026-10-01T09:00:00Z'),
            },
          ],
          added: {
            id: 52,
            type: 'weekdays',
            timesPerWeek: null,
            days: mwf,
            rotation: [],
            effectiveFrom: newStart,
            createdBy: 1,
            createdAt: new Date('2026-10-10T10:00:00Z'),
          },
        },
      },
    })
  })

  // Moving the start EARLIER, with a change planned: the first version is
  // brought forward (deleted, re-created on the new day) and the planned
  // one stays — so the audit entry lists only the first as replaced.
  it('records as replaced only the versions the move deleted', async () => {
    db.query.programSchedules.findMany.mockResolvedValue([
      firstVersion,
      {
        ...firstVersion,
        id: 53,
        type: 'times_per_week',
        timesPerWeek: 2,
        effectiveFrom: addDays(start, 5),
      },
    ])
    db.query.programScheduleRotation.findMany.mockResolvedValue([
      { scheduleId: 53, assignedProgramId: 900, position: 0, workoutId: 950 },
    ])
    const newStart = addDays(start, -2)

    await service.update(900, admin, { startDate: newStart })

    const [, entry] = writes.find(([kind]) => kind === 'audit')!
    const { scheduleVersions } = (
      entry as {
        details: {
          scheduleVersions: {
            replaced: { id: number }[]
            added: { effectiveFrom: string }
          }
        }
      }
    ).details
    expect(scheduleVersions.replaced.map((v) => v.id)).toEqual([51])
    expect(scheduleVersions.added.effectiveFrom).toBe(newStart)
  })

  // A version is stored with its days or rotation; one read back without
  // them (which the database can't prevent: the rule spans two tables)
  // must not be copied as an empty version — the move fails instead, and
  // the transaction undoes it.
  it.each([
    [
      'a weekdays version with no days',
      firstVersion,
      "A 'weekdays' schedule version needs at least one day",
    ],
    [
      'a rotation with no workouts',
      { ...firstVersion, type: 'times_per_week', timesPerWeek: 2 },
      'A rotation needs at least one workout',
    ],
  ])('refuses to copy %s', async (_label, version, message) => {
    db.query.programSchedules.findMany.mockResolvedValue([version])
    db.query.programScheduleDays.findMany.mockResolvedValue([])

    await expect(
      service.update(900, admin, { startDate: addDays(today, 14) }),
    ).rejects.toThrow(new Error(message))
    expect(writes.map(([kind]) => kind)).not.toContain('insert')
  })

  // A pause planned 5 days after the start. Moving the start INTO it — past
  // its first day (the pause would be re-created on the new start), or onto
  // its first day exactly (the pause is already there) — would make the
  // program begin paused: refused. Nothing of the schedule is touched; the
  // program row's UPDATE, already sent, is undone with the transaction.
  it.each([
    ['past the first day of a planned pause', 7],
    ['onto the first day of a planned pause', 5],
  ])('refuses moving the start %s', async (_label, offset) => {
    db.query.programSchedules.findMany.mockResolvedValue([
      firstVersion,
      {
        ...firstVersion,
        id: 53,
        type: 'paused',
        effectiveFrom: addDays(start, 5),
      },
    ])

    await expect(
      service.update(900, admin, { startDate: addDays(start, offset) }),
    ).rejects.toThrow(
      new BadRequestException(
        "A program can't start paused: the new start date falls in a planned pause",
      ),
    )
    expect(writes.map(([kind]) => kind)).toEqual(['update'])
  })

  // Only REAL changes are listed: the title sent unchanged isn't one.
  // (Without the comparison, every field a form re-sends would be logged as
  // changed.)
  it('audits only the fields that really changed', async () => {
    await service.update(900, admin, {
      title: 'Knee Rehab',
      endDate: null,
      allowSwaps: false,
      // A DTO instance can carry declared-but-unsent fields as undefined
      // keys: "not sent" is not a change to undefined.
      startDate: undefined,
    })

    const [, entry] = writes.find(([kind]) => kind === 'audit')!
    expect((entry as { details: unknown }).details).toStrictEqual({
      changes: {
        endDate: { from: end, to: null },
        allowSwaps: { from: undefined, to: false },
      },
    })
  })

  // The entry goes through the SAME transaction object as the change: that's
  // what makes them commit or roll back together.
  it("writes the audit entry through the change's transaction", async () => {
    let txSeen: unknown
    db.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
      txSeen = db
      return fn(db)
    })

    await service.update(900, admin, { title: 'New' })

    expect(auditService.logInTransaction).toHaveBeenCalledWith(
      txSeen,
      expect.objectContaining({ action: 'ASSIGNED_PROGRAM_UPDATED' }),
    )
  })
})

describe('AssignedProgramsService.summary', () => {
  let service: AssignedProgramsService
  let usersService: { isPatientManagedBy: jest.Mock }
  let sessionsWhere: jest.Mock
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock }
      programScheduleDays: { findMany: jest.Mock }
      programScheduleRotation: { findMany: jest.Mock }
      programSchedules: { findMany: jest.Mock }
    }
    select: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  // A times-per-week program started 3 days ago, so "today" is inside its
  // first week whatever day the tests run.
  const today = utcToday()
  const start = addDays(today, -3)

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) }
    // One completed session, of workout 1 — the one the rotation asks for.
    sessionsWhere = jest.fn().mockResolvedValue([
      {
        id: 31,
        localDate: start,
        workoutId: 1,
        countsFor: null,
        status: 'completed',
        endReason: null,
      },
    ])
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            ...OPEN_STATE,
            id: 900,
            patientId: 20,
            startDate: start,
            endDate: null,
          }),
        },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        // Version 50's rotation: workout 1, over and over.
        programScheduleRotation: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ scheduleId: 50, position: 0, workoutId: 1 }]),
        },
        programSchedules: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 50,
              assignedProgramId: 900,
              type: 'times_per_week',
              timesPerWeek: 2,
              effectiveFrom: start,
            },
          ]),
        },
      },
      select: jest.fn(() => ({ from: () => ({ where: sessionsWhere }) })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()

    service = moduleRef.get(AssignedProgramsService)
  })

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER }

  // The service only gathers data: the program's dates, its versions (with
  // their rotation) and its sessions (with their workout) reach the module,
  // whose answer comes back as is. Were the rotation or the session's
  // workout lost on the way, the session would count as an extra, not done.
  it('summarizes the program from its dates, versions and sessions', async () => {
    const result = await service.summary(900, practitioner, today)

    expect(result.firstDay).toBe(start)
    expect(result.today).toBe(today)
    expect(result.totals).toEqual({
      expected: null,
      done: 1,
      madeUp: 0,
      madeUpLate: 0,
      doneEarly: 0,
      swapped: 0,
      missed: 0,
      extra: 0,
      skipped: 0,
      incomplete: 0,
    })
    expect(result.weeks[0].sessionIds).toEqual([31])
    expect(result.nextWorkout?.workoutId).toBe(1)
  })

  // Step 1b: a session that ENDED without being completed reaches the module
  // as an attempt — a label, with its reason — never as a session that
  // counts. (Which statuses are read is the query's business: e2e.)
  it('passes a stopped session as an attempt, not as done', async () => {
    sessionsWhere.mockResolvedValue([
      {
        id: 31,
        localDate: start,
        workoutId: 1,
        countsFor: null,
        status: 'completed',
        endReason: null,
      },
      {
        id: 32,
        localDate: addDays(start, 1),
        workoutId: 1,
        countsFor: null,
        status: 'incomplete',
        endReason: 'pain',
      },
    ])

    const result = await service.summary(900, practitioner, today)

    expect(result.totals).toMatchObject({ done: 1, incomplete: 1, skipped: 0 })
    expect(result.weeks[0].sessionIds).toEqual([31])
    expect(result.weeks[0].attempts).toStrictEqual([
      {
        sessionId: 32,
        status: 'incomplete',
        endReason: 'pain',
        date: addDays(start, 1),
      },
    ])
  })

  // Phase 4, the patient home: the session in progress rides along — read
  // by the same query, never given to the module (it would otherwise count
  // nowhere and label nothing — nothing to see), so the totals and weeks
  // are those of the completed session alone.
  it('adds the session in progress as openSession, apart from what counts', async () => {
    sessionsWhere.mockResolvedValue([
      {
        id: 31,
        localDate: start,
        workoutId: 1,
        countsFor: null,
        status: 'completed',
        endReason: null,
      },
      {
        id: 33,
        localDate: today,
        workoutId: 1,
        countsFor: null,
        status: 'in_progress',
        endReason: null,
      },
    ])

    const result = await service.summary(900, practitioner, today)

    expect(result.openSession).toStrictEqual({
      sessionId: 33,
      localDate: today,
      workoutId: 1,
    })
    expect(result.totals).toMatchObject({ done: 1, incomplete: 0, skipped: 0 })
    expect(result.weeks[0].sessionIds).toEqual([31])
    expect(result.weeks[0].attempts).toStrictEqual([])
    expect(result.extraSessions).toStrictEqual([])
  })

  it('says openSession null when no session is in progress', async () => {
    const result = await service.summary(900, practitioner, today)
    expect(result.openSession).toBeNull()
  })

  // `through` reaches the module: the program is open-ended (default: the
  // current program week only), so a later `through` covers more weeks.
  it('covers up to `through` when asked', async () => {
    const through = addDays(today, 14)
    const plain = await service.summary(900, practitioner, today)
    const further = await service.summary(900, practitioner, today, through)
    expect(further.lastDay > plain.lastDay).toBe(true)
    expect(further.lastDay >= through).toBe(true)
  })

  it('accepts `through` up to a year after today — and today itself', async () => {
    await expect(
      service.summary(900, practitioner, today, addDays(today, 366)),
    ).resolves.toBeDefined()
    await expect(
      service.summary(900, practitioner, today, today),
    ).resolves.toBeDefined()
  })

  it.each([
    ['before today', -1, 'through must be on or after today'],
    [
      'more than a year ahead',
      367,
      'through can be at most a year after today',
    ],
  ])(
    'refuses a `through` %s, before reading anything',
    async (_label, offset, message) => {
      await expect(
        service.summary(900, practitioner, today, addDays(today, offset)),
      ).rejects.toThrow(new BadRequestException(message))
      expect(db.transaction).not.toHaveBeenCalled()
    },
  )

  it("refuses a today that can't be today anywhere, before reading anything", async () => {
    await expect(
      service.summary(900, practitioner, addDays(today, -2)),
    ).rejects.toThrow(
      new BadRequestException("today must be today's date in your time zone"),
    )
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('refuses someone who may not view the program, before reading sessions', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)

    await expect(service.summary(900, practitioner, today)).rejects.toThrow(
      new ForbiddenException(
        'You do not have permission to view this assigned program',
      ),
    )
    expect(sessionsWhere).not.toHaveBeenCalled()
  })
})

// The race the e2e tests can't produce on demand: an exercise added — or a
// session started — on the workout between removeWorkout's counts and its
// DELETE. The database refuses the DELETE through that row's foreign key;
// the service answers 409, not a 500. The error is mocked, wrapped the way
// Drizzle wraps it.
describe('AssignedProgramsService.removeWorkout — losing the race', () => {
  let service: AssignedProgramsService
  let deleteReturning: jest.Mock

  beforeEach(async () => {
    deleteReturning = jest.fn()
    // The row lock (.for) and the four counts share one select chain: every
    // count reads 0, so the checks pass and the DELETE is what fails.
    const where = () =>
      Object.assign(
        Promise.resolve([
          { exerciseCount: 0, sessionCount: 0, dayUses: 0, rotationUses: 0 },
        ]),
        { for: jest.fn().mockResolvedValue([]) },
      )
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn(() => ({ from: () => ({ where }) })),
      query: {
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...OPEN_STATE, id: 900, patientId: 20 }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue([
            { id: 1, name: null, sortOrder: 0 },
            { id: 2, name: null, sortOrder: 1 },
          ]),
        },
      },
      delete: jest.fn(() => ({
        where: () => ({ returning: deleteReturning }),
      })),
    }
    const db = {
      ...tx,
      transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: UsersService,
          useValue: { isPatientManagedBy: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()
    service = moduleRef.get(AssignedProgramsService)
  })

  it.each([
    ['an exercise', 'assigned_program_exercises_workout_fk'],
    ['a session', 'sessions_workout_fk'],
    ['a schedule day', 'program_schedule_days_workout_fk'],
    ['a rotation slot', 'program_schedule_rotation_workout_fk'],
  ])(
    "answers 409 when %s's foreign key refuses the delete",
    async (_what, constraint) => {
      deleteReturning.mockRejectedValue(
        new DrizzleQueryError(
          'delete from "program_workouts" ...',
          [],
          Object.assign(new Error('fk'), { code: '23503', constraint }),
        ),
      )
      await expect(
        service.removeWorkout(900, 2, {
          id: 7,
          activeRole: UserRole.PRACTITIONER,
        }),
      ).rejects.toThrow(
        new ConflictException(
          'This workout was just given exercises, a session or a place in the schedule: reload the program and try again',
        ),
      )
      expect(auditService.logInTransaction).not.toHaveBeenCalled()
    },
  )

  it('lets any other error through unchanged', async () => {
    const other = new Error('connection lost')
    deleteReturning.mockRejectedValue(other)
    await expect(
      service.removeWorkout(900, 2, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toBe(other)
  })
})

// Step 2b-iii — closing a program (cancel / complete), archiving, and the
// rule that a closed program no longer changes. One flexible mock database:
// `program` is what the program row reads as (before AND after the lock),
// `sessionRows` the program's sessions; `calls` records the order of the
// steps that matter (the lock, the reads, the writes).
describe('AssignedProgramsService — closing and archiving (step 2b-iii)', () => {
  let service: AssignedProgramsService
  let program: Record<string, unknown>
  let sessionRows: { localDate: string; status: string }[]
  // What closing the program's OPEN sessions returns (step 1b): none,
  // unless a test says otherwise — and their checklist rows.
  let closedSessions: Record<string, unknown>[]
  let checklistRows: Record<string, unknown>[]
  let calls: string[]
  let setValues: jest.Mock
  let db: Record<string, unknown> & { transaction: jest.Mock }

  const admin = { id: 1, activeRole: UserRole.ADMIN }
  const today = utcToday()

  beforeEach(async () => {
    calls = []
    program = {
      id: 900,
      patientId: 20,
      title: 'Knee Rehab',
      status: 'active',
      isArchived: false,
      startDate: addDays(today, -20),
      endDate: null,
      basedOnTemplateId: 3,
      basedOnProgramId: null,
    }
    sessionRows = []
    closedSessions = []
    checklistRows = []
    setValues = jest.fn((values: Record<string, unknown>) => {
      // The sessions' UPDATE (its `endedAt` is SQL — now() — so it isn't
      // written out): recorded by what it does.
      if (values.endReason === 'program_closed') {
        calls.push('close open sessions')
        return {
          where: () => ({
            returning: jest.fn().mockResolvedValue(closedSessions),
          }),
        }
      }
      calls.push(`update ${JSON.stringify(values)}`)
      return {
        where: () =>
          Object.assign(Promise.resolve(undefined), {
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 900, ...(values as object) }]),
          }),
      }
    })
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn(() => {
            calls.push('read program')
            return Promise.resolve({ ...program })
          }),
        },
        programWorkouts: {
          findMany: jest.fn().mockResolvedValue(PROGRAM_WORKOUTS),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
      },
      // One select chain for the lock (.for) and the sessions read (awaited).
      select: jest.fn(() => ({
        from: () => ({
          // A "thenable": awaiting it runs `then` — so "read sessions" is
          // recorded only when the chain is really awaited, not when .for()
          // takes it elsewhere (a Promise would run its callback either way).
          where: () => ({
            then: (
              resolve: (rows: unknown) => unknown,
              reject: (error: unknown) => unknown,
            ) => {
              calls.push('read sessions')
              return Promise.resolve(sessionRows).then(resolve, reject)
            },
            for: jest.fn(() => {
              calls.push('lock')
              return Promise.resolve([])
            }),
            // The closed sessions' checklists (one query for all).
            orderBy: jest.fn(() => {
              calls.push('read checklists')
              return Promise.resolve(checklistRows)
            }),
          }),
        }),
      })),
      update: jest.fn(() => ({ set: setValues })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }
    auditService.logInTransaction.mockImplementation(
      (_tx: unknown, entry: { action: string }) => {
        calls.push(`audit ${entry.action}`)
        return Promise.resolve(undefined)
      },
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: UsersService,
          useValue: { isPatientManagedBy: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()
    service = moduleRef.get(AssignedProgramsService)
  })

  // The steps after the access checks: lock, read the program AGAIN, read
  // its sessions, write, audit — the state used is the one read under the
  // lock.
  const afterChecks = () => calls.slice(calls.indexOf('lock'))

  describe('close', () => {
    it('archives a program cancelled before any session — and answers no program', async () => {
      const result = await service.close(900, admin, 'cancel', today)

      expect(result).toEqual({ outcome: 'archived', program: null })
      expect(afterChecks()).toEqual([
        'lock',
        'read program',
        'read sessions',
        'update {"isArchived":true}',
        'audit ASSIGNED_PROGRAM_ARCHIVED',
      ])
      expect(auditService.logInTransaction).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          targetUserId: 20,
          details: {
            reason: 'cancelled before any session',
            program: {
              title: 'Knee Rehab',
              status: 'active',
              startDate: addDays(today, -20),
              endDate: null,
              basedOnTemplateId: 3,
              basedOnProgramId: null,
            },
          },
        }),
      )
    })

    // Any session counts — even one started and never completed: it is a
    // record of something that happened.
    it('cancels — not archives — a program with only an unfinished session', async () => {
      sessionRows = [{ localDate: addDays(today, -3), status: 'in_progress' }]

      const result = await service.close(900, admin, 'cancel', today)

      expect(result.outcome).toBe('cancelled')
      expect(setValues).toHaveBeenCalledWith({
        status: 'cancelled',
        endDate: addDays(today, -1),
      })
      expect(result.program).toMatchObject({ id: 900 })
    })

    // Completing with no session at all is still completing (only CANCEL
    // archives).
    it('completes a program even with no session', async () => {
      const result = await service.close(900, admin, 'complete', today)

      expect(result.outcome).toBe('completed')
      expect(setValues).toHaveBeenCalledWith({
        status: 'completed',
        endDate: addDays(today, -1),
      })
    })

    // TODAY's end only for a session COMPLETED today: one started today and
    // abandoned doesn't make today part of the program; one completed
    // yesterday doesn't either.
    it.each([
      ['completed today', today, 'completed', 0],
      ['started today, not completed', today, 'in_progress', -1],
      ['completed yesterday', addDays(today, -1), 'completed', -1],
    ])(
      'ends the program by the session %s',
      async (_label, day, status, offset) => {
        sessionRows = [{ localDate: day, status }]

        await service.close(900, admin, 'complete', today)

        expect(setValues).toHaveBeenCalledWith({
          status: 'completed',
          endDate: addDays(today, offset),
        })
      },
    )

    it('audits the status and end date, before → after, with the day it was decided', async () => {
      sessionRows = [{ localDate: today, status: 'completed' }]

      await service.close(900, admin, 'cancel', today)

      // …then the full program is read for the answer.
      expect(afterChecks().slice(0, 6)).toEqual([
        'lock',
        'read program',
        'read sessions',
        `update ${JSON.stringify({ status: 'cancelled', endDate: today })}`,
        'close open sessions',
        'audit ASSIGNED_PROGRAM_CANCELLED',
      ])
      expect(auditService.logInTransaction).toHaveBeenCalledWith(db, {
        performedBy: 1,
        action: 'ASSIGNED_PROGRAM_CANCELLED',
        targetUserId: 20,
        entityType: 'assigned-programs',
        entityId: 900,
        details: {
          today,
          changes: {
            status: { from: 'active', to: 'cancelled' },
            endDate: { from: null, to: today },
          },
          closedSessionIds: [],
        },
      })
    })

    // Step 1b: its OPEN sessions are closed with it — AFTER the program's own
    // UPDATE (the database's guard checks the program is closed), each with
    // its own entry carrying what was done in it, then the program's entry
    // listing them. (Which sessions the UPDATE matches is the database's
    // business: e2e.)
    it('closes its open sessions after itself, each with its own entry', async () => {
      sessionRows = [{ localDate: addDays(today, -1), status: 'in_progress' }]
      closedSessions = [
        {
          id: 70,
          patientId: 20,
          assignedProgramId: 900,
          status: 'incomplete',
          endReason: 'program_closed',
        },
      ]
      checklistRows = [
        { id: 7001, sessionId: 70, name: 'Squat', completed: true },
        { id: 7002, sessionId: 71, name: 'Not this one', completed: false },
      ]

      await service.close(900, admin, 'cancel', today)

      expect(afterChecks().slice(0, 8)).toEqual([
        'lock',
        'read program',
        'read sessions',
        `update ${JSON.stringify({ status: 'cancelled', endDate: addDays(today, -1) })}`,
        'close open sessions',
        'read checklists',
        'audit SESSION_STOPPED',
        'audit ASSIGNED_PROGRAM_CANCELLED',
      ])
      const entries = auditService.logInTransaction.mock.calls.map(
        (call) => (call as unknown[])[1],
      )
      expect(entries[0]).toMatchObject({
        performedBy: 1,
        action: 'SESSION_STOPPED',
        targetUserId: 20,
        entityType: 'sessions',
        entityId: 70,
        details: {
          session: { status: 'incomplete', endReason: 'program_closed' },
          exercises: [{ exerciseRowId: 7001, name: 'Squat', completed: true }],
        },
      })
      expect(
        (entries[0] as { details: { exercises: unknown[] } }).details.exercises,
      ).toHaveLength(1)
      expect(entries[1]).toMatchObject({
        action: 'ASSIGNED_PROGRAM_CANCELLED',
        details: { closedSessionIds: [70] },
      })
    })

    it('reads no checklist when no session was open', async () => {
      sessionRows = [{ localDate: addDays(today, -1), status: 'completed' }]

      await service.close(900, admin, 'complete', today)

      expect(calls).not.toContain('read checklists')
      expect(calls).toContain('close open sessions')
    })

    // The state that counts is the one read UNDER the lock: here the first
    // read (the access check) sees an active program, the second — after
    // the lock — a completed one, as when another request closed it while
    // this one waited.
    it('refuses a program closed while it waited for the lock, writing nothing', async () => {
      ;(
        db.query as { assignedPrograms: { findFirst: jest.Mock } }
      ).assignedPrograms.findFirst
        .mockImplementationOnce(() => Promise.resolve({ ...program }))
        .mockImplementationOnce(() =>
          Promise.resolve({ ...program, status: 'completed' }),
        )

      await expect(service.close(900, admin, 'cancel', today)).rejects.toThrow(
        new ConflictException(
          'This program is completed, so it can no longer change. To continue it, assign it again',
        ),
      )
      expect(setValues).not.toHaveBeenCalled()
      expect(auditService.logInTransaction).not.toHaveBeenCalled()
    })

    it("refuses a today that can't be today anywhere, before reading anything", async () => {
      await expect(
        service.close(900, admin, 'complete', addDays(today, -2)),
      ).rejects.toThrow(
        new BadRequestException("today must be today's date in your time zone"),
      )
      expect(calls).toEqual([])
    })
  })

  describe('archive', () => {
    it('archives a program with no session, audited with what it was', async () => {
      await service.archive(900, admin)

      expect(afterChecks()).toEqual([
        'lock',
        'read program',
        'read sessions',
        'update {"isArchived":true}',
        'audit ASSIGNED_PROGRAM_ARCHIVED',
      ])
    })

    it('refuses a program with sessions: cancel it instead', async () => {
      sessionRows = [{ localDate: today, status: 'completed' }]

      await expect(service.archive(900, admin)).rejects.toThrow(
        new ConflictException(
          "This program has sessions, so it is part of the patient's record and can't be deleted: cancel it instead",
        ),
      )
      expect(setValues).not.toHaveBeenCalled()
    })

    // A completed program with no session may still be archived; an
    // archived one can't be archived again.
    it('archives a completed program with no session, not an archived one', async () => {
      program = { ...program, status: 'completed' }
      await service.archive(900, admin)
      expect(setValues).toHaveBeenCalledTimes(1)

      program = { ...program, isArchived: true }
      await expect(service.archive(900, admin)).rejects.toThrow(
        new ConflictException(
          'This program was deleted, so it can no longer change',
        ),
      )
      expect(setValues).toHaveBeenCalledTimes(1)
    })
  })

  // Every write on a program refuses a closed one, before its transaction
  // (the program read + the access check run first: 404 / 403 win).
  describe('writes on a closed program', () => {
    const writes: [string, (s: AssignedProgramsService) => Promise<unknown>][] =
      [
        ['update', (s) => s.update(900, admin, { title: 'New' })],
        [
          'addExercise',
          (s) => s.addExercise(900, admin, { exerciseId: 1, sortOrder: 0 }),
        ],
        [
          'updateExercise',
          (s) => s.updateExercise(900, 31, admin, { sets: 3 }),
        ],
        ['reorderExercises', (s) => s.reorderExercises(900, admin, [31])],
        ['removeExercise', (s) => s.removeExercise(900, 31, admin)],
        [
          'addScheduleVersion',
          (s) =>
            s.addScheduleVersion(900, admin, {
              type: ScheduleType.PAUSED,
              effectiveFrom: today,
            }),
        ],
        ['addWorkout', (s) => s.addWorkout(900, admin, {})],
        [
          'renameWorkout',
          (s) => s.renameWorkout(900, 950, admin, { name: 'A' }),
        ],
        ['reorderWorkouts', (s) => s.reorderWorkouts(900, admin, [950])],
        ['removeWorkout', (s) => s.removeWorkout(900, 950, admin)],
      ]

    it.each(writes)('%s refuses a cancelled program', async (_name, write) => {
      program = { ...program, status: 'cancelled' }

      await expect(write(service)).rejects.toThrow(ConflictException)
      expect(db.transaction).toHaveBeenCalledTimes(1) // the program read only
      expect(setValues).not.toHaveBeenCalled()
    })
  })
})

// "Assign again": the source program's checks, all before anything is
// written. (The copy itself — workouts and tailored exercises, in order — is
// checked end to end in test/program-schedules.e2e-spec.ts.)
describe('AssignedProgramsService.create — assigning again (step 2b-iii)', () => {
  let service: AssignedProgramsService
  let source: Record<string, unknown>
  let db: {
    query: Record<string, unknown>
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER }
  const dto = {
    patientId: 20,
    basedOnProgramId: 800,
    title: 'Knee Rehab — block 2',
    startDate: utcToday(),
    schedule: { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 2 },
  }

  beforeEach(async () => {
    source = {
      id: 800,
      patientId: 20,
      status: 'cancelled',
      isArchived: false,
      basedOnTemplateId: 3,
    }
    db = {
      query: {
        assignedPrograms: { findFirst: jest.fn(() => Promise.resolve(source)) },
        programWorkouts: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 850, name: 'Upper', sortOrder: 0 }]),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      insert: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: UsersService,
          useValue: { isPatientManagedBy: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuditService, useValue: auditService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()
    service = moduleRef.get(AssignedProgramsService)
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>, Error]>([
    [
      'an active program',
      { status: 'active' },
      {},
      new ConflictException(
        'Only a completed or cancelled program can be assigned again: this one is still active',
      ),
    ],
    [
      'a deleted (archived) program',
      { isArchived: true },
      {},
      new BadRequestException('Deleted programs cannot be assigned again'),
    ],
    [
      "another patient's program",
      { patientId: 21 },
      {},
      new BadRequestException(
        'Program 800 belongs to another patient: a program is assigned again to the same patient',
      ),
    ],
    [
      'a program with an emptied workout',
      {},
      {},
      new BadRequestException('Workout A of program 800 has no exercises'),
    ],
    [
      'two sources at once',
      {},
      { basedOnTemplateId: 3 },
      new BadRequestException(
        'Give one source: basedOnTemplateId, basedOnProgramId or exercises',
      ),
    ],
  ])('refuses %s, writing nothing', async (_label, change, extra, error) => {
    source = { ...source, ...change }

    await expect(
      service.create(practitioner, { ...dto, ...extra }),
    ).rejects.toThrow(error)
    expect(db.insert).not.toHaveBeenCalled()
  })

  // Program-specific photos (2026-10-17): the old program's own photos are
  // COPIED to new files of the patient before the transaction — and if the
  // transaction then fails, the copies are deleted (nothing points at them).
  // The successful copy, end to end: test/program-exercise-photos.e2e-spec.ts.
  it('copies the own photos first, and deletes the copies when the transaction fails', async () => {
    const copies: [string, string][] = []
    storageService.copy.mockReset()
    storageService.copy.mockImplementation((from: string, to: string) => {
      copies.push([from, to])
      return Promise.resolve(to)
    })
    storageService.deleteUnreferenced.mockClear()
    ;(
      db.query.assignedProgramExercises as { findMany: jest.Mock }
    ).findMany.mockResolvedValue([
      {
        id: 31,
        workoutId: 850,
        sortOrder: 0,
        useLibraryImages: false,
        mediaUrls: ['patients/20/exercise-photos/old-a.png'],
      },
      {
        id: 32,
        workoutId: 850,
        sortOrder: 1,
        useLibraryImages: true,
        mediaUrls: ['patients/20/exercise-photos/old-b.jpg'],
      },
    ])
    const failure = new Error('insert refused')
    db.insert.mockImplementation(() => {
      throw failure
    })

    await expect(service.create(practitioner, dto)).rejects.toBe(failure)

    // Both rows' own photos — kept even where the library is shown — each
    // to a new key of the patient, with its own extension.
    expect(copies.map(([from]) => from)).toEqual([
      'patients/20/exercise-photos/old-a.png',
      'patients/20/exercise-photos/old-b.jpg',
    ])
    expect(copies[0][1]).toMatch(
      /^patients\/20\/exercise-photos\/[0-9a-f-]{36}\.png$/,
    )
    expect(copies[1][1]).toMatch(
      /^patients\/20\/exercise-photos\/[0-9a-f-]{36}\.jpg$/,
    )
    expect(storageService.deleteUnreferenced.mock.calls).toEqual(
      copies.map(([, to]) => [to]),
    )
  })

  it("refuses a program the caller can't see (404)", async () => {
    ;(
      db.query.assignedPrograms as { findFirst: jest.Mock }
    ).findFirst.mockImplementation(() => Promise.resolve(undefined))

    await expect(service.create(practitioner, dto)).rejects.toThrow(
      new NotFoundException('Assigned program 800 not found'),
    )
    expect(db.insert).not.toHaveBeenCalled()
  })
})

// The rule the removal preview answers with — the same one the removal
// follows (a session used it → retired, else deleted).
describe('planRemoval', () => {
  it.each([
    [0, 'deleted'],
    [1, 'retired'],
    [12, 'retired'],
  ])('%i session(s) → %s', (sessions, outcome) => {
    expect(planRemoval(sessions)).toStrictEqual({
      outcome,
      sessionCount: sessions,
    })
  })
})
