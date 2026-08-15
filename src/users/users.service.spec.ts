import { Test } from '@nestjs/testing'
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { UsersService } from './users.service'
import { StorageService } from '../storage/storage.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from './dto/create-user.dto'

describe('UsersService.create', () => {
  let usersService: UsersService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
    select: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      transaction: jest.fn(),
      select: jest.fn(),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('refuses a practitioner creating anything other than a patient account', async () => {
    await expect(
      usersService.create(
        {
          email: 'new-practitioner@example.com',
          password: 'password123',
          role: UserRole.PRACTITIONER,
          firstName: 'New',
          lastName: 'Practitioner',
          licenseNumber: 'PT-1',
        },
        { id: 7, activeRole: UserRole.PRACTITIONER },
      ),
    ).rejects.toThrow(ForbiddenException)

    // The check runs before any lookup — a rejected request should never
    // touch the database at all.
    expect(db.query.users.findFirst).not.toHaveBeenCalled()
  })

  it('allows a practitioner to create a patient account', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    db.transaction.mockImplementation((cb: any) =>
      cb({
        // withRlsContext() sets two session GUCs via tx.execute() before
        // invoking the callback, since requestingUser is defined here.
        execute: jest.fn().mockResolvedValue(undefined),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              {
                id: 10,
                email: 'patient@example.com',
                passwordHash: 'hashed',
                firstName: 'New',
                lastName: 'Patient',
                avatarPath: null,
                isActive: true,
              },
            ]),
          }),
        }),
        query: { clinics: { findFirst: jest.fn() } },
      }),
    )

    const result = await usersService.create(
      {
        email: 'patient@example.com',
        password: 'password123',
        role: UserRole.PATIENT,
        firstName: 'New',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
      },
      { id: 7, activeRole: UserRole.PRACTITIONER },
    )

    expect(result.roles).toEqual([UserRole.PATIENT])
    expect((result as any).passwordHash).toBeUndefined()
  })

  it('rejects an email that already belongs to another account', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'taken@example.com',
    })

    await expect(
      usersService.create({
        email: 'taken@example.com',
        password: 'password123',
        role: UserRole.ADMIN,
        firstName: 'Dup',
        lastName: 'Licate',
      }),
    ).rejects.toThrow(ConflictException)
  })

  it('rejects a clinicId that does not correspond to any real clinic', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    db.transaction.mockImplementation((cb: any) =>
      cb({
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              {
                id: 11,
                email: 'admin@example.com',
                passwordHash: 'hashed',
                firstName: 'New',
                lastName: 'Admin',
                avatarPath: null,
                isActive: true,
              },
            ]),
          }),
        }),
        query: {
          clinics: { findFirst: jest.fn().mockResolvedValue(undefined) },
        },
      }),
    )

    await expect(
      usersService.create({
        email: 'admin@example.com',
        password: 'password123',
        role: UserRole.ADMIN,
        firstName: 'New',
        lastName: 'Admin',
        clinicId: 999,
      }),
    ).rejects.toThrow(NotFoundException)
  })

  // Security-fix regression coverage: dto.clinicId used to only be checked
  // for existing as a real clinic, never as one the REQUESTING practitioner
  // actually belongs to — see the comment on the check itself in
  // users.service.ts.
  it("rejects a practitioner creating a patient in a clinic they don't belong to", async () => {
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ clinicId: 5 }]),
      }),
    })

    await expect(
      usersService.create(
        {
          email: 'other-clinic-patient@example.com',
          password: 'password123',
          role: UserRole.PATIENT,
          firstName: 'New',
          lastName: 'Patient',
          dateOfBirth: '1990-01-01',
          clinicId: 6,
        },
        { id: 7, activeRole: UserRole.PRACTITIONER },
      ),
    ).rejects.toThrow(ForbiddenException)

    // Rejected before ever checking for a duplicate email.
    expect(db.query.users.findFirst).not.toHaveBeenCalled()
  })

  it('allows a practitioner to create a patient in a clinic they belong to', async () => {
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ clinicId: 6 }]),
      }),
    })
    db.query.users.findFirst.mockResolvedValue(undefined)
    db.transaction.mockImplementation((cb: any) =>
      cb({
        // withRlsContext() sets two session GUCs via tx.execute() before
        // invoking the callback, since requestingUser is defined here.
        execute: jest.fn().mockResolvedValue(undefined),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              {
                id: 12,
                email: 'own-clinic-patient@example.com',
                passwordHash: 'hashed',
                firstName: 'New',
                lastName: 'Patient',
                avatarPath: null,
                isActive: true,
              },
            ]),
          }),
        }),
        query: {
          clinics: { findFirst: jest.fn().mockResolvedValue({ id: 6 }) },
        },
      }),
    )

    const result = await usersService.create(
      {
        email: 'own-clinic-patient@example.com',
        password: 'password123',
        role: UserRole.PATIENT,
        firstName: 'New',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
        clinicId: 6,
      },
      { id: 7, activeRole: UserRole.PRACTITIONER },
    )

    expect(result.roles).toEqual([UserRole.PATIENT])
  })

  it('does not apply the clinic-ownership check to an admin', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    db.transaction.mockImplementation((cb: any) =>
      cb({
        // withRlsContext() sets two session GUCs via tx.execute() before
        // invoking the callback, since requestingUser is defined here.
        execute: jest.fn().mockResolvedValue(undefined),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              {
                id: 13,
                email: 'admin-created-patient@example.com',
                passwordHash: 'hashed',
                firstName: 'New',
                lastName: 'Patient',
                avatarPath: null,
                isActive: true,
              },
            ]),
          }),
        }),
        query: {
          clinics: { findFirst: jest.fn().mockResolvedValue({ id: 999 }) },
        },
      }),
    )

    const result = await usersService.create(
      {
        email: 'admin-created-patient@example.com',
        password: 'password123',
        role: UserRole.PATIENT,
        firstName: 'New',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
        clinicId: 999,
      },
      { id: 1, activeRole: UserRole.ADMIN },
    )

    expect(result.roles).toEqual([UserRole.PATIENT])
    // Admin never triggers getClinicIdsForUser's db.select lookup at all.
    expect(db.select).not.toHaveBeenCalled()
  })
})

describe('UsersService.grantRole', () => {
  let usersService: UsersService
  let db: {
    query: {
      users: { findFirst: jest.Mock }
      userRoles: { findFirst: jest.Mock }
    }
    select: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        users: { findFirst: jest.fn() },
        userRoles: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    }
    // findOne() (called first by grantRole) needs a real user, and
    // getRolesForUser() (called at the end, via this.db not tx) needs a
    // resolvable roles query — both are exercised on every test below.
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
      }),
    })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('refuses to grant a role the user already holds', async () => {
    db.query.userRoles.findFirst.mockResolvedValue({
      id: 5,
      userId: 1,
      role: UserRole.PRACTITIONER,
    })

    await expect(
      usersService.grantRole(
        1,
        { role: UserRole.PRACTITIONER, licenseNumber: 'PT-2' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(ConflictException)
  })

  it('grants a new role and creates its profile when none exists yet', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    const insert = jest
      .fn()
      .mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) })
    const tx = {
      // withRlsContext() sets two session GUCs via tx.execute() before
      // invoking the callback, since the granting admin's session is real.
      execute: jest.fn().mockResolvedValue(undefined),
      insert,
      // getRolesForUser(userId, tx) is called through tx, not this.db, so
      // the just-inserted role is read back through the same still-open
      // transaction rather than a separate connection that can't see it
      // yet — see the comment on getRolesForUser itself.
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
        }),
      }),
      query: {
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    }
    db.transaction.mockImplementation((cb: any) => cb(tx))

    await usersService.grantRole(
      1,
      { role: UserRole.PRACTITIONER, licenseNumber: 'PT-2' },
      { id: 9, activeRole: UserRole.ADMIN },
    )

    // userRoles insert + practitionerProfiles insert, since none existed yet.
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('grants a new role without duplicating an already-existing profile', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    const insert = jest
      .fn()
      .mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) })
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      insert,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
        }),
      }),
      query: {
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue({ userId: 1 }),
        },
      },
    }
    db.transaction.mockImplementation((cb: any) => cb(tx))

    await usersService.grantRole(
      1,
      { role: UserRole.PRACTITIONER, licenseNumber: 'PT-2' },
      { id: 9, activeRole: UserRole.ADMIN },
    )

    // Only the userRoles insert — the existing profile must not be re-inserted.
    expect(insert).toHaveBeenCalledTimes(1)
  })
})

describe('UsersService.findPatientsForPractitioner', () => {
  let usersService: UsersService
  let db: { select: jest.Mock; selectDistinct: jest.Mock }

  beforeEach(async () => {
    db = { select: jest.fn(), selectDistinct: jest.fn() }

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('returns an empty list without querying further when the practitioner belongs to no clinic', async () => {
    db.select.mockReturnValue({
      from: jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    })

    const result = await usersService.findPatientsForPractitioner(1)

    expect(result).toEqual([])
    expect(db.selectDistinct).not.toHaveBeenCalled()
  })

  it("returns patients sharing at least one of the practitioner's clinics", async () => {
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ clinicId: 7 }]),
      }),
    })
    db.selectDistinct.mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                user: {
                  id: 20,
                  email: 'patient@example.com',
                  passwordHash: 'hashed',
                },
              },
            ]),
          }),
        }),
      }),
    })

    const result = await usersService.findPatientsForPractitioner(1)

    expect(result).toHaveLength(1)
    expect((result[0] as any).passwordHash).toBeUndefined()
  })
})

describe('UsersService.isPatientManagedBy', () => {
  let usersService: UsersService
  let db: { select: jest.Mock }

  beforeEach(async () => {
    db = { select: jest.fn() }

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('returns false when the practitioner belongs to no clinic at all', async () => {
    db.select.mockReturnValue({
      from: jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    })

    const result = await usersService.isPatientManagedBy(20, 1)
    expect(result).toBe(false)
  })

  it('returns true when the patient shares a clinic with the practitioner', async () => {
    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ clinicId: 7 }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      })

    const result = await usersService.isPatientManagedBy(20, 1)
    expect(result).toBe(true)
  })

  it('returns false when the patient does not belong to any shared clinic', async () => {
    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ clinicId: 7 }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      })

    const result = await usersService.isPatientManagedBy(20, 1)
    expect(result).toBe(false)
  })
})

describe('UsersService.findOne', () => {
  let usersService: UsersService
  let db: { query: { users: { findFirst: jest.Mock } }; select: jest.Mock }

  beforeEach(async () => {
    db = { query: { users: { findFirst: jest.fn() } }, select: jest.fn() }
    // getRolesForUser() (called at the end of findOne, via this.db) needs a
    // resolvable roles query for the success-path test below.
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
      }),
    })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('throws NotFoundException when the user does not exist', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)

    await expect(usersService.findOne(999)).rejects.toThrow(NotFoundException)
  })

  // Regression coverage for the toPublic() leak: findOne() is what
  // SessionSerializer.deserializeUser() calls to build req.user on every
  // authenticated request, so anything it fails to strip here reaches
  // GET /auth/me, POST /auth/mfa/verify, and POST /auth/switch-role.
  it('strips passwordHash, mfaSecret, and password-reset token fields from the returned user', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
      firstName: 'Test',
      lastName: 'User',
      passwordHash: 'bcrypt-hash',
      mfaSecret: 'iv:authTag:ciphertext',
      mfaEnabled: true,
      passwordResetTokenHash: 'reset-hash',
      passwordResetTokenExpiresAt: new Date(),
    })

    const result = await usersService.findOne(1)

    expect(result).not.toHaveProperty('passwordHash')
    expect(result).not.toHaveProperty('mfaSecret')
    expect(result).not.toHaveProperty('passwordResetTokenHash')
    expect(result).not.toHaveProperty('passwordResetTokenExpiresAt')
    expect(result.email).toBe('user@example.com')
  })
})
