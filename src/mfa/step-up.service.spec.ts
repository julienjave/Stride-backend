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

import {
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import * as bcrypt from 'bcrypt'
import { OTP } from 'otplib'
import { SQL } from 'drizzle-orm'
import type { DrizzleDb } from '../database/drizzle.provider'
import type { AuditService } from '../audit/audit.service'
import type { EmailService } from '../email/email.service'
import type { MessagingEvents } from '../messaging/messaging-events'
import { encryptMfaSecret } from '../auth/mfa-secret-crypto'
import { WRONG_PASSWORD_MESSAGE } from '../common/current-password'
import { INVALID_MFA_CODE_MESSAGE, newMfaSecret } from './totp'
import { INVALID_RECOVERY_CODE_MESSAGE } from './second-factor'
import {
  MFA_CODE_REQUIRED_MESSAGE,
  STEP_UP_SIGNED_OUT_MESSAGE,
  type StepUpAccount,
  StepUpRefusedException,
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
    stepUpFailures: 0,
  }
  mfaOff = {
    ...person,
    passwordHash: hash,
    mfaEnabled: false,
    mfaSecret: null,
    mfaLastUsedStep: null,
    stepUpFailures: 0,
  }
})
afterAll(() => {
  process.env.MFA_ENCRYPTION_KEY = savedKey
})
// For it.each: its table is built before beforeAll runs, so it names the
// fixtures through functions read when each test runs.
const mfaOffLater = () => mfaOff
const mfaOnLater = () => mfaOn

// A stand-in for the transaction. The step-up's writes: an app code's step
// (`update().set().where()`, awaited) or a recovery code marked used
// (`update().set().where().returning()`), then the count of those left
// (`select().from().where()`). `where()` answers a THENABLE — awaitable
// itself, with a `returning()` — so both shapes work; `spent` is what
// RETURNING finds (an empty list = no such unused code).
function fakeTx({ spent = [{ id: 1 }] as unknown[], left = 7 } = {}) {
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
  // Raw SQL: the row-security settings, and the session's DELETE.
  const execute = jest.fn().mockResolvedValue({ rows: [] })
  return {
    tx: { update, select, execute } as unknown as DrizzleDb,
    update,
    set,
    execute,
  }
}

// The failure's own transaction (failureRecorder): the database runs the
// callback with a stand-in whose UPDATE … RETURNING answers the count after
// the increment (`failures`) — or nothing, for an account gone meanwhile.
function fakeDb(row: { failures: number } | null) {
  const fake = fakeTx({
    spent:
      row === null
        ? []
        : [{ ...row, email: 'pat@example.com', firstName: 'Pat' }],
  })
  const transaction = jest.fn((fn: (tx: DrizzleDb) => Promise<unknown>) =>
    fn(fake.tx),
  )
  return { db: { transaction } as unknown as DrizzleDb, transaction, ...fake }
}

let service: StepUpService
let logInTransaction: jest.Mock
let sendRecoveryCodeUsedNotice: jest.Mock
let sendStepUpSignOutNotice: jest.Mock
let disconnectSession: jest.Mock

// The service, with a database for failureRecorder's own transaction.
function serviceWith(db: DrizzleDb) {
  return new StepUpService(
    db,
    { logInTransaction } as unknown as AuditService,
    {
      sendRecoveryCodeUsedNotice,
      sendStepUpSignOutNotice,
    } as unknown as EmailService,
    { disconnectSession } as unknown as MessagingEvents,
  )
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  logInTransaction = jest.fn().mockResolvedValue(undefined)
  sendRecoveryCodeUsedNotice = jest.fn().mockResolvedValue(undefined)
  sendStepUpSignOutNotice = jest.fn().mockResolvedValue(undefined)
  disconnectSession = jest.fn()
  // confirm() never touches its own database — only the caller's `tx`.
  service = serviceWith({} as DrizzleDb)
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

  // Each wrong proof is a StepUpRefusedException carrying WHY — what
  // failureRecorder counts. Still a 400 with the same words (above).
  it.each([
    ['a wrong password', mfaOffLater, 'wrong', undefined, 'wrong_password'],
    ['a wrong app code', mfaOnLater, 'password123', '000000', 'wrong_code'],
    [
      'an unknown recovery code',
      mfaOnLater,
      'password123',
      'abcde-23456',
      'wrong_recovery_code',
    ],
  ])(
    'says why it refused %s',
    async (_name, account, currentPassword, mfaCode, reason) => {
      const { tx } = fakeTx({ spent: [] })
      const refusal = await service
        .confirm(tx, 7, account(), { currentPassword, mfaCode })
        .catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(StepUpRefusedException)
      expect((refusal as StepUpRefusedException).reason).toBe(reason)
    },
  )

  it('refuses a step-up made too early as a code already used', async () => {
    const { tx } = fakeTx()
    const refusal = await service
      .confirm(
        tx,
        7,
        { ...mfaOn, mfaLastUsedStep: STEP },
        { currentPassword: 'password123', mfaCode: goodCode },
      )
      .catch((error: unknown) => error)
    expect((refusal as StepUpRefusedException).reason).toBe('code_already_used')
  })

  // Not a failed proof: nothing was guessed — so not counted.
  it('asks for the code when two-factor is on and none was sent', async () => {
    const { tx } = fakeTx()
    const refusal = await service
      .confirm(tx, 7, mfaOn, { currentPassword: 'password123' })
      .catch((error: unknown) => error)
    expect(refusal).toStrictEqual(
      new BadRequestException(MFA_CODE_REQUIRED_MESSAGE),
    )
    expect(refusal).not.toBeInstanceOf(StepUpRefusedException)
  })

  // A step-up that passes ends the failures in a row — written only when
  // there were some.
  it('puts the failures in a row back to 0 when it passes', async () => {
    const off = fakeTx()
    await service.confirm(
      off.tx,
      7,
      { ...mfaOff, stepUpFailures: 3 },
      { currentPassword: 'password123' },
    )
    expect(off.set.mock.calls).toStrictEqual([[{ stepUpFailures: 0 }]])

    // With two-factor on: the code spent, then the count reset.
    const on = fakeTx()
    await service.confirm(
      on.tx,
      7,
      { ...mfaOn, stepUpFailures: 3 },
      { currentPassword: 'password123', mfaCode: goodCode },
    )
    expect(on.set.mock.calls).toStrictEqual([
      [{ mfaLastUsedStep: STEP }],
      [{ stepUpFailures: 0 }],
    ])
  })

  it('leaves the count alone when it fails', async () => {
    const { tx, set } = fakeTx()
    await expect(
      service.confirm(
        tx,
        7,
        { ...mfaOn, stepUpFailures: 3 },
        { currentPassword: 'password123', mfaCode: '000000' },
      ),
    ).rejects.toThrow(StepUpRefusedException)
    expect(set).not.toHaveBeenCalled()
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

describe('StepUpService.confirmPassword (two-factor set-up)', () => {
  it('refuses a wrong password as a counted failure', async () => {
    const { tx, set } = fakeTx()
    const refusal = await service
      .confirmPassword(tx, 7, { passwordHash: hash, stepUpFailures: 2 }, 'x')
      .catch((error: unknown) => error)
    // Still the 400 every caller answered before, with its words.
    expect(refusal).toBeInstanceOf(BadRequestException)
    expect(refusal).toMatchObject({
      message: WRONG_PASSWORD_MESSAGE,
      reason: 'wrong_password',
    })
    expect(set).not.toHaveBeenCalled()
  })

  it('passes, putting the count back to 0 only when there was one', async () => {
    const before = fakeTx()
    await service.confirmPassword(
      before.tx,
      7,
      { passwordHash: hash, stepUpFailures: 0 },
      'password123',
    )
    expect(before.update).not.toHaveBeenCalled()

    const after = fakeTx()
    await service.confirmPassword(
      after.tx,
      7,
      { passwordHash: hash, stepUpFailures: 4 },
      'password123',
    )
    expect(after.set.mock.calls).toStrictEqual([[{ stepUpFailures: 0 }]])
  })
})

describe('StepUpService.failureRecorder', () => {
  const pat = { id: 7, activeRole: 'patient' as never }
  const refused = () =>
    new StepUpRefusedException(WRONG_PASSWORD_MESSAGE, 'wrong_password')

  // Only a failed PROOF counts: any other refusal a change ends with (the
  // same password again, MFA already off…) passes through untouched, and
  // nothing is written.
  it('lets any other error through without recording anything', async () => {
    const { db, transaction } = fakeDb({ failures: 1 })
    const other = new ConflictException('Two-factor sign-in is already on')
    await expect(
      serviceWith(db).failureRecorder(pat, 'sid-1', 'mfa_setup')(other),
    ).rejects.toBe(other)
    expect(transaction).not.toHaveBeenCalled()
    expect(logInTransaction).not.toHaveBeenCalled()
  })

  // Under the limit: counted (+1, by the database), ONE entry with what was
  // tried and why — and the SAME refusal goes on to the client.
  it('counts and records a failure, then lets the refusal through', async () => {
    const { db, tx, set, execute } = fakeDb({ failures: 4 })
    const refusal = refused()
    await expect(
      serviceWith(db).failureRecorder(pat, 'sid-1', 'email_change')(refusal),
    ).rejects.toBe(refusal)

    // ONE write, of the count alone — as an SQL expression (`+ 1`, computed
    // by the database under the row's lock), never a number worked out here
    // from a value read earlier, which two failures at once could both read.
    const [[values]] = set.mock.calls as [[Record<string, unknown>]]
    expect(Object.keys(values)).toEqual(['stepUpFailures'])
    expect(values.stepUpFailures).toBeInstanceOf(SQL)
    expect(logInTransaction.mock.calls).toStrictEqual([
      [
        tx,
        {
          performedBy: 7,
          action: 'STEP_UP_FAILED',
          targetUserId: 7,
          entityType: 'users',
          entityId: 7,
          details: {
            purpose: 'email_change',
            reason: 'wrong_password',
            consecutiveFailures: 4,
          },
        },
      ],
    ])
    // The row-security settings only — no session deleted.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(disconnectSession).not.toHaveBeenCalled()
    expect(sendStepUpSignOutNotice).not.toHaveBeenCalled()
  })

  // The 5th in a row: the count back to 0, THIS session deleted, the entry
  // saying so — then its sockets closed, the owner told, and a 401.
  it('signs the session out at the 5th failure in a row', async () => {
    const { db, set, execute } = fakeDb({ failures: 5 })
    await expect(
      serviceWith(db).failureRecorder(pat, 'sid-1', 'mfa_disable')(refused()),
    ).rejects.toStrictEqual(
      new UnauthorizedException(STEP_UP_SIGNED_OUT_MESSAGE),
    )

    const writes = set.mock.calls as [Record<string, unknown>][]
    expect(writes[1]).toStrictEqual([{ stepUpFailures: 0 }])
    // The two row-security settings, then the session's DELETE.
    const statements = execute.mock.calls as [unknown][]
    expect(statements).toHaveLength(3)
    expect(JSON.stringify(statements[2][0])).toContain(
      'DELETE FROM session WHERE sid = ',
    )
    expect(JSON.stringify(statements[2][0])).toContain('"sid-1"')
    const [[, logged]] = logInTransaction.mock.calls as [[unknown, unknown]]
    expect(logged).toStrictEqual({
      performedBy: 7,
      action: 'STEP_UP_FAILED',
      targetUserId: 7,
      entityType: 'users',
      entityId: 7,
      details: {
        purpose: 'mfa_disable',
        reason: 'wrong_password',
        consecutiveFailures: 5,
        signedOut: true,
      },
    })
    expect(disconnectSession.mock.calls).toStrictEqual([['sid-1']])
    expect(sendStepUpSignOutNotice.mock.calls).toStrictEqual([
      [{ to: 'pat@example.com', firstName: 'Pat' }],
    ])
  })

  it('does not sign out below the limit', async () => {
    const { db } = fakeDb({ failures: 4 })
    await expect(
      serviceWith(db).failureRecorder(pat, 'sid-1', 'mfa_reset')(refused()),
    ).rejects.toBeInstanceOf(StepUpRefusedException)
    expect(disconnectSession).not.toHaveBeenCalled()
  })

  // The account deleted between the refusal and the record: nothing to
  // count — the refusal still goes out.
  it('records nothing for an account that is gone', async () => {
    const { db } = fakeDb(null)
    const refusal = refused()
    await expect(
      serviceWith(db).failureRecorder(pat, 'sid-1', 'mfa_setup')(refusal),
    ).rejects.toBe(refusal)
    expect(logInTransaction).not.toHaveBeenCalled()
  })

  it('logs a failed sign-out notice instead of throwing it', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockReturnValue()
    sendStepUpSignOutNotice.mockRejectedValue(new Error('smtp down'))
    const { db } = fakeDb({ failures: 5 })
    await expect(
      serviceWith(db).failureRecorder(
        pat,
        'sid-1',
        'password_change',
      )(refused()),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    await new Promise((resolve) => setImmediate(resolve))
    expect(log.mock.calls).toStrictEqual([
      [
        'Failed to send the step-up sign-out notice to pat@example.com: smtp down',
      ],
    ])
  })
})
