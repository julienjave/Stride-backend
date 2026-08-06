import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { ExercisesService } from './exercises.service'
import { StorageService } from '../storage/storage.service'
import { DRIZZLE } from '../database/drizzle.provider'

describe('ExercisesService.assertCanModify (via update)', () => {
  let exercisesService: ExercisesService
  let db: {
    query: { exercises: { findFirst: jest.Mock } }
    update: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: { exercises: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 1, name: 'Updated' }]),
          }),
        }),
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    exercisesService = moduleRef.get(ExercisesService)
  })

  it('allows the practitioner who created a custom exercise to modify it', async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: 'custom',
      createdBy: 7,
      mediaUrls: [],
    })

    await expect(
      exercisesService.update(
        1,
        { id: 7, activeRole: 'practitioner' },
        { name: 'Updated' },
      ),
    ).resolves.toEqual({ id: 1, name: 'Updated' })
  })

  it('allows an admin to modify any exercise, including one they did not create', async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: 'custom',
      createdBy: 7,
      mediaUrls: [],
    })

    await expect(
      exercisesService.update(
        1,
        { id: 999, activeRole: 'admin' },
        { name: 'Updated' },
      ),
    ).resolves.toEqual({ id: 1, name: 'Updated' })
  })

  it('rejects a different practitioner modifying a custom exercise they did not create', async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: 'custom',
      createdBy: 7,
      mediaUrls: [],
    })

    await expect(
      exercisesService.update(
        1,
        { id: 999, activeRole: 'practitioner' },
        { name: 'Updated' },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects a practitioner modifying an api-sourced exercise, even one nobody "owns"', async () => {
    db.query.exercises.findFirst.mockResolvedValue({
      id: 1,
      source: 'api',
      createdBy: null,
      mediaUrls: [],
    })

    await expect(
      exercisesService.update(
        1,
        { id: 7, activeRole: 'practitioner' },
        { name: 'Updated' },
      ),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('ExercisesService.reorderImages', () => {
  let exercisesService: ExercisesService
  let db: {
    query: { exercises: { findFirst: jest.Mock } }
    update: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        exercises: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            source: 'custom',
            createdBy: 7,
            mediaUrls: ['a.jpg', 'b.jpg', 'c.jpg'],
          }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([
                { id: 1, mediaUrls: ['c.jpg', 'a.jpg', 'b.jpg'] },
              ]),
          }),
        }),
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    exercisesService = moduleRef.get(ExercisesService)
  })

  it('accepts a reordering that is an exact permutation of the current images', async () => {
    const result = await exercisesService.reorderImages(
      1,
      { id: 7, activeRole: 'practitioner' },
      ['c.jpg', 'a.jpg', 'b.jpg'],
    )

    expect(result).toEqual({ id: 1, mediaUrls: ['c.jpg', 'a.jpg', 'b.jpg'] })
  })

  it('rejects a reordering that drops an existing image', async () => {
    await expect(
      exercisesService.reorderImages(1, { id: 7, activeRole: 'practitioner' }, [
        'a.jpg',
        'b.jpg',
      ]),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects a reordering that introduces a key that was never uploaded', async () => {
    await expect(
      exercisesService.reorderImages(1, { id: 7, activeRole: 'practitioner' }, [
        'a.jpg',
        'b.jpg',
        'c.jpg',
        'never-uploaded.jpg',
      ]),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects a reordering from someone who does not own the exercise', async () => {
    await expect(
      exercisesService.reorderImages(
        1,
        { id: 999, activeRole: 'practitioner' },
        ['c.jpg', 'a.jpg', 'b.jpg'],
      ),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('ExercisesService.removeImage', () => {
  let exercisesService: ExercisesService
  let storageService: { delete: jest.Mock }
  let db: {
    query: { exercises: { findFirst: jest.Mock } }
    update: jest.Mock
  }

  beforeEach(async () => {
    storageService = { delete: jest.fn().mockResolvedValue(undefined) }
    db = {
      query: {
        exercises: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            source: 'custom',
            createdBy: 7,
            mediaUrls: ['a.jpg', 'b.jpg'],
          }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([{ id: 1, mediaUrls: ['b.jpg'] }]),
          }),
        }),
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()

    exercisesService = moduleRef.get(ExercisesService)
  })

  it('removes an image key that belongs to this exercise', async () => {
    const result = await exercisesService.removeImage(
      1,
      { id: 7, activeRole: 'practitioner' },
      'a.jpg',
    )

    expect(result).toEqual({ id: 1, mediaUrls: ['b.jpg'] })
    expect(storageService.delete).toHaveBeenCalledWith('a.jpg')
  })

  it('throws NotFoundException for a key that does not belong to this exercise', async () => {
    await expect(
      exercisesService.removeImage(
        1,
        { id: 7, activeRole: 'practitioner' },
        'not-mine.jpg',
      ),
    ).rejects.toThrow(NotFoundException)
    expect(storageService.delete).not.toHaveBeenCalled()
  })
})

describe('ExercisesService.findOne', () => {
  let exercisesService: ExercisesService
  let db: { query: { exercises: { findFirst: jest.Mock } } }

  beforeEach(async () => {
    db = { query: { exercises: { findFirst: jest.fn() } } }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExercisesService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    exercisesService = moduleRef.get(ExercisesService)
  })

  it('throws NotFoundException when the exercise does not exist', async () => {
    db.query.exercises.findFirst.mockResolvedValue(undefined)

    await expect(exercisesService.findOne(999)).rejects.toThrow(
      NotFoundException,
    )
  })
})
