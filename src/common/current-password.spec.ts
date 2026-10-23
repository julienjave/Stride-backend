/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { BadRequestException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import * as bcrypt from 'bcrypt'
import { OTP } from 'otplib'
import type { DrizzleDb } from '../database/drizzle.provider'
import { encryptMfaSecret } from '../auth/mfa-secret-crypto'
import { INVALID_MFA_CODE_MESSAGE, newMfaSecret } from '../mfa/totp'
import {
  confirmStepUp,
  IsCurrentPassword,
  isCurrentPassword,
  MFA_CODE_REQUIRED_MESSAGE,
  type StepUpAccount,
  WRONG_PASSWORD_MESSAGE,
} from './current-password'

// --- TESTS -------------------------------------------------------------------------------------------------

describe('isCurrentPassword', () => {
  // A real hash (cost 4: the rule is the same, the test is fast).
  let hash: string
  beforeAll(async () => {
    hash = await bcrypt.hash('password123', 4)
  })

  it('accepts the password the hash was made from', async () => {
    await expect(isCurrentPassword(hash, 'password123')).resolves.toBe(true)
  })

  it('refuses any other password, even one differing only in case or a space', async () => {
    await expect(isCurrentPassword(hash, 'Password123')).resolves.toBe(false)
    await expect(isCurrentPassword(hash, 'password123 ')).resolves.toBe(false)
  })

  // bcrypt.compare(given, null) would THROW (a 500); an account without a
  // password has no current password to match.
  it('refuses for an account without a password, without throwing', async () => {
    await expect(isCurrentPassword(null, '')).resolves.toBe(false)
    await expect(isCurrentPassword(null, 'password123')).resolves.toBe(false)
  })
})

describe('confirmStepUp', () => {
  // Real values throughout: a bcrypt hash, an encrypted secret (with a test
  // key), and a code otplib computes for a PINNED clock (2031).
  const NOW_MS = Date.parse('2031-03-04T10:00:10Z')
  const STEP = Math.floor(NOW_MS / 1000 / 30)
  const otp = new OTP({ strategy: 'totp' })
  const savedKey = process.env.MFA_ENCRYPTION_KEY
  let hash: string
  let secret: string
  let goodCode: string
  let mfaOn: StepUpAccount
  let mfaOff: StepUpAccount

  beforeAll(async () => {
    process.env.MFA_ENCRYPTION_KEY = 'cd'.repeat(32)
    hash = await bcrypt.hash('password123', 4)
    secret = newMfaSecret()
    goodCode = await otp.generate({ secret, epoch: STEP * 30 })
    mfaOn = {
      passwordHash: hash,
      mfaEnabled: true,
      mfaSecret: encryptMfaSecret(secret),
      mfaLastUsedStep: null,
    }
    mfaOff = {
      passwordHash: hash,
      mfaEnabled: false,
      mfaSecret: null,
      mfaLastUsedStep: null,
    }
  })
  afterAll(() => {
    process.env.MFA_ENCRYPTION_KEY = savedKey
  })
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // A stand-in for the transaction: the only write a step-up makes is the
  // code's step (mfa/totp.ts's recordMfaStep).
  function fakeTx() {
    const set = jest.fn()
    set.mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) })
    const update = jest.fn().mockReturnValue({ set })
    return { tx: { update } as unknown as DrizzleDb, update, set }
  }

  it('passes on the password alone for an account without two-factor, and ignores a code', async () => {
    const { tx, update } = fakeTx()
    await expect(
      confirmStepUp(tx, 7, mfaOff, { currentPassword: 'password123' }),
    ).resolves.toBeUndefined()
    // Even a wrong code: the account has no second factor to check.
    await expect(
      confirmStepUp(tx, 7, mfaOff, {
        currentPassword: 'password123',
        mfaCode: '000000',
      }),
    ).resolves.toBeUndefined()
    expect(update).not.toHaveBeenCalled()
  })

  // The password comes FIRST: a request with a good code but the wrong
  // password is refused for the password, and the code is NOT spent.
  it('refuses a wrong password before looking at the code, and spends nothing', async () => {
    const { tx, update } = fakeTx()
    for (const account of [mfaOff, mfaOn]) {
      await expect(
        confirmStepUp(tx, 7, account, {
          currentPassword: 'wrong',
          mfaCode: goodCode,
        }),
      ).rejects.toThrow(new BadRequestException(WRONG_PASSWORD_MESSAGE))
    }
    expect(update).not.toHaveBeenCalled()
  })

  it('asks for the code when two-factor is on and none was sent', async () => {
    const { tx } = fakeTx()
    await expect(
      confirmStepUp(tx, 7, mfaOn, { currentPassword: 'password123' }),
    ).rejects.toThrow(new BadRequestException(MFA_CODE_REQUIRED_MESSAGE))
  })

  it('passes with the password and a good code, and records the code as used', async () => {
    const { tx, set } = fakeTx()
    await expect(
      confirmStepUp(tx, 7, mfaOn, {
        currentPassword: 'password123',
        mfaCode: goodCode,
      }),
    ).resolves.toBeUndefined()
    expect(set.mock.calls).toStrictEqual([[{ mfaLastUsedStep: STEP }]])
  })

  it('refuses a wrong code, and records nothing', async () => {
    const { tx, update } = fakeTx()
    await expect(
      confirmStepUp(tx, 7, mfaOn, {
        currentPassword: 'password123',
        mfaCode: '000000',
      }),
    ).rejects.toThrow(new BadRequestException(INVALID_MFA_CODE_MESSAGE))
    expect(update).not.toHaveBeenCalled()
  })

  // Fail closed: ON with no secret can't be stored (the CHECK), but if it
  // were, the code check must refuse — not be skipped.
  it('refuses when two-factor is on but there is no secret to check against', async () => {
    const { tx, update } = fakeTx()
    await expect(
      confirmStepUp(
        tx,
        7,
        { ...mfaOn, mfaSecret: null },
        { currentPassword: 'password123', mfaCode: goodCode },
      ),
    ).rejects.toThrow(new BadRequestException(INVALID_MFA_CODE_MESSAGE))
    expect(update).not.toHaveBeenCalled()
  })
})

describe('IsCurrentPassword', () => {
  class Body {
    @IsCurrentPassword()
    currentPassword!: unknown
  }
  const errorsFor = async (currentPassword: unknown) =>
    (await validate(plainToInstance(Body, { currentPassword }))).flatMap(
      (error) => Object.keys(error.constraints ?? {}),
    )

  // The limits of signing in: at least one character, at most 128.
  it('accepts 1 to 128 characters', async () => {
    await expect(errorsFor('x')).resolves.toStrictEqual([])
    await expect(errorsFor('x'.repeat(128))).resolves.toStrictEqual([])
  })

  it('refuses an empty string, 129 characters, and a non-string', async () => {
    await expect(errorsFor('')).resolves.toStrictEqual(['minLength'])
    await expect(errorsFor('x'.repeat(129))).resolves.toStrictEqual([
      'maxLength',
    ])
    await expect(errorsFor(12345678)).resolves.toContain('isString')
  })
})
