import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ExercisesService } from "./exercises.service";
import { StorageService } from "../storage/storage.service";
import { DRIZZLE } from "../database/drizzle.provider";
import { UserRole } from "../users/dto/create-user.dto";

describe("ExercisesService.assertCanModify (via update)", () => {
  let exercisesService: ExercisesService;
  let db: {
    query: { exercises: { findFirst: jest.Mock } };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: { exercises: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 1, name: "Updated" }]),
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
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    exercisesService = moduleRef.get(ExercisesService);
  });

  it("allows the practitioner who created a custom exercise to modify it", async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: "custom",
      createdBy: 7,
      mediaUrls: [],
    });

    await expect(
      exercisesService.update(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { name: "Updated" },
      ),
    ).resolves.toEqual({ id: 1, name: "Updated" });
  });

  it("allows an admin to modify any exercise, including one they did not create", async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: "custom",
      createdBy: 7,
      mediaUrls: [],
    });

    await expect(
      exercisesService.update(
        1,
        { id: 999, activeRole: UserRole.ADMIN },
        { name: "Updated" },
      ),
    ).resolves.toEqual({ id: 1, name: "Updated" });
  });

  it("rejects a different practitioner modifying a custom exercise they did not create", async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: "custom",
      createdBy: 7,
      mediaUrls: [],
    });

    await expect(
      exercisesService.update(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        { name: "Updated" },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a practitioner modifying an api-sourced exercise, even one nobody "owns"', async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: "api",
      createdBy: null,
      mediaUrls: [],
    });

    await expect(
      exercisesService.update(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        { name: "Updated" },
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("ExercisesService.reorderImages", () => {
  let exercisesService: ExercisesService;
  let db: {
    query: { exercises: { findFirst: jest.Mock } };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: {
        exercises: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            source: "custom",
            createdBy: 7,
            mediaUrls: ["a.jpg", "b.jpg", "c.jpg"],
          }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([
                { id: 1, mediaUrls: ["c.jpg", "a.jpg", "b.jpg"] },
              ]),
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
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    exercisesService = moduleRef.get(ExercisesService);
  });

  it("accepts a reordering that is an exact permutation of the current images", async () => {
    const result = await exercisesService.reorderImages(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      ["c.jpg", "a.jpg", "b.jpg"],
    );

    expect(result).toEqual({ id: 1, mediaUrls: ["c.jpg", "a.jpg", "b.jpg"] });
  });

  it("rejects a reordering that drops an existing image", async () => {
    await expect(
      exercisesService.reorderImages(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        ["a.jpg", "b.jpg"],
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a reordering that introduces a key that was never uploaded", async () => {
    await expect(
      exercisesService.reorderImages(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        ["a.jpg", "b.jpg", "c.jpg", "never-uploaded.jpg"],
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a duplicate-padded reordering instead of silently corrupting the gallery", async () => {
    await expect(
      exercisesService.reorderImages(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        ["a.jpg", "b.jpg", "c.jpg", "a.jpg"],
      ),
    ).rejects.toThrow(BadRequestException);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a reordering from someone who does not own the exercise", async () => {
    await expect(
      exercisesService.reorderImages(
        1,
        { id: 999, activeRole: UserRole.PRACTITIONER },
        ["c.jpg", "a.jpg", "b.jpg"],
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("ExercisesService.removeImage", () => {
  let exercisesService: ExercisesService;
  let storageService: { delete: jest.Mock };
  let db: {
    query: { exercises: { findFirst: jest.Mock } };
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    storageService = { delete: jest.fn().mockResolvedValue(undefined) };
    db = {
      query: {
        exercises: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            source: "custom",
            createdBy: 7,
            mediaUrls: ["a.jpg", "b.jpg"],
          }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 1, mediaUrls: ["b.jpg"] }]),
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
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    exercisesService = moduleRef.get(ExercisesService);
  });

  it("removes an image key that belongs to this exercise", async () => {
    const result = await exercisesService.removeImage(
      1,
      { id: 7, activeRole: UserRole.PRACTITIONER },
      "a.jpg",
    );

    expect(result).toEqual({ id: 1, mediaUrls: ["b.jpg"] });
    expect(storageService.delete).toHaveBeenCalledWith("a.jpg");
  });

  it("throws NotFoundException for a key that does not belong to this exercise", async () => {
    await expect(
      exercisesService.removeImage(
        1,
        { id: 7, activeRole: UserRole.PRACTITIONER },
        "not-mine.jpg",
      ),
    ).rejects.toThrow(NotFoundException);
    expect(storageService.delete).not.toHaveBeenCalled();
  });
});

describe("ExercisesService.findOne", () => {
  let exercisesService: ExercisesService;
  let db: { query: { exercises: { findFirst: jest.Mock } } };

  beforeEach(async () => {
    db = { query: { exercises: { findFirst: jest.fn() } } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    exercisesService = moduleRef.get(ExercisesService);
  });

  it("throws NotFoundException when the exercise does not exist", async () => {
    db.query.exercises.findFirst.mockResolvedValue(undefined);

    await expect(exercisesService.findOne(999)).rejects.toThrow(
      NotFoundException,
    );
  });
});

// findAll's pagination math (offset/total/totalPages) was added later and
// had no coverage at all — worth pinning down given it's genuine arithmetic,
// not just a passthrough.
describe("ExercisesService.findAll", () => {
  let exercisesService: ExercisesService;
  let db: {
    query: { exercises: { findMany: jest.Mock } };
    select: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: {
        exercises: {
          findMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ total: 42 }]),
        }),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    exercisesService = moduleRef.get(ExercisesService);
  });

  it("defaults to page 1 and limit 20, computing offset 0, when neither is provided", async () => {
    const result = await exercisesService.findAll({});

    expect(db.query.exercises.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
    expect(result.data).toEqual([
      { id: 1, author: null },
      { id: 2, author: null },
    ]);
    expect(result.meta).toEqual({
      total: 42,
      page: 1,
      limit: 20,
      totalPages: 3,
    });
  });

  it("computes the offset from the requested page and limit", async () => {
    await exercisesService.findAll({ page: 3, limit: 10 });

    expect(db.query.exercises.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });

  it("rounds totalPages up so a partial last page still counts as a page", async () => {
    const result = await exercisesService.findAll({ page: 1, limit: 10 });

    // total: 42, limit: 10 -> 4.2 pages -> rounds up to 5
    expect(result.meta.totalPages).toBe(5);
  });

  // The two tests below cover the author-attachment LOGIC (the JS-side
  // batching and mapping) with mocks, same as the pagination math above —
  // deliberately NOT trying to prove the underlying SQL (the muscle-search
  // EXISTS/unnest fragments, the mine filter) is correct, since comparing
  // Drizzle's SQL-builder objects for equality would be fragile and
  // wouldn't actually prove the query behaves correctly against real data.
  // That correctness is covered by real e2e tests against a live
  // database instead (test/exercises.e2e-spec.ts).

  it("skips the author lookup entirely when no returned exercise has a creator", async () => {
    // The shared beforeEach's fixture rows ({id:1}, {id:2}) have no
    // createdBy at all — this asserts that ACTUALLY skips the second
    // query, not just that it happens to resolve to null either way.
    await exercisesService.findAll({});

    // Called once for the total count, and that's it — a second call
    // would mean the author lookup fired even though nothing needed it.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("attaches the correct author to each exercise, batching a single lookup for all creators on the page", async () => {
    db.query.exercises.findMany.mockResolvedValueOnce([
      { id: 1, createdBy: 5 },
      { id: 2, createdBy: 6 },
      { id: 3, createdBy: null },
    ]);

    // First call to db.select() is the total-count query (unchanged from
    // the shared beforeEach's mock); the second is the NEW author-batch
    // lookup — mockReturnValueOnce/mockResolvedValueOnce chain in the
    // exact order findAll actually calls db.select(), matching how the
    // real implementation calls it: total count first (inside
    // Promise.all), author lookup second (only after rows are known).
    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ total: 3 }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 5, firstName: "Amy", lastName: "Lee" },
            { id: 6, firstName: "Bo", lastName: "Ng" },
          ]),
        }),
      });

    const result = await exercisesService.findAll({});

    expect(result.data).toEqual([
      { id: 1, createdBy: 5, author: { firstName: "Amy", lastName: "Lee" } },
      { id: 2, createdBy: 6, author: { firstName: "Bo", lastName: "Ng" } },
      { id: 3, createdBy: null, author: null },
    ]);
    // Exactly two db.select calls (total + one BATCHED author lookup) —
    // not three, which would mean a separate query per creator instead
    // of the single inArray(...) lookup this is supposed to be.
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});