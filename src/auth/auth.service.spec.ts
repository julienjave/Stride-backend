import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { DRIZZLE } from '../database/drizzle.provider';

describe('AuthService.validateUser', () => {
  let authService: AuthService;
  let usersService: { findByEmailWithHash: jest.Mock; getRolesForUser: jest.Mock };

  beforeEach(async () => {
    // A plain object with jest.fn() stand-ins — no real database, no real
    // UsersService logic runs at all. We're testing ONLY AuthService's own
    // decision-making, trusting UsersService's own behavior is covered by
    // its own separate test file.
    usersService = {
      findByEmailWithHash: jest.fn(),
      getRolesForUser: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        // AuthService's constructor also injects DRIZZLE (used only by
        // registerClinic, not validateUser) — still has to be provided
        // SOMETHING for the module to compile, even though this test
        // never touches it.
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