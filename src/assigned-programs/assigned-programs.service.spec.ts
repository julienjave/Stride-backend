import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AssignedProgramsService } from "./assigned-programs.service";
import { UsersService } from "../users/users.service";
import { DRIZZLE } from "../database/drizzle.provider";
import { UserRole } from "../users/dto/create-user.dto";

describe("AssignedProgramsService.create", () => {
  let service: AssignedProgramsService;
  let usersService: {
    isPatientManagedBy: jest.Mock;
    findPatientsForPractitioner: jest.Mock;
  };
  let db: {
    query: {
      templateExercises: { findMany: jest.Mock };
      assignedPrograms: { findFirst: jest.Mock };
      assignedProgramExercises: { findMany: jest.Mock };
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
        assignedPrograms: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 900, patientId: 20, isArchived: false }),
        },
        assignedProgramExercises: { findMany: jest.fn().mockResolvedValue([]) },
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
        { patientId: 20, title: "Rehab Plan", startDate: "2026-01-01" },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws NotFoundException when the source template has no exercises to copy", async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);
    db.query.templateExercises.findMany.mockResolvedValue([]);

    await expect(
      service.create(
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          patientId: 20,
          title: "Rehab Plan",
          startDate: "2026-01-01",
          basedOnTemplateId: 55,
        },
      ),
    ).rejects.toThrow(NotFoundException);
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
        basedOnTemplateId: 55,
      },
    );

    // One insert for the program itself, one for the copied exercise row —
    // this row is a brand-new record, never an FK back to templateExercises.
    expect(inserted).toHaveLength(2);
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
          exercises: [{ exerciseId: 999, sortOrder: 0 }],
        },
      ),
    ).rejects.toThrow(NotFoundException);
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
    query: { assignedPrograms: { findMany: jest.Mock } };
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
      { id: 1, assignedBy: 7, assigner: { id: 7, firstName: "Alex", lastName: "Moreau" } },
      { id: 2, assignedBy: 8, assigner: { id: 8, firstName: "Sam", lastName: "Okafor" } },
      { id: 3, assignedBy: 7, assigner: { id: 7, firstName: "Alex", lastName: "Moreau" } },
    ]);
    // One query for three programs — not one per program.
    expect(db.select).toHaveBeenCalledTimes(1);
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
    query: { assignedPrograms: { findFirst: jest.Mock } };
    update: jest.Mock;
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
    ).resolves.toEqual({ id: 900 });
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
    ).resolves.toEqual({ id: 900 });
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