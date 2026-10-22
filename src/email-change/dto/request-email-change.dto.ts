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

import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'
import { NormalizeEmail } from '../../common/email-address'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /auth/email-change — the address to move the account to, and the
// current password: a session alone isn't enough to move the sign-in (a
// browser left signed in, a stolen cookie). Both in the BODY.
export class RequestEmailChangeDto {
  // Normalised like every email a request brings in (emails are
  // case-insensitive — common/email-address.ts), so "same as now" and
  // "already taken" are both judged on the stored spelling.
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(255)
  newEmail!: string

  // The same limits as signing in (LoginDto). MinLength(1): an empty string
  // is refused here, not compared with a hash.
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string
}
