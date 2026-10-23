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

import { createHash } from 'crypto'
import {
  hashRecoveryCode,
  newRecoveryCodes,
  normaliseRecoveryCode,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
} from './recovery-codes'

// --- TESTS -------------------------------------------------------------------------------------------------

describe('newRecoveryCodes', () => {
  it('makes 10 different codes of two groups of 5', () => {
    const codes = newRecoveryCodes()
    expect(RECOVERY_CODE_COUNT).toBe(10)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
    }
  })

  // The alphabet leaves out what people misread. Over 500 codes (5,000
  // symbols) every one of the 31 symbols appears, and nothing else does.
  it('uses exactly the 31 symbols — no 0, 1, i, l or o', () => {
    const symbols = new Set(
      Array.from({ length: 50 }, () => newRecoveryCodes())
        .flat()
        .join('')
        .replace(/-/g, ''),
    )
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(31)
    expect([...symbols].sort()).toEqual([...RECOVERY_CODE_ALPHABET].sort())
  })

  // Each code's own symbols differ between calls (not a fixed list).
  it('makes new codes on every call', () => {
    expect(newRecoveryCodes()).not.toEqual(newRecoveryCodes())
  })
})

describe('normaliseRecoveryCode', () => {
  // What a person may type: either case, a hyphen, a space, or nothing
  // between the groups — one stored spelling.
  it.each([['abcde-23456'], ['ABCDE-23456'], ['abcde 23456'], ['AbCdE23456']])(
    'reads %p as abcde-23456',
    (input) => {
      expect(normaliseRecoveryCode(input)).toBe('abcde-23456')
    },
  )

  it.each([
    ['123456'], // an app code
    ['abcde-2345'], // one symbol short
    ['abcde-234567'], // one too many
    ['abcde--23456'], // two separators
    ['abcde_23456'], // another separator
    ['abcdi-23456'], // i is not in the alphabet
    ['abcd0-23456'], // nor 0
    [' abcde-23456'], // the DTO trims; this function doesn't guess
  ])('refuses %p', (input) => {
    expect(normaliseRecoveryCode(input)).toBeNull()
  })
})

describe('hashRecoveryCode', () => {
  const savedKey = process.env.MFA_ENCRYPTION_KEY
  afterEach(() => {
    process.env.MFA_ENCRYPTION_KEY = savedKey
  })

  it('answers 64 hex characters, the same for the same code', () => {
    process.env.MFA_ENCRYPTION_KEY = 'ab'.repeat(32)
    const hash = hashRecoveryCode('abcde-23456')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRecoveryCode('abcde-23456')).toBe(hash)
    expect(hashRecoveryCode('abcde-23457')).not.toBe(hash)
  })

  // A PINNED value: the stored hashes depend on this exact derivation (the
  // subkey, then the code). Changed by accident, every code already given to
  // a person would silently stop working — so the value is written down.
  it('derives the hash exactly as documented (a pinned value)', () => {
    process.env.MFA_ENCRYPTION_KEY = 'ab'.repeat(32)
    expect(hashRecoveryCode('abcde-23456')).toBe(
      '0353b0fec614e8ea78c5322bf0813cfbf5bd119a4db44a80734f795c5a5b8021',
    )
  })

  // KEYED: without the server's key, a guess can't be checked against a
  // stored hash — not a plain SHA-256 of the code, and not the same under
  // another key.
  it('depends on the key, and is not a plain SHA-256 of the code', () => {
    process.env.MFA_ENCRYPTION_KEY = 'ab'.repeat(32)
    const underOne = hashRecoveryCode('abcde-23456')
    process.env.MFA_ENCRYPTION_KEY = 'cd'.repeat(32)
    const underAnother = hashRecoveryCode('abcde-23456')
    expect(underAnother).not.toBe(underOne)
    const plain = createHash('sha256').update('abcde-23456').digest('hex')
    expect([underOne, underAnother]).not.toContain(plain)
  })
})
