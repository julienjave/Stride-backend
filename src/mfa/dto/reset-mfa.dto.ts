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

import { ValidateIf } from 'class-validator'
import { IsCurrentPassword } from '../../common/current-password'
import { isPresent } from '../../common/validators/is-present'
import { IsSecondFactorCode } from '../second-factor'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /users/:id/mfa/reset — an admin turning someone else's two-factor
// sign-in off. The ADMIN's own step-up (the person's choice): their password,
// and — when THEIR account has MFA on — their own second factor. A stolen
// admin session alone must not be able to weaken any account.
export class ResetMfaDto {
  @IsCurrentPassword()
  currentPassword!: string

  // Only for an admin whose own account has MFA on (the service asks it
  // then); when sent, a code (`null` refused — see ChangePasswordDto).
  @ValidateIf(isPresent)
  @IsSecondFactorCode()
  mfaCode?: string
}
