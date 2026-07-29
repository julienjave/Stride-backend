import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProgramsService } from './programs.service';
import { DRIZZLE } from '../database/drizzle.provider';

describe('ProgramsService.assertCanModify (via update)', () => {
  let programsService: ProgramsService;
  let db: {
    query: { programTemplates: { findFirst: jest.Mock } };
    update: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: { programTemplates: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, title: 'Updated' }]),
          }),
        }),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it('allows the owning practitioner to modify their own template', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({ id: 1, practitionerId: 7 });

    await expect(
      programsService.update(1, { id: 7, activeRole: 'practitioner' }, { title: 'Updated' }),
    ).resolves.toEqual({ id: 1, title: 'Updated' });
  });

  it('allows an admin to modify a template they do not own', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({ id: 1, practitionerId: 7 });

    await expect(
      programsService.update(1, { id: 999, activeRole: 'admin' }, { title: 'Updated' }),
    ).resolves.toEqual({ id: 1, title: 'Updated' });
  });

  it('rejects a different practitioner modifying a template they do not own', async () => {
    db.query.programTemplates.findFirst.mockResolvedValue({ id: 1, practitionerId: 7 });

    await expect(
      programsService.update(1, { id: 999, activeRole: 'practitioner' }, { title: 'Updated' }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ProgramsService.addExercise', () => {
  let programsService: ProgramsService;
  let db: {
    query: { programTemplates: { findFirst: jest.Mock }; exercises: { findFirst: jest.Mock } };
    insert: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
        },
        exercises: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it('throws NotFoundException when the referenced exercise does not exist', async () => {
    db.query.exercises.findFirst.mockResolvedValue(undefined);

    await expect(
      programsService.addExercise(1, { id: 7, activeRole: 'practitioner' }, {
        exerciseId: 999,
        sortOrder: 0,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a non-owning practitioner before ever checking the exercise exists', async () => {
    await expect(
      programsService.addExercise(1, { id: 999, activeRole: 'practitioner' }, {
        exerciseId: 5,
        sortOrder: 0,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(db.query.exercises.findFirst).not.toHaveBeenCalled();
  });

  it('adds the exercise once ownership and existence both check out', async () => {
    db.query.exercises.findFirst.mockResolvedValue({ id: 5, name: 'Squat' });
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 10, templateId: 1, exerciseId: 5 }]),
      }),
    });

    const result = await programsService.addExercise(1, { id: 7, activeRole: 'practitioner' }, {
      exerciseId: 5,
      sortOrder: 0,
    });

    expect(result).toEqual({ id: 10, templateId: 1, exerciseId: 5 });
  });
});

describe('ProgramsService.reorderExercises', () => {
  let programsService: ProgramsService;
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock };
      templateExercises: { findFirst: jest.Mock; findMany: jest.Mock };
    };
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
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 100 }, { id: 101 }, { id: 102 }]),
        },
      },
      transaction: jest.fn().mockImplementation((cb: any) =>
        cb({ update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }) }),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it('accepts a reordering that is an exact permutation of the current rows', async () => {
    // findOne() is called at the end to return the freshly reordered
    // template — reuse the same findFirst/findMany mocks already configured.
    await programsService.reorderExercises(1, { id: 7, activeRole: 'practitioner' }, [102, 100, 101]);

    expect(db.transaction).toHaveBeenCalled();
  });

  it('rejects a reordering that omits one of the current rows', async () => {
    await expect(
      programsService.reorderExercises(1, { id: 7, activeRole: 'practitioner' }, [100, 101]),
    ).rejects.toThrow(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects a reordering from a practitioner who does not own the template', async () => {
    await expect(
      programsService.reorderExercises(1, { id: 999, activeRole: 'practitioner' }, [100, 101, 102]),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('ProgramsService IDOR checks (updateExercise / removeExercise)', () => {
  let programsService: ProgramsService;
  let db: {
    query: {
      programTemplates: { findFirst: jest.Mock };
      templateExercises: { findFirst: jest.Mock };
    };
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: {
        programTemplates: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, practitionerId: 7 }),
        },
        templateExercises: { findFirst: jest.fn() },
      },
      update: jest.fn(),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProgramsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    programsService = moduleRef.get(ProgramsService);
  });

  it('throws NotFoundException when the exercise row does not belong to this template', async () => {
    db.query.templateExercises.findFirst.mockResolvedValue(undefined);

    await expect(
      programsService.removeExercise(1, 999, { id: 7, activeRole: 'practitioner' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('removes the exercise row once it is confirmed to belong to this template', async () => {
    db.query.templateExercises.findFirst.mockResolvedValue({ id: 50, templateId: 1 });

    await programsService.removeExercise(1, 50, { id: 7, activeRole: 'practitioner' });

    expect(db.delete).toHaveBeenCalled();
  });
});
