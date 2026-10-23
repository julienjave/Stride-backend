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

import { applyDecorators } from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import * as bcrypt from 'bcrypt'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// "Step-up authentication": a signed-in session proves someone signed in at
// some point — not that the account's owner is at the keyboard NOW (a browser
// left signed in, a stolen cookie). So the changes that would let someone
// take the account over ask for the current password again, even though the
// request is already signed in (decisions §12 for the email; §13 for the
// password itself).
//
// Every route that re-asks the password must refuse in the same words and on
// the same rule, so the PASSWORD half lives here once. For an account with
// two-factor sign-in on, the step-up asks a second factor too — that half,
// and the whole step-up, is StepUpService (mfa/step-up.service.ts).

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The one refusal for a wrong current password. The frontend reads it to put
// the message at the password field (emailChangeRules / passwordChangeRules).
export const WRONG_PASSWORD_MESSAGE = 'Your current password is not correct'

// --- VALIDATION --------------------------------------------------------------------------------------------

// The DTO rule for a current-password field: the same limits as signing in
// (LoginDto). MinLength(1): an empty string is refused here, not compared
// with a hash. One decorator, so the DTOs that ask for it can't drift.
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
