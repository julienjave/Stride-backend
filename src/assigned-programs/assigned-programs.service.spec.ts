import { Test } from "@nestjs/testing";
import { DrizzleQueryError } from "drizzle-orm";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  AssignedProgramsService,
  assertScheduleDayAllowed,
} from "./assigned-programs.service";
import { addDays, utcToday } from "../common/calendar-date";
import { AuditService } from "../audit/audit.service";

// The audit entries written by create / update / addScheduleVersion
// (AuditService.logInTransaction) — shared by every test module below, and
// cleared before each test.
const auditService = {
  logInTransaction: jest.fn().mockResolvedValue(undefined),
};
beforeEach(() => {
  auditService.logInTransaction.mockReset();
  auditService.logInTransaction.mockResolvedValue(undefined);
});
import { UsersService } from "../users/users.service";
import { DRIZZLE } from "../database/drizzle.provider";
import { UserRole } from "../users/dto/create-user.dto";
import { ScheduleType } from "./dto/schedule-input.dto";

// Every program has at least one workout, and the full program (what most
// writes answer with) includes them. Most tests here use a one-workout
// program; their exercise rows predate workouts (no workoutId), which
// orderExercisesByWorkout handles by keeping their own order.
// What every program mock carries unless a test says otherwise: an active,
// not archived program — the only kind that may change (program-state.ts).
const OPEN_STATE = { status: "active", isArchived: false } as const;

const PROGRAM_WORKOUTS = [
  { id: 950, assignedProgramId: 900, name: null, sortOrder: 0 },
];

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
};

describe("AssignedProgramsService.create", () => {
  let service: AssignedProgramsService;
  let usersService: {
    isPatientManagedBy: jest.Mock;
    findPatientsForPractitioner: jest.Mock;
  };
  let db: {
    query: {
      templateWorkouts: { findMany: jest.Mock };
      templateExercises: { findMany: jest.Mock };
      programTemplates: { findFirst: jest.Mock };
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
      exercises: { findMany: jest.Mock };
    };
    insert: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    usersService = {
      isPatientManagedBy: jest.fn(),
      findPatientsForPractitioner: jest.fn(),
    };
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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  it("refuses to assign a program to a patient the practitioner does not manage", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: "Rehab Plan",
          startDate: "2026-01-01",
          schedule: MWF,
          exercises: [{ exerciseId: 1, sortOrder: 0 }],
        },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects when neither basedOnTemplateId nor an inline exercises array is provided", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { patientId: 20, title: "Rehab Plan", startDate: "2026-01-01", schedule: MWF },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // A 400, no longer a 404: the template exists (it was found), so "not
  // found" would describe the wrong problem.
  it("refuses a template that has no exercises to copy", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.templateExercises.findMany.mockResolvedValue([]);

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: "Rehab Plan",
          startDate: "2026-01-01",
          schedule: MWF,
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(
      new BadRequestException("Program template 55 has no exercises to copy"),
    );
  });

  it("refuses a template that doesn't exist", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.programTemplates.findFirst.mockResolvedValue(undefined);

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: "Rehab Plan",
          startDate: "2026-01-01",
          schedule: MWF,
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(new NotFoundException("Program template 55 not found"));
  });

  // The gap from deferred-improvements.md. The template still HAS its
  // exercises (archiving doesn't remove them) — which is exactly why the
  // old code, reading only the exercises, let it through.
  it("refuses an archived template, without creating anything", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 55,
      isArchived: true,
    });
    db.query.templateExercises.findMany.mockResolvedValue([
      { exerciseId: 1, sortOrder: 0 },
    ]);

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: "Rehab Plan",
          startDate: "2026-01-01",
          schedule: MWF,
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(
      new BadRequestException("Archived program templates cannot be assigned"),
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("copies the template exercises into independent rows, not references to the template", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.templateExercises.findMany.mockResolvedValue([
      {
        exerciseId: 1,
        workoutId: 70,
        sets: 3,
        reps: 10,
        durationInSeconds: null,
        weight: 62.5,
        weightUnit: "kg",
        sortOrder: 0,
        notes: null,
      },
    ]);
    // The exercise's CURRENT data at the moment of copy — this is what
    // fetchExerciseSnapshots reads to build the snapshot.
    db.query.exercises.findMany.mockResolvedValue([
      {
        id: 1,
        name: "Squat",
        primaryMuscles: ["legs"],
        secondaryMuscles: ["core"],
        equipment: ["barbell"],
        instructions: ["Step one"],
      },
    ]);

    const inserted: any[] = [];
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: any) => {
        inserted.push(values);
        return {
          returning: jest.fn().mockResolvedValue([{ id: 900, ...values }]),
        };
      }),
    }));

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        patientId: 20,
        title: "Rehab Plan",
        startDate: "2026-01-01",
          schedule: MWF,
        basedOnTemplateId: 55,
      },
    );

    // One insert for the program itself, one for its copy of the template's
    // workout, one for the copied exercise row — this row is a brand-new
    // record, never an FK back to templateExercises — and two for the
    // program's first schedule version: the version, then its days (tested
    // below).
    expect(inserted).toHaveLength(5);
    expect(inserted[1]).toEqual({
      assignedProgramId: 900,
      name: null,
      sortOrder: 0,
    });
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
      name: "Squat",
      primaryMuscles: ["legs"],
      secondaryMuscles: ["core"],
      equipment: ["barbell"],
      instructions: ["Step one"],
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
      weightUnit: "kg",
      sortOrder: 0,
      notes: undefined,
    });
  });

  it("uses the inline exercises array directly when no template is referenced, snapshotting each exercise's current details", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.exercises.findMany.mockResolvedValue([
      {
        id: 3,
        name: "Lunge",
        primaryMuscles: ["legs"],
        secondaryMuscles: [],
        equipment: [],
        instructions: ["Step one"],
      },
    ]);

    const inserted: any[] = [];
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: any) => {
        inserted.push(values);
        return {
          returning: jest.fn().mockResolvedValue([{ id: 901, ...values }]),
        };
      }),
    }));

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        patientId: 20,
        title: "Ad-hoc Plan",
        startDate: "2026-01-01",
          schedule: MWF,
        exercises: [{ exerciseId: 3, sortOrder: 0 }],
      },
    );

    expect(db.query.templateExercises.findMany).not.toHaveBeenCalled();
    // An inline list is one unnamed workout...
    expect(inserted[1]).toEqual({
      assignedProgramId: 901,
      name: null,
      sortOrder: 0,
    });
    // ...holding the exercise.
    expect(inserted[2]).toEqual(
      expect.objectContaining({ exerciseId: 3, name: "Lunge", workoutId: 901 }),
    );
  });

  it("rejects an inline exercises array referencing an exercise that does not exist — a real validation gap closed by snapshotting", async () => {
    // Before snapshotting made fetching each exercise unavoidable, this
    // path never checked existence at all — an inline exerciseId that
    // didn't exist would have been silently inserted anyway.
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.exercises.findMany.mockResolvedValue([]); // nothing found

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: "Ad-hoc Plan",
          startDate: "2026-01-01",
          schedule: MWF,
          exercises: [{ exerciseId: 999, sortOrder: 0 }],
        },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // --- schedule and dates ---

  // Records every insert, in order; each answers like .returning() would.
  // Typed rows rather than any[]: what's read back from them stays
  // type-checked (and lint-clean).
  function recordInserts() {
    const inserted: Record<string, unknown>[] = [];
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: jest.fn().mockResolvedValue([{ id: 900, ...values }]),
        };
      }),
    }));
    return inserted;
  }

  const inlineProgram = {
    patientId: 20,
    title: "Rehab Plan",
    startDate: "2026-10-15",
    exercises: [{ exerciseId: 3, sortOrder: 0 }],
  };

  function knownExercise() {
    db.query.exercises.findMany.mockResolvedValue([
      { id: 3, name: "Lunge", primaryMuscles: [], secondaryMuscles: [], equipment: [], instructions: [] },
    ]);
  }

  // toStrictEqual: timesPerWeek must be an explicit null (the database's
  // fields-match-type check needs it NULL) and nothing extra may sneak in.
  // The inserts, in order: program, workout, exercise, the VERSION, then its
  // days (one multi-row insert). MWF is sent Friday first: the days are
  // written in weekday order, each with the program's new workout (every
  // insert in these mocks answers with id 900).
  it("saves the schedule as the program's first version with its days, in weekday order", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    const inserted = recordInserts();

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { ...inlineProgram, schedule: MWF },
    );

    expect(inserted[inserted.length - 2]).toStrictEqual({
      assignedProgramId: 900,
      type: "weekdays",
      timesPerWeek: null,
      effectiveFrom: "2026-10-15",
      createdBy: 7,
    });
    expect(inserted[inserted.length - 1]).toStrictEqual(
      [1, 3, 5].map((weekday) => ({
        scheduleId: 900,
        assignedProgramId: 900,
        weekday,
        workoutId: 900,
      })),
    );
  });

  it("doesn't reorder the caller's own days while sorting", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    recordInserts();
    const schedule = structuredClone(MWF);

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { ...inlineProgram, schedule },
    );

    expect(schedule.days.map((day) => day.weekday)).toEqual([5, 1, 3]);
  });

  // No rotation sent: every workout in order — here the inline list's one.
  it("saves a times-per-week schedule with its rotation and no days", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    const inserted = recordInserts();

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        ...inlineProgram,
        schedule: { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 3 },
      },
    );

    expect(inserted[inserted.length - 2]).toStrictEqual({
      assignedProgramId: 900,
      type: "times_per_week",
      timesPerWeek: 3,
      effectiveFrom: "2026-10-15",
      createdBy: 7,
    });
    expect(inserted[inserted.length - 1]).toStrictEqual([
      { scheduleId: 900, assignedProgramId: 900, position: 0, workoutId: 900 },
    ]);
  });

  // The position is resolved once the workouts exist: one the inline list
  // (one workout) doesn't have is refused — inside the transaction, so the
  // program, workout and exercise already inserted roll back with it.
  it("refuses a workout position the program doesn't have", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    recordInserts();

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
    );
  });

  // The whole prescription as assigned, in ONE entry written in the
  // program's own transaction: dates, the first schedule version, every
  // exercise with its prescription — what the patient was given, by whom.
  it("audits the program as assigned: dates, schedule and every exercise", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.exercises.findMany.mockResolvedValue([
      { id: 3, name: "Lunge", primaryMuscles: [], secondaryMuscles: [], equipment: [], instructions: [] },
    ]);
    recordInserts();

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        ...inlineProgram,
        endDate: "2026-12-15",
        exercises: [{ exerciseId: 3, sortOrder: 0, sets: 3, reps: 12 }],
        schedule: MWF,
      },
    );

    expect(auditService.logInTransaction).toHaveBeenCalledTimes(1);
    // Typed: a jest mock's recorded arguments are `any` otherwise.
    const [tx, entry] = auditService.logInTransaction.mock.calls[0] as [
      unknown,
      unknown,
    ];
    // Through the transaction the program was written in (tx === db in
    // these mocks, as withRlsContext passes it on).
    expect(tx).toBe(db);
    expect(entry).toStrictEqual({
      performedBy: 7,
      action: "ASSIGNED_PROGRAM_CREATED",
      targetUserId: 20,
      entityType: "assigned-programs",
      entityId: 900,
      details: {
        title: "Rehab Plan",
        startDate: "2026-10-15",
        endDate: "2026-12-15",
        basedOnTemplateId: null,
        basedOnProgramId: null,
        // What .returning() gave back for the schedule row (the mock
        // answers every insert with id 900 and no createdAt).
        schedule: {
          id: 900,
          type: "weekdays",
          timesPerWeek: null,
          days: [1, 3, 5].map((weekday) => ({ weekday, workoutId: 900 })),
          rotation: [],
          effectiveFrom: "2026-10-15",
          createdBy: 7,
          createdAt: undefined,
        },
        workouts: [{ id: 900, name: null, sortOrder: 0 }],
        exercises: [
          {
            workoutId: 900,
            exerciseId: 3,
            name: "Lunge",
            sets: 3,
            reps: 12,
            durationInSeconds: null,
            weight: null,
            weightUnit: null,
            sortOrder: 0,
            notes: null,
          },
        ],
      },
    });
  });

  it("refuses an end date before the start date, before writing anything", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { ...inlineProgram, endDate: "2026-10-14", schedule: MWF },
      ),
    ).rejects.toThrow(
      new BadRequestException("The end date can't be before the start date"),
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // The boundary: a one-day program is legitimate (>=, not >).
  it("accepts an end date on the start date", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    recordInserts();

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { ...inlineProgram, endDate: "2026-10-15", schedule: MWF },
      ),
    ).resolves.toBeDefined();
  });
});

describe("AssignedProgramsService.findAllForCurrentUser", () => {
  let service: AssignedProgramsService;
  let usersService: {
    isPatientManagedBy: jest.Mock;
    findPatientsForPractitioner: jest.Mock;
  };
  // The assigners' names come from ONE select().from().where() chain;
  // `assignerRows` is what that query answers, `assignerWhere` records it.
  let assignerRows: { id: number; firstName: string; lastName: string }[];
  let assignerWhere: jest.Mock;
  let db: {
    query: {
      assignedPrograms: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    select: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    usersService = {
      isPatientManagedBy: jest.fn(),
      findPatientsForPractitioner: jest.fn(),
    };
    assignerRows = [{ id: 7, firstName: "Alex", lastName: "Moreau" }];
    assignerWhere = jest.fn(() => Promise.resolve(assignerRows));
    db = {
      query: {
        assignedPrograms: {
          findMany: jest.fn().mockResolvedValue([{ id: 1, assignedBy: 7 }]),
        },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn(() => ({ from: () => ({ where: assignerWhere }) })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  it("returns every program for an admin", async () => {
    await service.findAllForCurrentUser({ id: 1, activeRole: UserRole.ADMIN });
    expect(db.query.assignedPrograms.findMany).toHaveBeenCalled();
    expect(usersService.findPatientsForPractitioner).not.toHaveBeenCalled();
  });

  it("returns only the patient's own programs for a patient", async () => {
    await service.findAllForCurrentUser({
      id: 20,
      activeRole: UserRole.PATIENT,
    });
    expect(db.query.assignedPrograms.findMany).toHaveBeenCalled();
    expect(usersService.findPatientsForPractitioner).not.toHaveBeenCalled();
  });

  it("returns an empty list for a practitioner managing no patients, without querying programs", async () => {
    usersService.findPatientsForPractitioner.mockResolvedValue([]);

    const result = await service.findAllForCurrentUser({
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    });

    expect(result).toEqual([]);
    // Nothing to name either: no query for assigners.
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns only managed patients' programs for a practitioner", async () => {
    usersService.findPatientsForPractitioner.mockResolvedValue([
      { id: 20 },
      { id: 21 },
    ]);

    await service.findAllForCurrentUser({
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    });

    expect(db.query.assignedPrograms.findMany).toHaveBeenCalled();
  });

  it("adds each program's assigner, all looked up in ONE query", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([
      { id: 1, assignedBy: 7 },
      { id: 2, assignedBy: 8 },
      { id: 3, assignedBy: 7 },
    ]);
    assignerRows = [
      { id: 7, firstName: "Alex", lastName: "Moreau" },
      { id: 8, firstName: "Sam", lastName: "Okafor" },
    ];

    const result = await service.findAllForCurrentUser({
      id: 1,
      activeRole: UserRole.ADMIN,
    });

    expect(result).toEqual([
      { id: 1, assignedBy: 7, assigner: { id: 7, firstName: "Alex", lastName: "Moreau" }, schedules: [] },
      { id: 2, assignedBy: 8, assigner: { id: 8, firstName: "Sam", lastName: "Okafor" }, schedules: [] },
      { id: 3, assignedBy: 7, assigner: { id: 7, firstName: "Alex", lastName: "Moreau" }, schedules: [] },
    ]);
    // One query for three programs — not one per program.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  // The naive version — one query per program — would give the same result
  // here; the call count is what tells them apart. Program 2's versions are
  // deliberately interleaved with program 1's in the query's answer: grouping
  // must follow assignedProgramId, not the rows' positions.
  it("adds each program's schedule versions, grouped by program, from ONE query", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([
      { id: 1, assignedBy: 7 },
      { id: 2, assignedBy: 7 },
      { id: 3, assignedBy: 7 },
    ]);
    db.query.programSchedules.findMany.mockResolvedValue([
      { id: 10, assignedProgramId: 1, effectiveFrom: "2026-10-01" },
      { id: 20, assignedProgramId: 2, effectiveFrom: "2026-10-02" },
      { id: 11, assignedProgramId: 1, effectiveFrom: "2026-10-12" },
    ]);

    const result = await service.findAllForCurrentUser({
      id: 1,
      activeRole: UserRole.ADMIN,
    });

    expect(result.map((p) => [p.id, p.schedules.map((v) => v.id)])).toEqual([
      [1, [10, 11]],
      [2, [20]],
      // A program with no version in the answer gets [], never undefined.
      [3, []],
    ]);
    expect(db.query.programSchedules.findMany).toHaveBeenCalledTimes(1);
  });

  it("doesn't look for schedules when there are no programs", async () => {
    db.query.assignedPrograms.findMany.mockResolvedValue([]);

    await expect(
      service.findAllForCurrentUser({ id: 1, activeRole: UserRole.ADMIN }),
    ).resolves.toEqual([]);
    expect(db.query.programSchedules.findMany).not.toHaveBeenCalled();
  });

  describe("with patientId", () => {
    it("lets a practitioner on the care team list that patient's programs", async () => {
      usersService.isPatientManagedBy.mockResolvedValue(true);

      const result = await service.findAllForCurrentUser(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        20,
      );

      expect(usersService.isPatientManagedBy).toHaveBeenCalledWith(20, 7);
      expect(result).toHaveLength(1);
      // Not the whole roster: the patient's list replaces it.
      expect(usersService.findPatientsForPractitioner).not.toHaveBeenCalled();
    });

    it("refuses a practitioner who is not on the care team, without querying programs", async () => {
      usersService.isPatientManagedBy.mockResolvedValue(false);

      await expect(
        service.findAllForCurrentUser(
          { id: 7, activeRole: UserRole.PRACTITIONER },
          20,
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          "You do not have permission to view this assigned program",
        ),
      );
      expect(db.query.assignedPrograms.findMany).not.toHaveBeenCalled();
    });

    it("refuses a patient asking for someone else's programs", async () => {
      await expect(
        service.findAllForCurrentUser({ id: 20, activeRole: UserRole.PATIENT }, 21),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

describe("AssignedProgramsService.assertCanView (via findOne)", () => {
  let service: AssignedProgramsService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() };
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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  it("allows an admin to view any program", async () => {
    await expect(
      service.findOne(900, { id: 1, activeRole: UserRole.ADMIN }),
    ).resolves.toBeDefined();
  });

  it("allows the owning patient to view their own program", async () => {
    await expect(
      service.findOne(900, { id: 20, activeRole: UserRole.PATIENT }),
    ).resolves.toBeDefined();
  });

  it("rejects a different patient viewing a program that is not theirs", async () => {
    await expect(
      service.findOne(900, { id: 999, activeRole: UserRole.PATIENT }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows a managing practitioner to view the program", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    await expect(
      service.findOne(900, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).resolves.toBeDefined();
  });

  it("rejects a non-managing practitioner from viewing the program", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);
    await expect(
      service.findOne(900, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("AssignedProgramsService.assertCanManage (via update)", () => {
  let service: AssignedProgramsService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };
  // What reached .set() — the PATCH's own fields, nothing else.
  let setValues: jest.Mock;

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() };
    setValues = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    });
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            ...OPEN_STATE,
            id: 900,
            patientId: 20,
            startDate: "2026-10-01",
            endDate: "2026-12-31",
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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  it("rejects the owning PATIENT from managing their own program", async () => {
    // The single most important distinction of assertCanManage vs
    // assertCanView: a patient can look, never touch.
    await expect(
      service.update(
        900,
        { id: 20, activeRole: UserRole.PATIENT },
        { title: "New Title" },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows the managing practitioner to update the program", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    await expect(
      service.update(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { title: "New Title" },
      ),
    ).resolves.toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      workouts: PROGRAM_WORKOUTS,
      exercises: [],
      schedules: [],
    });
  });

  it("rejects a non-managing practitioner from updating the program", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);
    await expect(
      service.update(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { title: "New Title" },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows an admin to update any program", async () => {
    await expect(
      service.update(
        900,
        { id: 1, activeRole: UserRole.ADMIN },
        { title: "New Title" },
      ),
    ).resolves.toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      workouts: PROGRAM_WORKOUTS,
      exercises: [],
      schedules: [],
    });
  });
});

describe("AssignedProgramsService.addExercise", () => {
  let service: AssignedProgramsService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      exercises: { findFirst: jest.Mock };
    };
    insert: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    usersService = {
      isPatientManagedBy: jest.fn().mockResolvedValue(true),
    };
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
        exercises: {
          findFirst: jest.fn().mockResolvedValue({ id: 5, name: "Squat" }),
        },
      },
      insert: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  it("throws NotFoundException when the referenced exercise does not exist", async () => {
    db.query.exercises.findFirst.mockResolvedValue(undefined);

    await expect(
      service.addExercise(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          exerciseId: 999,
          sortOrder: 0,
        },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects a non-managing practitioner before ever checking the exercise exists", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(
      service.addExercise(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          exerciseId: 5,
          sortOrder: 0,
        },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(db.query.exercises.findFirst).not.toHaveBeenCalled();
  });

  it("inserts every provided field, including weight/weightUnit and the exercise's snapshotted details", async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 5,
      name: "Squat",
      primaryMuscles: ["legs"],
      secondaryMuscles: ["core"],
      equipment: ["barbell"],
      instructions: ["Step one"],
    });
    // Captured so the test can assert on exactly what reached the
    // database — the same real bug (weight/weightUnit silently missing
    // from this object) shipped once on the programs side already,
    // caught only by a real e2e run, precisely because no unit test
    // checked this before.
    const valuesMock = jest.fn().mockReturnValue({
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 40, assignedProgramId: 900, exerciseId: 5 }]),
    });
    db.insert.mockReturnValue({ values: valuesMock });

    const result = await service.addExercise(
      900,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        exerciseId: 5,
        sets: 3,
        reps: 10,
        weight: 62.5,
        weightUnit: "kg",
        notes: "Go slow",
        sortOrder: 0,
      },
    );

    expect(valuesMock).toHaveBeenCalledWith({
      assignedProgramId: 900,
      // No workoutId in the request: the program's first workout.
      workoutId: 950,
      exerciseId: 5,
      name: "Squat",
      primaryMuscles: ["legs"],
      secondaryMuscles: ["core"],
      equipment: ["barbell"],
      instructions: ["Step one"],
      sets: 3,
      reps: 10,
      durationInSeconds: undefined,
      weight: 62.5,
      weightUnit: "kg",
      sortOrder: 0,
      notes: "Go slow",
    });
    expect(result).toEqual({ id: 40, assignedProgramId: 900, exerciseId: 5 });
  });
});

describe("AssignedProgramsService.reorderExercises", () => {
  let service: AssignedProgramsService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };
  let txUpdate: jest.Mock;

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) };
    txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    });

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
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]),
        },
        programScheduleDays: { findMany: jest.fn().mockResolvedValue([]) },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: { findMany: jest.fn().mockResolvedValue([]) },
      },
      update: txUpdate,
      // withRlsContext() wraps EVERY query in its own db.transaction() call
      // now (findProgramOrThrow, reorderExercises' own read-validate-write,
      // and findProgramWithExercises' two reads) — tx === db throughout, so
      // all of them resolve against the mocks configured above.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  it("accepts an exact permutation of the current exercise rows", async () => {
    await service.reorderExercises(
      900,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [3, 1, 2],
    );
    expect(db.transaction).toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalledTimes(3);
  });

  it("rejects an order that does not match the current set of rows, without writing anything", async () => {
    await expect(
      service.reorderExercises(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [1, 2],
      ),
    ).rejects.toThrow(BadRequestException);
    // The permutation check now runs inside the transaction (alongside the
    // read it validates against), so the transaction IS entered — it just
    // never reaches the update loop before throwing.
    expect(db.transaction).toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

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
    ]);

    await expect(
      service.reorderExercises(
        900,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [1, 2, 3],
      ),
    ).rejects.toThrow(BadRequestException);
    expect(txUpdate).not.toHaveBeenCalled();
  });
});

// --- Schedule versions ---------------------------------------------------------------------------------

// A pure function: the program's dates and a pinned clock in, a 400 or
// nothing out. `now` is 2026-10-09 at 12:00 UTC, so UTC's today is the 9th
// and the earliest allowed day (one day of slack) is the 8th.
describe("assertScheduleDayAllowed", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const program = { startDate: "2026-10-01", endDate: "2026-12-31" };

  it.each([
    ["today", "2026-10-09"],
    ["yesterday in UTC — today for someone west of UTC", "2026-10-08"],
    ["a day in the future", "2026-11-02"],
    ["the program's last day", "2026-12-31"],
  ])("allows %s", (_label, day) => {
    expect(() => assertScheduleDayAllowed(day, program, now)).not.toThrow();
  });

  it.each([
    [
      "two days ago (past the one day of slack)",
      "2026-10-07",
      program,
      "A schedule change can't apply to a day in the past",
    ],
    [
      "a day after the program ends",
      "2027-01-01",
      program,
      "A schedule change can't apply after the program ends (2026-12-31)",
    ],
    [
      "a day before the program starts — even a future one",
      "2026-10-20",
      { startDate: "2026-11-01", endDate: null },
      "A schedule change can't apply before the program starts (2026-11-01)",
    ],
  ])("refuses %s", (_label, day, dates, message) => {
    expect(() => assertScheduleDayAllowed(day, dates, now)).toThrow(
      new BadRequestException(message),
    );
  });

  // endDate null = open-ended: no upper limit at all.
  it("allows any later day for an open-ended program", () => {
    expect(() =>
      assertScheduleDayAllowed(
        "2030-01-01",
        { startDate: "2026-10-01", endDate: null },
        now,
      ),
    ).not.toThrow();
  });

  // Uses the CLOCK, not a fixed date: the same day is allowed at one moment
  // and refused two days later.
  it("judges 'the past' by the clock it's given", () => {
    const later = new Date("2026-10-11T12:00:00Z");
    expect(() => assertScheduleDayAllowed("2026-10-09", program, now)).not.toThrow();
    expect(() => assertScheduleDayAllowed("2026-10-09", program, later)).toThrow(
      new BadRequestException("A schedule change can't apply to a day in the past"),
    );
  });
});

describe("AssignedProgramsService.addScheduleVersion", () => {
  let service: AssignedProgramsService;
  let usersService: { isPatientManagedBy: jest.Mock };
  // Every write, in the order it happened: [kind, details, transaction #].
  let writes: [string, unknown, number][];
  // Which db.transaction() call is running (each withRlsContext opens one).
  let currentTransaction: number;
  let insertValues: jest.Mock;
  // What the insert's RETURNING answers (a test can make it fail).
  let insertReturning: jest.Mock;
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    delete: jest.Mock;
    insert: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  // Dates relative to the real clock (the service reads it), so the tests
  // don't depend on the day they run.
  const today = utcToday();
  const programStart = addDays(today, -30);

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) };
    writes = [];
    currentTransaction = 0;
    insertReturning = jest.fn();
    insertValues = jest.fn((values: Record<string, unknown>) => {
      writes.push(["insert", values, currentTransaction]);
      insertReturning.mockResolvedValue([
        { id: 99, createdAt: new Date("2026-10-10T10:00:00Z"), ...values },
      ]);
      return { returning: insertReturning };
    });
    auditService.logInTransaction.mockImplementation(
      (_tx: unknown, entry: unknown) => {
        writes.push(["audit", entry, currentTransaction]);
        return Promise.resolve(undefined);
      },
    );
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
          writes.push(["delete", condition, currentTransaction]);
          return Promise.resolve(undefined);
        }),
      })),
      insert: jest.fn(() => ({ values: insertValues })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => {
        currentTransaction += 1;
        return fn(db);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER };

  // Delete FIRST, then insert: the other way round, the new version would
  // be deleted by its own "from that day on" clean-up (its effective_from
  // is that day). Which rows the delete reaches is tested against a real
  // database in the e2e suite; here, the order and the inserted values.
  // …and the version's days come right after it (sent Thursday first,
  // written in weekday order), naming the program's workout (950).
  it("replaces the versions from that day on, then inserts the new one and its days", async () => {
    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.WEEKDAYS,
      days: [
        { weekday: 4, workoutId: 950 },
        { weekday: 2, workoutId: 950 },
      ],
      effectiveFrom: today,
    });

    expect(writes.map(([kind]) => kind)).toEqual([
      "delete",
      "insert",
      "insert",
      "audit",
    ]);
    expect(writes[1][1]).toStrictEqual({
      assignedProgramId: 900,
      type: "weekdays",
      timesPerWeek: null,
      effectiveFrom: today,
      createdBy: 7,
    });
    expect(writes[2][1]).toStrictEqual(
      [2, 4].map((weekday) => ({
        scheduleId: 99,
        assignedProgramId: 900,
        weekday,
        workoutId: 950,
      })),
    );
    // All in the SAME transaction: otherwise a failed insert would leave
    // the program with its versions deleted and nothing in their place —
    // and the audit entry could describe a change that never happened, or
    // the change happen with no entry.
    expect(new Set(writes.map(([, , tx]) => tx)).size).toBe(1);
  });

  // Checked before anything is deleted: a workout of another program.
  it("refuses another program's workout, before writing anything", async () => {
    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.WEEKDAYS,
        days: [{ weekday: 1, workoutId: 12345 }],
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new NotFoundException("Workout 12345 not found in this program"),
    );
    expect(writes).toEqual([]);
  });

  // A pause on the start date would replace the first version: the program
  // would begin paused (decided 2026-10-11).
  it("refuses a pause from the program's first day", async () => {
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: today,
      endDate: null,
    });
    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.PAUSED,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new BadRequestException(
        "A program can't start paused: choose its start date for when it begins",
      ),
    );
    expect(writes).toEqual([]);
  });

  // A pause is a version with nothing else: no days, no rotation.
  it("writes a pause as a version alone", async () => {
    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.PAUSED,
      effectiveFrom: today,
    });
    expect(writes.map(([kind]) => kind)).toEqual(["delete", "insert", "audit"]);
    expect(writes[1][1]).toMatchObject({ type: "paused", timesPerWeek: null });
  });

  it("answers with the full program: exercises and every schedule version", async () => {
    const result = await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.TIMES_PER_WEEK,
      timesPerWeek: 2,
      effectiveFrom: today,
    });

    expect(result).toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: programStart,
      endDate: null,
      workouts: PROGRAM_WORKOUTS,
      exercises: [],
      schedules: [
        { id: 1, days: [], rotation: [] },
        { id: 2, days: [], rotation: [] },
      ],
    });
  });

  // The audit entry: what was set, from when, and every version it
  // replaced — after this transaction the replaced versions exist nowhere
  // else, so the entry must carry them whole.
  // The replaced versions are READ before the delete, with their content:
  // here a times-per-week version planned for next week, whose rotation is
  // the program's one workout. (The first read is the service's own; later
  // reads — the full program it answers with — get the defaults.) An older
  // version, before the day, is not replaced and not in the entry.
  it("audits the new version and every version it replaced", async () => {
    db.query.programSchedules.findMany.mockResolvedValueOnce([
      {
        id: 3,
        assignedProgramId: 900,
        type: "weekdays",
        timesPerWeek: null,
        effectiveFrom: programStart,
        createdBy: 4,
        createdAt: new Date("2026-09-01T08:00:00Z"),
      },
      // Set earlier for today itself: replaced too — "from D on" includes
      // D.
      {
        id: 6,
        assignedProgramId: 900,
        type: "paused",
        timesPerWeek: null,
        effectiveFrom: today,
        createdBy: 4,
        createdAt: new Date("2026-10-01T08:00:00Z"),
      },
      {
        id: 7,
        assignedProgramId: 900,
        type: "times_per_week",
        timesPerWeek: 3,
        effectiveFrom: addDays(today, 7),
        createdBy: 4,
        createdAt: new Date("2026-10-02T08:00:00Z"),
      },
    ]);
    db.query.programScheduleRotation.findMany.mockResolvedValueOnce([
      { scheduleId: 7, assignedProgramId: 900, position: 0, workoutId: 950 },
    ]);

    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.WEEKDAYS,
      days: [
        { weekday: 5, workoutId: 950 },
        { weekday: 1, workoutId: 950 },
      ],
      effectiveFrom: today,
    });

    const [, entry] = writes.find(([kind]) => kind === "audit")!;
    expect(entry).toStrictEqual({
      performedBy: 7,
      action: "ASSIGNED_PROGRAM_SCHEDULE_SET",
      targetUserId: 20,
      entityType: "assigned-programs",
      entityId: 900,
      details: {
        effectiveFrom: today,
        added: {
          id: 99,
          type: "weekdays",
          timesPerWeek: null,
          days: [
            { weekday: 1, workoutId: 950 },
            { weekday: 5, workoutId: 950 },
          ],
          rotation: [],
          effectiveFrom: today,
          createdBy: 7,
          createdAt: new Date("2026-10-10T10:00:00Z"),
        },
        replaced: [
          {
            id: 6,
            type: "paused",
            timesPerWeek: null,
            days: [],
            rotation: [],
            effectiveFrom: today,
            createdBy: 4,
            createdAt: new Date("2026-10-01T08:00:00Z"),
          },
          {
            id: 7,
            type: "times_per_week",
            timesPerWeek: 3,
            days: [],
            rotation: [950],
            effectiveFrom: addDays(today, 7),
            createdBy: 4,
            createdAt: new Date("2026-10-02T08:00:00Z"),
          },
        ],
      },
    });
  });

  // A failed change writes no entry: the insert fails before the audit
  // call, and the transaction rolls everything back.
  it("writes no audit entry when the change fails", async () => {
    insertValues.mockImplementationOnce(() => ({
      returning: () =>
        Promise.reject(
          pgError("23505", "program_schedules_program_effective_from_unique"),
        ),
    }));

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(ConflictException);
    expect(auditService.logInTransaction).not.toHaveBeenCalled();
  });

  it("refuses someone who can't manage the program, before writing anything", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        "You do not have permission to manage this assigned program",
      ),
    );
    expect(writes).toEqual([]);
  });

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
    );
    expect(writes).toEqual([]);
  });

  // What node-postgres throws, wrapped the way Drizzle wraps it (the
  // driver's error in `cause`) — the shape isUniqueViolation looks through.
  function pgError(code: string, constraint: string) {
    return Object.assign(new Error("query failed"), {
      cause: { code, constraint },
    });
  }

  it("turns a same-day race (the unique constraint) into a 409", async () => {
    insertValues.mockImplementationOnce(() => ({
      returning: () =>
        Promise.reject(
          pgError("23505", "program_schedules_program_effective_from_unique"),
        ),
    }));

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toThrow(
      new ConflictException(
        "Someone else changed this schedule at the same moment. Reload the program and try again.",
      ),
    );
  });

  // Only THAT constraint means "a race on the same day"; anything else is
  // a real failure and must surface as itself, not as a misleading 409.
  it("lets any other database error through unchanged", async () => {
    const other = pgError("23505", "some_other_unique");
    insertValues.mockImplementationOnce(() => ({
      returning: () => Promise.reject(other),
    }));

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toBe(other);
  });
});

describe("AssignedProgramsService.update — dates, start-date moves, audit", () => {
  let service: AssignedProgramsService;
  // Every write in order: [kind, details].
  let writes: [string, unknown][];
  let setValues: jest.Mock;
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    update: jest.Mock;
    delete: jest.Mock;
    insert: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  // Relative to the real clock (the service reads it): a program that
  // hasn't started yet — the only kind whose start date may move.
  const today = utcToday();
  const start = addDays(today, 10);
  const end = addDays(today, 90);
  // Version 51: Monday, Wednesday, Friday — all workout 950, the program's
  // only workout (its days are the programScheduleDays rows below).
  const firstVersion = {
    id: 51,
    assignedProgramId: 900,
    type: "weekdays",
    timesPerWeek: null,
    effectiveFrom: start,
    createdBy: 3,
    createdAt: new Date("2026-10-01T09:00:00Z"),
  };
  const firstVersionDays = [1, 3, 5].map((weekday) => ({
    scheduleId: 51,
    assignedProgramId: 900,
    weekday,
    workoutId: 950,
  }));
  const mwf = [
    { weekday: 1, workoutId: 950 },
    { weekday: 3, workoutId: 950 },
    { weekday: 5, workoutId: 950 },
  ];

  beforeEach(async () => {
    writes = [];
    auditService.logInTransaction.mockImplementation((_tx: unknown, entry: unknown) => {
      writes.push(["audit", entry]);
      return Promise.resolve(undefined);
    });
    setValues = jest.fn((values: unknown) => {
      writes.push(["update", values]);
      return { where: jest.fn().mockResolvedValue(undefined) };
    });
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            ...OPEN_STATE,
            id: 900,
            patientId: 20,
            title: "Knee Rehab",
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
        programSchedules: { findMany: jest.fn().mockResolvedValue([firstVersion]) },
      },
      update: jest.fn().mockReturnValue({ set: setValues }),
      // The DELETE is awaited as is (its rows were read before it).
      delete: jest.fn(() => ({
        where: jest.fn(() => {
          writes.push(["delete", null]);
          return Promise.resolve(undefined);
        }),
      })),
      // An INSERT is either awaited as is (days, rotation) or through
      // .returning() (the version row, which gets id 52): a Promise with a
      // `returning` method serves both.
      insert: jest.fn(() => ({
        values: jest.fn((values: unknown) => {
          writes.push(["insert", values]);
          return Object.assign(Promise.resolve(undefined), {
            returning: jest.fn().mockResolvedValue([
              {
                id: 52,
                createdAt: new Date("2026-10-10T10:00:00Z"),
                ...(values as Record<string, unknown>),
              },
            ]),
          });
        }),
      })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: { isPatientManagedBy: jest.fn() } },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  const admin = { id: 1, activeRole: UserRole.ADMIN };

  // Each case sends only ONE of the two dates: the check must combine it
  // with the stored other one. Checking only what was sent would pass all
  // three refusals.
  it.each([
    ["an end date before the stored start", { endDate: addDays(start, -1) }],
    ["a start date after the stored end", { startDate: addDays(end, 1) }],
    ["both, in the wrong order", { startDate: addDays(today, 20), endDate: addDays(today, 19) }],
  ])("refuses %s, without writing", async (_label, dto) => {
    await expect(service.update(900, admin, dto)).rejects.toThrow(
      new BadRequestException("The end date can't be before the start date"),
    );
    expect(writes).toEqual([]);
  });

  // null = "no end date any more": the program becomes open-ended, and a
  // start after the OLD end is then fine. Treating null like "not sent"
  // (keeping the stored end) would refuse this.
  it("accepts clearing the end date together with a later start", async () => {
    const later = addDays(end, 5);
    await service.update(900, admin, { startDate: later, endDate: null });

    expect(setValues).toHaveBeenCalledWith({ startDate: later, endDate: null });
  });

  it("refuses moving the start of a program that has started, without writing", async () => {
    const started = addDays(today, -5);
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      startDate: started,
      endDate: null,
    });

    await expect(
      service.update(900, admin, { startDate: addDays(today, 3) }),
    ).rejects.toThrow(
      new BadRequestException(
        `The start date can't change once the program has started (it started on ${started})`,
      ),
    );
    expect(writes).toEqual([]);
  });

  // Sending the start date it already has isn't a move: no rule, no
  // schedule work (a form re-sending every field must keep working on a
  // program that has started).
  it("treats the same start date as no move", async () => {
    const started = addDays(today, -5);
    db.query.assignedPrograms.findFirst.mockResolvedValue({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      title: "Knee Rehab",
      startDate: started,
      endDate: null,
    });

    await service.update(900, admin, { startDate: started, title: "Knee" });

    expect(writes.map(([kind]) => kind)).toEqual(["update", "audit"]);
  });

  // The program row, then its schedule (via planStartDateMove: here the one
  // version moves — its row AND its days), then the audit entry — all in
  // that order, in one transaction.
  it("moves the schedule with the start date, and audits both", async () => {
    const newStart = addDays(today, 14);

    await service.update(900, admin, { startDate: newStart });

    expect(writes.map(([kind]) => kind)).toEqual([
      "update",
      "delete",
      "insert",
      "insert",
      "audit",
    ]);
    expect(writes[2][1]).toStrictEqual({
      assignedProgramId: 900,
      type: "weekdays",
      timesPerWeek: null,
      effectiveFrom: newStart,
      createdBy: 1,
    });
    // The same days, now belonging to the new version 52.
    expect(writes[3][1]).toStrictEqual(
      [1, 3, 5].map((weekday) => ({
        scheduleId: 52,
        assignedProgramId: 900,
        weekday,
        workoutId: 950,
      })),
    );
    expect(writes[4][1]).toStrictEqual({
      performedBy: 1,
      action: "ASSIGNED_PROGRAM_UPDATED",
      targetUserId: 20,
      entityType: "assigned-programs",
      entityId: 900,
      details: {
        changes: { startDate: { from: start, to: newStart } },
        scheduleVersions: {
          replaced: [
            {
              id: 51,
              type: "weekdays",
              timesPerWeek: null,
              days: mwf,
              rotation: [],
              effectiveFrom: start,
              createdBy: 3,
              createdAt: new Date("2026-10-01T09:00:00Z"),
            },
          ],
          added: {
            id: 52,
            type: "weekdays",
            timesPerWeek: null,
            days: mwf,
            rotation: [],
            effectiveFrom: newStart,
            createdBy: 1,
            createdAt: new Date("2026-10-10T10:00:00Z"),
          },
        },
      },
    });
  });

  // Moving the start EARLIER, with a change planned: the first version is
  // brought forward (deleted, re-created on the new day) and the planned
  // one stays — so the audit entry lists only the first as replaced.
  it("records as replaced only the versions the move deleted", async () => {
    db.query.programSchedules.findMany.mockResolvedValue([
      firstVersion,
      {
        ...firstVersion,
        id: 53,
        type: "times_per_week",
        timesPerWeek: 2,
        effectiveFrom: addDays(start, 5),
      },
    ]);
    db.query.programScheduleRotation.findMany.mockResolvedValue([
      { scheduleId: 53, assignedProgramId: 900, position: 0, workoutId: 950 },
    ]);
    const newStart = addDays(start, -2);

    await service.update(900, admin, { startDate: newStart });

    const [, entry] = writes.find(([kind]) => kind === "audit")!;
    const { scheduleVersions } = (
      entry as {
        details: {
          scheduleVersions: {
            replaced: { id: number }[];
            added: { effectiveFrom: string };
          };
        };
      }
    ).details;
    expect(scheduleVersions.replaced.map((v) => v.id)).toEqual([51]);
    expect(scheduleVersions.added.effectiveFrom).toBe(newStart);
  });

  // A version is stored with its days or rotation; one read back without
  // them (which the database can't prevent: the rule spans two tables)
  // must not be copied as an empty version — the move fails instead, and
  // the transaction undoes it.
  it.each([
    [
      "a weekdays version with no days",
      firstVersion,
      "A 'weekdays' schedule version needs at least one day",
    ],
    [
      "a rotation with no workouts",
      { ...firstVersion, type: "times_per_week", timesPerWeek: 2 },
      "A rotation needs at least one workout",
    ],
  ])("refuses to copy %s", async (_label, version, message) => {
    db.query.programSchedules.findMany.mockResolvedValue([version]);
    db.query.programScheduleDays.findMany.mockResolvedValue([]);

    await expect(
      service.update(900, admin, { startDate: addDays(today, 14) }),
    ).rejects.toThrow(new Error(message));
    expect(writes.map(([kind]) => kind)).not.toContain("insert");
  });

  // A pause planned 5 days after the start. Moving the start INTO it — past
  // its first day (the pause would be re-created on the new start), or onto
  // its first day exactly (the pause is already there) — would make the
  // program begin paused: refused. Nothing of the schedule is touched; the
  // program row's UPDATE, already sent, is undone with the transaction.
  it.each([
    ["past the first day of a planned pause", 7],
    ["onto the first day of a planned pause", 5],
  ])("refuses moving the start %s", async (_label, offset) => {
    db.query.programSchedules.findMany.mockResolvedValue([
      firstVersion,
      {
        ...firstVersion,
        id: 53,
        type: "paused",
        effectiveFrom: addDays(start, 5),
      },
    ]);

    await expect(
      service.update(900, admin, { startDate: addDays(start, offset) }),
    ).rejects.toThrow(
      new BadRequestException(
        "A program can't start paused: the new start date falls in a planned pause",
      ),
    );
    expect(writes.map(([kind]) => kind)).toEqual(["update"]);
  });

  // Only REAL changes are listed: the title sent unchanged isn't one.
  // (Without the comparison, every field a form re-sends would be logged as
  // changed.)
  it("audits only the fields that really changed", async () => {
    await service.update(900, admin, {
      title: "Knee Rehab",
      endDate: null,
      allowSwaps: false,
      // A DTO instance can carry declared-but-unsent fields as undefined
      // keys: "not sent" is not a change to undefined.
      startDate: undefined,
    });

    const [, entry] = writes.find(([kind]) => kind === "audit")!;
    expect((entry as { details: unknown }).details).toStrictEqual({
      changes: {
        endDate: { from: end, to: null },
        allowSwaps: { from: undefined, to: false },
      },
    });
  });

  // The entry goes through the SAME transaction object as the change: that's
  // what makes them commit or roll back together.
  it("writes the audit entry through the change's transaction", async () => {
    let txSeen: unknown;
    db.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
      txSeen = db;
      return fn(db);
    });

    await service.update(900, admin, { title: "New" });

    expect(auditService.logInTransaction).toHaveBeenCalledWith(
      txSeen,
      expect.objectContaining({ action: "ASSIGNED_PROGRAM_UPDATED" }),
    );
  });
});

describe("AssignedProgramsService.updateExercise", () => {
  let service: AssignedProgramsService;
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programWorkouts: { findMany: jest.Mock };
      assignedProgramExercises: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
      };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
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
        assignedProgramExercises: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 31, assignedProgramId: 900 }),
          findMany: jest.fn().mockResolvedValue([
            { id: 30, sets: 2 },
            { id: 31, sets: 4 },
          ]),
        },
        // Version 5 is Tuesdays, workout 950.
        programScheduleDays: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ scheduleId: 5, weekday: 2, workoutId: 950 }]),
        },
        programScheduleRotation: { findMany: jest.fn().mockResolvedValue([]) },
        programSchedules: {
          findMany: jest.fn().mockResolvedValue([{ id: 5 }]),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: { isPatientManagedBy: jest.fn() } },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  // The gap from deferred-improvements.md: it used to answer with the one
  // updated row. A screen writing that into the program's cache entry
  // would lose every other exercise.
  it("answers with the full program — every exercise and the schedules — not the updated row", async () => {
    const result = await service.updateExercise(
      900,
      31,
      { id: 1, activeRole: UserRole.ADMIN },
      { sets: 4 },
    );

    expect(result).toEqual({
      ...OPEN_STATE,
      id: 900,
      patientId: 20,
      workouts: PROGRAM_WORKOUTS,
      exercises: [{ id: 30, sets: 2 }, { id: 31, sets: 4 }],
      schedules: [
        { id: 5, days: [{ weekday: 2, workoutId: 950 }], rotation: [] },
      ],
    });
  });
});

describe("AssignedProgramsService.summary", () => {
  let service: AssignedProgramsService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let sessionsWhere: jest.Mock;
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      programScheduleDays: { findMany: jest.Mock };
      programScheduleRotation: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    select: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  // A times-per-week program started 3 days ago, so "today" is inside its
  // first week whatever day the tests run.
  const today = utcToday();
  const start = addDays(today, -3);

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn().mockResolvedValue(true) };
    // One completed session, of workout 1 — the one the rotation asks for.
    sessionsWhere = jest
      .fn()
      .mockResolvedValue([{ id: 31, localDate: start, workoutId: 1 }]);
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
              type: "times_per_week",
              timesPerWeek: 2,
              effectiveFrom: start,
            },
          ]),
        },
      },
      select: jest.fn(() => ({ from: () => ({ where: sessionsWhere }) })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER };

  // The service only gathers data: the program's dates, its versions (with
  // their rotation) and its sessions (with their workout) reach the module,
  // whose answer comes back as is. Were the rotation or the session's
  // workout lost on the way, the session would count as an extra, not done.
  it("summarizes the program from its dates, versions and sessions", async () => {
    const result = await service.summary(900, practitioner, today);

    expect(result.firstDay).toBe(start);
    expect(result.today).toBe(today);
    expect(result.totals).toEqual({
      expected: null,
      done: 1,
      madeUp: 0,
      doneEarly: 0,
      swapped: 0,
      missed: 0,
      extra: 0,
    });
    expect(result.weeks[0].sessionIds).toEqual([31]);
    expect(result.nextWorkout?.workoutId).toBe(1);
  });

  it("refuses a today that can't be today anywhere, before reading anything", async () => {
    await expect(
      service.summary(900, practitioner, addDays(today, -2)),
    ).rejects.toThrow(
      new BadRequestException("today must be today's date in your time zone"),
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses someone who may not view the program, before reading sessions", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(service.summary(900, practitioner, today)).rejects.toThrow(
      new ForbiddenException(
        "You do not have permission to view this assigned program",
      ),
    );
    expect(sessionsWhere).not.toHaveBeenCalled();
  });
});

// The race the e2e tests can't produce on demand: an exercise added — or a
// session started — on the workout between removeWorkout's counts and its
// DELETE. The database refuses the DELETE through that row's foreign key;
// the service answers 409, not a 500. The error is mocked, wrapped the way
// Drizzle wraps it.
describe("AssignedProgramsService.removeWorkout — losing the race", () => {
  let service: AssignedProgramsService;
  let deleteReturning: jest.Mock;

  beforeEach(async () => {
    deleteReturning = jest.fn();
    // The row lock (.for) and the four counts share one select chain: every
    // count reads 0, so the checks pass and the DELETE is what fails.
    const where = () =>
      Object.assign(
        Promise.resolve([
          { exerciseCount: 0, sessionCount: 0, dayUses: 0, rotationUses: 0 },
        ]),
        { for: jest.fn().mockResolvedValue([]) },
      );
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
    };
    const db = {
      ...tx,
      transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: UsersService,
          useValue: { isPatientManagedBy: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(AssignedProgramsService);
  });

  it.each([
    ["an exercise", "assigned_program_exercises_workout_fk"],
    ["a session", "sessions_workout_fk"],
    ["a schedule day", "program_schedule_days_workout_fk"],
    ["a rotation slot", "program_schedule_rotation_workout_fk"],
  ])(
    "answers 409 when %s's foreign key refuses the delete",
    async (_what, constraint) => {
      deleteReturning.mockRejectedValue(
        new DrizzleQueryError(
          'delete from "program_workouts" ...',
          [],
          Object.assign(new Error("fk"), { code: "23503", constraint }),
        ),
      );
      await expect(
        service.removeWorkout(900, 2, {
          id: 7,
          activeRole: UserRole.PRACTITIONER,
        }),
      ).rejects.toThrow(
        new ConflictException(
          "This workout was just given exercises, a session or a place in the schedule: reload the program and try again",
        ),
      );
      expect(auditService.logInTransaction).not.toHaveBeenCalled();
    },
  );

  it("lets any other error through unchanged", async () => {
    const other = new Error("connection lost");
    deleteReturning.mockRejectedValue(other);
    await expect(
      service.removeWorkout(900, 2, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toBe(other);
  });
});

// Step 2b-iii — closing a program (cancel / complete), archiving, and the
// rule that a closed program no longer changes. One flexible mock database:
// `program` is what the program row reads as (before AND after the lock),
// `sessionRows` the program's sessions; `calls` records the order of the
// steps that matter (the lock, the reads, the writes).
describe("AssignedProgramsService — closing and archiving (step 2b-iii)", () => {
  let service: AssignedProgramsService;
  let program: Record<string, unknown>;
  let sessionRows: { localDate: string; status: string }[];
  let calls: string[];
  let setValues: jest.Mock;
  let db: Record<string, unknown> & { transaction: jest.Mock };

  const admin = { id: 1, activeRole: UserRole.ADMIN };
  const today = utcToday();

  beforeEach(async () => {
    calls = [];
    program = {
      id: 900,
      patientId: 20,
      title: "Knee Rehab",
      status: "active",
      isArchived: false,
      startDate: addDays(today, -20),
      endDate: null,
      basedOnTemplateId: 3,
      basedOnProgramId: null,
    };
    sessionRows = [];
    setValues = jest.fn((values: unknown) => {
      calls.push(`update ${JSON.stringify(values)}`);
      return {
        where: () =>
          Object.assign(Promise.resolve(undefined), {
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 900, ...(values as object) }]),
          }),
      };
    });
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn(() => {
            calls.push("read program");
            return Promise.resolve({ ...program });
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
              calls.push("read sessions");
              return Promise.resolve(sessionRows).then(resolve, reject);
            },
            for: jest.fn(() => {
              calls.push("lock");
              return Promise.resolve([]);
            }),
          }),
        }),
      })),
      update: jest.fn(() => ({ set: setValues })),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };
    auditService.logInTransaction.mockImplementation(
      (_tx: unknown, entry: { action: string }) => {
        calls.push(`audit ${entry.action}`);
        return Promise.resolve(undefined);
      },
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: UsersService,
          useValue: { isPatientManagedBy: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(AssignedProgramsService);
  });

  // The steps after the access checks: lock, read the program AGAIN, read
  // its sessions, write, audit — the state used is the one read under the
  // lock.
  const afterChecks = () => calls.slice(calls.indexOf("lock"));

  describe("close", () => {
    it("archives a program cancelled before any session — and answers no program", async () => {
      const result = await service.close(900, admin, "cancel", today);

      expect(result).toEqual({ outcome: "archived", program: null });
      expect(afterChecks()).toEqual([
        "lock",
        "read program",
        "read sessions",
        'update {"isArchived":true}',
        "audit ASSIGNED_PROGRAM_ARCHIVED",
      ]);
      expect(auditService.logInTransaction).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          targetUserId: 20,
          details: {
            reason: "cancelled before any session",
            program: {
              title: "Knee Rehab",
              status: "active",
              startDate: addDays(today, -20),
              endDate: null,
              basedOnTemplateId: 3,
              basedOnProgramId: null,
            },
          },
        }),
      );
    });

    // Any session counts — even one started and never completed: it is a
    // record of something that happened.
    it("cancels — not archives — a program with only an unfinished session", async () => {
      sessionRows = [{ localDate: addDays(today, -3), status: "in_progress" }];

      const result = await service.close(900, admin, "cancel", today);

      expect(result.outcome).toBe("cancelled");
      expect(setValues).toHaveBeenCalledWith({
        status: "cancelled",
        endDate: addDays(today, -1),
      });
      expect(result.program).toMatchObject({ id: 900 });
    });

    // Completing with no session at all is still completing (only CANCEL
    // archives).
    it("completes a program even with no session", async () => {
      const result = await service.close(900, admin, "complete", today);

      expect(result.outcome).toBe("completed");
      expect(setValues).toHaveBeenCalledWith({
        status: "completed",
        endDate: addDays(today, -1),
      });
    });

    // TODAY's end only for a session COMPLETED today: one started today and
    // abandoned doesn't make today part of the program; one completed
    // yesterday doesn't either.
    it.each([
      ["completed today", today, "completed", 0],
      ["started today, not completed", today, "in_progress", -1],
      ["completed yesterday", addDays(today, -1), "completed", -1],
    ])(
      "ends the program by the session %s",
      async (_label, day, status, offset) => {
        sessionRows = [{ localDate: day, status }];

        await service.close(900, admin, "complete", today);

        expect(setValues).toHaveBeenCalledWith({
          status: "completed",
          endDate: addDays(today, offset),
        });
      },
    );

    it("audits the status and end date, before → after, with the day it was decided", async () => {
      sessionRows = [{ localDate: today, status: "completed" }];

      await service.close(900, admin, "cancel", today);

      // …then the full program is read for the answer.
      expect(afterChecks().slice(0, 5)).toEqual([
        "lock",
        "read program",
        "read sessions",
        `update ${JSON.stringify({ status: "cancelled", endDate: today })}`,
        "audit ASSIGNED_PROGRAM_CANCELLED",
      ]);
      expect(auditService.logInTransaction).toHaveBeenCalledWith(db, {
        performedBy: 1,
        action: "ASSIGNED_PROGRAM_CANCELLED",
        targetUserId: 20,
        entityType: "assigned-programs",
        entityId: 900,
        details: {
          today,
          changes: {
            status: { from: "active", to: "cancelled" },
            endDate: { from: null, to: today },
          },
        },
      });
    });

    // The state that counts is the one read UNDER the lock: here the first
    // read (the access check) sees an active program, the second — after
    // the lock — a completed one, as when another request closed it while
    // this one waited.
    it("refuses a program closed while it waited for the lock, writing nothing", async () => {
      (
        db.query as { assignedPrograms: { findFirst: jest.Mock } }
      ).assignedPrograms.findFirst
        .mockImplementationOnce(() => Promise.resolve({ ...program }))
        .mockImplementationOnce(() =>
          Promise.resolve({ ...program, status: "completed" }),
        );

      await expect(service.close(900, admin, "cancel", today)).rejects.toThrow(
        new ConflictException(
          "This program is completed, so it can no longer change. To continue it, assign it again",
        ),
      );
      expect(setValues).not.toHaveBeenCalled();
      expect(auditService.logInTransaction).not.toHaveBeenCalled();
    });

    it("refuses a today that can't be today anywhere, before reading anything", async () => {
      await expect(
        service.close(900, admin, "complete", addDays(today, -2)),
      ).rejects.toThrow(
        new BadRequestException("today must be today's date in your time zone"),
      );
      expect(calls).toEqual([]);
    });
  });

  describe("archive", () => {
    it("archives a program with no session, audited with what it was", async () => {
      await service.archive(900, admin);

      expect(afterChecks()).toEqual([
        "lock",
        "read program",
        "read sessions",
        'update {"isArchived":true}',
        "audit ASSIGNED_PROGRAM_ARCHIVED",
      ]);
    });

    it("refuses a program with sessions: cancel it instead", async () => {
      sessionRows = [{ localDate: today, status: "completed" }];

      await expect(service.archive(900, admin)).rejects.toThrow(
        new ConflictException(
          "This program has sessions, so it is part of the patient's record and can't be deleted: cancel it instead",
        ),
      );
      expect(setValues).not.toHaveBeenCalled();
    });

    // A completed program with no session may still be archived; an
    // archived one can't be archived again.
    it("archives a completed program with no session, not an archived one", async () => {
      program = { ...program, status: "completed" };
      await service.archive(900, admin);
      expect(setValues).toHaveBeenCalledTimes(1);

      program = { ...program, isArchived: true };
      await expect(service.archive(900, admin)).rejects.toThrow(
        new ConflictException(
          "This program was deleted, so it can no longer change",
        ),
      );
      expect(setValues).toHaveBeenCalledTimes(1);
    });
  });

  // Every write on a program refuses a closed one, before its transaction
  // (the program read + the access check run first: 404 / 403 win).
  describe("writes on a closed program", () => {
    const writes: [string, (s: AssignedProgramsService) => Promise<unknown>][] =
      [
        ["update", (s) => s.update(900, admin, { title: "New" })],
        [
          "addExercise",
          (s) => s.addExercise(900, admin, { exerciseId: 1, sortOrder: 0 }),
        ],
        [
          "updateExercise",
          (s) => s.updateExercise(900, 31, admin, { sets: 3 }),
        ],
        ["reorderExercises", (s) => s.reorderExercises(900, admin, [31])],
        ["removeExercise", (s) => s.removeExercise(900, 31, admin)],
        [
          "addScheduleVersion",
          (s) =>
            s.addScheduleVersion(900, admin, {
              type: ScheduleType.PAUSED,
              effectiveFrom: today,
            }),
        ],
        ["addWorkout", (s) => s.addWorkout(900, admin, {})],
        [
          "renameWorkout",
          (s) => s.renameWorkout(900, 950, admin, { name: "A" }),
        ],
        ["reorderWorkouts", (s) => s.reorderWorkouts(900, admin, [950])],
        ["removeWorkout", (s) => s.removeWorkout(900, 950, admin)],
      ];

    it.each(writes)("%s refuses a cancelled program", async (_name, write) => {
      program = { ...program, status: "cancelled" };

      await expect(write(service)).rejects.toThrow(ConflictException);
      expect(db.transaction).toHaveBeenCalledTimes(1); // the program read only
      expect(setValues).not.toHaveBeenCalled();
    });
  });
});

// "Assign again": the source program's checks, all before anything is
// written. (The copy itself — workouts and tailored exercises, in order — is
// checked end to end in test/program-schedules.e2e-spec.ts.)
describe("AssignedProgramsService.create — assigning again (step 2b-iii)", () => {
  let service: AssignedProgramsService;
  let source: Record<string, unknown>;
  let db: {
    query: Record<string, unknown>;
    insert: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER };
  const dto = {
    patientId: 20,
    basedOnProgramId: 800,
    title: "Knee Rehab — block 2",
    startDate: utcToday(),
    schedule: { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 2 },
  };

  beforeEach(async () => {
    source = {
      id: 800,
      patientId: 20,
      status: "cancelled",
      isArchived: false,
      basedOnTemplateId: 3,
    };
    db = {
      query: {
        assignedPrograms: { findFirst: jest.fn(() => Promise.resolve(source)) },
        programWorkouts: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 850, name: "Upper", sortOrder: 0 }]),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
      },
      insert: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignedProgramsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: UsersService,
          useValue: { isPatientManagedBy: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(AssignedProgramsService);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, Error]>([
    [
      "an active program",
      { status: "active" },
      {},
      new ConflictException(
        "Only a completed or cancelled program can be assigned again: this one is still active",
      ),
    ],
    [
      "a deleted (archived) program",
      { isArchived: true },
      {},
      new BadRequestException("Deleted programs cannot be assigned again"),
    ],
    [
      "another patient's program",
      { patientId: 21 },
      {},
      new BadRequestException(
        "Program 800 belongs to another patient: a program is assigned again to the same patient",
      ),
    ],
    [
      "a program with an emptied workout",
      {},
      {},
      new BadRequestException("Workout A of program 800 has no exercises"),
    ],
    [
      "two sources at once",
      {},
      { basedOnTemplateId: 3 },
      new BadRequestException(
        "Give one source: basedOnTemplateId, basedOnProgramId or exercises",
      ),
    ],
  ])("refuses %s, writing nothing", async (_label, change, extra, error) => {
    source = { ...source, ...change };

    await expect(
      service.create(practitioner, { ...dto, ...extra }),
    ).rejects.toThrow(error);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses a program the caller can't see (404)", async () => {
    (
      db.query.assignedPrograms as { findFirst: jest.Mock }
    ).findFirst.mockImplementation(() => Promise.resolve(undefined));

    await expect(service.create(practitioner, dto)).rejects.toThrow(
      new NotFoundException("Assigned program 800 not found"),
    );
    expect(db.insert).not.toHaveBeenCalled();
  });
});