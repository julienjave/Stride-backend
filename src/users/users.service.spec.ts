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
import { CareTeamService } from '../care-team/care-team.service'
import { InvitationsService } from '../invitations/invitations.service'

// CareTeamService is where the care-team rule lives (and has its own spec).
// Here it's a stub: these tests are about what THIS service does with the
// answers — each test that cares sets them through moduleRef.get(...).
// create() hands every new account to InvitationsService: its first
// invitation inside the transaction, the email after it.
const INVITATION_EXPIRES_AT = new Date('2026-10-14T10:00:00Z')
function invitationsStub() {
  return {
    insertInvitation: jest.fn().mockResolvedValue({
      invitation: { id: 500, expiresAt: INVITATION_EXPIRES_AT },
      token: 'raw-token',
    }),
    deliver: jest.fn().mockResolvedValue(true),
  }
}

function careTeamStub() {
  return {
    isOnCareTeam: jest.fn().mockResolvedValue(false),
    findPatientIdsForPractitioner: jest.fn().mockResolvedValue([]),
    linkCreator: jest.fn().mockResolvedValue({ id: 900 }),
    endLinksWithoutSharedClinic: jest.fn().mockResolvedValue([]),
  }
}
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from './dto/create-user.dto'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  PG_UNIQUE_VIOLATION,
  PRACTITIONER_LICENSE_NUMBER_UNIQUE,
} from '../database/pg-errors'

// What a duplicate licenseNumber really looks like by the time it reaches
// UsersService: node-postgres's error (code 23505 + the constraint's name),
// wrapped by drizzle in a DrizzleQueryError. Built with drizzle's real
// error class rather than a hand-made look-alike, so these tests exercise
// the same shape production code sees.
function duplicateLicenseError() {
  return new DrizzleQueryError(
    'insert into "practitioner_profiles" ...',
    [],
    Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: PG_UNIQUE_VIOLATION,
      constraint: PRACTITIONER_LICENSE_NUMBER_UNIQUE,
    }),
  )
}

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

// toPublic() now presigns avatarPath on every user it returns, so every
// describe block needs a StorageService with a callable
// getPresignedUrlOrNull — an empty {} would throw "is not a function".
// Resolving null is the "this user has no photo" answer, which is what
// most tests' fixtures are (avatarPath: null or absent); tests that are
// ABOUT avatars build their own storage mock with real-looking URLs.
function storageStub() {
  return { getPresignedUrlOrNull: jest.fn().mockResolvedValue(null) }
}

describe('UsersService.create', () => {
  let usersService: UsersService
  let careTeam: ReturnType<typeof careTeamStub>
  let invitations: ReturnType<typeof invitationsStub>
  let auditLog: jest.Mock
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
    careTeam = moduleRef.get(CareTeamService)
    auditLog = moduleRef.get<{ log: jest.Mock }>(AuditService).log
    invitations = moduleRef.get(InvitationsService)
  })

  it('refuses a practitioner creating anything other than a patient account', async () => {
    await expect(
      usersService.create(
        {
          email: 'new-practitioner@example.com',
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

  // Since the care team: a practitioner-created patient must belong to a
  // clinic, or nobody (the creator included) could ever reach them.
  it('refuses a practitioner creating a patient without a clinic', async () => {
    await expect(
      usersService.create(
        {
          email: 'patient@example.com',
          role: UserRole.PATIENT,
          firstName: 'New',
          lastName: 'Patient',
          dateOfBirth: '1990-01-01',
        },
        { id: 7, activeRole: UserRole.PRACTITIONER },
      ),
    ).rejects.toThrow(BadRequestException)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('lets a practitioner create a patient in their clinic, and puts them on the care team', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    // getClinicIdsForUser(): the practitioner belongs to clinic 3.
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ clinicId: 3 }]),
      }),
    })
    const tx = {
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
        clinics: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
        patientProfiles: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ userId: 10, dateOfBirth: '1990-01-01' }),
        },
      },
    }
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) =>
      cb(tx),
    )

    const result = await usersService.create(
      {
        email: 'patient@example.com',
        role: UserRole.PATIENT,
        firstName: 'New',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
        clinicId: 3,
      },
      { id: 7, activeRole: UserRole.PRACTITIONER },
    )

    expect(result.roles).toEqual([UserRole.PATIENT])
    expect((result as any).passwordHash).toBeUndefined()
    // Regression coverage for the gap this fix closes: patientProfiles was
    // written inside this same insert, but never attached to create()'s own
    // response until attachProfile() started reading it back.
    expect(result.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    // The creator joins the care team INSIDE the same transaction (same tx
    // object), so the patient and the link exist together or not at all…
    expect(careTeam.linkCreator).toHaveBeenCalledWith(tx, 10, 7)
    // …and it's audited, after the transaction.
    expect(auditLog).toHaveBeenCalledWith({
      performedBy: 7,
      action: 'CARE_TEAM_JOINED',
      targetUserId: 10,
      entityType: 'care_team_members',
      entityId: 900,
      details: { practitionerId: 7, reason: 'Created the patient' },
    })
    expect(auditLog.mock.invocationCallOrder[0]).toBeGreaterThan(
      careTeam.linkCreator.mock.invocationCallOrder[0],
    )

    // Invitations: no password is ever written — the users INSERT carries
    // no passwordHash at all…
    // A mock's recorded arguments are typed `any`; destructuring the first
    // call as a one-object tuple gives the inserted values a real type.
    const insertValues = tx.insert.mock.results[0].value as {
      values: jest.Mock
    }
    const [usersRow] = insertValues.values.mock.calls[0] as [
      Record<string, unknown>,
    ]
    expect(usersRow).not.toHaveProperty('passwordHash')
    // …the first invitation is created in the SAME transaction, by the
    // creator, and AFTER the care-team link (the invitations insert policy
    // only lets a practitioner invite a patient whose care team they're on)…
    expect(invitations.insertInvitation).toHaveBeenCalledWith(tx, 10, 7)
    expect(
      invitations.insertInvitation.mock.invocationCallOrder[0],
    ).toBeGreaterThan(careTeam.linkCreator.mock.invocationCallOrder[0])
    // …emailed after the transaction, with the raw token, as the creator…
    expect(invitations.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, email: 'patient@example.com' }),
      'raw-token',
      { id: 7, activeRole: UserRole.PRACTITIONER },
    )
    expect(auditLog).toHaveBeenCalledWith({
      performedBy: 7,
      action: 'INVITATION_SENT',
      targetUserId: 10,
      entityType: 'invitations',
      entityId: 500,
      details: { emailSent: true },
    })
    // …and reported in the response.
    expect(result.invitation).toEqual({
      id: 500,
      status: 'pending',
      expiresAt: INVITATION_EXPIRES_AT,
      emailSent: true,
    })
  })

  // The account and its invitation exist once the transaction commits; a
  // failed email is reported, never turned into a failed creation.
  it('still creates the account when the invitation email fails, and says so', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    invitations.deliver.mockResolvedValue(false)
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: emptyClinicsSelect(),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: 12, email: 'staff@example.com' }]),
        }),
      }),
      query: {
        clinics: { findFirst: jest.fn() },
        adminProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    }
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx))

    const result = await usersService.create(
      {
        email: 'staff@example.com',
        role: UserRole.ADMIN,
        firstName: 'New',
        lastName: 'Admin',
      },
      { id: 1, activeRole: UserRole.ADMIN },
    )

    expect(result.invitation.emailSent).toBe(false)
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INVITATION_SENT',
        details: { emailSent: false },
      }),
    )
  })

  it('does not put an ADMIN who creates a patient on the care team', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: emptyClinicsSelect(),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { id: 10, email: 'p@example.com', passwordHash: 'x' },
          ]),
        }),
      }),
      query: {
        clinics: { findFirst: jest.fn() },
        patientProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    }
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) =>
      cb(tx),
    )

    await usersService.create(
      {
        email: 'p@example.com',
        role: UserRole.PATIENT,
        firstName: 'New',
        lastName: 'Patient',
        dateOfBirth: '1990-01-01',
      },
      { id: 1, activeRole: UserRole.ADMIN },
    )

    expect(careTeam.linkCreator).not.toHaveBeenCalled()
    // Audit entries ARE written now (INVITATION_SENT, for every new
    // account) — just never a care-team join for an admin.
    expect(auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CARE_TEAM_JOINED' }),
    )
  })

  it('rejects an email that already belongs to another account', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'taken@example.com',
    })

    await expect(
      usersService.create(
        {
          email: 'taken@example.com',
          role: UserRole.ADMIN,
          firstName: 'Dup',
          lastName: 'Licate',
        },
        { id: 1, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(ConflictException)
  })

  // licenseNumber is UNIQUE in the database. Before this fix, a duplicate
  // reached Postgres and came back as an unhandled 500.
  it('turns a duplicate licenseNumber into a 409 ConflictException, not a 500', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    // withRlsContext opens the transaction; failing it is the simplest way
    // to make "the INSERT hit the unique constraint" happen in a unit test.
    db.transaction.mockRejectedValue(duplicateLicenseError())

    await expect(
      usersService.create(
        {
          email: 'second-practitioner@example.com',
          role: UserRole.PRACTITIONER,
          firstName: 'Second',
          lastName: 'Practitioner',
          licenseNumber: 'PT-TAKEN',
        },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(ConflictException)
    // Nothing was created, so nothing may be emailed: the email only goes
    // out after a successful commit.
    expect(invitations.deliver).not.toHaveBeenCalled()
  })

  it('rejects a clinicId that does not correspond to any real clinic', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    db.transaction.mockImplementation((cb: any) =>
      cb({
        // withRlsContext() sets the creator's session context first.
        execute: jest.fn().mockResolvedValue(undefined),
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
      usersService.create(
        {
          email: 'admin@example.com',
          role: UserRole.ADMIN,
          firstName: 'New',
          lastName: 'Admin',
          clinicId: 999,
        },
        { id: 1, activeRole: UserRole.ADMIN },
      ),
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
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

  it('turns a duplicate licenseNumber on the new practitioner profile into a 409', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    db.transaction.mockRejectedValue(duplicateLicenseError())

    await expect(
      usersService.grantRole(
        1,
        { role: UserRole.PRACTITIONER, licenseNumber: 'PT-TAKEN' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(ConflictException)
  })
})

describe('UsersService.findPatientsForPractitioner', () => {
  let usersService: UsersService
  let careTeam: ReturnType<typeof careTeamStub>
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
    careTeam = moduleRef.get(CareTeamService)
  })

  // Mocks the users query and the two batched queries attachProfilesToMany()
  // runs after it (roles, clinics), for the given patients.
  function mockPatientRows(
    patients: { id: number; email: string }[],
    clinicRows: { userId: number; id: number; name: string }[] = [],
  ) {
    db.selectDistinct.mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(
            patients.map((p) => ({ user: { ...p, passwordHash: 'x' } })),
          ),
        }),
      }),
    })
    db.select
      // attachProfilesToMany()'s batched userRoles query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(
            patients.map((p) => ({ userId: p.id, role: UserRole.PATIENT })),
          ),
        }),
      })
      // attachProfilesToMany()'s batched clinic-membership query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(clinicRows),
          }),
        }),
      })
  }

  it('returns an empty list without querying users when the practitioner is on no care team', async () => {
    careTeam.findPatientIdsForPractitioner.mockResolvedValue([])

    const result = await usersService.findPatientsForPractitioner(1)

    expect(result).toEqual([])
    expect(careTeam.findPatientIdsForPractitioner).toHaveBeenCalledWith(1)
    expect(db.selectDistinct).not.toHaveBeenCalled()
  })

  it("returns the patients of the practitioner's care teams, stripped and with their profile", async () => {
    careTeam.findPatientIdsForPractitioner.mockResolvedValue([20])
    mockPatientRows([{ id: 20, email: 'patient@example.com' }])
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
  // specifically — with only ONE user in the result, a bug mixing two
  // users' clinic rows together couldn't show.
  it("groups each returned patient's OWN clinics separately, not mixed across patients", async () => {
    careTeam.findPatientIdsForPractitioner.mockResolvedValue([20, 21])
    mockPatientRows(
      [
        { id: 20, email: 'p20@example.com' },
        { id: 21, email: 'p21@example.com' },
      ],
      [
        { userId: 20, id: 7, name: 'Shared Clinic' },
        { userId: 20, id: 1, name: 'Patient 20 Only Clinic' },
        { userId: 21, id: 7, name: 'Shared Clinic' },
      ],
    )

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
  let careTeam: ReturnType<typeof careTeamStub>

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: {} },
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
    careTeam = moduleRef.get(CareTeamService)
  })

  // The rule itself is CareTeamService's (and the e2e parity test's); what
  // matters here is that the arguments aren't swapped on the way through —
  // isPatientManagedBy takes (patient, practitioner), isOnCareTeam takes
  // (practitioner, patient).
  it.each([true, false])(
    'answers with the care-team check (%s), practitioner first',
    async (answer) => {
      careTeam.isOnCareTeam.mockResolvedValue(answer)

      await expect(usersService.isPatientManagedBy(20, 1)).resolves.toBe(answer)
      expect(careTeam.isOnCareTeam).toHaveBeenCalledWith(1, 20)
    },
  )
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
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

  // --- licenseNumber is admin-only (design decisions §4) ---

  // Shared by the tests below: the target (id 1) is a practitioner, and
  // findOne() resolves them before any rule is checked.
  function mockPractitionerTarget() {
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
  }

  // A transaction whose only write is the practitioner_profiles UPDATE.
  // `profileWhere` is what that UPDATE's final .where() returns, so a test
  // can make the write succeed or fail.
  function mockProfileOnlyTransaction(profileWhere: jest.Mock) {
    const profileUpdateChain = {
      set: jest.fn().mockReturnValue({ where: profileWhere }),
    }
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnValue(profileUpdateChain),
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            email: 'prac@example.com',
            firstName: 'Prac',
            lastName: 'Titioner',
            avatarPath: null,
            isActive: true,
          }),
        },
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue({
            userId: 1,
            licenseNumber: 'PT-1',
            specialties: ['ortho'],
            bio: 'Bio.',
          }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ role: UserRole.PRACTITIONER }]),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }
    // Typed callback (not `cb: any`, the older pattern above): calling an
    // `any` is exactly what the no-unsafe-call lint rule flags.
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx))
    return profileUpdateChain
  }

  it('refuses a practitioner changing their OWN licenseNumber — 403, before any write', async () => {
    mockPractitionerTarget()

    await expect(
      usersService.update(
        1,
        // Sent alongside a field they ARE allowed to change: the whole
        // request must be refused, so specialties isn't half-applied.
        { licenseNumber: 'PT-SELF', specialties: ['ortho'] },
        { id: 1, activeRole: UserRole.PRACTITIONER },
      ),
    ).rejects.toThrow(
      new ForbiddenException('Only an admin can change a license number'),
    )
    expect(db.transaction).not.toHaveBeenCalled()
  })

  // Multi-role accounts: it's the ACTIVE role that counts. The same person
  // (id 1, holding practitioner + admin) is refused while acting as a
  // practitioner, and allowed once switched to admin.
  it('allows the same license change once the caller is ACTING as admin', async () => {
    mockPractitionerTarget()
    const profileUpdateChain = mockProfileOnlyTransaction(
      jest.fn().mockResolvedValue(undefined),
    )

    await usersService.update(
      1,
      { licenseNumber: 'PT-NEW' },
      { id: 1, activeRole: UserRole.ADMIN },
    )

    // What actually reached the UPDATE — exactly the license, nothing else.
    expect(profileUpdateChain.set).toHaveBeenCalledWith({
      licenseNumber: 'PT-NEW',
    })
  })

  it('still lets a practitioner change their own specialties and bio', async () => {
    mockPractitionerTarget()
    const profileUpdateChain = mockProfileOnlyTransaction(
      jest.fn().mockResolvedValue(undefined),
    )

    await usersService.update(
      1,
      { specialties: ['ortho', 'sports'], bio: 'New bio.' },
      { id: 1, activeRole: UserRole.PRACTITIONER },
    )

    expect(profileUpdateChain.set).toHaveBeenCalledWith({
      specialties: ['ortho', 'sports'],
      bio: 'New bio.',
    })
  })

  it('turns a duplicate licenseNumber into a 409 ConflictException, not a 500', async () => {
    mockPractitionerTarget()
    mockProfileOnlyTransaction(
      jest.fn().mockRejectedValue(duplicateLicenseError()),
    )

    await expect(
      usersService.update(
        1,
        { licenseNumber: 'PT-TAKEN' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(
      new ConflictException(
        'This license number is already registered to another practitioner',
      ),
    )
  })

  // The translation must be narrow: any OTHER failure keeps its own
  // identity, so a real bug still surfaces as the error it really is.
  it('rethrows any other database error unchanged', async () => {
    mockPractitionerTarget()
    const otherError = new Error('connection terminated')
    mockProfileOnlyTransaction(jest.fn().mockRejectedValue(otherError))

    await expect(
      usersService.update(
        1,
        { bio: 'Anything' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toBe(otherError)
  })

  // --- preferredWeightUnit is self-only ---

  // A transaction whose only write is the `users` UPDATE — the preference
  // is a plain users column. Returns that UPDATE's chain so a test can
  // check exactly what reached .set().
  function mockUsersOnlyTransaction() {
    const usersUpdateChain = {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 1,
              email: 'prac@example.com',
              firstName: 'Prac',
              lastName: 'Titioner',
              preferredWeightUnit: 'lbs',
            },
          ]),
        }),
      }),
    }
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnValue(usersUpdateChain),
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
            licenseNumber: 'PT-1',
            specialties: [],
            bio: null,
          }),
        },
      },
    }
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx))
    return usersUpdateChain
  }

  // Two callers who DO pass the controller's "may edit this profile"
  // check for user 1 — an admin, and (for a patient target) a managing
  // practitioner — and are still refused this one field. The rule is
  // about WHO the target is, not what role the caller holds.
  it.each([
    ['an admin', UserRole.ADMIN],
    ['another practitioner', UserRole.PRACTITIONER],
  ])(
    "refuses %s changing someone else's weight unit — 403, before any write",
    async (_who, activeRole) => {
      mockPractitionerTarget()

      await expect(
        usersService.update(
          1,
          { preferredWeightUnit: 'lbs' },
          { id: 9, activeRole },
        ),
      ).rejects.toThrow(
        new ForbiddenException(
          'Only the user themselves can change their weight unit preference',
        ),
      )
      expect(db.transaction).not.toHaveBeenCalled()
    },
  )

  it('lets a user change their own weight unit, written to the users row', async () => {
    mockPractitionerTarget()
    const usersUpdateChain = mockUsersOnlyTransaction()

    const result = await usersService.update(
      1,
      { preferredWeightUnit: 'lbs' },
      { id: 1, activeRole: UserRole.PRACTITIONER },
    )

    expect(usersUpdateChain.set).toHaveBeenCalledWith({
      preferredWeightUnit: 'lbs',
    })
    expect(result.preferredWeightUnit).toBe('lbs')
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: auditService },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
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
      // Always present on a returned user — null when there's no photo.
      avatarUrl: null,
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
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
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

// --- Avatars ------------------------------------------------------------------

// Shared by the three avatar describe blocks below. The only moving parts
// are what the raw users row looks like, and what the UPDATE returns —
// everything after that (roles, clinics) resolves to "none", since none of
// these tests are about roles or clinic membership.
function avatarTestDb() {
  const db = {
    query: { users: { findFirst: jest.fn() } },
    update: jest.fn(),
    // withRlsContext() runs the UPDATE inside db.transaction() and sets two
    // session variables through tx.execute() first. tx === db here, so the
    // update() mock above is what the transaction body actually calls.
    execute: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(),
    // getRolesForUser() (.from().where()) and attachProfile()'s clinic join
    // (.from().innerJoin().where()) — both resolving to nothing.
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  }
  db.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db))
  return db
}

// Builds the update().set().where().returning() chain and hands back the
// set() mock, so a test can assert on what actually reached the UPDATE.
function mockUpdateReturning(
  db: ReturnType<typeof avatarTestDb>,
  row: Record<string, unknown>,
) {
  const set = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([row]),
    }),
  })
  db.update.mockReturnValue({ set })
  return set
}

const fakeAvatar = {
  mimetype: 'image/png',
  buffer: Buffer.from('fake-avatar'),
} as Express.Multer.File

const selfUser = { id: 5, activeRole: UserRole.PATIENT }

// The raw `users` row type toPublic() takes, derived from the method's own
// signature — so a fixture can list only the columns a test cares about
// (cast to this type) without importing the schema just for its type.
type RawUserRow = Parameters<UsersService['toPublic']>[0]

describe('UsersService.toPublic', () => {
  let usersService: UsersService
  let storageService: { getPresignedUrlOrNull: jest.Mock }

  beforeEach(async () => {
    storageService = {
      getPresignedUrlOrNull: jest
        .fn()
        .mockResolvedValue(
          'https://storage.example.com/signed/avatars/5/123.png',
        ),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: {} },
        { provide: StorageService, useValue: storageService },
        { provide: AuditService, useValue: {} },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  // A full toEqual, not a list of not.toHaveProperty checks: the point is
  // that the output is EXACTLY the public fields plus avatarUrl — nothing
  // private survives, and nothing public goes missing.
  it('drops the private fields and swaps avatarPath for a presigned avatarUrl', async () => {
    const result = await usersService.toPublic({
      id: 5,
      email: 'patient@example.com',
      firstName: 'Pat',
      lastName: 'Ient',
      passwordHash: 'bcrypt-hash',
      mfaSecret: 'iv:authTag:ciphertext',
      passwordResetTokenHash: 'reset-hash',
      passwordResetTokenExpiresAt: new Date(),
      avatarPath: 'avatars/5/123.png',
      isActive: true,
    } as RawUserRow)

    expect(result).toEqual({
      id: 5,
      email: 'patient@example.com',
      firstName: 'Pat',
      lastName: 'Ient',
      isActive: true,
      avatarUrl: 'https://storage.example.com/signed/avatars/5/123.png',
    })
    // 24 hours, like a clinic logo — not StorageService's own 15-minute
    // default, which would expire while an ordinary page is still open.
    expect(storageService.getPresignedUrlOrNull).toHaveBeenCalledWith(
      'avatars/5/123.png',
      60 * 60 * 24,
    )
  })

  it('returns avatarUrl: null for a user with no photo', async () => {
    storageService.getPresignedUrlOrNull.mockResolvedValue(null)

    const result = await usersService.toPublic({
      id: 5,
      avatarPath: null,
    } as RawUserRow)

    expect(result).toEqual({ id: 5, avatarUrl: null })
    expect(storageService.getPresignedUrlOrNull).toHaveBeenCalledWith(
      null,
      60 * 60 * 24,
    )
  })
})

describe('UsersService.updateAvatar', () => {
  let usersService: UsersService
  let db: ReturnType<typeof avatarTestDb>
  let storageService: {
    // Typed with upload()'s real argument list (objectKey, buffer,
    // contentType), so mock.calls below is typed too, not `any`.
    upload: jest.Mock<Promise<void>, [string, Buffer, string]>
    deleteUnreferenced: jest.Mock
    getPresignedUrlOrNull: jest.Mock
  }

  beforeEach(async () => {
    db = avatarTestDb()
    storageService = {
      upload: jest
        .fn<Promise<void>, [string, Buffer, string]>()
        .mockResolvedValue(undefined),
      deleteUnreferenced: jest.fn().mockResolvedValue(undefined),
      getPresignedUrlOrNull: jest
        .fn()
        .mockResolvedValue(
          'https://storage.example.com/signed/avatars/5/NEW.png',
        ),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
        { provide: AuditService, useValue: {} },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('throws NotFoundException for a nonexistent user, without touching storage or the DB', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)

    await expect(
      usersService.updateAvatar(999, fakeAvatar, selfUser),
    ).rejects.toThrow(NotFoundException)
    expect(storageService.upload).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('uploads the file under a new key, stores that key, and returns avatarUrl — never avatarPath', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, avatarPath: null })
    const set = mockUpdateReturning(db, {
      id: 5,
      avatarPath: 'avatars/5/NEW.png',
    })

    const result = await usersService.updateAvatar(5, fakeAvatar, selfUser)

    expect(storageService.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^avatars\/5\/\d+\.png$/),
      Buffer.from('fake-avatar'),
      'image/png',
    )
    // The key that reached the UPDATE is the same one that was uploaded.
    const [uploadedKey] = storageService.upload.mock.calls[0]
    expect(set).toHaveBeenCalledWith({ avatarPath: uploadedKey })
    expect(result).toEqual({
      id: 5,
      avatarUrl: 'https://storage.example.com/signed/avatars/5/NEW.png',
      roles: [],
      clinics: [],
    })
    // No previous photo, so nothing to clean up.
    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
  })

  it('deletes the OLD file — only after the new one is uploaded and the row points at it', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 5,
      avatarPath: 'avatars/5/OLD.png',
    })
    mockUpdateReturning(db, { id: 5, avatarPath: 'avatars/5/NEW.png' })

    await usersService.updateAvatar(5, fakeAvatar, selfUser)

    expect(storageService.deleteUnreferenced).toHaveBeenCalledTimes(1)
    expect(storageService.deleteUnreferenced).toHaveBeenCalledWith('avatars/5/OLD.png')
    // invocationCallOrder: a global counter Jest stamps on every mock call
    // — a lower number means an earlier call.
    const deleteOrder = storageService.deleteUnreferenced.mock.invocationCallOrder[0]
    expect(storageService.upload.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrder,
    )
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder)
  })
})

describe('UsersService.removeAvatar', () => {
  let usersService: UsersService
  let db: ReturnType<typeof avatarTestDb>
  let storageService: { deleteUnreferenced: jest.Mock; getPresignedUrlOrNull: jest.Mock }

  beforeEach(async () => {
    db = avatarTestDb()
    storageService = {
      deleteUnreferenced: jest.fn().mockResolvedValue(undefined),
      getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
        { provide: AuditService, useValue: {} },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  it('throws NotFoundException for a nonexistent user, without touching storage or the DB', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)

    await expect(usersService.removeAvatar(999, selfUser)).rejects.toThrow(
      NotFoundException,
    )
    expect(db.update).not.toHaveBeenCalled()
    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
  })

  it('clears avatarPath, then deletes the file, and returns avatarUrl: null', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 5,
      avatarPath: 'avatars/5/OLD.png',
    })
    const set = mockUpdateReturning(db, { id: 5, avatarPath: null })

    const result = await usersService.removeAvatar(5, selfUser)

    expect(set).toHaveBeenCalledWith({ avatarPath: null })
    expect(storageService.deleteUnreferenced).toHaveBeenCalledWith('avatars/5/OLD.png')
    // The row stops pointing at the file BEFORE the file is deleted.
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(
      storageService.deleteUnreferenced.mock.invocationCallOrder[0],
    )
    expect(result).toEqual({ id: 5, avatarUrl: null, roles: [], clinics: [] })
  })

  it('is idempotent — succeeds without touching storage when there was no photo', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, avatarPath: null })
    mockUpdateReturning(db, { id: 5, avatarPath: null })

    const result = await usersService.removeAvatar(5, selfUser)

    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 5, avatarUrl: null, roles: [], clinics: [] })
  })
})