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

import { createHmac, randomInt } from 'crypto'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// Recovery codes for two-factor sign-in (decisions §14): the way back in on
// the day the phone is lost. Ten of them, shown once; each works once,
// wherever a code from the authenticator app is asked.
//
// THE SHAPE: 10 characters in two groups, "k7m2p-x9q4h". The alphabet leaves
// out the characters people misread — 0 / o, 1 / l / i — so 31 symbols:
// 10 × log2(31) ≈ 49.5 bits of randomness per code. Plenty against ONLINE
// guessing (each try is a throttled request, 5 a minute), but not enough on
// its own against OFFLINE guessing: with a stolen database and a plain
// SHA-256 hash, a GPU tries ~10 billion hashes a second, and 2^49.5 is about
// 8 × 10^14 — one code in a day or so.
//
// So the stored value is a KEYED hash (HMAC-SHA256), with a key that lives
// outside the database — derived from MFA_ENCRYPTION_KEY, the key that
// already protects the TOTP secrets. Without the key a guess can't even be
// checked: a copy of the database alone is useless, the same promise the
// encrypted secret makes. (bcrypt would also slow guessing, but a use would
// then compare the typed code against up to ten slow hashes; a keyed hash
// is one fast, exact lookup.) The reset and invitation tokens get away with
// plain SHA-256 because they are 256 random bits — far beyond any guessing.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10

// 23 letters (no i, l, o) and 8 digits (no 0, 1).
export const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

// What a person may TYPE for one: either case, the hyphen or a space
// between the groups, or nothing (pasted without it).
export const RECOVERY_CODE_INPUT =
  /^[a-hjkmnp-z2-9]{5}[- ]?[a-hjkmnp-z2-9]{5}$/i

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

// Ten new codes. `randomInt` draws from the operating system's secure
// generator (crypto) and is unbiased for any range — `byte % 31` would make
// the first symbols slightly likelier.
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let symbols = ''
    for (let i = 0; i < 10; i += 1) {
      symbols +=
        RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)]
    }
    return `${symbols.slice(0, 5)}-${symbols.slice(5)}`
  })
}

// The one spelling a code is hashed in: lowercase, the hyphen between the
// groups. Null when the input isn't a recovery code at all.
export function normaliseRecoveryCode(input: string): string | null {
  if (!RECOVERY_CODE_INPUT.test(input)) return null
  // The pattern allows one separator at most, so removing the first one
  // leaves the 10 symbols.
  const symbols = input.toLowerCase().replace(/[- ]/, '')
  return `${symbols.slice(0, 5)}-${symbols.slice(5)}`
}

// The stored form of a normalised code. The key: an HMAC of a fixed label
// under MFA_ENCRYPTION_KEY — a SUBKEY, so the encryption key itself is
// never used for two different jobs ("domain separation"). Read at each
// call, like mfa-secret-crypto (validateEnv guarantees it at boot; tests
// set their own).
export function hashRecoveryCode(code: string): string {
  const subkey = createHmac(
    'sha256',
    Buffer.from(process.env.MFA_ENCRYPTION_KEY!, 'hex'),
  )
    .update('stride:mfa-recovery-codes')
    .digest()
  return createHmac('sha256', subkey).update(code).digest('hex')
}
