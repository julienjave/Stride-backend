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

import { BadRequestException, Logger } from '@nestjs/common'
import * as bcrypt from 'bcrypt'
import { OTP } from 'otplib'
import type { DrizzleDb } from '../database/drizzle.provider'
import type { AuditService } from '../audit/audit.service'
import type { EmailService } from '../email/email.service'
import { encryptMfaSecret } from '../auth/mfa-secret-crypto'
import { WRONG_PASSWORD_MESSAGE } from '../common/current-password'
import { INVALID_MFA_CODE_MESSAGE, newMfaSecret } from './totp'
import { INVALID_RECOVERY_CODE_MESSAGE } from './second-factor'
import {
  MFA_CODE_REQUIRED_MESSAGE,
  type StepUpAccount,
  StepUpService,
} from './step-up.service'

// --- FIXTURES ----------------------------------------------------------------------------------------------

// Real values throughout: a bcrypt hash, an encrypted secret (with a test
// key), and a code otplib computes for a PINNED clock (2031).
const NOW_MS = Date.parse('2031-03-04T10:00:10Z')
const STEP = Math.floor(NOW_MS / 1000 / 30)
const otp = new OTP({ strategy: 'totp' })
const savedKey = process.env.MFA_ENCRYPTION_KEY
let hash: string
let goodCode: string
let mfaOn: StepUpAccount
let mfaOff: StepUpAccount

beforeAll(async () => {
  process.env.MFA_ENCRYPTION_KEY = 'cd'.repeat(32)
  hash = await bcrypt.hash('password123', 4)
  const secret = newMfaSecret()
  goodCode = await otp.generate({ secret, epoch: STEP * 30 })
  const person = { email: 'pat@example.com', firstName: 'Pat' }
  mfaOn = {
    ...person,
    passwordHash: hash,
    mfaEnabled: true,
    mfaSecret: encryptMfaSecret(secret),
    mfaLastUsedStep: null,
  }
  mfaOff = {
    ...person,
    passwordHash: hash,
    mfaEnabled: false,
    mfaSecret: null,
    mfaLastUsedStep: null,
  }
})
afterAll(() => {
  process.env.MFA_ENCRYPTION_KEY = savedKey
})

// A stand-in for the transaction. The step-up's writes: an app code's step
// (`update().set().where()`, awaited) or a recovery code marked used
// (`update().set().where().returning()`), then the count of those left
// (`select().from().where()`). `where()` answers a THENABLE — awaitable
// itself, with a `returning()` — so both shapes work; `spent` is what
// RETURNING finds (an empty list = no such unused code).
function fakeTx({ spent = [{ id: 1 }], left = 7 } = {}) {
  const set = jest.fn()
  const returning = jest.fn().mockResolvedValue(spent)
  set.mockReturnValue({
    where: jest.fn().mockReturnValue({
      then: (resolve: (value: undefined) => void) => resolve(undefined),
      returning,
    }),
  })
  const update = jest.fn().mockReturnValue({ set })
  const select = jest.fn().mockReturnValue({
    from: () => ({ where: () => Promise.resolve([{ remaining: left }]) }),
  })
  return { tx: { update, select } as unknown as DrizzleDb, update, set }
}

let service: StepUpService
let logInTransaction: jest.Mock
let sendRecoveryCodeUsedNotice: jest.Mock

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  logInTransaction = jest.fn().mockResolvedValue(undefined)
  sendRecoveryCodeUsedNotice = jest.fn().mockResolvedValue(undefined)
  service = new StepUpService(
    { logInTransaction } as unknown as AuditService,
    { sendRecoveryCodeUsedNotice } as unknown as EmailService,
  )
})
afterEach(() => {
  jest.restoreAllMocks()
})

// --- TESTS -------------------------------------------------------------------------------------------------

describe('StepUpService.confirm', () => {
  it('passes on the password alone for an account without two-factor, and ignores a code', async () => {
    const { tx, update } = fakeTx()
    const receipt = await service.confirm(tx, 7, mfaOff, {
      currentPassword: 'password123',
      mfaCode: '000000',
    })
    receipt.afterCommit()
    expect(update).not.toHaveBeenCalled()
    expect(logInTransaction).not.toHaveBeenCalled()
    expect(sendRecoveryCodeUsedNotice).not.toHaveBeenCalled()
  })

  // The password comes FIRST: a request with a good code but the wrong
  // password is refused for the password, and the code is NOT spent.
  it('refuses a wrong password before looking at the code, and spends nothing', async () => {
    const { tx, update } = fakeTx()
    for (const account of [mfaOff, mfaOn]) {
      await expect(
        service.confirm(tx, 7, account, {
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
      service.confirm(tx, 7, mfaOn, { currentPassword: 'password123' }),
    ).rejects.toThrow(new BadRequestException(MFA_CODE_REQUIRED_MESSAGE))
  })

  it('passes with an app code, recording its step — no extra entry, no notice', async () => {
    const { tx, set } = fakeTx()
    const receipt = await service.confirm(tx, 7, mfaOn, {
      currentPassword: 'password123',
      mfaCode: goodCode,
    })
    receipt.afterCommit()
    expect(set.mock.calls).toStrictEqual([[{ mfaLastUsedStep: STEP }]])
    expect(logInTransaction).not.toHaveBeenCalled()
    expect(sendRecoveryCodeUsedNotice).not.toHaveBeenCalled()
  })

  it('refuses a wrong app code, and records nothing', async () => {
    const { tx, update } = fakeTx()
    await expect(
      service.confirm(tx, 7, mfaOn, {
        currentPassword: 'password123',
        mfaCode: '000000',
      }),
    ).rejects.toThrow(new BadRequestException(INVALID_MFA_CODE_MESSAGE))
    expect(update).not.toHaveBeenCalled()
  })

  // A recovery code: spent, its entry IN the transaction, and its notice
  // only once the caller says its transaction committed.
  it('passes with a recovery code: its entry in the transaction, its notice after the commit', async () => {
    const { tx, update } = fakeTx({ left: 7 })
    const receipt = await service.confirm(tx, 7, mfaOn, {
      currentPassword: 'password123',
      mfaCode: 'abcde-23456',
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect(logInTransaction.mock.calls).toStrictEqual([
      [
        tx,
        {
          performedBy: 7,
          action: 'MFA_RECOVERY_CODE_USED',
          targetUserId: 7,
          entityType: 'users',
          entityId: 7,
          details: { remaining: 7 },
        },
      ],
    ])
    expect(sendRecoveryCodeUsedNotice).not.toHaveBeenCalled()

    receipt.afterCommit()
    expect(sendRecoveryCodeUsedNotice.mock.calls).toStrictEqual([
      [{ to: 'pat@example.com', firstName: 'Pat', remaining: 7 }],
    ])
  })

  it('refuses a recovery code that is unknown or used, writing no entry', async () => {
    const { tx } = fakeTx({ spent: [] })
    await expect(
      service.confirm(tx, 7, mfaOn, {
        currentPassword: 'password123',
        mfaCode: 'abcde-23456',
      }),
    ).rejects.toThrow(new BadRequestException(INVALID_RECOVERY_CODE_MESSAGE))
    expect(logInTransaction).not.toHaveBeenCalled()
  })

  // Fail closed: ON with no secret can't be stored (the CHECK), but if it
  // were, the code check must refuse — not be skipped.
  it('refuses when two-factor is on but there is no secret to check against', async () => {
    const { tx, update } = fakeTx()
    await expect(
      service.confirm(
        tx,
        7,
        { ...mfaOn, mfaSecret: null },
        { currentPassword: 'password123', mfaCode: goodCode },
      ),
    ).rejects.toThrow(new BadRequestException(INVALID_MFA_CODE_MESSAGE))
    expect(update).not.toHaveBeenCalled()
  })

  // The change is made whatever the mail server does: a failed notice is
  // logged with its reason, never thrown at the caller.
  it('logs a failed notice instead of throwing', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockReturnValue()
    sendRecoveryCodeUsedNotice.mockRejectedValue(new Error('smtp down'))
    const { tx } = fakeTx()
    const receipt = await service.confirm(tx, 7, mfaOn, {
      currentPassword: 'password123',
      mfaCode: 'abcde-23456',
    })

    expect(() => receipt.afterCommit()).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
    expect(log.mock.calls).toStrictEqual([
      ['Failed to send the recovery-code notice to pat@example.com: smtp down'],
    ])
  })
})
