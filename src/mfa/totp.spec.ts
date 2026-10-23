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
import { OTP } from 'otplib'
import type { DrizzleDb } from '../database/drizzle.provider'
import { encryptMfaSecret } from '../auth/mfa-secret-crypto'
import {
  checkMfaCode,
  INVALID_MFA_CODE_MESSAGE,
  IsTotpCode,
  MFA_CODE_ALREADY_USED_MESSAGE,
  MFA_CODE_FORMAT_MESSAGE,
  mfaCodeRefusalMessage,
  mfaKeyUri,
  newMfaSecret,
  useMfaCode,
} from './totp'

// --- FIXTURES ----------------------------------------------------------------------------------------------

// A real secret, really encrypted (the module reads MFA_ENCRYPTION_KEY when
// it runs, so a test key set here is the one used), and real codes computed
// by otplib for a PINNED clock — far from today, so no test depends on when
// it runs. 10 seconds into a 30-second window: `STEP` is that window.
const NOW_MS = Date.parse('2031-03-04T10:00:10Z')
const STEP = Math.floor(NOW_MS / 1000 / 30)
const otp = new OTP({ strategy: 'totp' })
const savedKey = process.env.MFA_ENCRYPTION_KEY

let secret: string
let stored: string
// The code the app shows at a given step (its window's first second).
const codeAt = (step: number) => otp.generate({ secret, epoch: step * 30 })

beforeAll(() => {
  process.env.MFA_ENCRYPTION_KEY = 'ab'.repeat(32)
  secret = newMfaSecret()
  stored = encryptMfaSecret(secret)
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

// --- TESTS -------------------------------------------------------------------------------------------------

describe('checkMfaCode', () => {
  it("accepts the current window's code and answers its step", async () => {
    await expect(
      checkMfaCode(
        { mfaSecret: stored, mfaLastUsedStep: null },
        await codeAt(STEP),
      ),
    ).resolves.toStrictEqual({ ok: true, step: STEP })
  })

  // Tolerance 0: the code of the window just before or after is refused —
  // the server accepts only the current 30 seconds.
  it('refuses a wrong code, and the codes of the neighbouring windows', async () => {
    for (const code of [
      '000000',
      await codeAt(STEP - 1),
      await codeAt(STEP + 1),
    ]) {
      await expect(
        checkMfaCode({ mfaSecret: stored, mfaLastUsedStep: null }, code),
      ).resolves.toStrictEqual({ ok: false, reason: 'wrong_code' })
    }
  })

  // No code works twice (RFC 6238 §5.2).
  it("refuses a right code when its step is the account's last used one", async () => {
    await expect(
      checkMfaCode(
        { mfaSecret: stored, mfaLastUsedStep: STEP },
        await codeAt(STEP),
      ),
    ).resolves.toStrictEqual({ ok: false, reason: 'code_already_used' })
  })

  it('accepts it when the last used code was of an earlier window', async () => {
    await expect(
      checkMfaCode(
        { mfaSecret: stored, mfaLastUsedStep: STEP - 1 },
        await codeAt(STEP),
      ),
    ).resolves.toStrictEqual({ ok: true, step: STEP })
  })

  // The `<=`: a clock moved BACK (an NTP correction) after a code of a later
  // window was used must not reopen the window it came from.
  it('refuses it when a code of a LATER window was already used', async () => {
    await expect(
      checkMfaCode(
        { mfaSecret: stored, mfaLastUsedStep: STEP + 1 },
        await codeAt(STEP),
      ),
    ).resolves.toStrictEqual({ ok: false, reason: 'code_already_used' })
  })

  // A wrong code is a wrong code, whatever was used before.
  it('says "wrong", not "already used", for a wrong code after a use', async () => {
    await expect(
      checkMfaCode({ mfaSecret: stored, mfaLastUsedStep: STEP }, '000000'),
    ).resolves.toStrictEqual({ ok: false, reason: 'wrong_code' })
  })
})

describe('mfaCodeRefusalMessage', () => {
  it('words each refusal', () => {
    expect(mfaCodeRefusalMessage('wrong_code')).toBe(INVALID_MFA_CODE_MESSAGE)
    expect(mfaCodeRefusalMessage('code_already_used')).toBe(
      MFA_CODE_ALREADY_USED_MESSAGE,
    )
  })
})

describe('useMfaCode', () => {
  // A stand-in for the transaction: records the UPDATE's values and WHERE.
  function fakeTx() {
    const set = jest.fn()
    const where = jest.fn().mockResolvedValue(undefined)
    set.mockReturnValue({ where })
    const update = jest.fn().mockReturnValue({ set })
    return { tx: { update } as unknown as DrizzleDb, update, set, where }
  }

  it("records a good code's step on the account", async () => {
    const { tx, update, set, where } = fakeTx()
    await useMfaCode(
      tx,
      7,
      { mfaSecret: stored, mfaLastUsedStep: null },
      await codeAt(STEP),
    )
    expect(update).toHaveBeenCalledTimes(1)
    expect(set.mock.calls).toStrictEqual([[{ mfaLastUsedStep: STEP }]])
    expect(where).toHaveBeenCalledTimes(1)
  })

  it('refuses in words, and records nothing, for a wrong or a used code', async () => {
    const { tx, update } = fakeTx()
    await expect(
      useMfaCode(tx, 7, { mfaSecret: stored, mfaLastUsedStep: null }, '000000'),
    ).rejects.toThrow(new BadRequestException(INVALID_MFA_CODE_MESSAGE))
    await expect(
      useMfaCode(
        tx,
        7,
        { mfaSecret: stored, mfaLastUsedStep: STEP },
        await codeAt(STEP),
      ),
    ).rejects.toThrow(new BadRequestException(MFA_CODE_ALREADY_USED_MESSAGE))
    expect(update).not.toHaveBeenCalled()
  })
})

describe('mfaKeyUri', () => {
  // What the QR code carries: the authenticator app names the entry from
  // the issuer and the label, and computes codes from the secret.
  it('names Stride and the account, and carries the secret', () => {
    const uri = new URL(mfaKeyUri('jane@example.com', 'JBSWY3DPEHPK3PXP'))
    expect(uri.protocol).toBe('otpauth:')
    expect(uri.host).toBe('totp')
    expect(decodeURIComponent(uri.pathname)).toBe('/Stride:jane@example.com')
    expect(uri.searchParams.get('issuer')).toBe('Stride')
    expect(uri.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP')
  })
})

describe('IsTotpCode', () => {
  class Body {
    @IsTotpCode()
    code!: unknown
  }
  const errorsFor = async (code: unknown) =>
    (await validate(plainToInstance(Body, { code }))).flatMap((error) =>
      Object.values(error.constraints ?? {}),
    )

  it('accepts 6 digits, a leading zero included', async () => {
    await expect(errorsFor('012345')).resolves.toStrictEqual([])
  })

  // It used to be `Length(6, 6)`: any 6 characters reached otplib.
  it.each([['12345a'], ['12345'], ['1234567'], [' 12345'], ['']])(
    'refuses %p with its own words',
    async (code) => {
      await expect(errorsFor(code)).resolves.toStrictEqual([
        MFA_CODE_FORMAT_MESSAGE,
      ])
    },
  )

  it('refuses a number or null — a code is text', async () => {
    for (const code of [123456, null]) {
      await expect(errorsFor(code)).resolves.toContain('code must be a string')
    }
  })
})
