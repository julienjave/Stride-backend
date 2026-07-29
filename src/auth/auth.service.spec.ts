import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { DRIZZLE } from '../database/drizzle.provider';

describe('AuthService.validateUser', () => {
  let authService: AuthService;
  let usersService: { findByEmailWithHash: jest.Mock; getRolesForUser: jest.Mock };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    usersService = {
      findByEmailWithHash: jest.fn(),
      getRolesForUser: jest.fn(),
    };
    // AuthService now calls auditService.log() from inside validateUser()
    // itself (LOGIN_SUCCESS/LOGIN_FAILURE) — this mock needs a real, callable
    // .log() method, not an empty object, or those calls would throw.
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

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
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it('returns null when the email does not exist', async () => {
    usersService.findByEmailWithHash.mockResolvedValue(undefined);
    const result = await authService.validateUser('nobody@example.com', 'password123');
    expect(result).toBeNull();
  });

  it('returns null when the password does not match', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('correct-password', 10),
    });
    const result = await authService.validateUser('jane@example.com', 'wrong-password');
    expect(result).toBeNull();
  });

  it('auto-selects the active role when the account has exactly one', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
    });
    usersService.getRolesForUser.mockResolvedValue(['practitioner']);

    const result = await authService.validateUser('jane@example.com', 'password123');
    expect(result?.activeRole).toBe('practitioner');
  });

  it('requires an explicit role when the account has more than one', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'ada@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
    });
    usersService.getRolesForUser.mockResolvedValue(['admin', 'practitioner']);

    await expect(
      authService.validateUser('ada@example.com', 'password123'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a requested role the account does not actually hold', async () => {
    usersService.findByEmailWithHash.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
    });
    usersService.getRolesForUser.mockResolvedValue(['practitioner']);

    await expect(
      authService.validateUser('jane@example.com', 'password123', 'admin'),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('AuthService.registerClinic', () => {
  let authService: AuthService;
  let db: {
    query: { userRoles: { findFirst: jest.Mock } };
    transaction: jest.Mock;
  };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    db = {
      query: { userRoles: { findFirst: jest.fn() } },
      transaction: jest.fn(),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it('refuses to run once an administrator already exists anywhere in the system', async () => {
    db.query.userRoles.findFirst.mockResolvedValue({ id: 1, userId: 7, role: 'admin' });

    await expect(
      authService.registerClinic({
        clinicName: 'Acme Clinic',
        clinicEmail: 'clinic@example.com',
        email: 'admin@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'Admin',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('creates the founding clinic + admin when no administrator exists yet', async () => {
    db.query.userRoles.findFirst.mockResolvedValue(undefined);

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
            .mockResolvedValue([{ id: 501, name: 'Acme Clinic', email: 'clinic@example.com' }]),
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
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) });

    db.transaction.mockImplementation((cb: any) => cb({ insert }));

    const result = await authService.registerClinic({
      clinicName: 'Acme Clinic',
      clinicEmail: 'clinic@example.com',
      email: 'admin@example.com',
      password: 'password123',
      firstName: 'New',
      lastName: 'Admin',
    });

    expect(result.clinicId).toBe(501);
    expect(result.activeRole).toBe('admin');
    expect(result.roles).toEqual(['admin']);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REGISTER_CLINIC', entityId: 501 }),
    );
  });
});

describe('AuthService.resetPassword', () => {
  let authService: AuthService;
  let db: {
    query: { users: { findFirst: jest.Mock } };
    update: jest.Mock;
    execute: jest.Mock;
  };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      update: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it('rejects a token that does not match any pending reset', async () => {
    db.query.users.findFirst.mockResolvedValue(undefined);

    await expect(authService.resetPassword('bogus-token', 'newpassword123')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a token that has already expired', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() - 60_000),
    });

    await expect(authService.resetPassword('expired-token', 'newpassword123')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('resets the password and destroys existing sessions for a valid, unexpired token', async () => {
    db.query.users.findFirst.mockResolvedValue({
      id: 1,
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    db.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    });

    await authService.resetPassword('valid-token', 'newpassword123');

    // The whole reason a password needed resetting might be that someone
    // else had access to the account — this confirms all existing sessions
    // are torn down, not just that the password itself changed.
    expect(db.execute).toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSWORD_RESET_COMPLETED', performedBy: 1 }),
    );
  });
});

describe('AuthService.enableMfa', () => {
  let authService: AuthService;
  let db: {
    query: { users: { findFirst: jest.Mock } };
    update: jest.Mock;
  };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it('refuses to enable MFA before setupMfa has ever run', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: null });

    await expect(authService.enableMfa(1, '123456')).rejects.toThrow(BadRequestException);
  });

  it('rejects an incorrect TOTP code', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: 'SECRET' });
    // otp is constructed internally by AuthService itself (`new OTP(...)`),
    // not injected via DI — there's no provider seam for it, so its
    // .verify() is monkey-patched directly on the constructed instance
    // instead, the same role the DRIZZLE mock plays for the database.
    (authService as any).otp.verify = jest.fn().mockResolvedValue({ valid: false });

    await expect(authService.enableMfa(1, '000000')).rejects.toThrow(BadRequestException);
  });

  it('enables MFA once a correct TOTP code is provided', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: 'SECRET' });
    (authService as any).otp.verify = jest.fn().mockResolvedValue({ valid: true });

    await authService.enableMfa(1, '123456');

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MFA_ENABLED', performedBy: 1 }),
    );
  });
});

describe('AuthService.disableMfa', () => {
  let authService: AuthService;
  let db: {
    query: { users: { findFirst: jest.Mock } };
    update: jest.Mock;
  };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it('refuses to disable MFA that is not currently enabled', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaEnabled: false, mfaSecret: null });

    await expect(authService.disableMfa(1, '123456')).rejects.toThrow(BadRequestException);
  });

  it('rejects an incorrect TOTP code even when MFA is currently enabled', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaEnabled: true, mfaSecret: 'SECRET' });
    (authService as any).otp.verify = jest.fn().mockResolvedValue({ valid: false });

    await expect(authService.disableMfa(1, '000000')).rejects.toThrow(BadRequestException);
  });

  it('disables MFA once a correct TOTP code is provided', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaEnabled: true, mfaSecret: 'SECRET' });
    (authService as any).otp.verify = jest.fn().mockResolvedValue({ valid: true });

    await authService.disableMfa(1, '123456');

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MFA_DISABLED', performedBy: 1 }),
    );
  });
});

describe('AuthService.verifyMfaCode', () => {
  let authService: AuthService;
  let db: { query: { users: { findFirst: jest.Mock } } };

  beforeEach(async () => {
    db = { query: { users: { findFirst: jest.fn() } } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it('returns false when the account has no MFA secret set up at all', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: null });

    const result = await authService.verifyMfaCode(1, '123456');
    expect(result).toBe(false);
  });

  it('returns true for a correct TOTP code', async () => {
    db.query.users.findFirst.mockResolvedValue({ id: 1, mfaSecret: 'SECRET' });
    (authService as any).otp.verify = jest.fn().mockResolvedValue({ valid: true });

    const result = await authService.verifyMfaCode(1, '123456');
    expect(result).toBe(true);
  });
});