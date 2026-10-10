import { Test } from "@nestjs/testing";
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
import { UsersService } from "../users/users.service";
import { DRIZZLE } from "../database/drizzle.provider";
import { UserRole } from "../users/dto/create-user.dto";
import { ScheduleType } from "./dto/schedule-input.dto";

// A schedule for the create() calls that aren't about schedules — the DTO
// requires one. Deliberately NOT in order ([5, 1, 3]): create() must sort it.
const MWF = { type: ScheduleType.WEEKDAYS, weekdays: [5, 1, 3] };

describe("AssignedProgramsService.create", () => {
  let service: AssignedProgramsService;
  let usersService: {
    isPatientManagedBy: jest.Mock;
    findPatientsForPractitioner: jest.Mock;
  };
  let db: {
    query: {
      templateExercises: { findMany: jest.Mock };
      programTemplates: { findFirst: jest.Mock };
      assignedPrograms: { findFirst: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
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
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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

    // One insert for the program itself, one for the copied exercise row —
    // this row is a brand-new record, never an FK back to templateExercises
    // — and one for the program's first schedule version (tested below).
    expect(inserted).toHaveLength(3);
    // Full equality, not objectContaining — a partial match is exactly
    // what let weight/weightUnit go silently missing from this copy the
    // first time (objectContaining only checks the properties you
    // remember to list, so a field the copy logic drops just never gets
    // caught). Every field the source row and the referenced exercise
    // carried must survive the copy.
    expect(inserted[1]).toEqual({
      assignedProgramId: 900,
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
    expect(inserted[1]).toEqual(
      expect.objectContaining({ exerciseId: 3, name: "Lunge" }),
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

  // toStrictEqual: the other column must be an explicit null (the
  // database's fields-match-type check needs it NULL) and nothing extra may
  // sneak in. MWF is sent as [5, 1, 3]: the sorting must happen here.
  it("saves the schedule as the program's first version, from its start date, weekdays sorted", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    const inserted = recordInserts();

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { ...inlineProgram, schedule: MWF },
    );

    expect(inserted[inserted.length - 1]).toStrictEqual({
      assignedProgramId: 900,
      type: "weekdays",
      weekdays: [1, 3, 5],
      timesPerWeek: null,
      effectiveFrom: "2026-10-15",
      createdBy: 7,
    });
  });

  it("doesn't reorder the caller's own weekdays array while sorting", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    knownExercise();
    recordInserts();
    const schedule = { type: ScheduleType.WEEKDAYS, weekdays: [5, 1, 3] };

    await service.create(
      { id: 7, activeRole: UserRole.PRACTITIONER },
      { ...inlineProgram, schedule },
    );

    expect(schedule.weekdays).toEqual([5, 1, 3]);
  });

  it("saves a times-per-week schedule with no weekdays", async () => {
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

    expect(inserted[inserted.length - 1]).toStrictEqual({
      assignedProgramId: 900,
      type: "times_per_week",
      weekdays: null,
      timesPerWeek: 3,
      effectiveFrom: "2026-10-15",
      createdBy: 7,
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
      assignedProgramExercises: { findMany: jest.Mock };
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
          findFirst: jest.fn().mockResolvedValue({ id: 900, patientId: 20 }),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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
      assignedProgramExercises: { findMany: jest.Mock };
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
            id: 900,
            patientId: 20,
            startDate: "2026-10-01",
            endDate: "2026-12-31",
          }),
        },
        // update() answers with the full program (exercises, schedules).
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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
      id: 900,
      patientId: 20,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
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
      id: 900,
      patientId: 20,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
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
          findFirst: jest.fn().mockResolvedValue({ id: 900, patientId: 20 }),
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
      assignedProgramExercises: { findMany: jest.Mock };
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
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
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
    insertValues = jest.fn((values: unknown) => {
      writes.push(["insert", values, currentTransaction]);
      return Promise.resolve(undefined);
    });
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            id: 900,
            patientId: 20,
            startDate: programStart,
            endDate: null,
          }),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER };

  // Delete FIRST, then insert: the other way round, the new version would
  // be deleted by its own "from that day on" clean-up (its effective_from
  // is that day). Which rows the delete reaches is tested against a real
  // database in the e2e suite; here, the order and the inserted values.
  it("replaces the versions from that day on, then inserts the new one, sorted", async () => {
    await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.WEEKDAYS,
      weekdays: [4, 2],
      effectiveFrom: today,
    });

    expect(writes.map(([kind]) => kind)).toEqual(["delete", "insert"]);
    expect(writes[1][1]).toStrictEqual({
      assignedProgramId: 900,
      type: "weekdays",
      weekdays: [2, 4],
      timesPerWeek: null,
      effectiveFrom: today,
      createdBy: 7,
    });
    // Both writes in the SAME transaction: otherwise a failed insert would
    // leave the program with its versions deleted and nothing in their place.
    expect(writes[0][2]).toBe(writes[1][2]);
  });

  it("answers with the full program: exercises and every schedule version", async () => {
    const result = await service.addScheduleVersion(900, practitioner, {
      type: ScheduleType.TIMES_PER_WEEK,
      timesPerWeek: 2,
      effectiveFrom: today,
    });

    expect(result).toEqual({
      id: 900,
      patientId: 20,
      startDate: programStart,
      endDate: null,
      exercises: [],
      schedules: [{ id: 1 }, { id: 2 }],
    });
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
    insertValues.mockRejectedValueOnce(
      pgError("23505", "program_schedules_program_effective_from_unique"),
    );

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
    insertValues.mockRejectedValueOnce(other);

    await expect(
      service.addScheduleVersion(900, practitioner, {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 2,
        effectiveFrom: today,
      }),
    ).rejects.toBe(other);
  });
});

describe("AssignedProgramsService.update — dates", () => {
  let service: AssignedProgramsService;
  let setValues: jest.Mock;
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
      programSchedules: { findMany: jest.Mock };
    };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    setValues = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    });
    db = {
      query: {
        assignedPrograms: {
          findFirst: jest.fn().mockResolvedValue({
            id: 900,
            patientId: 20,
            startDate: "2026-10-01",
            endDate: "2026-12-31",
          }),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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
        { provide: UsersService, useValue: { isPatientManagedBy: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(AssignedProgramsService);
  });

  const admin = { id: 1, activeRole: UserRole.ADMIN };

  // Each case sends only ONE of the two dates: the check must combine it
  // with the stored other one. Checking only what was sent would pass all
  // three refusals.
  it.each([
    ["an end date before the stored start", { endDate: "2026-09-30" }],
    ["a start date after the stored end", { startDate: "2027-01-01" }],
    ["both, in the wrong order", { startDate: "2026-11-01", endDate: "2026-10-31" }],
  ])("refuses %s, without writing", async (_label, dto) => {
    await expect(service.update(900, admin, dto)).rejects.toThrow(
      new BadRequestException("The end date can't be before the start date"),
    );
    expect(setValues).not.toHaveBeenCalled();
  });

  // null = "no end date any more": the program becomes open-ended, and a
  // start after the OLD end is then fine. Treating null like "not sent"
  // (keeping the stored end) would refuse this.
  it("accepts clearing the end date together with a later start", async () => {
    await service.update(900, admin, { startDate: "2027-01-01", endDate: null });

    expect(setValues).toHaveBeenCalledWith({
      startDate: "2027-01-01",
      endDate: null,
    });
  });
});

describe("AssignedProgramsService.updateExercise", () => {
  let service: AssignedProgramsService;
  let db: {
    query: {
      assignedPrograms: { findFirst: jest.Mock };
      assignedProgramExercises: {
        findFirst: jest.Mock;
        findMany: jest.Mock;
      };
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
          findFirst: jest.fn().mockResolvedValue({ id: 900, patientId: 20 }),
        },
        assignedProgramExercises: {
          findFirst: jest.fn().mockResolvedValue({ id: 31, assignedProgramId: 900 }),
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 30, sets: 2 }, { id: 31, sets: 4 }]),
        },
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
      id: 900,
      patientId: 20,
      exercises: [{ id: 30, sets: 2 }, { id: 31, sets: 4 }],
      schedules: [{ id: 5 }],
    });
  });
});