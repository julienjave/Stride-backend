import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ProgramsService } from "./programs.service";
import { DRIZZLE } from "../database/drizzle.provider";
import { UserRole } from "../users/dto/create-user.dto";

describe("ProgramsService.assertCanModify (via update)", () => {
  let programsService: ProgramsService;
  let db: {
    query: { programTemplates: { findFirst: jest.Mock } };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: { programTemplates: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 1, title: "Updated" }]),
          }),
        }),
      }),
      // withRlsContext() wraps the actual UPDATE in db.transaction()/
      // db.execute() — tx === db here, so the mocked update() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it("allows the owning practitioner to modify their own template", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    });

    await expect(
      programsService.update(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { title: "Updated" },
      ),
    ).resolves.toEqual({ id: 1, title: "Updated" });
  });

  it("allows an admin to modify a template they do not own", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    });

    await expect(
      programsService.update(
        1,
        { id: 999, activeRole: UserRole.ADMIN },
        { title: "Updated" },
      ),
    ).resolves.toEqual({ id: 1, title: "Updated" });
  });

  it("rejects a different practitioner modifying a template they do not own", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    });

    await expect(
      programsService.update(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        { title: "Updated" },
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("ProgramsService.addExercise", () => {
  let programsService: ProgramsService;
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock };
      exercises: { findFirst: jest.Mock; findMany: jest.Mock };
      templateExercises: { findMany: jest.Mock };
    };
    insert: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it("throws NotFoundException when the referenced exercise does not exist", async () => {
    db.query.exercises.findFirst.mockResolvedValue(undefined);

    await expect(
      programsService.addExercise(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        {
          exerciseId: 999,
          sortOrder: 0,
        },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects a non-owning practitioner before ever checking the exercise exists", async () => {
    await expect(
      programsService.addExercise(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        {
          exerciseId: 5,
          sortOrder: 0,
        },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(db.query.exercises.findFirst).not.toHaveBeenCalled();
  });

  it("adds the exercise, then returns the full enriched template via findOne", async () => {
    db.query.exercises.findFirst.mockResolvedValue({ id: 5, name: "Squat" });
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 10, templateId: 1, exerciseId: 5 }]),
      }),
    });
    // findOne()'s own reads, AFTER the insert above — a fresh row list
    // (as the real DB would return post-insert) and the matching
    // exercise details for withExerciseDetails to attach.
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 10, templateId: 1, exerciseId: 5, sortOrder: 0 },
    ]);
    db.query.exercises.findMany.mockResolvedValue([
      { id: 5, name: "Squat", primaryMuscles: ["legs"] },
    ]);

    const result = await programsService.addExercise(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      {
        exerciseId: 5,
        sortOrder: 0,
      },
    );

    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      exercises: [
        {
          id: 10,
          templateId: 1,
          exerciseId: 5,
          sortOrder: 0,
          exercise: { id: 5, name: "Squat", primaryMuscles: ["legs"] },
        },
      ],
    });
  });
});

describe("ProgramsService.reorderExercises", () => {
  let programsService: ProgramsService;
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock };
      templateExercises: { findFirst: jest.Mock; findMany: jest.Mock };
      exercises: { findMany: jest.Mock };
    };
    transaction: jest.Mock;
  };
  let txUpdate: jest.Mock;
  let txWhere: jest.Mock;

  beforeEach(async () => {
    txWhere = jest.fn().mockResolvedValue(undefined);
    txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: txWhere }),
    });

    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
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
      transaction: jest.fn().mockImplementation((cb: any) =>
        cb({
          query: {
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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it("accepts a reordering that is an exact permutation of the current rows", async () => {
    // findOne() is called at the end to return the freshly reordered
    // template — reuse the same findFirst/findMany mocks already configured.
    await programsService.reorderExercises(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [102, 100, 101],
    );

    expect(db.transaction).toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalledTimes(3);
  });

  it("rejects a reordering that omits one of the current rows, without writing anything", async () => {
    await expect(
      programsService.reorderExercises(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [100, 101],
      ),
    ).rejects.toThrow(BadRequestException);
    // The permutation check now runs inside the transaction (alongside the
    // read it validates against), so the transaction IS entered — it just
    // never reaches the update loop before throwing.
    expect(db.transaction).toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("rejects a reordering from a practitioner who does not own the template", async () => {
    await expect(
      programsService.reorderExercises(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        [100, 101, 102],
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // Regression coverage for the TOCTOU fix: the permutation check must
  // validate against the transaction's OWN read, not a snapshot taken
  // before the transaction opened — otherwise a row removed/added in the
  // gap between the two could slip past validation. Simulated here by
  // making the pre-transaction (db.query) view stale/wrong on purpose: if
  // the service were still reading via this.db.query instead of tx.query,
  // this reordering would wrongly pass (it's a valid permutation of the
  // STALE set) instead of being rejected against the tx's real set.
  it("validates the permutation against the transaction, not a pre-transaction snapshot", async () => {
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 100 },
      { id: 101 },
      { id: 102 },
      { id: 999 }, // a row the tx-scoped read does NOT see
    ]);

    await expect(
      programsService.reorderExercises(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        [100, 101, 102, 999],
      ),
    ).rejects.toThrow(BadRequestException);
    expect(txUpdate).not.toHaveBeenCalled();
  });
});

describe("ProgramsService.findOne", () => {
  let programsService: ProgramsService;
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock };
      templateExercises: { findMany: jest.Mock };
      exercises: { findMany: jest.Mock };
    };
  };

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: { findFirst: jest.fn() },
        templateExercises: { findMany: jest.fn() },
        exercises: { findMany: jest.fn() },
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it("throws NotFoundException when the template does not exist", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue(undefined);

    await expect(programsService.findOne(999)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("returns an empty exercises array without querying exercises at all, for a template with none", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    });
    db.query.templateExercises.findMany.mockResolvedValue([]);

    const result = await programsService.findOne(1);

    expect(result.exercises).toEqual([]);
    expect(db.query.exercises.findMany).not.toHaveBeenCalled();
  });

  it("batches a single lookup for multiple rows, even ones referencing the same exercise", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    });
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 10, templateId: 1, exerciseId: 5, sortOrder: 0 },
      { id: 11, templateId: 1, exerciseId: 6, sortOrder: 1 },
      // Same exercise as row 10 — e.g. the same movement done twice in
      // one template with different sets/reps.
      { id: 12, templateId: 1, exerciseId: 5, sortOrder: 2 },
    ]);
    db.query.exercises.findMany.mockResolvedValue([
      { id: 5, name: "Squat", primaryMuscles: ["legs"] },
      { id: 6, name: "Lunge", primaryMuscles: ["legs"] },
    ]);

    const result = await programsService.findOne(1);

    expect(db.query.exercises.findMany).toHaveBeenCalledTimes(1);
    expect(result.exercises).toEqual([
      {
        id: 10,
        templateId: 1,
        exerciseId: 5,
        sortOrder: 0,
        exercise: { id: 5, name: "Squat", primaryMuscles: ["legs"] },
      },
      {
        id: 11,
        templateId: 1,
        exerciseId: 6,
        sortOrder: 1,
        exercise: { id: 6, name: "Lunge", primaryMuscles: ["legs"] },
      },
      {
        id: 12,
        templateId: 1,
        exerciseId: 5,
        sortOrder: 2,
        exercise: { id: 5, name: "Squat", primaryMuscles: ["legs"] },
      },
    ]);
  });

  it("defensively returns a null exercise rather than throwing, if the referenced exercise is somehow missing", async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({
      id: 1,
      practitionerId: 7,
    });
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 10, templateId: 1, exerciseId: 999, sortOrder: 0 },
    ]);
    db.query.exercises.findMany.mockResolvedValue([]);

    const result = await programsService.findOne(1);

    expect(result.exercises[0].exercise).toBeNull();
  });
});

describe("ProgramsService IDOR checks (updateExercise / removeExercise)", () => {
  let programsService: ProgramsService;
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock };
      templateExercises: { findFirst: jest.Mock; findMany: jest.Mock };
      exercises: { findMany: jest.Mock };
    };
    update: jest.Mock;
    delete: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
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
      delete: jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      // withRlsContext() wraps the actual DELETE in db.transaction()/
      // db.execute() — tx === db here, so the mocked delete() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it("throws NotFoundException when the exercise row does not belong to this template", async () => {
    db.query.templateExercises.findFirst.mockResolvedValue(undefined);

    await expect(
      programsService.removeExercise(1, 999, {
        id: 7,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("removes the exercise row, then returns the full enriched template via findOne", async () => {
    db.query.templateExercises.findFirst.mockResolvedValue({
      id: 50,
      templateId: 1,
    });
    // findOne()'s post-removal read — the removed row (50) is gone,
    // proving the response reflects real post-write state, not an echo
    // of the request.
    db.query.templateExercises.findMany.mockResolvedValue([
      { id: 51, templateId: 1, exerciseId: 6, sortOrder: 0 },
    ]);
    db.query.exercises.findMany.mockResolvedValue([
      { id: 6, name: "Lunge", primaryMuscles: ["legs"] },
    ]);

    const result = await programsService.removeExercise(1, 50, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    });

    expect(db.delete).toHaveBeenCalled();
    expect(result).toEqual({
      id: 1,
      practitionerId: 7,
      exercises: [
        {
          id: 51,
          templateId: 1,
          exerciseId: 6,
          sortOrder: 0,
          exercise: { id: 6, name: "Lunge", primaryMuscles: ["legs"] },
        },
      ],
    });
  });
});