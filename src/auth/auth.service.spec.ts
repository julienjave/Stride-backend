import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common'
import * as bcrypt from 'bcrypt'
import { AuthService } from './auth.service'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'

// AuthService now decrypts the stored MFA secret (encryptMfaSecret/
// decryptMfaSecret, AES-256-GCM) before ever handing it to otp.verify() —
// real encrypted values require MFA_ENCRYPTION_KEY, which isn't set up for
// these mocked unit tests. Mocking the module as a passthrough lets the
// existing convention below (a plain string like 'SECRET' standing in for
// "whatever is in mfaSecret") keep working, without pulling real AES or env
// config into what's otherwise a pure, isolated unit test.
jest.mock('./mfa-secret-crypto', () => ({
  encryptMfaSecret: jest.fn((plaintext: string) => plaintext),
  decryptMfaSecret: jest.fn((stored: string) => stored),
}))

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

describe('AuthService.validateUser', () => {
  let authService: AuthService
  let usersService: {
    findByEmailWithHash: jest.Mock
    getRolesForUser: jest.Mock
    attachProfile: jest.Mock
    toPublic: jest.Mock
  }
  let auditService: { log: jest.Mock }

  beforeEach(async () => {
    usersService = {
      findByEmailWithHash: jest.fn(),
      getRolesForUser: jest.fn(),
      // validateUser() now attaches profile fields the same way
      // findOne()/create() do — defaults to "no profile" here since most
      // tests in this block don't care; the dedicated test below overrides
      // this to assert the real behavior.
      attachProfile: jest.fn().mockImplementation((user) => user),
      toPublic: jest.fn().mockImplementation(fakeToPublic),
    }
    // AuthService now calls auditService.log() from inside validateUser()
    // itself (LOGIN_SUCCESS/LOGIN_FAILURE) — this mock needs a real, callable
    // .log() method, not an empty object, or those calls would throw.
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    }

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
  let auditService: { log: jest.Mock }

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
      attachProfile: jest.fn().mockImplementation((user) => user),
      toPublic: jest.fn().mockImplementation(fakeToPublic),
    }
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

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
    ).rejects.toThrow(ForbiddenException)

    expect(db.transaction).not.toHaveBeenCalled()
  })

  // Regression coverage for a real bug: registerClinic() inserts directly
  // into `users` inside its own transaction, bypassing UsersService.create()
  // entirely — which is where every other signup path gets its duplicate-
  // email check for free. Before this fix, a colliding email here hit the
  // raw Postgres unique constraint, unhandled, and surfaced as a bare 500
  // via the catch-all exception filter instead of a proper 409.
  it('refuses to run when the email is already in use by any existing account', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined)
    db.query.users.findFirst.mockResolvedValue({
      id: 99,
      email: 'admin@example.com',
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
    ).rejects.toThrow(ConflictException)

    // Same reasoning as the admin-already-exists case just above: a
    // rejected request should never open a transaction at all.
    expect(db.transaction).not.toHaveBeenCalled()
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

    db.transaction.mockImplementation((cb: any) => cb({ insert }))

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
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REGISTER_CLINIC', entityId: 501 }),
    )
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
    db.transaction.mockImplementation((cb: any) => cb(tx))
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

describe('AuthService.resetPassword', () => {
  let authService: AuthService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
    execute: jest.Mock
  }
  let usersService: { getRolesForUser: jest.Mock }
  let auditService: { log: jest.Mock }

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      transaction: jest.fn(),
      // destroyAllSessionsForUser() calls this.db.execute() directly (raw
      // SQL against connect-pg-simple's session table), separate from the
      // tx.execute() withRlsContext() issues inside db.transaction() below.
      execute: jest.fn().mockResolvedValue(undefined),
    }
    // resetPassword() now fetches the target user's real roles to build a
    // synthetic self-context for withRlsContext() — see the comment on the
    // call site in auth.service.ts for why.
    usersService = {
      getRolesForUser: jest.fn().mockResolvedValue(['patient']),
    }
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

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

  it('rejects a token that has already expired', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() - 60_000),
    })

    await expect(
      authService.resetPassword('expired-token', 'newpassword123'),
    ).rejects.toThrow(BadRequestException)
  })

  it('resets the password and destroys existing sessions for a valid, unexpired token', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    })
    // withRlsContext() sets two session GUCs via tx.execute() before
    // invoking the callback, which then issues the real UPDATE via tx.
    db.transaction.mockImplementation((cb: any) =>
      cb({
        execute: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      }),
    )

    await authService.resetPassword('valid-token', 'newpassword123')

    // The whole reason a password needed resetting might be that someone
    // else had access to the account — this confirms all existing sessions
    // are torn down, not just that the password itself changed.
    expect(db.execute).toHaveBeenCalled()
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PASSWORD_RESET_COMPLETED',
        performedBy: 1,
      }),
    )
  })
})

describe('AuthService.enableMfa', () => {
  let authService: AuthService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
  }
  let auditService: { log: jest.Mock }
  const currentUser = { id: 1, activeRole: UserRole.PATIENT }

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      // withRlsContext() sets two session GUCs via tx.execute() before
      // invoking the callback, which then issues the real UPDATE via tx.
      transaction: jest.fn().mockImplementation((cb: any) =>
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
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

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

  it('refuses to enable MFA before setupMfa has ever run', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: null })

    await expect(
      authService.enableMfa(1, '123456', currentUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects an incorrect TOTP code', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: 'SECRET' })
    // otp is constructed internally by AuthService itself (`new OTP(...)`),
    // not injected via DI — there's no provider seam for it, so its
    // .verify() is monkey-patched directly on the constructed instance
    // instead, the same role the DRIZZLE mock plays for the database.
    ;(authService as any).otp.verify = jest
      .fn()
      .mockResolvedValue({ valid: false })

    await expect(
      authService.enableMfa(1, '000000', currentUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('enables MFA once a correct TOTP code is provided', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: 'SECRET' })
    ;(authService as any).otp.verify = jest
      .fn()
      .mockResolvedValue({ valid: true })

    await authService.enableMfa(1, '123456', currentUser)

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MFA_ENABLED', performedBy: 1 }),
    )
  })
})

describe('AuthService.disableMfa', () => {
  let authService: AuthService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
  }
  let auditService: { log: jest.Mock }
  const currentUser = { id: 1, activeRole: UserRole.PATIENT }

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      // withRlsContext() sets two session GUCs via tx.execute() before
      // invoking the callback, which then issues the real UPDATE via tx.
      transaction: jest.fn().mockImplementation((cb: any) =>
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
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

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

  it('refuses to disable MFA that is not currently enabled', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      mfaEnabled: false,
      mfaSecret: null,
    })

    await expect(
      authService.disableMfa(1, '123456', currentUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects an incorrect TOTP code even when MFA is currently enabled', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      mfaEnabled: true,
      mfaSecret: 'SECRET',
    })
    ;(authService as any).otp.verify = jest
      .fn()
      .mockResolvedValue({ valid: false })

    await expect(
      authService.disableMfa(1, '000000', currentUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('disables MFA once a correct TOTP code is provided', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      mfaEnabled: true,
      mfaSecret: 'SECRET',
    })
    ;(authService as any).otp.verify = jest
      .fn()
      .mockResolvedValue({ valid: true })

    await authService.disableMfa(1, '123456', currentUser)

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MFA_DISABLED', performedBy: 1 }),
    )
  })
})

describe('AuthService.verifyMfaCode', () => {
  let authService: AuthService
  let db: { query: { users: { findFirst: jest.Mock } } }

  beforeEach(async () => {
    db = { query: { users: { findFirst: jest.fn() } } }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile()

    authService = moduleRef.get(AuthService)
  })

  it('returns false when the account has no MFA secret set up at all', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: null })

    const result = await authService.verifyMfaCode(1, '123456')
    expect(result).toBe(false)
  })

  it('returns true for a correct TOTP code', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: 'SECRET' })
    ;(authService as any).otp.verify = jest
      .fn()
      .mockResolvedValue({ valid: true })

    const result = await authService.verifyMfaCode(1, '123456')
    expect(result).toBe(true)
  })
})