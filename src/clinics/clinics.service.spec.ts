import { Test } from '@nestjs/testing'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  PG_UNIQUE_VIOLATION,
  USER_CLINICS_USER_CLINIC_UNIQUE,
} from '../database/pg-errors'
import { ClinicsService } from './clinics.service'
import { StorageService } from '../storage/storage.service'
import { AuditService } from '../audit/audit.service'
import { CareTeamService } from '../care-team/care-team.service'

// CareTeamService is where the care-team rule lives (and has its own spec).
// Here it's a stub: these tests are about what THIS service does with the
// answers — each test that cares sets them through moduleRef.get(...).
function careTeamStub() {
  return {
    isOnCareTeam: jest.fn().mockResolvedValue(false),
    findPatientIdsForPractitioner: jest.fn().mockResolvedValue([]),
    linkCreator: jest.fn().mockResolvedValue({ id: 900 }),
    endLinksWithoutSharedClinic: jest.fn().mockResolvedValue([]),
  }
}
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'

const adminUser = { id: 2, activeRole: UserRole.ADMIN }

// AuditService since the audit review: every clinic write goes through
// logInTransaction (inside its transaction). A fresh stub before EVERY test
// (this top-level beforeEach runs before each block's own); log() — the
// after-commit path — is kept to assert it's no longer used.
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

// lockClinic()'s SELECT … FOR UPDATE, on a block's mocked db (tx === db in
// every block here): answers `row` — the clinic as it is INSIDE the
// transaction, the "before" an entry records. Returns the .for() mock.
function lockRow(db: object, row: Record<string, unknown> | undefined) {
  const forUpdate = jest.fn().mockResolvedValue(row ? [row] : [])
  Object.assign(db, {
    select: jest.fn(() => ({
      from: () => ({ where: () => ({ for: forUpdate }) }),
    })),
  })
  return forUpdate
}

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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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

  // Already a member: user_clinics' UNIQUE refuses the INSERT (no read
  // beforehand — two requests at once could both pass one), and that refusal
  // becomes the 409 (privacy and security pass 2).
  it('throws ConflictException when the user already belongs to the clinic — the constraint decides', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue({
      id: 10,
      email: 'member@example.com',
    })
    db.insert.mockReturnValue({
      values: () => ({
        returning: () =>
          Promise.reject(
            new DrizzleQueryError(
              'insert into ...',
              [],
              Object.assign(new Error('duplicate key value'), {
                code: PG_UNIQUE_VIOLATION,
                constraint: USER_CLINICS_USER_CLINIC_UNIQUE,
              }),
            ),
          ),
      }),
    })

    await expect(clinicsService.addMember(1, 10, adminUser)).rejects.toThrow(
      new ConflictException('This user already belongs to this clinic'),
    )
    expect(db.query.userClinics.findFirst).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })

  // Narrow translation: any other failure keeps its own identity — a
  // duplicate on ANOTHER unique constraint too.
  it('rethrows any other failure of the insert unchanged', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue({ id: 10 })
    const otherDuplicate = new DrizzleQueryError(
      'insert into ...',
      [],
      Object.assign(new Error('duplicate key value'), {
        code: PG_UNIQUE_VIOLATION,
        constraint: 'user_clinics_pkey',
      }),
    )
    for (const otherError of [
      new Error('connection terminated'),
      otherDuplicate,
    ]) {
      db.insert.mockReturnValue({
        values: () => ({ returning: () => Promise.reject(otherError) }),
      })
      await expect(clinicsService.addMember(1, 10, adminUser)).rejects.toBe(
        otherError,
      )
    }
  })

  it('creates the membership when the clinic and user exist and are not already linked', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    db.query.users.findFirst.mockResolvedValue({
      id: 10,
      email: 'member@example.com',
    })
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 50, clinicId: 1, userId: 10 }]),
      }),
    })

    const result = await clinicsService.addMember(1, 10, adminUser)

    expect(result).toEqual({ id: 50, clinicId: 1, userId: 10 })
    // ONE entry in the same transaction (tx === db), about the person who
    // joined, naming the clinic.
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: adminUser.id,
      action: 'CLINIC_MEMBER_ADDED',
      targetUserId: 10,
      entityType: 'user_clinics',
      entityId: 50,
      details: { clinicId: 1 },
    })
    expect(audit.log).not.toHaveBeenCalled()
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('inserts the given fields and returns the created clinic', async () => {
    const values = jest.fn().mockReturnValue({
      returning: jest
        .fn()
        .mockResolvedValue([
          { id: 1, name: 'Acme Clinic', email: 'acme@example.com' },
        ]),
    })
    db.insert.mockReturnValue({ values })

    const result = await clinicsService.create(adminUser, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
    })

    expect(values).toHaveBeenCalledWith({
      name: 'Acme Clinic',
      email: 'acme@example.com',
    })
    expect(result).toEqual({
      id: 1,
      name: 'Acme Clinic',
      email: 'acme@example.com',
      logoUrl: null,
    })
    // The clinic as created, in its transaction. Organisation data: no
    // targetUserId (the key is absent, not undefined).
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: adminUser.id,
      action: 'CLINIC_CREATED',
      entityType: 'clinics',
      entityId: 1,
      details: {
        record: { name: 'Acme Clinic', email: 'acme@example.com' },
      },
    })
  })

  it('passes a full address through to the insert when given', async () => {
    const address = {
      addressLine1: '1 Acme Way',
      addressLine2: 'Suite 200',
      addressCity: 'Springfield',
      addressState: 'IL',
      addressPostalCode: '62704',
      addressCountry: 'US',
    }
    const values = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([
        {
          id: 1,
          name: 'Acme Clinic',
          email: 'acme@example.com',
          ...address,
        },
      ]),
    })
    db.insert.mockReturnValue({ values })

    const result = await clinicsService.create(adminUser, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
      ...address,
    })

    expect(values).toHaveBeenCalledWith({
      name: 'Acme Clinic',
      email: 'acme@example.com',
      ...address,
    })
    expect(result).toEqual({
      id: 1,
      name: 'Acme Clinic',
      email: 'acme@example.com',
      ...address,
      logoUrl: null,
    })
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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
    expect(result).toEqual([{ ...activeClinics[0], logoUrl: null }])
  })

  it('filters to active clinics only when includeInactive is omitted', async () => {
    db.query.clinics.findMany.mockResolvedValue([])

    await clinicsService.findAll()

    // A mock's recorded arguments are `any`; naming the one argument's
    // shape keeps the destructuring typed.
    const [[{ where }]] = db.query.clinics.findMany.mock.calls as [
      [{ where: unknown }],
    ]
    expect(where).not.toBeUndefined()
  })

  it('passes no filter at all when includeInactive is true', async () => {
    db.query.clinics.findMany.mockResolvedValue([])

    await clinicsService.findAll(true)

    expect(db.query.clinics.findMany).toHaveBeenCalledWith({ where: undefined })
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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
    const forUpdate = lockRow(db, { id: 1, name: 'Acme Clinic' })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 1, name: 'Renamed Clinic' }]),
      }),
    })
    db.update.mockReturnValue({ set })

    const result = await clinicsService.update(1, adminUser, {
      name: 'Renamed Clinic',
    })

    expect(set).toHaveBeenCalledWith({ name: 'Renamed Clinic' })
    expect(result).toEqual({ id: 1, name: 'Renamed Clinic', logoUrl: null })
    // "Before" read under the row's lock, then before → after in ONE entry.
    expect(forUpdate).toHaveBeenCalledWith('update')
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: adminUser.id,
      action: 'CLINIC_UPDATED',
      entityType: 'clinics',
      entityId: 1,
      details: {
        changes: { name: { from: 'Acme Clinic', to: 'Renamed Clinic' } },
      },
    })
  })

  // The convention: a PATCH that changes nothing writes nothing.
  it('writes nothing — no UPDATE, no entry — when every value sent is already stored', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' })
    lockRow(db, { id: 1, name: 'Acme Clinic', email: 'acme@example.com' })

    const result = await clinicsService.update(1, adminUser, {
      name: 'Acme Clinic',
    })

    expect(db.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(result).toEqual({
      id: 1,
      name: 'Acme Clinic',
      email: 'acme@example.com',
      logoUrl: null,
    })
  })
})

describe('ClinicsService.updateLogo', () => {
  let clinicsService: ClinicsService
  let storageService: {
    upload: jest.Mock
    deleteUnreferenced: jest.Mock
    getPresignedUrlOrNull: jest.Mock
  }
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    storageService = {
      upload: jest.fn().mockResolvedValue(undefined),
      deleteUnreferenced: jest.fn().mockResolvedValue(undefined),
      getPresignedUrlOrNull: jest
        .fn()
        .mockResolvedValue(
          'https://storage.example.com/signed/clinics/1/logo-123.png',
        ),
    }
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
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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
    lockRow(db, { id: 1, name: 'Acme Clinic', logoPath: null })
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
    // The key that reached the UPDATE is exactly the one uploaded.
    const [[uploadedKey]] = storageService.upload.mock.calls as [[string]]
    expect(set.mock.calls).toEqual([[{ logoPath: uploadedKey }]])
    // The raw object key (logoPath) is never handed back to the caller —
    // only a ready-to-use logoUrl, generated with a 24-hour expiry
    // (60 * 60 * 24 seconds) rather than getPresignedUrl's own much
    // shorter 900-second default.
    expect(storageService.getPresignedUrlOrNull).toHaveBeenCalledWith(
      'clinics/1/logo-123.png',
      60 * 60 * 24,
    )
    expect(result).toEqual({
      id: 1,
      logoUrl: 'https://storage.example.com/signed/clinics/1/logo-123.png',
    })
    // This clinic had no prior logo (the locked row's logoPath is null) —
    // nothing should be deleted.
    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
    // ONE entry, in the transaction: the storage keys before and after.
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: adminUser.id,
      action: 'CLINIC_LOGO_CHANGED',
      entityType: 'clinics',
      entityId: 1,
      details: {
        changes: {
          logoPath: {
            from: null,
            to: (storageService.upload.mock.calls as [string][])[0][0],
          },
        },
      },
    })
  })

  // The file deleted is the one the row pointed at UNDER THE LOCK (OLD), not
  // the one read before the upload (EARLIER): another upload in between
  // would have made that one stale.
  it('deletes the OLD logo file — the one read under the lock — after a successful replace', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      logoPath: 'clinics/1/logo-EARLIER.png',
    })
    lockRow(db, { id: 1, logoPath: 'clinics/1/logo-OLD.png' })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 1, logoPath: 'clinics/1/logo-NEW.png' }]),
      }),
    })
    db.update.mockReturnValue({ set })

    await clinicsService.updateLogo(1, adminUser, {
      mimetype: 'image/png',
      buffer: Buffer.from('fake-logo'),
    } as Express.Multer.File)

    expect(storageService.deleteUnreferenced).toHaveBeenCalledWith(
      'clinics/1/logo-OLD.png',
    )
    // …and the entry names that same file as the one replaced.
    const [, entry] = audit.logInTransaction.mock.calls[0] as [
      unknown,
      { details: unknown },
    ]
    expect(entry.details).toStrictEqual({
      changes: {
        logoPath: {
          from: 'clinics/1/logo-OLD.png',
          to: (storageService.upload.mock.calls as [string][])[0][0],
        },
      },
    })
    // Deleted AFTER the new file was uploaded and the DB pointed at it —
    // never before, so a failure partway through this method can't leave
    // the clinic pointing at an already-deleted file. invocationCallOrder
    // is plain Jest (no extra matcher library installed here) — lower
    // numbers mean earlier calls.
    expect(storageService.upload.mock.invocationCallOrder[0]).toBeLessThan(
      storageService.deleteUnreferenced.mock.invocationCallOrder[0],
    )
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(
      storageService.deleteUnreferenced.mock.invocationCallOrder[0],
    )
  })

  it('does not touch storage.delete when the clinic had no prior logo', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      logoPath: null,
    })
    lockRow(db, { id: 1, logoPath: null })
    db.update.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: 1, logoPath: 'clinics/1/logo-NEW.png' }]),
        }),
      }),
    })

    await clinicsService.updateLogo(1, adminUser, {
      mimetype: 'image/png',
      buffer: Buffer.from('fake-logo'),
    } as Express.Multer.File)

    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
  })
})

describe('ClinicsService.removeLogo', () => {
  let clinicsService: ClinicsService
  let storageService: {
    deleteUnreferenced: jest.Mock
    getPresignedUrlOrNull: jest.Mock
  }
  let db: {
    query: { clinics: { findFirst: jest.Mock } }
    update: jest.Mock
    execute: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    storageService = {
      deleteUnreferenced: jest.fn().mockResolvedValue(undefined),
      getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
    }
    db = {
      query: { clinics: { findFirst: jest.fn() } },
      update: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist, without touching storage or the DB', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.removeLogo(999, adminUser)).rejects.toThrow(
      NotFoundException,
    )
    expect(db.update).not.toHaveBeenCalled()
    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
  })

  it('clears logoPath and deletes the file from storage when a logo exists', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      logoPath: 'clinics/1/logo-OLD.png',
    })
    lockRow(db, { id: 1, logoPath: 'clinics/1/logo-OLD.png' })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, logoPath: null }]),
      }),
    })
    db.update.mockReturnValue({ set })

    const result = await clinicsService.removeLogo(1, adminUser)

    expect(set).toHaveBeenCalledWith({ logoPath: null })
    expect(storageService.deleteUnreferenced).toHaveBeenCalledWith(
      'clinics/1/logo-OLD.png',
    )
    // The DB update happens before the storage delete — same ordering
    // rule as updateLogo(), for the same reason: a failed storage delete
    // should leave an orphaned file, never a clinic still pointing at
    // one that's already gone.
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(
      storageService.deleteUnreferenced.mock.invocationCallOrder[0],
    )
    expect(result).toEqual({ id: 1, logoUrl: null })
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: adminUser.id,
      action: 'CLINIC_LOGO_REMOVED',
      entityType: 'clinics',
      entityId: 1,
      details: {
        changes: { logoPath: { from: 'clinics/1/logo-OLD.png', to: null } },
      },
    })
  })

  // No logo to remove changes nothing — so nothing is written: no UPDATE, no
  // entry (the convention), and storage is left alone.
  it('is idempotent — succeeds without touching storage, the row or the audit log when there was no logo to begin with', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      logoPath: null,
    })
    lockRow(db, { id: 1, logoPath: null })

    const result = await clinicsService.removeLogo(1, adminUser)

    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 1, logoUrl: null })
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist, without querying members', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.listMembers(999)).rejects.toThrow(
      NotFoundException,
    )
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
            where: jest.fn().mockResolvedValue([
              {
                id: 10,
                email: 'member@example.com',
                firstName: 'Mem',
                lastName: 'Ber',
              },
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
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
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      isActive: true,
    })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1, isActive: false }]),
      }),
    })
    db.update.mockReturnValue({ set })

    lockRow(db, { id: 1, isActive: true })

    const result = await clinicsService.deactivate(1, adminUser)

    expect(set).toHaveBeenCalledWith({ isActive: false })
    expect(result).toEqual({ id: 1, isActive: false, logoUrl: null })
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: adminUser.id,
      action: 'CLINIC_DEACTIVATED',
      entityType: 'clinics',
      entityId: 1,
      details: { changes: { isActive: { from: true, to: false } } },
    })
  })

  it('writes nothing for a clinic that is already deactivated', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, isActive: false })
    lockRow(db, { id: 1, isActive: false })

    await clinicsService.deactivate(1, adminUser)

    expect(db.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })

  // lockClinic() under row security: a row the UPDATE policy hides comes
  // back as nothing — answered like a missing clinic, nothing written.
  it('answers 404 when the locked read finds no row', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, isActive: true })
    lockRow(db, undefined)

    await expect(clinicsService.deactivate(1, adminUser)).rejects.toThrow(
      new NotFoundException('Clinic 1 not found'),
    )
    expect(db.update).not.toHaveBeenCalled()
  })
})

describe('ClinicsService.reactivate', () => {
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
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
  })

  it('throws NotFoundException when the clinic does not exist, without opening a transaction', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.reactivate(999, adminUser)).rejects.toThrow(
      NotFoundException,
    )
    expect(db.update).not.toHaveBeenCalled()
  })

  it('sets isActive back to true on the SAME row and returns the reactivated clinic', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      isActive: false,
    })
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 1, name: 'Acme Clinic', isActive: true }]),
      }),
    })
    db.update.mockReturnValue({ set })
    lockRow(db, { id: 1, name: 'Acme Clinic', isActive: false })

    const result = await clinicsService.reactivate(1, adminUser)

    expect(set).toHaveBeenCalledWith({ isActive: true })
    expect(result).toEqual({
      id: 1,
      name: 'Acme Clinic',
      isActive: true,
      logoUrl: null,
    })
  })

  it('audits the reactivation in its transaction, naming who did it and which clinic', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, isActive: false })
    db.update.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: jest.fn().mockResolvedValue([{ id: 1, isActive: true }]),
        }),
      }),
    })
    lockRow(db, { id: 1, isActive: false })

    await clinicsService.reactivate(1, { ...adminUser, id: 42 })

    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: 42,
      action: 'CLINIC_REACTIVATED',
      entityType: 'clinics',
      entityId: 1,
      details: { changes: { isActive: { from: false, to: true } } },
    })
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('writes nothing for a clinic that is already active', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, isActive: true })
    lockRow(db, { id: 1, isActive: true })

    await clinicsService.reactivate(1, adminUser)

    expect(db.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })
})

describe('ClinicsService.removeMember', () => {
  let clinicsService: ClinicsService
  let careTeam: ReturnType<typeof careTeamStub>
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
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
      ],
    }).compile()

    clinicsService = moduleRef.get(ClinicsService)
    careTeam = moduleRef.get(CareTeamService)
  })

  // The DELETE's chain: .where() → .returning({ id }) → the rows deleted
  // (one membership, or none when the person wasn't a member).
  function mockDelete(deleted: { id: number }[]) {
    const returning = jest.fn().mockResolvedValue(deleted)
    const where = jest.fn().mockReturnValue({ returning })
    db.delete.mockReturnValue({ where })
    return { where, returning }
  }

  it('throws NotFoundException when the clinic does not exist, without touching the delete', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined)

    await expect(clinicsService.removeMember(1, 10, adminUser)).rejects.toThrow(
      NotFoundException,
    )
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('deletes the membership row for the given clinic and user', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      isActive: true,
    })
    const { where } = mockDelete([{ id: 70 }])

    await clinicsService.removeMember(1, 10, adminUser)

    expect(db.delete).toHaveBeenCalled()
    expect(where).toHaveBeenCalled()
    // No link ended: ONE entry, the removal, about the member.
    expect(audit.logInTransaction.mock.calls).toStrictEqual([
      [
        db,
        {
          performedBy: adminUser.id,
          action: 'CLINIC_MEMBER_REMOVED',
          targetUserId: 10,
          entityType: 'user_clinics',
          entityId: 70,
          details: { clinicId: 1, endedCareTeamLinkIds: [] },
        },
      ],
    ])
  })

  // Same "currentUser is genuinely threaded through" check as addMember —
  // without this, a future userClinics RLS policy would silently see no
  // session context and block or misjudge the delete.
  it('sets the RLS session context from the given currentUser before deleting', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      isActive: true,
    })
    mockDelete([{ id: 70 }])

    await clinicsService.removeMember(1, 10, adminUser)

    const executeCalls = db.execute.mock.calls as unknown[][]
    expect(db.transaction).toHaveBeenCalled()
    expect(executeCalls).toHaveLength(2)
    expect(flattenSqlChunks(executeCalls[0][0])).toContain(
      'app.current_user_id',
    )
    expect(flattenSqlChunks(executeCalls[1][0])).toContain('app.current_role')
  })

  // Leaving a clinic ends the care-team links that no longer have a clinic
  // in common — in the SAME transaction as the membership delete (the same
  // tx object), after the delete (so the shared-clinic check sees the
  // membership gone). The trail (decided with the person 2026-10-21): the
  // removal about the member, then one CARE_TEAM_ENDED per link about ITS
  // patient — all through the same transaction.
  it('ends the care-team links left without a shared clinic, in the same transaction, and audits each for its patient', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      isActive: true,
    })
    const { where } = mockDelete([{ id: 70 }])
    const started = new Date('2031-01-05T09:00:00Z')
    const ended = new Date('2031-02-01T10:00:00Z')
    careTeam.endLinksWithoutSharedClinic.mockResolvedValue([
      {
        id: 31,
        patientId: 11,
        practitionerId: 4,
        startedAt: started,
        endsAt: ended,
      },
      {
        id: 32,
        patientId: 12,
        practitionerId: 4,
        startedAt: started,
        endsAt: ended,
      },
    ])

    await clinicsService.removeMember(1, 10, adminUser)

    // tx === db in this suite (see beforeEach).
    expect(careTeam.endLinksWithoutSharedClinic).toHaveBeenCalledWith(
      db,
      10,
      adminUser.id,
    )
    expect(where.mock.invocationCallOrder[0]).toBeLessThan(
      careTeam.endLinksWithoutSharedClinic.mock.invocationCallOrder[0],
    )
    const ending = (id: number, patientId: number) => [
      db,
      {
        performedBy: adminUser.id,
        action: 'CARE_TEAM_ENDED',
        targetUserId: patientId,
        entityType: 'care_team_members',
        entityId: id,
        details: {
          practitionerId: 4,
          startedAt: started,
          endsAt: ended,
          reason: 'No longer share a clinic',
          clinicId: 1,
        },
      },
    ]
    expect(audit.logInTransaction.mock.calls).toStrictEqual([
      [
        db,
        {
          performedBy: adminUser.id,
          action: 'CLINIC_MEMBER_REMOVED',
          targetUserId: 10,
          entityType: 'user_clinics',
          entityId: 70,
          details: { clinicId: 1, endedCareTeamLinkIds: [31, 32] },
        },
      ],
      ending(31, 11),
      ending(32, 12),
    ])
    expect(audit.log).not.toHaveBeenCalled()
  })

  // Not a member (nothing deleted) and no link to end: nothing changed,
  // nothing written.
  it('writes nothing when the person was not a member and no link had to end', async () => {
    db.query.clinics.findFirst.mockResolvedValue({
      id: 1,
      name: 'Acme Clinic',
      isActive: true,
    })
    mockDelete([])

    await clinicsService.removeMember(1, 10, adminUser)

    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })
})
