import { Test } from '@nestjs/testing'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { ClinicsService } from './clinics.service'
import { StorageService } from '../storage/storage.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'

const adminUser = { id: 2, activeRole: UserRole.ADMIN }

// sql`` template results don't stringify meaningfully via String() — the
// literal text lives in queryChunks as StringChunk({ value: [...] })
// entries, interspersed with the interpolated params. Flattening those
// chunks is the only way to assert on which GUC a given tx.execute() call
// actually targeted.
function flattenSqlChunks(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        return (chunk as { value: unknown[] }).value.join('')
      }
      return String(chunk)
    })
    .join('')
}

describe('ClinicsService.addMember', () => {
  let clinicsService: ClinicsService
  let db: {
    query: {
      clinics: { findFirst: jest.Mock }
      users: { findFirst: jest.Mock }
      userClinics: { findFirst: jest.Mock }
    }
    insert: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        clinics: { findFirst: jest.fn() },
        users: { findFirst: jest.fn() },
        userClinics: { findFirst: jest.fn() },
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
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.addMember(999, 1, adminUser)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('throws NotFoundException when the user does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.addMember(1, 999, adminUser)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('throws ConflictException when the user already belongs to the clinic', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue({
      id: 10,
      email: 'member@example.com',
    })
    db.query.userClinics.findFirst.mockResolvedValue({
      id: 5,
      clinicId: 1,
      userId: 10,
    })

    await expect(clinicsService.addMember(1, 10, adminUser)).rejects.toThrow(
      ConflictException,
    )
  })

  it('creates the membership when the clinic and user exist and are not already linked', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue({
      id: 10,
      email: 'member@example.com',
    })
    db.query.userClinics.findFirst.mockResolvedValue(undefined)
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 50, clinicId: 1, userId: 10 }]),
      }),
    })

    const result = await clinicsService.addMember(1, 10, adminUser)

    expect(result).toEqual({ id: 50, clinicId: 1, userId: 10 })
  })

  // Pinning down that currentUser is actually threaded into the RLS
  // context, not just accepted and ignored — set_config() is what makes
  // this insert visible to a future userClinics RLS policy at all.
  it('sets the RLS session context from the given currentUser before inserting', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue({
      id: 10,
      email: 'member@example.com',
    })
    db.query.userClinics.findFirst.mockResolvedValue(undefined)
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 50, clinicId: 1, userId: 10 }]),
      }),
    })

    await clinicsService.addMember(1, 10, adminUser)

    const executeCalls = db.execute.mock.calls as unknown[][]
    expect(db.transaction).toHaveBeenCalled()
    expect(executeCalls).toHaveLength(2)
    expect(flattenSqlChunks(executeCalls[0][0])).toContain(
      'app.current_user_id',
    )
    expect(flattenSqlChunks(executeCalls[1][0])).toContain('app.current_role')
  })
})

describe('ClinicsService.findOne', () => {
  let clinicsService: ClinicsService
  let db: { query: { clinics: { findFirst: jest.Mock } } }

  beforeEach(async () => {
    db = { query: { clinics: { findFirst: jest.fn() } } }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.findOne(999)).rejects.toThrow(NotFoundException)
  })
})

describe('ClinicsService.create', () => {
  let clinicsService: ClinicsService
  let db: { insert: jest.Mock; execute: jest.Mock; transaction: jest.Mock }

  beforeEach(async () => {
    db = {
      insert: jest.fn(),
      // withRlsContext() wraps the actual INSERT in db.transaction()/
      // db.execute() — tx === db here, so the mocked insert() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('inserts the given fields and returns the created clinic', async () => {
    const values = jest.fn().mockReturnValue({
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 1, name: 'Acme Clinic', email: 'acme@example.com' }]),
    })
    db.insert.mockReturnValue({ values })

    const result = await clinicsService.create(adminUser, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
    })

    expect(values).toHaveBeenCalledWith({ name: 'Acme Clinic', email: 'acme@example.com' })
    expect(result).toEqual({ id: 1, name: 'Acme Clinic', email: 'acme@example.com' })
  })
})

describe('ClinicsService.findAll', () => {
  let clinicsService: ClinicsService
  let db: { query: { clinics: { findMany: jest.Mock } } }

  beforeEach(async () => {
    db = { query: { clinics: { findMany: jest.fn() } } }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  // isActive filtering itself is a Drizzle `where` clause built inline in
  // the service, not something a mocked findMany can meaningfully assert on
  // without re-implementing Drizzle's query builder — what's actually worth
  // pinning down here is that findAll is a straight passthrough of whatever
  // findMany resolves.
  it('returns whatever the active-clinics query resolves', async () => {
    const activeClinics = [{ id: 1, name: 'Acme Clinic', isActive: true }]
    db.query.clinics.findMany.mockResolvedValue(activeClinics)

    const result = await clinicsService.findAll()

    expect(db.query.clinics.findMany).toHaveBeenCalled()
    expect(result).toEqual(activeClinics)
  })
})

describe('ClinicsService.update', () => {
  let clinicsService: ClinicsService
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: { clinics: { findFirst: jest.fn() } },
      update: jest.fn(),
      // withRlsContext() wraps the actual UPDATE in db.transaction()/
      // db.execute() — tx === db here, so the mocked update() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(
      clinicsService.update(999, adminUser, { name: 'New Name' }),
    ).rejects.toThrow(NotFoundException)
    expect(db.update).not.toHaveBeenCalled()
  })

  it('updates and returns the clinic when it exists', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, name: 'Renamed Clinic' }]),
      }),
    })
    db.update.mockReturnValue({ set })

    const result = await clinicsService.update(1, adminUser, { name: 'Renamed Clinic' })

    expect(set).toHaveBeenCalledWith({ name: 'Renamed Clinic' })
    expect(result).toEqual({ id: 1, name: 'Renamed Clinic' })
  })
})

describe('ClinicsService.updateLogo', () => {
  let clinicsService: ClinicsService
  let storageService: { upload: jest.Mock }
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    storageService = { upload: jest.fn().mockResolvedValue(undefined) }
    db = {
      query: { clinics: { findFirst: jest.fn() } },
      update: jest.fn(),
      // withRlsContext() wraps the actual UPDATE in db.transaction()/
      // db.execute() — tx === db here, so the mocked update() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist, without touching storage', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(
      clinicsService.updateLogo(999, adminUser, {
        mimetype: 'image/png',
        buffer: Buffer.from('x'),
      } as Express.Multer.File),
    ).rejects.toThrow(NotFoundException)
    expect(storageService.upload).not.toHaveBeenCalled()
  })

  it('uploads the file and stores the resulting object key as logoPath', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 1, logoPath: 'clinics/1/logo-123.png' }]),
      }),
    })
    db.update.mockReturnValue({ set })

    const result = await clinicsService.updateLogo(1, adminUser, {
      mimetype: 'image/png',
      buffer: Buffer.from('fake-logo'),
    } as Express.Multer.File)

    expect(storageService.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^clinics\/1\/logo-\d+\.png$/),
      Buffer.from('fake-logo'),
      'image/png',
    )
    expect(set).toHaveBeenCalledWith({
      logoPath: expect.stringMatching(/^clinics\/1\/logo-\d+\.png$/),
    })
    expect(result).toEqual({ id: 1, logoPath: 'clinics/1/logo-123.png' })
  })
})

describe('ClinicsService.exists', () => {
  let clinicsService: ClinicsService
  let db: { query: { clinics: { findFirst: jest.Mock } } }

  beforeEach(async () => {
    db = { query: { clinics: { findFirst: jest.fn() } } }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  // Deliberately a yes/no answer rather than findOne's throw-on-missing —
  // callers like UsersService.create need to decide for themselves how to
  // react to a missing clinic, not have an exception forced on them.
  it('returns true when the clinic exists', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })

    await expect(clinicsService.exists(1)).resolves.toBe(true)
  })

  it('returns false, not a thrown error, when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.exists(999)).resolves.toBe(false)
  })
})

describe('ClinicsService.listMembers', () => {
  let clinicsService: ClinicsService
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    select: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: { clinics: { findFirst: jest.fn() } },
      select: jest.fn(),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist, without querying members', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.listMembers(999)).rejects.toThrow(NotFoundException)
    expect(db.select).not.toHaveBeenCalled()
  })

  // Two separate queries under the hood — the member rows themselves, then
  // one roles lookup per member — collapsed by the service into a single
  // flat { ...member, roles: [...] } shape. Worth pinning down since a
  // regression here (e.g. losing the per-member roles attachment) wouldn't
  // be caught by anything checking just the member list.
  it("attaches each member's roles array to their basic info", async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest
              .fn()
              .mockResolvedValue([
                { id: 10, email: 'member@example.com', firstName: 'Mem', lastName: 'Ber' },
              ]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ role: 'practitioner' }]),
        }),
      })

    const result = await clinicsService.listMembers(1)

    expect(result).toEqual([
      {
        id: 10,
        email: 'member@example.com',
        firstName: 'Mem',
        lastName: 'Ber',
        roles: ['practitioner'],
      },
    ])
  })
})

describe('ClinicsService.deactivate', () => {
  let clinicsService: ClinicsService
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: { clinics: { findFirst: jest.fn() } },
      update: jest.fn(),
      // withRlsContext() wraps the actual UPDATE in db.transaction()/
      // db.execute() — tx === db here, so the mocked update() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.deactivate(999, adminUser)).rejects.toThrow(
      NotFoundException,
    )
    expect(db.update).not.toHaveBeenCalled()
  })

  it('sets isActive to false and returns the deactivated clinic', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic', isActive: true })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, isActive: false }]),
      }),
    })
    db.update.mockReturnValue({ set })

    const result = await clinicsService.deactivate(1, adminUser)

    expect(set).toHaveBeenCalledWith({ isActive: false })
    expect(result).toEqual({ id: 1, isActive: false })
  })
})

describe('ClinicsService.removeMember', () => {
  let clinicsService: ClinicsService
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    delete: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: { clinics: { findFirst: jest.fn() } },
      delete: jest.fn(),
      // withRlsContext() wraps the actual DELETE in db.transaction()/
      // db.execute() — tx === db here, so the mocked delete() above still
      // resolves against this same object.
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist, without touching the delete', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.removeMember(1, 10, adminUser)).rejects.toThrow(
      NotFoundException,
    )
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('deletes the membership row for the given clinic and user', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic', isActive: true })
    const where = jest.fn().mockResolvedValue(undefined)
    db.delete.mockReturnValue({ where })

    await clinicsService.removeMember(1, 10, adminUser)

    expect(db.delete).toHaveBeenCalled()
    expect(where).toHaveBeenCalled()
  })

  // Same "currentUser is genuinely threaded through" check as addMember —
  // without this, a future userClinics RLS policy would silently see no
  // session context and block or misjudge the delete.
  it('sets the RLS session context from the given currentUser before deleting', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic', isActive: true })
    const where = jest.fn().mockResolvedValue(undefined)
    db.delete.mockReturnValue({ where })

    await clinicsService.removeMember(1, 10, adminUser)

    const executeCalls = db.execute.mock.calls as unknown[][]
    expect(db.transaction).toHaveBeenCalled()
    expect(executeCalls).toHaveLength(2)
    expect(flattenSqlChunks(executeCalls[0][0])).toContain(
      'app.current_user_id',
    )
    expect(flattenSqlChunks(executeCalls[1][0])).toContain('app.current_role')
  })
})
