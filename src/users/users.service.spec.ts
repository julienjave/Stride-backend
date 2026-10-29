import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import {
  MERGED_ACCOUNT_REACTIVATION_MESSAGE,
  UsersService,
} from './users.service'
import { patientMerges } from '../database/schema'
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

// AuditService since the audit review: every account write goes through
// logInTransaction (inside its transaction); log() — the after-commit
// path — must no longer be used by any of them, so it's here to be asserted
// NOT called. Typed with logInTransaction's real arguments, so mock.calls
// is typed too.
function auditStub() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logInTransaction: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(undefined),
  }
}

// A care-team link's period, for the links a deactivation ends.
const STARTED = new Date('2031-03-01T09:00:00Z')
const ENDED = new Date('2031-04-02T10:00:00Z')

function careTeamStub() {
  return {
    isOnCareTeam: jest.fn().mockResolvedValue(false),
    findPatientIdsForPractitioner: jest.fn().mockResolvedValue([]),
    linkCreator: jest.fn().mockResolvedValue({ id: 900 }),
    endLinksWithoutSharedClinic: jest.fn().mockResolvedValue([]),
    endLinksOfDeactivatedPractitioner: jest.fn().mockResolvedValue([]),
    recordEndedLinks: jest.fn().mockResolvedValue(undefined),
  }
}
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from './dto/create-user.dto'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  PG_UNIQUE_VIOLATION,
  PRACTITIONER_LICENSE_NUMBER_UNIQUE,
  USER_ROLES_USER_ROLE_UNIQUE,
  USERS_EMAIL_UNIQUE,
} from '../database/pg-errors'
import { DUPLICATE_EMAIL_MESSAGE } from '../common/email-address'

// What UsersService hands to db.transaction(): a function of the
// transaction. The mocks call it with a small stub of their own; `unknown`
// because each test's stub has its own shape (an `any` here made every call
// and return through it unchecked — no-unsafe-call / no-unsafe-return).
type TransactionCallback = (tx: unknown) => unknown

// What a duplicate value really looks like by the time it reaches
// UsersService: node-postgres's error (code 23505 + the constraint's name),
// wrapped by drizzle in a DrizzleQueryError. Built with drizzle's real
// error class rather than a hand-made look-alike, so these tests exercise
// the same shape production code sees.
function uniqueViolationError(constraint: string) {
  return new DrizzleQueryError(
    'insert into ...',
    [],
    Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: PG_UNIQUE_VIOLATION,
      constraint,
    }),
  )
}

function duplicateLicenseError() {
  return uniqueViolationError(PRACTITIONER_LICENSE_NUMBER_UNIQUE)
}

// attachProfile() now unconditionally looks up clinic membership for
// every user it returns (a select().from(userClinics).innerJoin(clinics)
// .where(...) chain) — most tests in this file aren't ABOUT clinic
// membership at all, they just need this new query to resolve to
// something rather than throw "select/innerJoin is not a function" on a
// mock db/tx object that predates this feature. This is that shared,
// generic "resolves to no clinics" chain; tests specifically about
// clinic membership build their own explicit version instead.
// Also the possible-duplicates lookup (decisions §27): patient_profiles ⋈
// users WHERE … ORDER BY — `where` answers both ways, awaited (the clinics)
// or followed by orderBy (no patient with that birthday). The lookup's
// "not merged away" subquery (pass 3) is built with from(…).where(…) and
// never awaited on its own — the outer query carries it.
function emptyClinicsSelect() {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn(),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn(() =>
          Object.assign(Promise.resolve([]), {
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        ),
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
  let audit: ReturnType<typeof auditStub>
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
    audit = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
    careTeam = moduleRef.get(CareTeamService)
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
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx))

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
    expect(result).not.toHaveProperty('passwordHash')
    // Regression coverage for the gap this fix closes: patientProfiles was
    // written inside this same insert, but never attached to create()'s own
    // response until attachProfile() started reading it back.
    expect(result.patientProfile).toEqual({ dateOfBirth: '1990-01-01' })

    // The creator joins the care team INSIDE the same transaction (same tx
    // object), so the patient and the link exist together or not at all.
    expect(careTeam.linkCreator).toHaveBeenCalledWith(tx, 10, 7)

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
    // …emailed after the transaction, with the raw token, as the creator,
    // for THIS invitation (deliver records the send time on it)…
    expect(invitations.deliver).toHaveBeenCalledWith(
      500,
      expect.objectContaining({ id: 10, email: 'patient@example.com' }),
      'raw-token',
      { id: 7, activeRole: UserRole.PRACTITIONER },
    )
    // The whole creation is ONE audit entry, written through the SAME
    // transaction (the first argument is `tx` itself — so it commits or
    // rolls back with the account): the account as sent, with the link and
    // the invitation named in it. toStrictEqual: no other key may be there.
    expect(audit.logInTransaction).toHaveBeenCalledTimes(1)
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(tx)
    expect(entry).toStrictEqual({
      performedBy: 7,
      action: 'USER_CREATED',
      targetUserId: 10,
      entityType: 'users',
      entityId: 10,
      details: {
        record: {
          email: 'patient@example.com',
          role: UserRole.PATIENT,
          firstName: 'New',
          lastName: 'Patient',
          dateOfBirth: '1990-01-01',
          clinicId: 3,
        },
        careTeamLinkId: 900,
        invitationId: 500,
      },
    })
    // Written once the link and the invitation exist (it names both)…
    expect(audit.logInTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(
      invitations.insertInvitation.mock.invocationCallOrder[0],
    )
    // …and nothing is logged outside the transaction any more.
    expect(audit.log).not.toHaveBeenCalled()
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
    // The entry was written in the transaction, BEFORE the email was even
    // tried: what the email does can't change what the trail says. (The
    // invitation row records whether it went out — deliver's job.)
    expect(audit.logInTransaction).toHaveBeenCalledTimes(1)
    expect(audit.logInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      invitations.deliver.mock.invocationCallOrder[0],
    )
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('does not put an ADMIN who creates a patient on the care team', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: emptyClinicsSelect(),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([
              { id: 10, email: 'p@example.com', passwordHash: 'x' },
            ]),
        }),
      }),
      query: {
        clinics: { findFirst: jest.fn() },
        patientProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    }
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx))

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
    // The entry names no care-team link: the KEY is absent (toStrictEqual),
    // not merely undefined — an admin joined nobody's team.
    const [, entry] = audit.logInTransaction.mock.calls[0]
    expect(entry).toStrictEqual({
      performedBy: 1,
      action: 'USER_CREATED',
      targetUserId: 10,
      entityType: 'users',
      entityId: 10,
      details: {
        record: {
          email: 'p@example.com',
          role: UserRole.PATIENT,
          firstName: 'New',
          lastName: 'Patient',
          dateOfBirth: '1990-01-01',
        },
        invitationId: 500,
      },
    })
  })

  // The email's UNIQUE constraint is the one judge since emails became
  // case-insensitive (Phase 6): no read beforehand, the insert's refusal is
  // translated. Its own message — not the license's, which the same
  // transaction could also hit.
  it('turns the email constraint refusing the insert into a 409 with its own message', async () => {
    db.transaction.mockRejectedValue(uniqueViolationError(USERS_EMAIL_UNIQUE))

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
    ).rejects.toThrow(new ConflictException(DUPLICATE_EMAIL_MESSAGE))
    // Nothing was created, so nothing may be emailed.
    expect(invitations.deliver).not.toHaveBeenCalled()
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
    db.transaction.mockImplementation((cb: TransactionCallback) =>
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
    db.transaction.mockImplementation((cb: TransactionCallback) =>
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
    db.transaction.mockImplementation((cb: TransactionCallback) =>
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
  let audit: ReturnType<typeof auditStub>
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
    audit = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()

    usersService = moduleRef.get(UsersService)
  })

  // A role the account already has: user_roles' UNIQUE refuses the INSERT
  // (no read beforehand — two grants at once could both pass a read), and
  // that refusal becomes the 409 (privacy and security pass 2).
  it('refuses to grant a role the user already holds — the constraint decides', async () => {
    db.transaction.mockRejectedValue(
      uniqueViolationError(USER_ROLES_USER_ROLE_UNIQUE),
    )

    await expect(
      usersService.grantRole(
        1,
        { role: UserRole.PRACTITIONER, licenseNumber: 'PT-2' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(
      new ConflictException('User already has the "practitioner" role'),
    )
    // Nothing read first: the insert is the check.
    expect(db.query.userRoles.findFirst).not.toHaveBeenCalled()
  })

  // Narrow translation: another constraint keeps its own answer (the
  // license's 409), any other failure its own identity.
  it('keeps other failures as they are', async () => {
    db.transaction.mockRejectedValue(duplicateLicenseError())
    await expect(
      usersService.grantRole(
        1,
        { role: UserRole.PRACTITIONER, licenseNumber: 'PT-TAKEN' },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toThrow(
      new ConflictException(
        'This license number is already registered to another practitioner',
      ),
    )

    const otherError = new Error('connection terminated')
    db.transaction.mockRejectedValue(otherError)
    await expect(
      usersService.grantRole(
        1,
        { role: UserRole.ADMIN },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toBe(otherError)

    // A duplicate on ANOTHER unique constraint isn't "already has the role".
    const otherDuplicate = uniqueViolationError('admin_profiles_pkey')
    db.transaction.mockRejectedValue(otherDuplicate)
    await expect(
      usersService.grantRole(
        1,
        { role: UserRole.ADMIN },
        { id: 9, activeRole: UserRole.ADMIN },
      ),
    ).rejects.toBe(otherDuplicate)
  })

  it('grants a new role and creates its profile when none exists yet', async () => {
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
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await usersService.grantRole(
      1,
      { role: UserRole.PRACTITIONER, licenseNumber: 'PT-2' },
      { id: 9, activeRole: UserRole.ADMIN },
    )

    // userRoles insert + practitionerProfiles insert, since none existed yet.
    expect(insert).toHaveBeenCalledTimes(2)
    // ONE entry, through the same transaction, with the profile the role
    // came with — the values really inserted (specialties defaulted to [],
    // no bio → null), so the entry reads like the row.
    expect(audit.logInTransaction).toHaveBeenCalledTimes(1)
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(tx)
    expect(entry).toStrictEqual({
      performedBy: 9,
      action: 'USER_ROLE_GRANTED',
      targetUserId: 1,
      entityType: 'users',
      entityId: 1,
      details: {
        role: UserRole.PRACTITIONER,
        profile: { licenseNumber: 'PT-2', specialties: [], bio: null },
      },
    })
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('grants a new role without duplicating an already-existing profile', async () => {
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
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await usersService.grantRole(
      1,
      { role: UserRole.PRACTITIONER, licenseNumber: 'PT-2' },
      { id: 9, activeRole: UserRole.ADMIN },
    )

    // Only the userRoles insert — the existing profile must not be re-inserted.
    expect(insert).toHaveBeenCalledTimes(1)
    // …and the entry says so: profile null — the request's licenseNumber
    // was NOT used, and the trail mustn't claim it was.
    const [, entry] = audit.logInTransaction.mock.calls[0]
    expect(entry).toStrictEqual({
      performedBy: 9,
      action: 'USER_ROLE_GRANTED',
      targetUserId: 1,
      entityType: 'users',
      entityId: 1,
      details: { role: UserRole.PRACTITIONER, profile: null },
    })
  })

  it('turns a duplicate licenseNumber on the new practitioner profile into a 409', async () => {
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
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
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
          where: jest
            .fn()
            .mockResolvedValue(
              patients.map((p) => ({ user: { ...p, passwordHash: 'x' } })),
            ),
        }),
      }),
    })
    db.select
      // attachProfilesToMany()'s batched userRoles query.
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockResolvedValue(
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
    expect(result[0]).not.toHaveProperty('passwordHash')
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
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
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
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
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
  it('strips passwordHash, the two-factor and step-up internals, and password-reset token fields from the returned user', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'user@example.com',
      firstName: 'Test',
      lastName: 'User',
      passwordHash: 'bcrypt-hash',
      mfaSecret: 'iv:authTag:ciphertext',
      mfaEnabled: true,
      mfaLastUsedStep: 59000000,
      stepUpFailures: 3,
      passwordResetTokenHash: 'reset-hash',
      passwordResetTokenExpiresAt: new Date(),
    })

    const result = await usersService.findOne(1)

    expect(result).not.toHaveProperty('passwordHash')
    expect(result).not.toHaveProperty('mfaSecret')
    expect(result).not.toHaveProperty('mfaLastUsedStep')
    // How many step-ups in a row failed (decisions §16) — a security
    // counter, no screen's business.
    expect(result).not.toHaveProperty('stepUpFailures')
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
  let audit: ReturnType<typeof auditStub>
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
    audit = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: audit },
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

  // The "before" values — firstName and the practitioner profile — come
  // from reads INSIDE the transaction (accountTx's first values); the
  // response from the reads after the writes (its second values).
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
    const { tx, set } = accountTx({
      locked: { id: 1, email: 'prac@example.com', firstName: 'Prac' },
      roles: [UserRole.PRACTITIONER],
      after: {
        id: 1,
        email: 'prac@example.com',
        firstName: 'Updated',
        lastName: 'Titioner',
        avatarPath: null,
        isActive: true,
      },
      practitioner: [
        { userId: 1, licenseNumber: 'PT-1', specialties: [], bio: null },
        {
          userId: 1,
          licenseNumber: 'PT-NEW',
          specialties: ['ortho'],
          bio: 'Updated bio.',
        },
      ],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

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
    // The users row, then the profile — each with exactly its own fields.
    expect(set.mock.calls).toEqual([
      [{ firstName: 'Updated' }],
      [
        {
          licenseNumber: 'PT-NEW',
          specialties: ['ortho'],
          bio: 'Updated bio.',
        },
      ],
    ])
    // ONE entry, through the same transaction: every field, before → after.
    expect(audit.logInTransaction).toHaveBeenCalledTimes(1)
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(tx)
    expect(entry).toStrictEqual({
      performedBy: 9,
      action: 'USER_UPDATED',
      targetUserId: 1,
      entityType: 'users',
      entityId: 1,
      details: {
        changes: {
          firstName: { from: 'Prac', to: 'Updated' },
          licenseNumber: { from: 'PT-1', to: 'PT-NEW' },
          specialties: { from: [], to: ['ortho'] },
          bio: { from: null, to: 'Updated bio.' },
        },
      },
    })
  })

  // The "before" values are read UNDER A LOCK: two simultaneous edits of one
  // profile take turns, so each entry's "from" is what that edit replaced.
  it('reads the values it replaces under a row lock (FOR UPDATE), before writing', async () => {
    mockPractitionerTarget()
    const { tx, lockFor } = accountTx({
      locked: { id: 1, firstName: 'Prac' },
      roles: [UserRole.PRACTITIONER],
      practitioner: [
        { licenseNumber: 'PT-1', specialties: [], bio: null },
        { licenseNumber: 'PT-1', specialties: [], bio: null },
      ],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await usersService.update(
      1,
      { firstName: 'Changed' },
      { id: 9, activeRole: UserRole.ADMIN },
    )

    expect(lockFor).toHaveBeenCalledWith('update')
    expect(lockFor.mock.invocationCallOrder[0]).toBeLessThan(
      tx.update.mock.invocationCallOrder[0],
    )
  })

  // The convention: a request that changes nothing writes nothing. A
  // profile field saved unchanged, a list re-sent in the same order —
  // neither is a change.
  it('writes nothing — no UPDATE, no audit entry — when every value sent is already stored', async () => {
    mockPractitionerTarget()
    const { tx } = accountTx({
      locked: { id: 1, firstName: 'Prac' },
      roles: [UserRole.PRACTITIONER],
      practitioner: [
        { licenseNumber: 'PT-1', specialties: ['ortho', 'sports'], bio: 'B' },
        { licenseNumber: 'PT-1', specialties: ['ortho', 'sports'], bio: 'B' },
      ],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.update(
      1,
      { firstName: 'Prac', specialties: ['ortho', 'sports'] },
      { id: 1, activeRole: UserRole.PRACTITIONER },
    )

    expect(tx.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(result.firstName).toBe('Prac')
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
    const { tx, set } = accountTx({
      locked: { id: 3, email: 'patient@example.com', firstName: 'Patient' },
      roles: [UserRole.PATIENT],
      patient: [
        { userId: 3, dateOfBirth: '1980-01-01' },
        { userId: 3, dateOfBirth: '1985-05-05' },
      ],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.update(
      3,
      { dateOfBirth: '1985-05-05' },
      { id: 3, activeRole: UserRole.PATIENT },
    )

    expect(tx.query.users.findFirst).toHaveBeenCalled()
    expect(result.patientProfile).toEqual({ dateOfBirth: '1985-05-05' })
    expect(set.mock.calls).toEqual([[{ dateOfBirth: '1985-05-05' }]])
    const [, entry] = audit.logInTransaction.mock.calls[0]
    expect(entry).toStrictEqual({
      performedBy: 3,
      action: 'USER_UPDATED',
      targetUserId: 3,
      entityType: 'users',
      entityId: 3,
      details: {
        changes: { dateOfBirth: { from: '1980-01-01', to: '1985-05-05' } },
      },
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

  // A transaction for a practitioner (id 1) whose profile is PT-1 /
  // ['ortho'] / 'Bio.' before the request. `updateResult` decides what each
  // UPDATE does (succeed, or fail like the database would). Returns the
  // shared `set` mock: what reached each UPDATE, in order.
  function mockProfileOnlyTransaction(updateResult?: () => Promise<unknown>) {
    const profile = {
      userId: 1,
      licenseNumber: 'PT-1',
      specialties: ['ortho'],
      bio: 'Bio.',
    }
    const { tx, set } = accountTx({
      locked: { id: 1, email: 'prac@example.com', firstName: 'Prac' },
      roles: [UserRole.PRACTITIONER],
      practitioner: [profile, profile],
      updateResult,
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))
    return set
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
    const set = mockProfileOnlyTransaction()

    await usersService.update(
      1,
      { licenseNumber: 'PT-NEW' },
      { id: 1, activeRole: UserRole.ADMIN },
    )

    // What actually reached the UPDATE — exactly the license, nothing else.
    expect(set.mock.calls).toEqual([[{ licenseNumber: 'PT-NEW' }]])
  })

  it('still lets a practitioner change their own specialties and bio', async () => {
    mockPractitionerTarget()
    const set = mockProfileOnlyTransaction()

    await usersService.update(
      1,
      { specialties: ['ortho', 'sports'], bio: 'New bio.' },
      { id: 1, activeRole: UserRole.PRACTITIONER },
    )

    expect(set.mock.calls).toEqual([
      [{ specialties: ['ortho', 'sports'], bio: 'New bio.' }],
    ])
  })

  it('turns a duplicate licenseNumber into a 409 ConflictException, not a 500', async () => {
    mockPractitionerTarget()
    mockProfileOnlyTransaction(() => Promise.reject(duplicateLicenseError()))

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
    // The write failed, so no entry claims it happened.
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })

  // The translation must be narrow: any OTHER failure keeps its own
  // identity, so a real bug still surfaces as the error it really is.
  it('rethrows any other database error unchanged', async () => {
    mockPractitionerTarget()
    const otherError = new Error('connection terminated')
    mockProfileOnlyTransaction(() => Promise.reject(otherError))

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
  // is a plain users column, 'kg' before. Returns the shared `set` mock.
  function mockUsersOnlyTransaction() {
    const { tx, set } = accountTx({
      locked: { id: 1, firstName: 'Prac', preferredWeightUnit: 'kg' },
      roles: [UserRole.PRACTITIONER],
      after: {
        id: 1,
        email: 'prac@example.com',
        firstName: 'Prac',
        lastName: 'Titioner',
        preferredWeightUnit: 'lbs',
      },
      practitioner: [
        { userId: 1, licenseNumber: 'PT-1', specialties: [], bio: null },
        { userId: 1, licenseNumber: 'PT-1', specialties: [], bio: null },
      ],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))
    return set
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
    const set = mockUsersOnlyTransaction()

    const result = await usersService.update(
      1,
      { preferredWeightUnit: 'lbs' },
      { id: 1, activeRole: UserRole.PRACTITIONER },
    )

    expect(set.mock.calls).toEqual([[{ preferredWeightUnit: 'lbs' }]])
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
  let audit: ReturnType<typeof auditStub>
  let careTeam: ReturnType<typeof careTeamStub>

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
    audit = auditStub()
    careTeam = careTeamStub()

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
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeam },
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
    const { tx, set } = accountTx({
      locked: {
        id: 5,
        email: 'returning-patient@example.com',
        isActive: false,
      },
      roles: [UserRole.PATIENT],
      after: { id: 5, email: 'returning-patient@example.com', isActive: true },
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.reactivate(5, {
      id: 1,
      activeRole: UserRole.ADMIN,
    })

    expect(set.mock.calls).toEqual([[{ isActive: true }]])
    // Reactivating restores no care-team link (an admin adds the
    // practitioner back where needed) — and ends none either.
    expect(careTeam.endLinksOfDeactivatedPractitioner).not.toHaveBeenCalled()
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

  // An account merged into another (decisions §27, pass 3) stays
  // deactivated: 409, and nothing written.
  it('refuses to reactivate an account merged into another', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, isActive: false })
    const { tx, set } = accountTx({
      locked: { id: 5, isActive: false },
      roles: [UserRole.PATIENT],
      mergedAway: true,
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await expect(
      usersService.reactivate(5, { id: 1, activeRole: UserRole.ADMIN }),
    ).rejects.toThrow(MERGED_ACCOUNT_REACTIVATION_MESSAGE)
    expect(set).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })

  // In the reactivation's own transaction, naming the account (targetUserId
  // — the old entry had none, so "what happened to this account" missed it).
  it('audits the reactivation in its transaction, naming who did it and whose account it was', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, isActive: false })
    const { tx, lockFor } = accountTx({
      locked: { id: 5, isActive: false },
      roles: [UserRole.PATIENT],
      after: { id: 5, isActive: true },
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await usersService.reactivate(5, { id: 42, activeRole: UserRole.ADMIN })

    expect(lockFor).toHaveBeenCalledWith('update')
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(tx)
    expect(entry).toStrictEqual({
      performedBy: 42,
      action: 'USER_REACTIVATED',
      targetUserId: 5,
      entityType: 'users',
      entityId: 5,
      details: { changes: { isActive: { from: false, to: true } } },
    })
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('writes nothing — no UPDATE, no entry — for an account that is already active', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, isActive: true })
    const { tx } = accountTx({
      locked: { id: 5, email: 'active@example.com', isActive: true },
      roles: [UserRole.PATIENT],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.reactivate(5, {
      id: 42,
      activeRole: UserRole.ADMIN,
    })

    expect(tx.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(result.isActive).toBe(true)
  })
})

// Deactivation: the same helper as reactivation (setActive), the other way.
// Same module set-up as the reactivate block above.
describe('UsersService.softDelete', () => {
  let usersService: UsersService
  let db: {
    query: {
      users: { findFirst: jest.Mock }
      practitionerProfiles: { findFirst: jest.Mock }
      patientProfiles: { findFirst: jest.Mock }
    }
    select: jest.Mock
    transaction: jest.Mock
  }
  let audit: ReturnType<typeof auditStub>
  let careTeam: ReturnType<typeof careTeamStub>
  // The roles of the account being deactivated, as findOne() (the 404
  // pre-check) reads them — a test about a practitioner sets its own.
  let targetRoles: UserRole[]

  beforeEach(async () => {
    targetRoles = [UserRole.PATIENT]
    db = {
      // findOne() attaches the profiles of the account's roles.
      query: {
        users: { findFirst: jest.fn() },
        practitionerProfiles: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
        patientProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn(() =>
            Promise.resolve(targetRoles.map((role) => ({ role }))),
          ),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      transaction: jest.fn(),
    }
    audit = auditStub()
    careTeam = careTeamStub()
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageStub() },
        { provide: AuditService, useValue: audit },
        { provide: CareTeamService, useValue: careTeam },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()
    usersService = moduleRef.get(UsersService)
  })

  it('sets isActive to false, ends the sessions and audits it all in the same transaction', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 6, isActive: true })
    const { tx, set } = accountTx({
      locked: { id: 6, isActive: true },
      roles: [UserRole.PATIENT],
      after: { id: 6, isActive: false },
      sessions: ['phone', 'laptop'],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.softDelete(6, {
      id: 7,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(set.mock.calls).toEqual([[{ isActive: false }]])
    expect(result.user.isActive).toBe(false)
    // The ended sessions answered, for the controller to close their sockets.
    expect(result.endedSessionIds).toEqual(['phone', 'laptop'])
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(tx)
    expect(entry).toStrictEqual({
      performedBy: 7,
      action: 'USER_DEACTIVATED',
      targetUserId: 6,
      entityType: 'users',
      entityId: 6,
      details: {
        changes: { isActive: { from: true, to: false } },
        signedOutSessions: 2,
        // Asked of every deactivation (the UPDATE finds a patient's none —
        // their links are kept), so the entry always says what it ended.
        endedCareTeamLinkIds: [],
      },
    })
    expect(careTeam.endLinksOfDeactivatedPractitioner.mock.calls).toEqual([
      [tx, 6, 7],
    ])
  })

  // The practitioner's links: ended in the SAME transaction, named in the
  // account's entry, and one CARE_TEAM_ENDED each — written after the
  // account's entry, with the deactivation's reason.
  it("ends a practitioner's care-team links and records each one, in the same transaction", async () => {
    targetRoles = [UserRole.PRACTITIONER]
    db.query.users.findFirst.mockResolvedValue({ id: 4, isActive: true })
    const { tx } = accountTx({
      locked: { id: 4, isActive: true },
      roles: [UserRole.PRACTITIONER],
      after: { id: 4, isActive: false },
      sessions: [],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))
    const links = [
      {
        id: 41,
        patientId: 6,
        practitionerId: 4,
        startedAt: STARTED,
        endsAt: ENDED,
      },
      {
        id: 42,
        patientId: 9,
        practitionerId: 4,
        startedAt: STARTED,
        endsAt: ENDED,
      },
    ]
    careTeam.endLinksOfDeactivatedPractitioner.mockResolvedValue(links)
    const order: string[] = []
    audit.logInTransaction.mockImplementation(() => {
      order.push('account entry')
      return Promise.resolve()
    })
    careTeam.recordEndedLinks.mockImplementation(() => {
      order.push('link entries')
      return Promise.resolve()
    })

    await usersService.softDelete(4, { id: 1, activeRole: UserRole.ADMIN })

    expect(careTeam.endLinksOfDeactivatedPractitioner.mock.calls).toEqual([
      [tx, 4, 1],
    ])
    const [, entry] = audit.logInTransaction.mock.calls[0]
    expect(entry).toStrictEqual({
      performedBy: 1,
      action: 'USER_DEACTIVATED',
      targetUserId: 4,
      entityType: 'users',
      entityId: 4,
      details: {
        changes: { isActive: { from: true, to: false } },
        signedOutSessions: 0,
        endedCareTeamLinkIds: [41, 42],
      },
    })
    expect(careTeam.recordEndedLinks.mock.calls).toEqual([
      [tx, links, 1, "The practitioner's account was deactivated"],
    ])
    expect(order).toEqual(['account entry', 'link entries'])
  })

  // Only an admin or the practitioner themselves may: the links' UPDATE
  // policy would silently skip anyone else's UPDATE, leaving them open.
  it.each([
    [
      'a managing practitioner (the account is also a patient)',
      { id: 7, activeRole: UserRole.PRACTITIONER },
      [UserRole.PATIENT, UserRole.PRACTITIONER],
    ],
    [
      'the account itself, acting as a patient',
      { id: 4, activeRole: UserRole.PATIENT },
      [UserRole.PATIENT, UserRole.PRACTITIONER],
    ],
  ])(
    "refuses a practitioner's deactivation by %s, before any write",
    async (_who, actor, roles) => {
      targetRoles = roles
      db.query.users.findFirst.mockResolvedValue({ id: 4, isActive: true })

      await expect(usersService.softDelete(4, actor)).rejects.toThrow(
        new ForbiddenException(
          "Only an admin, or the practitioner themselves, can deactivate a practitioner's account",
        ),
      )
      expect(db.transaction).not.toHaveBeenCalled()
    },
  )

  // The practitioner themselves, acting as one: the UPDATE policy lets them
  // end their own links, so it goes through — as does an admin (above).
  it('lets a practitioner deactivate their own account', async () => {
    targetRoles = [UserRole.PRACTITIONER]
    db.query.users.findFirst.mockResolvedValue({ id: 4, isActive: true })
    const { tx } = accountTx({
      locked: { id: 4, isActive: true },
      roles: [UserRole.PRACTITIONER],
      after: { id: 4, isActive: false },
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.softDelete(4, {
      id: 4,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(result.user.isActive).toBe(false)
    expect(careTeam.endLinksOfDeactivatedPractitioner.mock.calls).toEqual([
      [tx, 4, 4],
    ])
  })

  it('writes nothing for an account that is already deactivated', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 6, isActive: false })
    const { tx } = accountTx({
      locked: { id: 6, isActive: false },
      roles: [UserRole.PATIENT],
    })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await usersService.softDelete(6, {
      id: 1,
      activeRole: UserRole.ADMIN,
    })

    expect(tx.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(result.endedSessionIds).toEqual([])
  })

  // lockUser() under row security: a row the UPDATE policy hides comes
  // back as nothing — answered like a missing user, and nothing written.
  it('answers 404 when the locked read finds no row (hidden by the UPDATE policy)', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 6, isActive: true })
    const { tx } = accountTx({ locked: undefined, roles: [UserRole.PATIENT] })
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await expect(
      usersService.softDelete(6, { id: 7, activeRole: UserRole.PRACTITIONER }),
    ).rejects.toThrow(new NotFoundException('User 6 not found'))
    expect(tx.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
  })
})

describe('UsersService.findAll', () => {
  let usersService: UsersService
  let db: {
    query: {
      // Typed with its call signature (what findAll passes), so the tests'
      // `mock.calls[0][0]` is checked rather than `any`.
      users: { findMany: jest.Mock<Promise<unknown[]>, [{ where: unknown }]> }
      practitionerProfiles: { findMany: jest.Mock }
      patientProfiles: { findMany: jest.Mock }
      adminProfiles: { findMany: jest.Mock }
    }
    select: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        users: {
          findMany: jest.fn<Promise<unknown[]>, [{ where: unknown }]>(),
        },
        practitionerProfiles: { findMany: jest.fn().mockResolvedValue([]) },
        patientProfiles: { findMany: jest.fn().mockResolvedValue([]) },
        adminProfiles: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn(),
    }
    db.select
      .mockReturnValueOnce({
        from: jest
          .fn()
          .mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest
            .fn()
            .mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
      })

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageStub() },
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
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
// A transaction for the account writes since the audit review (update,
// reactivate, softDelete, the avatar). They read their "before" values
// INSIDE the transaction: lockUser()'s SELECT … FOR UPDATE (→ `locked`) and
// profileValues()'s three profile reads (→ each pair's FIRST value); the
// response then reads the "after" state (`after`, and each pair's SECOND
// value — attachProfile() only reads the profiles of roles the user holds).
//
// One mocked tx.select serves three queries: getRolesForUser() awaits
// .from().where() directly (→ `roles`), lockUser() adds .for('update')
// (→ `locked`), attachProfile() uses .innerJoin() (→ no clinics).
//
// Every UPDATE goes through ONE shared `set` mock, so a test reads what was
// written, in order, from set.mock.calls. Its where() is a LAZY thenable:
// awaited directly (update()'s writes) or through .returning() (setActive,
// the avatar), it runs `updateResult` only when awaited — so a rejecting
// one (a duplicate license) fails exactly the write that awaits it.
type ProfilePair = [before: object | undefined, after: object | undefined]
function accountTx(options: {
  locked: Record<string, unknown> | undefined
  roles: UserRole[]
  after?: Record<string, unknown>
  practitioner?: ProfilePair
  patient?: ProfilePair
  admin?: ProfilePair
  updateResult?: () => Promise<unknown>
  // The ids a session DELETE answers (RETURNING sid) — a deactivation ends
  // the account's sessions. The same execute() also sets the RLS context,
  // whose answer nobody reads.
  sessions?: string[]
  // Whether patient_merges has a row merging this account away (pass 3).
  mergedAway?: boolean
}) {
  const result = options.updateResult ?? (() => Promise.resolve(undefined))
  const after = options.after ?? options.locked
  const lockFor = jest
    .fn()
    .mockResolvedValue(options.locked ? [options.locked] : [])
  const set = jest.fn((values: Record<string, unknown>) => ({
    values,
    where: jest.fn(() => ({
      then: (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => result().then(resolve, reject),
      returning: () => result().then(() => [after]),
    })),
  }))
  const profile = (pair?: ProfilePair) => ({
    findFirst: jest
      .fn()
      .mockResolvedValueOnce(pair?.[0])
      .mockResolvedValue(pair?.[1]),
  })
  const rolesRows = options.roles.map((role) => ({ role }))
  const tx = {
    execute: jest.fn().mockResolvedValue({
      rows: (options.sessions ?? []).map((sid) => ({ sid })),
    }),
    update: jest.fn(() => ({ set })),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) =>
        table === patientMerges
          ? {
              where: jest
                .fn()
                .mockResolvedValue(options.mergedAway ? [{ id: 1 }] : []),
            }
          : {
              where: jest.fn(() =>
                Object.assign(Promise.resolve(rolesRows), { for: lockFor }),
              ),
              innerJoin: jest.fn(() => ({
                where: jest.fn().mockResolvedValue([]),
              })),
            },
      ),
    })),
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(after) },
      practitionerProfiles: profile(options.practitioner),
      patientProfiles: profile(options.patient),
      adminProfiles: profile(options.admin),
    },
  }
  return { tx, set, lockFor }
}

function avatarTestDb() {
  // lockUser()'s SELECT … FOR UPDATE: the row as it is INSIDE the
  // transaction — the avatarPath the change really replaces. Each test sets
  // it (none by default: a missing row).
  const lock = jest.fn().mockResolvedValue([])
  const db = {
    lock,
    query: { users: { findFirst: jest.fn() } },
    update: jest.fn(),
    // withRlsContext() runs the UPDATE inside db.transaction() and sets two
    // session variables through tx.execute() first. tx === db here, so the
    // update() mock above is what the transaction body actually calls.
    execute: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(),
    // getRolesForUser() (.from().where()) and attachProfile()'s clinic join
    // (.from().innerJoin().where()) — both resolving to nothing; lockUser()
    // adds .for('update') to the first, answered by `lock`.
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn(() => Object.assign(Promise.resolve([]), { for: lock })),
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
      mfaLastUsedStep: 59_000_000,
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
  let audit: ReturnType<typeof auditStub>
  let storageService: {
    // Typed with upload()'s real argument list (objectKey, buffer,
    // contentType), so mock.calls below is typed too, not `any`.
    upload: jest.Mock<Promise<void>, [string, Buffer, string]>
    deleteUnreferenced: jest.Mock
    getPresignedUrlOrNull: jest.Mock
  }

  beforeEach(async () => {
    db = avatarTestDb()
    audit = auditStub()
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
        { provide: AuditService, useValue: audit },
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
    db.lock.mockResolvedValue([{ id: 5, avatarPath: null }])
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
    // ONE entry, in the transaction (tx === db in this mock): the storage
    // keys before and after — a key names the file for good, a signed URL
    // expires in minutes.
    expect(audit.logInTransaction).toHaveBeenCalledTimes(1)
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: 5,
      action: 'USER_AVATAR_CHANGED',
      targetUserId: 5,
      entityType: 'users',
      entityId: 5,
      details: { changes: { avatarPath: { from: null, to: uploadedKey } } },
    })
  })

  // The file deleted is the one the row pointed at UNDER THE LOCK — not the
  // one read before the upload: if another upload landed in between, that
  // newer photo is the one being replaced. Here the early read says
  // EARLIER.png and the locked read OLD.png: OLD.png is replaced, and named.
  it('deletes the OLD file — the one read under the lock — only after the new one is uploaded and the row points at it', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 5,
      avatarPath: 'avatars/5/EARLIER.png',
    })
    db.lock.mockResolvedValue([{ id: 5, avatarPath: 'avatars/5/OLD.png' }])
    mockUpdateReturning(db, { id: 5, avatarPath: 'avatars/5/NEW.png' })

    await usersService.updateAvatar(5, fakeAvatar, selfUser)

    expect(storageService.deleteUnreferenced).toHaveBeenCalledTimes(1)
    expect(storageService.deleteUnreferenced).toHaveBeenCalledWith(
      'avatars/5/OLD.png',
    )
    const [, entry] = audit.logInTransaction.mock.calls[0]
    expect(entry.details).toStrictEqual({
      changes: {
        avatarPath: {
          from: 'avatars/5/OLD.png',
          to: storageService.upload.mock.calls[0][0],
        },
      },
    })
    // invocationCallOrder: a global counter Jest stamps on every mock call
    // — a lower number means an earlier call.
    const deleteOrder =
      storageService.deleteUnreferenced.mock.invocationCallOrder[0]
    expect(storageService.upload.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrder,
    )
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder)
  })
})

describe('UsersService.removeAvatar', () => {
  let usersService: UsersService
  let db: ReturnType<typeof avatarTestDb>
  let audit: ReturnType<typeof auditStub>
  let storageService: {
    deleteUnreferenced: jest.Mock
    getPresignedUrlOrNull: jest.Mock
  }

  beforeEach(async () => {
    db = avatarTestDb()
    audit = auditStub()
    storageService = {
      deleteUnreferenced: jest.fn().mockResolvedValue(undefined),
      getPresignedUrlOrNull: jest.fn().mockResolvedValue(null),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageService },
        { provide: AuditService, useValue: audit },
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
    db.lock.mockResolvedValue([{ id: 5, avatarPath: 'avatars/5/OLD.png' }])
    const set = mockUpdateReturning(db, { id: 5, avatarPath: null })

    const result = await usersService.removeAvatar(5, selfUser)

    expect(set).toHaveBeenCalledWith({ avatarPath: null })
    expect(storageService.deleteUnreferenced).toHaveBeenCalledWith(
      'avatars/5/OLD.png',
    )
    // The row stops pointing at the file BEFORE the file is deleted.
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(
      storageService.deleteUnreferenced.mock.invocationCallOrder[0],
    )
    expect(result).toEqual({ id: 5, avatarUrl: null, roles: [], clinics: [] })
    const [entryTx, entry] = audit.logInTransaction.mock.calls[0]
    expect(entryTx).toBe(db)
    expect(entry).toStrictEqual({
      performedBy: 5,
      action: 'USER_AVATAR_REMOVED',
      targetUserId: 5,
      entityType: 'users',
      entityId: 5,
      details: {
        changes: { avatarPath: { from: 'avatars/5/OLD.png', to: null } },
      },
    })
  })

  // Nothing to remove changes nothing — so nothing is written: no UPDATE,
  // no entry (the convention), and storage is left alone.
  it('is idempotent — succeeds without touching storage, the row or the audit log when there was no photo', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 5, avatarPath: null })
    db.lock.mockResolvedValue([{ id: 5, avatarPath: null }])

    const result = await usersService.removeAvatar(5, selfUser)

    expect(storageService.deleteUnreferenced).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
    expect(audit.logInTransaction).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 5, avatarUrl: null, roles: [], clinics: [] })
  })
})

// "Can this account sign in?" (decisions §22) — false for a deactivated
// account AND for an id with no account: a missing row must never read as
// active.
describe('UsersService.isAccountActive', () => {
  let usersService: UsersService
  let rows: { isActive: boolean }[]
  let where: jest.Mock

  beforeEach(async () => {
    rows = []
    where = jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(rows)) }))
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storageStub() },
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CareTeamService, useValue: careTeamStub() },
        { provide: InvitationsService, useValue: invitationsStub() },
      ],
    }).compile()
    usersService = moduleRef.get(UsersService)
  })

  it('is true for an active account, false for a deactivated one', async () => {
    rows = [{ isActive: true }]
    expect(await usersService.isAccountActive(20)).toBe(true)
    rows = [{ isActive: false }]
    expect(await usersService.isAccountActive(20)).toBe(false)
    expect(where).toHaveBeenCalledTimes(2)
  })

  it('is false for an id with no account', async () => {
    expect(await usersService.isAccountActive(999)).toBe(false)
  })
})
