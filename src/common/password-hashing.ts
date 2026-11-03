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

import * as bcrypt from 'bcrypt'

// --- THE COST ----------------------------------------------------------------------------------------------

// bcrypt's cost factor: each +1 doubles the work of hashing AND of checking a
// password (2^10 rounds ≈ 70 ms here). One constant, used by every place that
// hashes a password (sign-up of the first admin, accepting an invitation, a
// reset, a change) — and by DUMMY_PASSWORD_HASH below, which must cost
// exactly the same for the sign-in timing to stay equal.
export const PASSWORD_HASH_COST = 10

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_HASH_COST)
}

// --- THE DUMMY HASH: EQUAL TIMING AT SIGN-IN ---------------------------------------------------------------

// Sign-in answers the same 401 for an unknown email and a wrong password, so
// the ANSWER reveals nothing (found 2026-11-03, documentation stage 1). Its
// TIME did: a wrong password costs a bcrypt comparison (~70 ms), while an
// unknown email — or an invited account with no password yet — answered at
// once, so timing a few attempts told an attacker whether an address has an
// account. The fix: when there is no real hash to check against, check
// against this one, so every sign-in pays the same bcrypt cost. (The same
// kind of gap forgot-password had, closed in journal entry 28.)
//
// Why a FIXED value rather than one hashed when the server starts: it costs
// nothing at runtime, and bcrypt.compare() takes the same time against any
// hash of the same cost — the comparison's work is set by the cost written
// inside the hash (the "10" in "$2b$10$…"), not by the password it hides.
// The password behind it is 64 random hex characters, thrown away: nobody
// knows it, so no typed password can ever match. password-hashing.spec.ts
// checks its cost equals PASSWORD_HASH_COST — change the cost, and that test
// says to make a new one.
export const DUMMY_PASSWORD_HASH =
  '$2b$10$.6E/vc/jE.IVwQDyT/fOoei1Ml/ps8ezPlMkR/rZK2HxgBn4ugAPC'

// The sign-in check: the account's own hash, or the dummy one when there is
// none (no account, or no password chosen yet). Always one real bcrypt
// comparison; true only for a real hash that matches.
export async function passwordMatches(
  password: string,
  passwordHash: string | null | undefined,
): Promise<boolean> {
  const matches = await bcrypt.compare(
    password,
    passwordHash ?? DUMMY_PASSWORD_HASH,
  )
  // `&& passwordHash != null`: belt and braces — the dummy's password is
  // unknown, but a result against it must never count as a match.
  return matches && passwordHash != null
}
