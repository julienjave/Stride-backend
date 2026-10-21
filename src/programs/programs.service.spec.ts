import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { DrizzleQueryError } from 'drizzle-orm'
import { ProgramsService } from './programs.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'
import { AuditService } from '../audit/audit.service'
import {
  programTemplates,
  templateExercises,
  templateWorkouts,
} from '../database/schema'

// Every template has at least one workout, and findOne() reads them. Most
// tests here use a one-workout template; their exercise rows predate
// workouts (no workoutId), which orderExercisesByWorkout handles by keeping
// their own order.
const ONE_WORKOUT = [{ id: 900, templateId: 1, name: null, sortOrder: 0 }]

// AuditService since the audit review (slice 1c): every write's ONE entry
// goes through logInTransaction, inside its transaction. A fresh stub before
// EVERY test (this top-level beforeEach runs before each block's own).
function auditStub() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logInTransaction: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(undefined),
  }
}
let audit: ReturnType<typeof auditStub>
beforeEach(() => {
  audit = auditStub()
})

// lockTemplate()'s SELECT … FOR UPDATE, on a block's mocked db (tx === db in
// these blocks): answers `row` — the template as it is INSIDE the
// transaction, the "before" an entry records. Returns the .for() mock.
function lockRow(db: object, row: Record<string, unknown>) {
  const forUpdate = jest.fn().mockResolvedValue([row])
  Object.assign(db, {
    select: jest.fn(() => ({
      from: () => ({ where: () => ({ for: forUpdate }) }),
    })),
  })
  return forUpdate
}

describe('ProgramsService.update (and assertCanModify through it)', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }
  // Captured so tests can assert on exactly what reached the UPDATE, not
  // just on what the (separately mocked) findOne() afterward returns.
  let setMock: jest.Mock

  beforeEach(async () => {
    setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, title: 'Updated' }]),
      }),
    })
    db = {
      query: {
        programTemplates: { findFirst: jest.fn() },
        // findOne()'s own reads, called at the END of update() now.
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: { findMany: jest.fn().mockResolvedValue([]) },
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn().mockReturnValue({ set: setMock }),
      // withRlsContext() wraps the actual UPDATE in db.transaction()/
      // db.execute() — tx === db here, so the mocked update() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
    lockRow(db, { id: 1, practitionerId: 7, title: 'Old', description: null })
  })

  it('allows the owning practitioner to modify their own template', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })

    await programsService.update(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { title: 'Updated' },
    )

    expect(setMock).toHaveBeenCalledWith({ title: 'Updated' })
    // ONE entry in the same transaction: before (read under the lock) →
    // after. Templates hold no patient data: no targetUserId.
    expect(audit.logInTransaction.mock.calls).toStrictEqual([
      [
        db,
        {
          performedBy: 7,
          action: 'TEMPLATE_UPDATED',
          entityType: 'program_templates',
          entityId: 1,
          details: { changes: { title: { from: 'Old', to: 'Updated' } } },
        },
      ],
    ])
  })

  it('writes nothing — no UPDATE, no entry — for a title that is already stored', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })

    await programsService.update(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { title: 'Old' },
    )

    expect(setMock).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })

  it('returns the full enriched template via findOne — not the bare updated row', async () => {
    // First call: the ownership check's lookup. Second call: findOne()'s
    // own lookup AFTER the write, which (like the real DB) sees the new
    // title.
    db.query.programTemplates.findFirst
      .mockResolvedValueOnce({ id: 1, practitionerId: 7, title: 'Old' })
      .mockResolvedValueOnce({ id: 1, practitionerId: 7, title: 'Updated' })
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 50, templateId: 1, exerciseId: 6, sortOrder: 0 },
    ])
    db.query.exercises.findMany.mockResolvedValue([
      { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
    ])

    const result = await programsService.update(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { title: 'Updated' },
    )

    // The regression guard: a bare-row return has no `exercises` array
    // at all — which, written straight into the frontend's cache, would
    // wipe the exercise list off the page the moment the title changed.
    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      title: 'Updated',
      workouts: ONE_WORKOUT,
      exercises: [
        {
          id: 50,
          templateId: 1,
          exerciseId: 6,
          sortOrder: 0,
          exercise: { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
        },
      ],
    })
  })

  it('allows an admin to modify a template they do not own', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })

    await programsService.update(
      1,
      { id: 999, activeRole: UserRole.ADMIN },
      { title: 'Updated' },
    )

    expect(setMock).toHaveBeenCalledWith({ title: 'Updated' })
  })

  it('rejects a different practitioner modifying a template they do not own', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })

    await expect(
      programsService.update(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        { title: 'Updated' },
      ),
    ).rejects.toThrow(ForbiddenException)
    expect(setMock).not.toHaveBeenCalled()
  })
})

describe('ProgramsService.archive', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }
  let setMock: jest.Mock

  beforeEach(async () => {
    setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, isArchived: true }]),
      }),
    })
    db = {
      query: {
        programTemplates: { findFirst: jest.fn() },
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: { findMany: jest.fn().mockResolvedValue([]) },
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn().mockReturnValue({ set: setMock }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
  })

  it('sets isArchived, then returns the full enriched template via findOne', async () => {
    db.query.programTemplates.findFirst
      .mockResolvedValueOnce({ id: 1, practitionerId: 7, isArchived: false })
      .mockResolvedValueOnce({ id: 1, practitionerId: 7, isArchived: true })
    lockRow(db, { id: 1, practitionerId: 7, title: 'Knee', isArchived: false })

    const result = await programsService.archive(1, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(setMock).toHaveBeenCalledWith({ isArchived: true })
    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      isArchived: true,
      workouts: ONE_WORKOUT,
      exercises: [],
    })
    // What the template WAS — after archiving, no list shows it.
    expect(audit.logInTransaction.mock.calls).toStrictEqual([
      [
        db,
        {
          performedBy: 7,
          action: 'TEMPLATE_ARCHIVED',
          entityType: 'program_templates',
          entityId: 1,
          details: { title: 'Knee' },
        },
      ],
    ])
  })

  it('writes nothing for a template that is already archived', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
      isArchived: true,
    })
    lockRow(db, { id: 1, practitionerId: 7, title: 'Knee', isArchived: true })

    await programsService.archive(1, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(setMock).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })

  it('rejects a non-owning practitioner without writing anything', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
      isArchived: false,
    })

    await expect(
      programsService.archive(1, {
        id: 999,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toThrow(ForbiddenException)
    expect(setMock).not.toHaveBeenCalled()
  })
})

describe('ProgramsService.duplicate', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
    transaction: jest.Mock
  }
  // Everything that happens INSIDE the transaction goes through this
  // separate tx object, not the top-level db — same split as
  // reorderExercises' tests. That separation is what lets these tests
  // prove the source rows are read inside the transaction, and that
  // both inserts go through it.
  let tx: {
    insert: jest.Mock
    query: {
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
    }
    execute: jest.Mock
  }
  let templateValues: jest.Mock
  let workoutValues: jest.Mock
  let rowValues: jest.Mock

  // The source's two workouts, returned by the database OUT of order on
  // purpose: the copy must follow their positions, not the read order.
  const sourceWorkouts = [
    { id: 902, templateId: 1, name: 'Lower body', sortOrder: 1 },
    { id: 901, templateId: 1, name: null, sortOrder: 0 },
  ]

  // A full row, every column populated — so a toEqual on what reaches
  // the INSERT genuinely proves nothing was dropped along the way.
  const sourceRows = [
    {
      id: 100,
      templateId: 1,
      workoutId: 901,
      exerciseId: 5,
      sets: 3,
      reps: 10,
      durationInSeconds: null,
      weight: 62.5,
      weightUnit: 'kg',
      sortOrder: 0,
      notes: 'Go slow',
    },
    {
      id: 101,
      templateId: 1,
      workoutId: 902,
      exerciseId: 6,
      sets: null,
      reps: null,
      durationInSeconds: 30,
      weight: null,
      weightUnit: null,
      sortOrder: 1,
      notes: null,
    },
  ]

  beforeEach(async () => {
    templateValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 42 }]),
    })
    rowValues = jest.fn().mockResolvedValue(undefined)
    // Each copied workout gets a new id: 951 for the first INSERT, 952 for
    // the second.
    let nextWorkoutId = 951
    workoutValues = jest.fn().mockImplementation(() => ({
      returning: jest.fn().mockResolvedValue([{ id: nextWorkoutId++ }]),
    }))
    tx = {
      // Routes by WHICH table is passed in, so the tests also prove each
      // insert targets the right table, not just that "an insert happened."
      insert: jest.fn((table: unknown) => {
        if (table === programTemplates) return { values: templateValues }
        if (table === templateWorkouts) return { values: workoutValues }
        if (table === templateExercises) return { values: rowValues }
        throw new Error('Unexpected table passed to insert()')
      }),
      query: {
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(sourceWorkouts),
        },
        templateExercises: {
          findMany: jest.fn().mockResolvedValue(sourceRows),
        },
      },
      execute: jest.fn().mockResolvedValue(undefined),
    }

    db = {
      query: {
        programTemplates: { findFirst: jest.fn() },
        // findOne()'s reads, AFTER the transaction — deliberately return
        // nothing useful by default; the main test overrides them.
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: { findMany: jest.fn().mockResolvedValue([]) },
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
  })

  it('copies the template and every exercise row, owned by the duplicating practitioner — even one who does not own the source', async () => {
    db.query.programTemplates.findFirst
      // The source — owned by practitioner 7, not the caller (9).
      .mockResolvedValueOnce({
        id: 1,
        practitionerId: 7,
        title: 'Knee Rehab',
        description: 'Phase 1',
        isArchived: false,
      })
      // findOne(42)'s lookup of the NEW template, after the transaction.
      .mockResolvedValueOnce({
        id: 42,
        practitionerId: 9,
        title: 'Copy of Knee Rehab',
        description: 'Phase 1',
        isArchived: false,
      })

    const result = await programsService.duplicate(1, {
      id: 9,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(templateValues).toHaveBeenCalledWith({
      practitionerId: 9,
      title: 'Copy of Knee Rehab',
      description: 'Phase 1',
    })
    // The workouts, copied in their order (A, then B), names included.
    // (toHaveBeenNthCalledWith rather than reading mock.calls, whose
    // untyped `any` the strict lint config flags.)
    expect(workoutValues).toHaveBeenCalledTimes(2)
    expect(workoutValues).toHaveBeenNthCalledWith(1, {
      templateId: 42,
      name: null,
      sortOrder: 0,
    })
    expect(workoutValues).toHaveBeenNthCalledWith(2, {
      templateId: 42,
      name: 'Lower body',
      sortOrder: 1,
    })
    // Full toEqual on the real INSERT argument — the regression guard
    // for the "copy silently drops a column" bug class this codebase has
    // hit three times. Every column comes across except id (the DB
    // assigns a new one) and templateId (re-pointed at the copy, 42).
    // ...and each exercise re-pointed at the COPY's workout: 901 (A) became
    // 951, 902 (B) became 952.
    expect(rowValues).toHaveBeenCalledWith([
      {
        templateId: 42,
        workoutId: 951,
        exerciseId: 5,
        sets: 3,
        reps: 10,
        durationInSeconds: null,
        weight: 62.5,
        weightUnit: 'kg',
        sortOrder: 0,
        notes: 'Go slow',
      },
      {
        templateId: 42,
        workoutId: 952,
        exerciseId: 6,
        sets: null,
        reps: null,
        durationInSeconds: 30,
        weight: null,
        weightUnit: null,
        sortOrder: 1,
        notes: null,
      },
    ])
    // Read inside the transaction, from the SOURCE template.
    expect(tx.query.templateExercises.findMany).toHaveBeenCalledTimes(1)
    // And the response is findOne() of the NEW template, not the source.
    expect(db.query.programTemplates.findFirst).toHaveBeenCalledTimes(2)
    expect(result).toEqual(expect.objectContaining({ id: 42 }))
  })

  it('skips the exercise-row insert entirely for a template with no exercises', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
      title: 'Empty',
      description: null,
      isArchived: false,
    })
    tx.query.templateExercises.findMany.mockResolvedValue([])

    await programsService.duplicate(1, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(templateValues).toHaveBeenCalledTimes(1)
    // Drizzle throws on .values([]) — reaching this with an empty array
    // would crash the real request.
    expect(rowValues).not.toHaveBeenCalled()
  })

  it('rejects an archived source without opening a transaction', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
      title: 'Deleted',
      description: null,
      isArchived: true,
    })

    await expect(
      programsService.duplicate(1, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toThrow(BadRequestException)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('throws NotFoundException when the source does not exist', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue(undefined)

    await expect(
      programsService.duplicate(999, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toThrow(NotFoundException)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it("trims a long generated title to exactly the DTO's 200-character limit", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
      title: 'a'.repeat(200),
      description: null,
      isArchived: false,
    })

    await programsService.duplicate(1, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    // Asserted against the full INSERT argument (not by digging into
    // templateValues.mock.calls, whose untyped `any` the strict lint
    // config flags). The expected title's own length is checked first, so
    // the test states the 200 limit explicitly instead of leaving it
    // implied by the 192.
    const expectedTitle = 'Copy of ' + 'a'.repeat(192)
    expect(expectedTitle).toHaveLength(200)
    expect(templateValues).toHaveBeenCalledWith({
      practitionerId: 7,
      title: expectedTitle,
      description: null,
    })
  })

  it('never cuts a multi-code-unit character (like an emoji) in half when trimming', async () => {
    // Each "💪" is ONE character but TWO UTF-16 code units — a naive
    // string.slice() by length could split the last one down the middle.
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
      title: '💪'.repeat(200),
      description: null,
      isArchived: false,
    })

    await programsService.duplicate(1, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    // 200 CHARACTERS (code points) — even though it's 392 UTF-16 code
    // units, which is what a plain .length would report.
    const expectedTitle = 'Copy of ' + '💪'.repeat(192)
    expect(Array.from(expectedTitle)).toHaveLength(200)
    expect(templateValues).toHaveBeenCalledWith({
      practitionerId: 7,
      title: expectedTitle,
      description: null,
    })
  })
})

describe('ProgramsService.addExercise', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      exercises: { findFirst: jest.Mock; findMany: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
    }
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
        },
        exercises: {
          findFirst: jest.fn(),
          // Used by the NEW findOne()-based return path's
          // withExerciseDetails enrichment, not the exerciseId-exists
          // check above (that's findFirst) — a separate lookup entirely.
          findMany: jest.fn().mockResolvedValue([]),
        },
        // Used by findOne(), called at the END of addExercise now (see
        // that method's own comment on why it matches reorderExercises'
        // existing convention).
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      insert: jest.fn(),
      // withRlsContext() wraps the actual INSERT in db.transaction()/
      // db.execute() — tx === db here, so the mocked insert() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
  })

  it('throws NotFoundException when the referenced exercise does not exist', async () => {
    db.query.exercises.findFirst.mockResolvedValue(undefined)

    await expect(
      programsService.addExercise(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          exerciseId: 999,
          sortOrder: 0,
        },
      ),
    ).rejects.toThrow(NotFoundException)
  })

  it('rejects a non-owning practitioner before ever checking the exercise exists', async () => {
    await expect(
      programsService.addExercise(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        {
          exerciseId: 5,
          sortOrder: 0,
        },
      ),
    ).rejects.toThrow(ForbiddenException)
    expect(db.query.exercises.findFirst).not.toHaveBeenCalled()
  })

  it('adds the exercise, then returns the full enriched template via findOne', async () => {
    db.query.exercises.findFirst.mockResolvedValue({ id: 5, name: 'Squat' })
    // Captured so the test can assert on exactly what reached the
    // database, not just what the (separately mocked) findOne() call
    // afterward happens to resolve to — a real bug (weight/weightUnit
    // silently missing from this object) shipped once already precisely
    // because no test checked this before.
    const valuesMock = jest.fn().mockReturnValue({
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 10, templateId: 1, exerciseId: 5 }]),
    })
    db.insert.mockReturnValue({ values: valuesMock })
    // findOne()'s own reads, AFTER the insert above — a fresh row list
    // (as the real DB would return post-insert) and the matching
    // exercise details for withExerciseDetails to attach.
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 10, templateId: 1, exerciseId: 5, sortOrder: 0 },
    ])
    db.query.exercises.findMany.mockResolvedValue([
      { id: 5, name: 'Squat', primaryMuscles: ['legs'] },
    ])

    const result = await programsService.addExercise(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        exerciseId: 5,
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: 'kg',
        notes: 'Go slow',
        sortOrder: 0,
      },
    )

    // The actual regression guard: every DTO field the caller provided
    // must reach the INSERT, not just the ones that happened to already
    // be there before weight/weightUnit were added.
    expect(valuesMock).toHaveBeenCalledWith({
      templateId: 1,
      // No workoutId in the request: the template's first workout.
      workoutId: 900,
      exerciseId: 5,
      sets: 3,
      reps: 10,
      durationInSeconds: undefined,
      weight: 62.5,
      weightUnit: 'kg',
      sortOrder: 0,
      notes: 'Go slow',
    })

    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      workouts: ONE_WORKOUT,
      exercises: [
        {
          id: 10,
          templateId: 1,
          exerciseId: 5,
          sortOrder: 0,
          exercise: { id: 5, name: 'Squat', primaryMuscles: ['legs'] },
        },
      ],
    })
  })
})

describe('ProgramsService.reorderExercises', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findFirst: jest.Mock; findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
    transaction: jest.Mock
  }
  let txUpdate: jest.Mock
  let txWhere: jest.Mock

  beforeEach(async () => {
    txWhere = jest.fn().mockResolvedValue(undefined)
    txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: txWhere }),
    })

    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
        },
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: {
          findFirst: jest.fn(),
          // Used by findOne() AFTER the transaction commits, to return the
          // freshly reordered template from real post-write state.
          findMany: jest.fn().mockResolvedValue([
            { id: 100, exerciseId: 50 },
            { id: 101, exerciseId: 51 },
            { id: 102, exerciseId: 52 },
          ]),
        },
        // findOne()'s own withExerciseDetails enrichment — not exercised
        // by most tests in this block (they only assert on txUpdate call
        // counts), but must exist and resolve to SOMETHING, or findOne()
        // would crash on `undefined.findMany` before ever returning.
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      // The read-validate-write now all happen inside this callback (via
      // tx.query), not against the top-level db — see the comment in
      // ProgramsService.reorderExercises for why. withRlsContext() also
      // issues two set_config calls via tx.execute() before invoking this
      // callback's own body, hence the added execute() mock below.
      transaction: jest
        .fn()
        .mockImplementation((cb: (tx: unknown) => unknown) =>
          cb({
            query: {
              templateWorkouts: {
                findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
              },
              templateExercises: {
                findMany: jest.fn().mockResolvedValue([
                  { id: 100, exerciseId: 50 },
                  { id: 101, exerciseId: 51 },
                  { id: 102, exerciseId: 52 },
                ]),
              },
            },
            update: txUpdate,
            execute: jest.fn().mockResolvedValue(undefined),
          }),
        ),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
  })

  it('accepts a reordering that is an exact permutation of the current rows', async () => {
    // findOne() is called at the end to return the freshly reordered
    // template — reuse the same findFirst/findMany mocks already configured.
    await programsService.reorderExercises(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [102, 100, 101],
    )

    expect(db.transaction).toHaveBeenCalled()
    expect(txUpdate).toHaveBeenCalledTimes(3)
  })

  it('rejects a reordering that omits one of the current rows, without writing anything', async () => {
    await expect(
      programsService.reorderExercises(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [100, 101],
      ),
    ).rejects.toThrow(BadRequestException)
    // The permutation check now runs inside the transaction (alongside the
    // read it validates against), so the transaction IS entered — it just
    // never reaches the update loop before throwing.
    expect(db.transaction).toHaveBeenCalled()
    expect(txUpdate).not.toHaveBeenCalled()
  })

  it('rejects a reordering from a practitioner who does not own the template', async () => {
    await expect(
      programsService.reorderExercises(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        [100, 101, 102],
      ),
    ).rejects.toThrow(ForbiddenException)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  // Regression coverage for the TOCTOU fix: the permutation check must
  // validate against the transaction's OWN read, not a snapshot taken
  // before the transaction opened — otherwise a row removed/added in the
  // gap between the two could slip past validation. Simulated here by
  // making the pre-transaction (db.query) view stale/wrong on purpose: if
  // the service were still reading via this.db.query instead of tx.query,
  // this reordering would wrongly pass (it's a valid permutation of the
  // STALE set) instead of being rejected against the tx's real set.
  it('validates the permutation against the transaction, not a pre-transaction snapshot', async () => {
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 100 },
      { id: 101 },
      { id: 102 },
      { id: 999 }, // a row the tx-scoped read does NOT see
    ])

    await expect(
      programsService.reorderExercises(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [100, 101, 102, 999],
      ),
    ).rejects.toThrow(BadRequestException)
    expect(txUpdate).not.toHaveBeenCalled()
  })
})

describe('ProgramsService.findOne', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
  }

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: { findFirst: jest.fn() },
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: { findMany: jest.fn() },
        exercises: { findMany: jest.fn() },
      },
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
  })

  it('throws NotFoundException when the template does not exist', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue(undefined)

    await expect(programsService.findOne(999)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns an empty exercises array without querying exercises at all, for a template with none', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })
    db.query.templateExercises.findMany.mockResolvedValue([])

    const result = await programsService.findOne(1)

    expect(result.exercises).toEqual([])
    expect(db.query.exercises.findMany).not.toHaveBeenCalled()
  })

  it('batches a single lookup for multiple rows, even ones referencing the same exercise', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 10, templateId: 1, exerciseId: 5, sortOrder: 0 },
      { id: 11, templateId: 1, exerciseId: 6, sortOrder: 1 },
      // Same exercise as row 10 — e.g. the same movement done twice in
      // one template with different sets/reps.
      { id: 12, templateId: 1, exerciseId: 5, sortOrder: 2 },
    ])
    db.query.exercises.findMany.mockResolvedValue([
      { id: 5, name: 'Squat', primaryMuscles: ['legs'] },
      { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
    ])

    const result = await programsService.findOne(1)

    expect(db.query.exercises.findMany).toHaveBeenCalledTimes(1)
    expect(result.exercises).toEqual([
      {
        id: 10,
        templateId: 1,
        exerciseId: 5,
        sortOrder: 0,
        exercise: { id: 5, name: 'Squat', primaryMuscles: ['legs'] },
      },
      {
        id: 11,
        templateId: 1,
        exerciseId: 6,
        sortOrder: 1,
        exercise: { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
      },
      {
        id: 12,
        templateId: 1,
        exerciseId: 5,
        sortOrder: 2,
        exercise: { id: 5, name: 'Squat', primaryMuscles: ['legs'] },
      },
    ])
  })

  it('defensively returns a null exercise rather than throwing, if the referenced exercise is somehow missing', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    })
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 10, templateId: 1, exerciseId: 999, sortOrder: 0 },
    ])
    db.query.exercises.findMany.mockResolvedValue([])

    const result = await programsService.findOne(1)

    expect(result.exercises[0].exercise).toBeNull()
  })
})

describe('ProgramsService IDOR checks (updateExercise / removeExercise)', () => {
  let programsService: ProgramsService
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock }
      templateWorkouts: { findMany: jest.Mock }
      templateExercises: { findFirst: jest.Mock; findMany: jest.Mock }
      exercises: { findMany: jest.Mock }
    }
    update: jest.Mock
    delete: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
        },
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue(ONE_WORKOUT),
        },
        templateExercises: {
          findFirst: jest.fn(),
          // Used by findOne(), called at the end of removeExercise now
          // (see that method's own comment on why).
          findMany: jest.fn().mockResolvedValue([]),
        },
        exercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: jest.fn(),
      // DELETE … RETURNING: the removed row, as the entry records it.
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 50,
              templateId: 1,
              workoutId: 900,
              exerciseId: 6,
              sets: 3,
              reps: 10,
              durationInSeconds: null,
              weight: null,
              weightUnit: null,
              sortOrder: 0,
              notes: null,
            },
          ]),
        }),
      }),
      // withRlsContext() wraps the actual DELETE in db.transaction()/
      // db.execute() — tx === db here, so the mocked delete() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    programsService = moduleRef.get(ProgramsService)
    lockRow(db, { id: 1, practitionerId: 7 })
  })

  it('throws NotFoundException when the exercise row does not belong to this template', async () => {
    db.query.templateExercises.findFirst.mockResolvedValue(undefined)

    await expect(
      programsService.removeExercise(1, 999, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toThrow(NotFoundException)
  })

  it('updateExercise: throws NotFoundException when the exercise row does not belong to this template', async () => {
    db.query.templateExercises.findFirst.mockResolvedValue(undefined)

    await expect(
      programsService.updateExercise(
        1,
        999,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { sets: 5 },
      ),
    ).rejects.toThrow(NotFoundException)
  })

  it('updateExercise: updates the row, then returns the full enriched template via findOne — not the bare updated row', async () => {
    db.query.templateExercises.findFirst.mockResolvedValue({
      id: 50,
      templateId: 1,
      sets: 3,
    })
    db.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: 50, templateId: 1, sets: 5 }]),
        }),
      }),
    })
    // findOne()'s own read AFTER the update — this is the actual
    // regression guard: a bare-row return (what this method used to do)
    // would have no `exercise` field at all, since only findOne's own
    // withExerciseDetails enrichment attaches it.
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 50, templateId: 1, exerciseId: 6, sets: 5, sortOrder: 0 },
    ])
    db.query.exercises.findMany.mockResolvedValue([
      { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
    ])

    const result = await programsService.updateExercise(
      1,
      50,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { sets: 5 },
    )

    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      workouts: ONE_WORKOUT,
      exercises: [
        {
          id: 50,
          templateId: 1,
          exerciseId: 6,
          sets: 5,
          sortOrder: 0,
          exercise: { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
        },
      ],
    })
    // Before → after, from the row read inside the transaction.
    expect(audit.logInTransaction.mock.calls).toStrictEqual([
      [
        db,
        {
          performedBy: 7,
          action: 'TEMPLATE_EXERCISE_UPDATED',
          entityType: 'program_templates',
          entityId: 1,
          details: {
            templateExerciseId: 50,
            changes: { sets: { from: 3, to: 5 } },
          },
        },
      ],
    ])
  })

  it('removes the exercise row, then returns the full enriched template via findOne', async () => {
    db.query.templateExercises.findFirst.mockResolvedValue({
      id: 50,
      templateId: 1,
    })
    // findOne()'s post-removal read — the removed row (50) is gone,
    // proving the response reflects real post-write state, not an echo
    // of the request.
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 51, templateId: 1, exerciseId: 6, sortOrder: 0 },
    ])
    db.query.exercises.findMany.mockResolvedValue([
      { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
    ])

    const result = await programsService.removeExercise(1, 50, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(db.delete).toHaveBeenCalled()
    // The row as it was when it went, whole.
    expect(audit.logInTransaction.mock.calls).toStrictEqual([
      [
        db,
        {
          performedBy: 7,
          action: 'TEMPLATE_EXERCISE_REMOVED',
          entityType: 'program_templates',
          entityId: 1,
          details: {
            exercise: {
              id: 50,
              workoutId: 900,
              exerciseId: 6,
              sets: 3,
              reps: 10,
              durationInSeconds: null,
              weight: null,
              weightUnit: null,
              sortOrder: 0,
              notes: null,
            },
          },
        },
      ],
    ])
    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      workouts: ONE_WORKOUT,
      exercises: [
        {
          id: 51,
          templateId: 1,
          exerciseId: 6,
          sortOrder: 0,
          exercise: { id: 6, name: 'Lunge', primaryMuscles: ['legs'] },
        },
      ],
    })
  })
})

// The one case the e2e tests can't produce on demand: an exercise added to
// the workout between removeWorkout's count ("empty") and its DELETE. The
// database then refuses the DELETE through the exercise's foreign key, and
// the service must answer with the same 409 the count would have given —
// not a 500. The database's error is mocked here, wrapped the way Drizzle
// wraps it.
describe('ProgramsService.removeWorkout — losing the race to an added exercise', () => {
  let programsService: ProgramsService
  let deleteWhere: jest.Mock

  beforeEach(async () => {
    deleteWhere = jest.fn()
    // The template's row lock (select … .for) and the exercise count
    // (select … where) share one chain: `where` answers the count AND
    // offers `.for` for the lock.
    const where = () =>
      Object.assign(Promise.resolve([{ exerciseCount: 0 }]), {
        for: jest.fn().mockResolvedValue([{ id: 1, practitionerId: 7 }]),
      })
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn(() => ({ from: () => ({ where }) })),
      query: {
        templateWorkouts: {
          findMany: jest.fn().mockResolvedValue([
            { id: 1, name: null, sortOrder: 0 },
            { id: 2, name: null, sortOrder: 1 },
          ]),
        },
      },
      delete: jest.fn(() => ({ where: deleteWhere })),
    }
    const db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
        },
      },
      transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()
    programsService = moduleRef.get(ProgramsService)
  })

  it("answers 409 when the exercises' foreign key refuses the delete", async () => {
    deleteWhere.mockRejectedValue(
      new DrizzleQueryError(
        'delete from "template_workouts" ...',
        [],
        Object.assign(new Error('fk'), {
          code: '23503',
          constraint: 'template_exercises_workout_fk',
        }),
      ),
    )
    await expect(
      programsService.removeWorkout(1, 2, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toThrow(
      new ConflictException(
        'This workout still has exercises: move or remove them first',
      ),
    )
  })

  // Any other failure is not this race, and stays what it is.
  it('lets any other error through unchanged', async () => {
    const other = new Error('connection lost')
    deleteWhere.mockRejectedValue(other)
    await expect(
      programsService.removeWorkout(1, 2, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toBe(other)
  })
})
