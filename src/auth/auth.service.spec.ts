import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common'
import * as bcrypt from 'bcrypt'
import { AuthService } from './auth.service'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'
import { DrizzleQueryError } from 'drizzle-orm'
import { PG_UNIQUE_VIOLATION, USERS_EMAIL_UNIQUE } from '../database/pg-errors'
import { DUPLICATE_EMAIL_MESSAGE } from '../common/email-address'

// What AuthService hands to db.transaction(): a function of the
// transaction. The mocks call it with a small stub of their own; `unknown`
// because each test's stub has its own shape (an `any` here made every call
// and return through it unchecked — no-unsafe-call / no-unsafe-return).
type TransactionCallback = (tx: unknown) => unknown

// A stand-in for UsersService.toPublic() that honours its contract
// (drop the private fields, turn avatarPath into avatarUrl) without
// needing a StorageService. Deliberately NOT a passthrough (user => user):
// the tests below assert that private fields never reach a response, and
// with a passthrough they'd fail even though AuthService is correct. With
// this fake, they fail only if AuthService stops routing the raw row
// through toPublic() — which is exactly the bug they exist to catch.
// The REAL toPublic() is tested in users.service.spec.ts.
function fakeToPublic(user: {
  avatarPath?: string | null
  [field: string]: unknown
}) {
  const {
    passwordHash,
    mfaSecret,
    passwordResetTokenHash,
    passwordResetTokenExpiresAt,
    avatarPath,
    ...rest
  } = user
  return Promise.resolve({
    ...rest,
    avatarUrl: avatarPath
      ? `https://storage.example.com/signed/${avatarPath}`
      : null,
  })
}

// AuditService since the audit review (slice 1b): a change of data writes its
// entry through logInTransaction, in the change's own transaction; the
// sign-in events (which change no data) through log(), awaited.
function auditStub() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logInTransaction: jest.fn().mockResolvedValue(undefined),
  }
}

describe('AuthService.validateUser', () => {
  let authService: AuthService
  let usersService: {
    findByEmailWithHash: jest.Mock
    getRolesForUser: jest.Mock
    attachProfile: jest.Mock
    toPublic: jest.Mock
  }
  let auditService: { log: jest.Mock; logInTransaction: jest.Mock }

  beforeEach(async () => {
    usersService = {
      findByEmailWithHash: jest.fn(),
      getRolesForUser: jest.fn(),
      // validateUser() now attaches profile fields the same way
      // findOne()/create() do — defaults to "no profile" here since most
      // tests in this block don't care; the dedicated test below overrides
      // this to assert the real behavior.
      attachProfile: jest.fn().mockImplementation((user: unknown) => user),
      toPublic: jest.fn().mockImplementation(fakeToPublic),
    }
    // AuthService now calls auditService.log() from inside validateUser()
    // itself (LOGIN_SUCCESS/LOGIN_FAILURE) — this mock needs a real, callable
    // .log() method, not an empty object, or those calls would throw.
    auditService = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        // Unused by validateUser() specifically (only forgotPassword() calls
        // it), but AuthService's constructor still requires SOMETHING here
        // for the module to compile at all.
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: {} },
      ],
    }).compile()

    authService = moduleRef.get(AuthService)
  })

  it('returns null when the email does not exist', async () => {
    usersService.findByEmailWithHash.mockResolvedValue(undefined)
    const result = await authService.validateUser(
      'nobody@example.com',
      'password123',
    )
    expect(result).toBeNull()
  })

  it('returns null when the password does not match', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('correct-password', 10),
    })
    const result = await authService.validateUser(
      'jane@example.com',
      'wrong-password',
    )
    expect(result).toBeNull()
  })

  // An account created by invitation, not yet accepted: no password. It
  // must fail exactly like a wrong password (null → the controller's 401).
  // Without the guard, bcrypt.compare() throws on the null hash, so this
  // test would see a rejected promise (a 500 in real life), not null.
  it('returns null for an account with no password yet, and records the failed attempt', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'invited@example.com',
      passwordHash: null,
      isActive: true,
    })
    const result = await authService.validateUser(
      'invited@example.com',
      'any-password',
    )
    expect(result).toBeNull()
    // Through log() — a sign-in changes no data, there's no transaction to
    // join — and naming the account concerned.
    expect(auditService.log.mock.calls).toStrictEqual([
      [
        {
          performedBy: 1,
          action: 'LOGIN_FAILURE',
          targetUserId: 1,
          entityType: 'users',
          entityId: 1,
        },
      ],
    ])
  })

  it('auto-selects the active role when the account has exactly one', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      isActive: true,
    })
    usersService.getRolesForUser.mockResolvedValue(['practitioner'])

    const result = await authService.validateUser(
      'jane@example.com',
      'password123',
    )
    expect(result?.activeRole).toBe('practitioner')
  })

  it('requires an explicit role when the account has more than one', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'ada@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      isActive: true,
    })
    usersService.getRolesForUser.mockResolvedValue(['admin', 'practitioner'])

    await expect(
      authService.validateUser('ada@example.com', 'password123'),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects a requested role the account does not actually hold', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      isActive: true,
    })
    usersService.getRolesForUser.mockResolvedValue(['practitioner'])

    await expect(
      authService.validateUser(
        'jane@example.com',
        'password123',
        UserRole.ADMIN,
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  // Regression coverage: findByEmailWithHash() is the one place that
  // deliberately bypasses UsersService.toPublic() (it needs the real
  // passwordHash for bcrypt.compare()), so validateUser() has to strip
  // sensitive fields itself. It was already stripping mfaSecret but not
  // passwordResetTokenHash/passwordResetTokenExpiresAt — meaning a login
  // response for an account with a pending password reset leaked the
  // token's hash and expiry.
  //
  // Extended for avatars: the raw row's avatarPath (an internal storage
  // key) must not reach the login response either — it's replaced by
  // avatarUrl, via UsersService.toPublic().
  it('strips passwordHash, mfaSecret, password-reset token fields and the raw avatarPath from the login result', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      isActive: true,
      mfaSecret: 'iv:authTag:ciphertext',
      passwordResetTokenHash: 'reset-hash',
      passwordResetTokenExpiresAt: new Date(),
      avatarPath: 'avatars/1/123.png',
    })
    usersService.getRolesForUser.mockResolvedValue(['practitioner'])

    const result = await authService.validateUser(
      'jane@example.com',
      'password123',
    )

    expect(result).not.toHaveProperty('passwordHash')
    expect(result).not.toHaveProperty('mfaSecret')
    expect(result).not.toHaveProperty('passwordResetTokenHash')
    expect(result).not.toHaveProperty('passwordResetTokenExpiresAt')
    expect(result).not.toHaveProperty('avatarPath')
    expect(result?.avatarUrl).toBe(
      'https://storage.example.com/signed/avatars/1/123.png',
    )
  })

  // Regression coverage for the actual gap this fix closes: validateUser()
  // (POST /auth/login) builds its own response by hand rather than going
  // through UsersService.findOne()/create(), so it needed its own explicit
  // call to attachProfile() — this proves that call actually happened and
  // its result made it into the login response, not just that the roles
  // array is present.
  it("attaches the account's profile data to the login response", async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      isActive: true,
    })
    usersService.getRolesForUser.mockResolvedValue(['practitioner'])
    usersService.attachProfile.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      practitionerProfile: { licenseNumber: 'PT-1', specialties: [] },
    })

    const result = await authService.validateUser(
      'jane@example.com',
      'password123',
    )

    expect(usersService.attachProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      ['practitioner'],
    )
    expect(result?.practitionerProfile).toEqual({
      licenseNumber: 'PT-1',
      specialties: [],
    })
  })

  it('rejects login for a deactivated account, even with the correct password', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      isActive: false,
    })

    await expect(
      authService.validateUser('jane@example.com', 'password123'),
    ).rejects.toThrow('This account has been deactivated')
    // getRolesForUser should never even be reached — the account is
    // rejected before any role resolution happens.
    expect(usersService.getRolesForUser).not.toHaveBeenCalled()
  })
})

describe('AuthService.registerClinic', () => {
  let authService: AuthService
  let db: {
    query: {
      userRoles: { findFirst: jest.Mock }
      users: { findFirst: jest.Mock }
    }
    transaction: jest.Mock
  }
  let usersService: { attachProfile: jest.Mock; toPublic: jest.Mock }
  let auditService: { log: jest.Mock; logInTransaction: jest.Mock }

  beforeEach(async () => {
    db = {
      query: {
        userRoles: { findFirst: jest.fn() },
        // Defaults to "no colliding email" so every existing happy-path
        // test below (which never cared about this check) keeps passing
        // unchanged. The dedicated test further down overrides this to
        // assert the new rejection behavior instead.
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn(),
    }
    // registerClinic() attaches adminProfile the same way create()/findOne()
    // do elsewhere, but reads through the still-open tx it's already inside
    // (the adminProfiles insert hasn't committed yet) — the default here
    // just passes the user through unchanged; the dedicated test below
    // overrides it to assert the real behavior and the tx it's called with.
    usersService = {
      attachProfile: jest.fn().mockImplementation((user: unknown) => user),
      toPublic: jest.fn().mockImplementation(fakeToPublic),
    }
    auditService = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile()

    authService = moduleRef.get(AuthService)
  })

  it('refuses to run once an administrator already exists anywhere in the system', async () => {
    db.query.userRoles.findFirst.mockResolvedValue({
      id: 1,
      userId: 7,
      role: 'admin',
    })

    await expect(
      authService.registerClinic({
        clinicName: 'Acme Clinic',
        clinicEmail: 'clinic@example.com',
        email: 'admin@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'Admin',
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        'An administrator account already exists. Ask an existing admin to create additional accounts.',
      ),
    )

    expect(db.transaction).not.toHaveBeenCalled()
  })

  // Regression coverage for a real bug: registerClinic() inserts directly
  // into `users` inside its own transaction, and a colliding email once hit
  // the raw Postgres unique constraint, unhandled — a bare 500 instead of a
  // 409. Since emails became case-insensitive (Phase 6), the constraint is
  // the one judge (no read beforehand): its refusal of the transaction is
  // translated. Built as drizzle delivers it — node-postgres's error wrapped
  // in a DrizzleQueryError.
  it('turns the email constraint refusing the transaction into a 409', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    db.transaction.mockRejectedValue(
      new DrizzleQueryError(
        'insert into "users" ...',
        [],
        Object.assign(new Error('duplicate key value'), {
          code: PG_UNIQUE_VIOLATION,
          constraint: USERS_EMAIL_UNIQUE,
        }),
      ),
    )

    await expect(
      authService.registerClinic({
        clinicName: 'Acme Clinic',
        clinicEmail: 'clinic@example.com',
        email: 'admin@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'Admin',
      }),
    ).rejects.toThrow(new ConflictException(DUPLICATE_EMAIL_MESSAGE))
  })

  // Any OTHER failure of the transaction is not a taken email: it reaches
  // the caller as it was (a 500 through the exception filter), never turned
  // into a misleading 409.
  it('rethrows any other failure of the transaction unchanged', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    const failure = new Error('connection terminated')
    db.transaction.mockRejectedValue(failure)

    await expect(
      authService.registerClinic({
        clinicName: 'Acme Clinic',
        clinicEmail: 'clinic@example.com',
        email: 'admin@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'Admin',
      }),
    ).rejects.toBe(failure)
  })

  it('creates the founding clinic + admin when no administrator exists yet', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)

    // Insert calls happen, in order, for: clinics, users, userRoles,
    // adminProfiles, userClinics. Only the first two are ever destructured
    // via .returning() by the real service — the rest are fire-and-forget
    // inserts awaited directly, so their .values() just needs to resolve.
    const insert = jest
      .fn()
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([
              { id: 501, name: 'Acme Clinic', email: 'clinic@example.com' },
            ]),
        }),
      })
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 42,
              email: 'admin@example.com',
              passwordHash: 'hashed',
              firstName: 'New',
              lastName: 'Admin',
              avatarPath: null,
              isActive: true,
              createdAt: new Date('2026-01-01'),
            },
          ]),
        }),
      })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })

    const tx = { insert }
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await authService.registerClinic({
      clinicName: 'Acme Clinic',
      clinicEmail: 'clinic@example.com',
      email: 'admin@example.com',
      password: 'password123',
      firstName: 'New',
      lastName: 'Admin',
    })

    expect(result.clinicId).toBe(501)
    expect(result.activeRole).toBe('admin')
    expect(result.roles).toEqual(['admin'])
    // ONE entry, through the founding transaction itself; it names the
    // clinic and the admin — and nothing of the request (the password).
    expect(auditService.logInTransaction.mock.calls).toStrictEqual([
      [
        tx,
        {
          performedBy: 42,
          action: 'REGISTER_CLINIC',
          targetUserId: 42,
          entityType: 'clinics',
          entityId: 501,
          details: { adminUserId: 42 },
        },
      ],
    ])
    expect(auditService.log).not.toHaveBeenCalled()
    // The users insert's .returning() is a raw row, never routed through
    // UsersService.toPublic() — regression coverage for that bypass.
    expect(result).not.toHaveProperty('passwordHash')
    expect(result).not.toHaveProperty('mfaSecret')
    expect(result).not.toHaveProperty('passwordResetTokenHash')
    expect(result).not.toHaveProperty('passwordResetTokenExpiresAt')
    // A brand-new account has no photo yet: the raw avatarPath is gone and
    // avatarUrl is present, as null.
    expect(result).not.toHaveProperty('avatarPath')
    expect(result.avatarUrl).toBeNull()
  })

  // Regression coverage for the actual gap this fix closes: adminProfiles
  // is inserted a few lines above inside this same transaction, but the
  // response was built from the raw `users` row alone — attachProfile() has
  // to be called with the still-open `tx`, not this.db, or it would be
  // reading a row that hasn't committed yet.
  it("attaches the founding admin's profile data, reading through the open transaction", async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    const insert = jest
      .fn()
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([
              { id: 501, name: 'Acme Clinic', email: 'clinic@example.com' },
            ]),
        }),
      })
      .mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: 42, email: 'admin@example.com' }]),
        }),
      })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })
    const tx = { insert }
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))
    usersService.attachProfile.mockImplementation((user) =>
      Promise.resolve({
        ...user,
        adminProfile: { position: 'Clinic Director' },
      }),
    )

    const result = await authService.registerClinic({
      clinicName: 'Acme Clinic',
      clinicEmail: 'clinic@example.com',
      email: 'admin@example.com',
      password: 'password123',
      firstName: 'New',
      lastName: 'Admin',
      position: 'Clinic Director',
    })

    expect(usersService.attachProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      ['admin'],
      tx,
    )
    expect(result.adminProfile).toEqual({ position: 'Clinic Director' })
  })
})

// The one definition of "Stride has been set up", shared by GET
// /auth/setup-status and registerClinic(). Both answers are tested: a method
// that always said "true" (or always "false") would pass either test alone.
describe('AuthService.isSetupComplete', () => {
  let authService: AuthService
  let findFirst: jest.Mock

  beforeEach(async () => {
    findFirst = jest.fn()
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: { query: { userRoles: { findFirst } } } },
      ],
    }).compile()
    authService = moduleRef.get(AuthService)
  })

  it('is false while no administrator account exists', async () => {
    findFirst.mockResolvedValue(undefined)

    await expect(authService.isSetupComplete()).resolves.toBe(false)
  })

  it('is true once an administrator account exists', async () => {
    findFirst.mockResolvedValue({ id: 1 })

    await expect(authService.isSetupComplete()).resolves.toBe(true)
  })
})

// Had no unit tests until the invitation guard (2026-10-07). The three cases
// are the two halves of the rule plus the case it exists for: the normal
// account must still get its email, or "sends nothing" tests would pass
// for a forgotPassword() that never sends anything at all.
describe('AuthService.forgotPassword', () => {
  let authService: AuthService
  let usersService: {
    findByEmailWithHash: jest.Mock
    getRolesForUser: jest.Mock
  }
  let db: { transaction: jest.Mock }
  let emailService: { sendPasswordResetEmail: jest.Mock }
  let auditService: { log: jest.Mock; logInTransaction: jest.Mock }

  beforeEach(async () => {
    usersService = {
      findByEmailWithHash: jest.fn(),
      getRolesForUser: jest.fn().mockResolvedValue(['patient']),
    }
    // Same transaction stand-in as the resetPassword tests below:
    // withRlsContext() runs two set_config calls through tx.execute(), then
    // the token UPDATE through tx.update().set().where(). The callback is
    // typed rather than `any` (deferred-improvements.md, lint entry).
    db = {
      transaction: jest
        .fn()
        .mockImplementation((cb: (tx: unknown) => unknown) =>
          cb({
            execute: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockReturnValue({
              set: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue(undefined),
              }),
            }),
          }),
        ),
    }
    emailService = {
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    }
    auditService = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: emailService },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile()

    authService = moduleRef.get(AuthService)
  })

  it('stores a reset token and emails the raw token to an account with a password', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: 'a-bcrypt-hash',
    })

    await authService.forgotPassword('jane@example.com')

    expect(db.transaction).toHaveBeenCalledTimes(1)
    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith(
      'jane@example.com',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    )
    // In the token's own transaction (the first argument is the mocked
    // transaction, not the module's db); never the token in it — only when
    // it stops working, an hour from now.
    const [entryTx, entry] = auditService.logInTransaction.mock.calls[0] as [
      unknown,
      { details: { expiresAt: Date } },
    ]
    expect(entryTx).not.toBe(db)
    expect(entryTx).toHaveProperty('update')
    expect(entry).toStrictEqual({
      performedBy: 1,
      action: 'PASSWORD_RESET_REQUESTED',
      targetUserId: 1,
      entityType: 'users',
      entityId: 1,
      details: { expiresAt: entry.details.expiresAt },
    })
    const inMinutes = (entry.details.expiresAt.getTime() - Date.now()) / 60_000
    expect(inMinutes).toBeGreaterThan(59)
    expect(inMinutes).toBeLessThanOrEqual(60)
    expect(auditService.log).not.toHaveBeenCalled()
  })

  // The email is sent without waiting (the 204 must not reveal whether
  // it went out), so a failure is only ever visible in the logs — the log
  // line must say why.
  it('still answers, and logs the reason, when the reset email fails', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: 'a-bcrypt-hash',
    })
    emailService.sendPasswordResetEmail.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:1025'),
    )
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)

    await expect(
      authService.forgotPassword('jane@example.com'),
    ).resolves.toBeUndefined()
    // The .catch() runs after forgotPassword() returned (fire-and-forget):
    // one turn of the event loop lets the rejected promise reach it.
    await new Promise((resolve) => setImmediate(resolve))

    expect(errorLog).toHaveBeenCalledWith(
      'Failed to send password reset email to jane@example.com: connect ECONNREFUSED 127.0.0.1:1025',
    )
    errorLog.mockRestore()
  })

  it('does nothing for an email that matches no account', async () => {
    usersService.findByEmailWithHash.mockResolvedValue(undefined)

    await authService.forgotPassword('nobody@example.com')

    expect(db.transaction).not.toHaveBeenCalled()
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled()
    expect(auditService.log).not.toHaveBeenCalled()
  })

  // The invitation is such an account's only way in: no token stored, no
  // email sent, nothing audited — indistinguishable from "no account".
  it('does nothing for an account with no password yet', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'invited@example.com',
      passwordHash: null,
    })

    await authService.forgotPassword('invited@example.com')

    expect(db.transaction).not.toHaveBeenCalled()
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled()
    expect(auditService.log).not.toHaveBeenCalled()
  })
})

describe('AuthService.resetPassword', () => {
  let authService: AuthService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
    execute: jest.Mock
  }
  let usersService: { getRolesForUser: jest.Mock }
  let auditService: { log: jest.Mock; logInTransaction: jest.Mock }

  beforeEach(async () => {
    const endedSessions = { rows: [{ sid: 'device-1' }, { sid: 'device-2' }] }
    db = {
      query: { users: { findFirst: jest.fn() } },
      transaction: jest.fn(),
      // destroyAllSessionsForUser() calls this.db.execute() directly (raw
      // SQL against connect-pg-simple's session table), separate from the
      // tx.execute() withRlsContext() issues inside db.transaction() below.
      // It answers the deleted sessions' ids (RETURNING sid) — two devices.
      execute: jest.fn().mockResolvedValue(endedSessions),
    }
    // resetPassword() now fetches the target user's real roles to build a
    // synthetic self-context for withRlsContext() — see the comment on the
    // call site in auth.service.ts for why.
    usersService = {
      getRolesForUser: jest.fn().mockResolvedValue(['patient']),
    }
    auditService = auditStub()

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile()

    authService = moduleRef.get(AuthService)
  })

  it('rejects a token that does not match any pending reset', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined)

    await expect(
      authService.resetPassword('bogus-token', 'newpassword123'),
    ).rejects.toThrow(BadRequestException)
  })

  // Defence in depth: forgotPassword() never gives such an account a reset
  // token, but if one got there anyway, the reset must still refuse — same
  // message as any invalid link, and nothing written.
  it('rejects a valid, unexpired token on an account with no password yet', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordHash: null,
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    })

    await expect(
      authService.resetPassword('valid-token', 'newpassword123'),
    ).rejects.toThrow('This password reset link is invalid or has expired')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('rejects a token that has already expired', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() - 60_000),
    })

    await expect(
      authService.resetPassword('expired-token', 'newpassword123'),
    ).rejects.toThrow(BadRequestException)
  })

  // The reset's transaction: the password UPDATE (awaited as it is), then
  // the pending email changes cancelled (`.returning()` says which). One
  // `where()` serves both: a promise that also has `returning`.
  function resetTx(cancelledChanges: { id: number }[]) {
    const returning = jest.fn().mockResolvedValue(cancelledChanges)
    const set = jest.fn().mockReturnValue({
      where: jest.fn(() =>
        Object.assign(Promise.resolve(undefined), { returning }),
      ),
    })
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnValue({ set }),
    }
    return { tx, set }
  }

  it('resets the password and destroys existing sessions for a valid, unexpired token', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    })
    // withRlsContext() sets two session GUCs via tx.execute() before
    // invoking the callback, which then issues the real UPDATEs via tx.
    const { tx } = resetTx([])
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    const result = await authService.resetPassword(
      'valid-token',
      'newpassword123',
    )

    // The whole reason a password needed resetting might be that someone
    // else had access to the account — this confirms all existing sessions
    // are torn down, not just that the password itself changed. Their ids
    // are answered, so the controller can close their sockets too.
    expect(db.execute).toHaveBeenCalled()
    expect(result).toStrictEqual({ endedSessionIds: ['device-1', 'device-2'] })
    // In the new password's own transaction; no password (nor its hash) in
    // it — and, with no email change pending, no details at all.
    expect(auditService.logInTransaction.mock.calls).toStrictEqual([
      [
        tx,
        {
          performedBy: 1,
          action: 'PASSWORD_RESET_COMPLETED',
          targetUserId: 1,
          entityType: 'users',
          entityId: 1,
        },
      ],
    ])
    expect(auditService.log).not.toHaveBeenCalled()
  })

  // "Change email" (decisions §12): a reset cancels a pending change of
  // sign-in email, in the same transaction, and its entry names it.
  it('cancels a pending email change, naming it in the entry', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    })
    const { tx, set } = resetTx([{ id: 7 }])
    db.transaction.mockImplementation((cb: TransactionCallback) => cb(tx))

    await authService.resetPassword('valid-token', 'newpassword123')

    // The second UPDATE's values: the email change, cancelled for its reason.
    const [, [cancelled]] = set.mock.calls as [unknown[], unknown[]]
    expect(cancelled).toMatchObject({ cancelReason: 'password_reset' })
    expect(auditService.logInTransaction.mock.calls).toStrictEqual([
      [
        tx,
        {
          performedBy: 1,
          action: 'PASSWORD_RESET_COMPLETED',
          targetUserId: 1,
          entityType: 'users',
          entityId: 1,
          details: { cancelledEmailChangeRequestId: 7 },
        },
      ],
    ])
  })
})

// The reset page's pre-check (2026-10-21): the SAME lookup as the reset —
// every dead link refused with the reset's own words — and a pure read.
describe('AuthService.checkResetToken', () => {
  let authService: AuthService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
    execute: jest.Mock
  }
  let auditService: { log: jest.Mock; logInTransaction: jest.Mock }
  const expiresAt = new Date(Date.now() + 30 * 60_000)

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      transaction: jest.fn(),
      execute: jest.fn(),
    }
    auditService = auditStub()
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile()
    authService = moduleRef.get(AuthService)
  })

  it("answers the account's email and the link's expiry, and changes nothing", async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: 'hash',
      passwordResetTokenExpiresAt: expiresAt,
    })

    await expect(
      authService.checkResetToken('valid-token'),
    ).resolves.toStrictEqual({
      email: 'jane@example.com',
      expiresAt,
    })
    expect(db.transaction).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled()
    expect(auditService.log).not.toHaveBeenCalled()
  })

  it.each([
    ['a token that matches nothing', undefined],
    [
      'an account with no password yet',
      {
        id: 1,
        email: 'x@example.com',
        passwordHash: null,
        passwordResetTokenExpiresAt: expiresAt,
      },
    ],
    [
      'an expired token',
      {
        id: 1,
        email: 'x@example.com',
        passwordHash: 'hash',
        passwordResetTokenExpiresAt: new Date(Date.now() - 1000),
      },
    ],
    [
      'a token with no expiry',
      {
        id: 1,
        email: 'x@example.com',
        passwordHash: 'hash',
        passwordResetTokenExpiresAt: null,
      },
    ],
  ])("refuses %s with the reset's own words", async (_name, row) => {
    db.query.users.findFirst.mockResolvedValue(row)
    await expect(authService.checkResetToken('some-token')).rejects.toThrow(
      new BadRequestException(
        'This password reset link is invalid or has expired',
      ),
    )
  })
})
