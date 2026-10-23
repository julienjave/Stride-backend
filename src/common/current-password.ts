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

import { applyDecorators, BadRequestException } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import * as bcrypt from 'bcrypt'
import type { DrizzleDb } from '../database/drizzle.provider'
import { users } from '../database/schema'
import { INVALID_MFA_CODE_MESSAGE, useMfaCode } from '../mfa/totp'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// "Step-up authentication": a signed-in session proves someone signed in at
// some point — not that the account's owner is at the keyboard NOW (a browser
// left signed in, a stolen cookie). So the changes that would let someone
// take the account over ask for the current password again, even though the
// request is already signed in (decisions §12 for the email; §13 for the
// password itself).
//
// Four routes ask it today — changing the sign-in email, changing the
// password, starting two-factor set-up and turning two-factor off — and they
// must refuse in the same words and on the same rule, so the rule lives here
// once.
//
// For an account with two-factor sign-in ON, the password alone is not the
// step-up (decided with the person, MFA enrolment): a phished password plus a
// stolen session would otherwise move the account. So `confirmStepUp` asks
// for a current code too — the second factor the account chose, asked again
// at the moment it matters.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The one refusal for a wrong current password. The frontend reads it to put
// the message at the password field (emailChangeRules / passwordChangeRules).
export const WRONG_PASSWORD_MESSAGE = 'Your current password is not correct'

// An account with two-factor sign-in on, and no code sent. The frontend shows
// the code field only for such accounts; this is what a request without it
// gets (an older screen, a direct API call).
export const MFA_CODE_REQUIRED_MESSAGE =
  'Enter the 6-digit code from your authenticator app'

// The account's columns a step-up reads. Selected by the caller together with
// whatever else it needs, from the account's row LOCKED FOR UPDATE: the code
// check below records the code's step, and two requests with the same code
// must not both find it unused (mfa/totp.ts).
export const STEP_UP_COLUMNS = {
  passwordHash: users.passwordHash,
  mfaEnabled: users.mfaEnabled,
  mfaSecret: users.mfaSecret,
  mfaLastUsedStep: users.mfaLastUsedStep,
}

// --- TYPES -------------------------------------------------------------------------------------------------

export interface StepUpAccount {
  passwordHash: string | null
  mfaEnabled: boolean
  mfaSecret: string | null
  mfaLastUsedStep: number | null
}

// What the request brought: the password always; the code when it sent one.
export interface StepUpProof {
  currentPassword: string
  mfaCode?: string
}

// --- VALIDATION --------------------------------------------------------------------------------------------

// The DTO rule for a current-password field: the same limits as signing in
// (LoginDto). MinLength(1): an empty string is refused here, not compared
// with a hash. One decorator, so the four DTOs that ask for it can't drift.
export function IsCurrentPassword(): PropertyDecorator {
  return applyDecorators(IsString(), MinLength(1), MaxLength(128))
}

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

// Is `given` the account's current password? An account without a password
// (an invitation not yet accepted) has no "current password" to match: false,
// without asking bcrypt — `bcrypt.compare` with a null hash would throw.
// A signed-in account always has one (it can't sign in otherwise); the null
// case keeps TypeScript, and a corrupted row, on the safe side.
//
// Returns a boolean rather than throwing: each caller refuses with
// WRONG_PASSWORD_MESSAGE itself, so TypeScript can see — in the caller — that
// the row it read exists past the check.
export async function isCurrentPassword(
  passwordHash: string | null,
  given: string,
): Promise<boolean> {
  if (passwordHash === null) return false
  return bcrypt.compare(given, passwordHash)
}

// The whole step-up, inside the caller's transaction, on the locked row:
//   1. the password — always; a wrong one refuses before any code is looked at
//      (a code is not even spent on a request that fails here);
//   2. for an account with two-factor on, a current code: missing → its own
//      400, wrong or already used → mfa/totp.ts's words; a good one is
//      recorded as used in this transaction.
// Throws a 400 on any refusal — the transaction then rolls back, nothing is
// changed — and returns nothing when the person is who they say.
export async function confirmStepUp(
  tx: DrizzleDb,
  userId: number,
  account: StepUpAccount,
  proof: StepUpProof,
): Promise<void> {
  if (!(await isCurrentPassword(account.passwordHash, proof.currentPassword))) {
    throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
  }
  if (!account.mfaEnabled) return
  if (proof.mfaCode === undefined) {
    throw new BadRequestException(MFA_CODE_REQUIRED_MESSAGE)
  }
  // ON with no secret can't be stored (users_mfa_enabled_has_secret), but
  // TypeScript can't see a CHECK. If it ever happened, refuse — never skip
  // the code check because there is nothing to check it against.
  if (account.mfaSecret === null) {
    throw new BadRequestException(INVALID_MFA_CODE_MESSAGE)
  }
  await useMfaCode(
    tx,
    userId,
    { mfaSecret: account.mfaSecret, mfaLastUsedStep: account.mfaLastUsedStep },
    proof.mfaCode,
  )
}
