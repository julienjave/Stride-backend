import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { UsersService } from './users.service'
import { StorageService } from '../storage/storage.service'
import { AuditService } from '../audit/audit.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from './dto/create-user.dto'

// attachProfile() now unconditionally looks up clinic membership for
// every user it returns (a select().from(userClinics).innerJoin(clinics)
// .where(...) chain) — most tests in this file aren't ABOUT clinic
// membership at all, they just need this new query to resolve to
// something rather than throw "select/innerJoin is not a function" on a
// mock db/tx object that predates this feature. This is that shared,
// generic "resolves to no clinics" chain; tests specifically about
// clinic membership build their own explicit version instead.
function emptyClinicsSelect() {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  })
}

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
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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
        select: emptyClinicsSelect(),
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
        query: {
          clinics: { findFirst: jest.fn() },
          patientProfiles: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ userId: 10, dateOfBirth: '1990-01-01' }),
          },
        },
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
    // Regression coverage for the gap this fix closes: patientProfiles was
    // written inside this same insert, but never attached to create()'s own
    // response until attachProfile() started reading it back.
    expect(result.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })
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
        select: emptyClinicsSelect(),
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
          patientProfiles: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ userId: 12, dateOfBirth: '1990-01-01' }),
          },
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
        select: emptyClinicsSelect(),
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
          patientProfiles: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ userId: 13, dateOfBirth: '1990-01-01' }),
          },
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
      practitionerProfiles: { findFirst: jest.Mock }
    }
    select: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        users: { findFirst: jest.fn() },
        userRoles: { findFirst: jest.fn() },
        // findOne() (called first by grantRole, below) now attaches profile
        // fields via attachProfile() — every test in this block resolves
        // the requesting user's roles to ['practitioner'], so that's the
        // only profile table findOne()'s own attachProfile() call reaches.
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    }
    // findOne() (called first by grantRole) needs a real user, and
    // getRolesForUser() (called at the end, via this.db not tx) needs a
    // resolvable roles query — both are exercised on every test below.
    // attachProfile(), reached through findOne(), also now runs a clinic-
    // membership join through this same this.db.select — .from() needs
    // to support both .where() directly (roles) and .innerJoin().where()
    // (clinics, resolving to none — no test here is about clinics).
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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
  let db: {
    select: jest.Mock
    selectDistinct: jest.Mock
    query: {
      practitionerProfiles: { findMany: jest.Mock }
      patientProfiles: { findMany: jest.Mock }
      adminProfiles: { findMany: jest.Mock }
    }
  }

  beforeEach(async () => {
    db = {
      select: jest.fn(),
      selectDistinct: jest.fn(),
      // attachProfilesToMany() (called once the patient list itself is
      // built) batches one findMany() per profile table across every
      // returned user, instead of a query per row.
      query: {
        practitionerProfiles: { findMany: jest.fn().mockResolvedValue([]) },
        patientProfiles: { findMany: jest.fn().mockResolvedValue([]) },
        adminProfiles: { findMany: jest.fn().mockResolvedValue([]) },
      },
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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
    db.select
      // getClinicIdsForUser()'s query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ clinicId: 7 }]),
        }),
      })
      // attachProfilesToMany()'s batched userRoles query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockResolvedValue([{ userId: 20, role: UserRole.PATIENT }]),
        }),
      })
      // attachProfilesToMany()'s batched clinic-membership query — not
      // what this test is about, so it resolves to no memberships.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
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
    db.query.patientProfiles.findMany.mockResolvedValue([
      { userId: 20, dateOfBirth: '1990-01-01' },
    ])

    const result = await usersService.findPatientsForPractitioner(1)

    expect(result).toHaveLength(1)
    expect((result[0] as any).passwordHash).toBeUndefined()
    // Regression coverage for the gap this fix closes: this is the
    // practitioner-facing branch of GET /users, which previously attached
    // neither roles nor profile data at all.
    expect(result[0].roles).toEqual([UserRole.PATIENT])
    expect(result[0].patientProfile).toEqual({ dateOfBirth: '1990-01-01' })
  })

  // Dedicated coverage for attachProfilesToMany's clinic-grouping logic
  // specifically — the test above only ever has ONE user in the result,
  // so it can't catch a bug where two different users' clinic rows get
  // mixed together instead of grouped correctly by userId.
  it("groups each returned patient's OWN clinics separately, not mixed across patients", async () => {
    db.select
      // getClinicIdsForUser()'s query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ clinicId: 7 }]),
        }),
      })
      // attachProfilesToMany()'s batched userRoles query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { userId: 20, role: UserRole.PATIENT },
            { userId: 21, role: UserRole.PATIENT },
          ]),
        }),
      })
      // attachProfilesToMany()'s batched clinic-membership query — patient
      // 20 belongs to two clinics, patient 21 to only the shared one.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { userId: 20, id: 7, name: 'Shared Clinic' },
              { userId: 20, id: 1, name: 'Patient 20 Only Clinic' },
              { userId: 21, id: 7, name: 'Shared Clinic' },
            ]),
          }),
        }),
      })
    db.selectDistinct.mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { user: { id: 20, email: 'p20@example.com', passwordHash: 'x' } },
              { user: { id: 21, email: 'p21@example.com', passwordHash: 'x' } },
            ]),
          }),
        }),
      }),
    })
    db.query.patientProfiles.findMany.mockResolvedValue([
      { userId: 20, dateOfBirth: '1990-01-01' },
      { userId: 21, dateOfBirth: '1991-02-02' },
    ])

    const result = await usersService.findPatientsForPractitioner(1)

    const patient20 = result.find((p) => p.id === 20)!
    const patient21 = result.find((p) => p.id === 21)!
    expect(patient20.clinics).toEqual([
      { id: 7, name: 'Shared Clinic' },
      { id: 1, name: 'Patient 20 Only Clinic' },
    ])
    expect(patient21.clinics).toEqual([{ id: 7, name: 'Shared Clinic' }])
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
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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
  let db: {
    query: {
      users: { findFirst: jest.Mock }
      patientProfiles: { findFirst: jest.Mock }
    }
    select: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        users: { findFirst: jest.fn() },
        // getRolesForUser() below always resolves ['patient'] — attachProfile()
        // only ever reaches this one profile table in this describe block.
        patientProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
    }
    // getRolesForUser() (called at the end of findOne, via this.db) needs a
    // resolvable roles query for the success-path test below. attachProfile()
    // ALSO now runs a clinic-membership join through this same this.db.select
    // — .from() needs to support both: .where() directly (roles) and
    // .innerJoin().where() (clinics, resolving to none — no test here is
    // about clinic membership).
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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

  // Regression coverage for the actual gap this fix closes: patientProfiles
  // was written at account creation but never read back on GET /users/:id
  // (or anywhere else) — see attachProfile()'s comment in users.service.ts.
  it("attaches the held role's nested profile data, and omits profiles for roles the account doesn't hold", async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'patient@example.com',
      firstName: 'Test',
      lastName: 'Patient',
    })
    db.query.patientProfiles.findFirst.mockResolvedValue({
      userId: 1,
      dateOfBirth: '1990-01-01',
    })

    const result = await usersService.findOne(1)

    expect(result.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })
    expect(result).not.toHaveProperty('practitionerProfile')
    expect(result).not.toHaveProperty('adminProfile')
  })

  // The real behavior this feature is FOR — every other test in this file
  // only confirms the new query doesn't crash on empty data. This one
  // confirms a user belonging to more than one clinic actually gets both
  // back, with just id/name (not full clinic rows), through the real join.
  it('attaches every clinic the user belongs to, as {id, name} pairs', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'multi-clinic@example.com',
      firstName: 'Multi',
      lastName: 'Clinic',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 1, name: 'Acme Clinic' },
            { id: 2, name: 'Second Clinic' },
          ]),
        }),
      }),
    })

    const result = await usersService.findOne(1)

    expect(result.clinics).toEqual([
      { id: 1, name: 'Acme Clinic' },
      { id: 2, name: 'Second Clinic' },
    ])
  })
})

describe('UsersService.update', () => {
  let usersService: UsersService
  let db: {
    query: {
      users: { findFirst: jest.Mock }
      practitionerProfiles: { findFirst: jest.Mock }
      patientProfiles: { findFirst: jest.Mock }
      adminProfiles: { findFirst: jest.Mock }
    }
    select: jest.Mock
    transaction: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        users: { findFirst: jest.fn() },
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
        patientProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
        adminProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  // Field applicability is checked against the TARGET's real held roles, not
  // the caller's — an admin (who passes every controller-level auth check)
  // still can't set a field for a profile the target doesn't have. All three
  // rejected before ever opening the write transaction.
  it("rejects profile fields that don't apply to the target's actual held role(s)", async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'patient@example.com',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })

    await expect(
      usersService.update(
        1,
        { licenseNumber: 'PT-99' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(BadRequestException)
    await expect(
      usersService.update(
        1,
        { position: 'Office Manager' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(BadRequestException)
    // bio is gated the same way as licenseNumber/specialties — a
    // practitioner-profile field, rejected for a target with no
    // practitioner role at all.
    await expect(
      usersService.update(
        1,
        { bio: 'Should fail' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(BadRequestException)
    expect(db.transaction).not.toHaveBeenCalled()

    db.query.users.findFirst.mockResolvedValue({
      id: 2,
      email: 'prac@example.com',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })
    await expect(
      usersService.update(
        2,
        { dateOfBirth: '1990-01-01' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(BadRequestException)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('updates a plain users column together with practitionerProfiles fields in the same transaction', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'prac@example.com',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })

    const usersUpdateChain = {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 1,
              email: 'prac@example.com',
              firstName: 'Updated',
              lastName: 'Titioner',
              avatarPath: null,
              isActive: true,
            },
          ]),
        }),
      }),
    }
    const profileUpdateChain = {
      set: jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest
        .fn()
        .mockReturnValueOnce(usersUpdateChain)
        .mockReturnValueOnce(profileUpdateChain),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      query: {
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue({
            userId: 1,
            licenseNumber: 'PT-NEW',
            specialties: ['ortho'],
            bio: 'Updated bio.',
          }),
        },
      },
    }
    db.transaction.mockImplementation((cb: any) => cb(tx))

    const result = await usersService.update(
      1,
      {
        firstName: 'Updated',
        licenseNumber: 'PT-NEW',
        specialties: ['ortho'],
        bio: 'Updated bio.',
      },
      { id: 9, activeRole: UserRole.ADMIN },
    )

    expect(result.firstName).toBe('Updated')
    expect(result.practitionerProfile).toEqual({
      licenseNumber: 'PT-NEW',
      specialties: ['ortho'],
      bio: 'Updated bio.',
    })
    expect(profileUpdateChain.set).toHaveBeenCalledWith({
      licenseNumber: 'PT-NEW',
      specialties: ['ortho'],
      bio: 'Updated bio.',
    })
  })

  // No `users`-table field in the dto at all — update() must skip the
  // `users` UPDATE entirely (an empty .set({}) would error) and read the
  // current row back through the still-open transaction instead, so the
  // response still reflects the just-written patientProfiles row.
  it('updates only patientProfiles when the dto carries no plain users field', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 3,
      email: 'patient@example.com',
    })
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })

    const profileUpdateChain = {
      set: jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnValue(profileUpdateChain),
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: 3,
            email: 'patient@example.com',
            firstName: 'Patient',
            lastName: 'Three',
            avatarPath: null,
            isActive: true,
          }),
        },
        patientProfiles: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ userId: 3, dateOfBirth: '1985-05-05' }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }
    db.transaction.mockImplementation((cb: any) => cb(tx))

    const result = await usersService.update(
      3,
      { dateOfBirth: '1985-05-05' },
      { id: 3, activeRole: UserRole.PATIENT },
    )

    expect(tx.query.users.findFirst).toHaveBeenCalled()
    expect(result.patientProfile).toEqual({ dateOfBirth: '1985-05-05' })
    expect(profileUpdateChain.set).toHaveBeenCalledWith({
      dateOfBirth: '1985-05-05',
    })
  })
})

describe('UsersService.reactivate', () => {
  let usersService: UsersService
  let db: {
    query: {
      users: { findFirst: jest.Mock }
      practitionerProfiles: { findFirst: jest.Mock }
      patientProfiles: { findFirst: jest.Mock }
      adminProfiles: { findFirst: jest.Mock }
    }
    select: jest.Mock
    transaction: jest.Mock
  }
  let auditService: { log: jest.Mock }

  beforeEach(async () => {
    db = {
      query: {
        users: { findFirst: jest.fn() },
        practitionerProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
        patientProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
        adminProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    }
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ role: UserRole.PATIENT }]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('throws NotFoundException for a nonexistent id, without opening a transaction', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)

    await expect(
      usersService.reactivate(999, { id: 1, activeRole: UserRole.ADMIN }),
    ).rejects.toThrow(NotFoundException)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('sets isActive back to true on the SAME row and returns the reactivated user', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, isActive: false })

    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([
          {
            id: 5,
            email: 'returning-patient@example.com',
            isActive: true,
          },
        ]),
      }),
    })
    db.transaction.mockImplementation((cb) =>
      cb({ execute: jest.fn().mockResolvedValue(undefined), update: () => ({ set }) }),
    )

    const result = await usersService.reactivate(5, {
      id: 1,
      activeRole: UserRole.ADMIN,
    })

    expect(set).toHaveBeenCalledWith({ isActive: true })
    expect(result).toEqual({
      id: 5,
      email: 'returning-patient@example.com',
      isActive: true,
      roles: [UserRole.PATIENT],
      clinics: [],
    })
  })

  it('audit-logs the reactivation, naming who performed it and which account was affected', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, isActive: false })
    db.transaction.mockImplementation((cb) =>
      cb({
        execute: jest.fn().mockResolvedValue(undefined),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: jest.fn().mockResolvedValue([{ id: 5, isActive: true }]),
            }),
          }),
        }),
      }),
    )

    await usersService.reactivate(5, { id: 42, activeRole: UserRole.ADMIN })

    expect(auditService.log).toHaveBeenCalledWith({
      performedBy: 42,
      action: 'USER_REACTIVATED',
      entityType: 'users',
      entityId: 5,
    })
  })
})

describe('UsersService.findAll', () => {
  let usersService: UsersService
  let db: {
    query: {
      users: { findMany: jest.Mock }
      practitionerProfiles: { findMany: jest.Mock }
      patientProfiles: { findMany: jest.Mock }
      adminProfiles: { findMany: jest.Mock }
    }
    select: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        users: { findMany: jest.fn() },
        practitionerProfiles: { findMany: jest.fn().mockResolvedValue([]) },
        patientProfiles: { findMany: jest.fn().mockResolvedValue([]) },
        adminProfiles: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn(),
    }
    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
      })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('filters to active users only when includeInactive is omitted', async () => {
    db.query.users.findMany.mockResolvedValue([])

    await usersService.findAll()

    const { where } = db.query.users.findMany.mock.calls[0][0]
    expect(where).not.toBeUndefined()
  })

  it('passes no filter at all when includeInactive is true', async () => {
    db.query.users.findMany.mockResolvedValue([])

    await usersService.findAll(true)

    expect(db.query.users.findMany).toHaveBeenCalledWith({ where: undefined })
  })
})