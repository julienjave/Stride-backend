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

import { IsString, MaxLength, MinLength, ValidateIf } from 'class-validator'
import { IsCurrentPassword } from '../../common/current-password'
import { isPresent } from '../../common/validators/is-present'
import { IsMfaCode } from '../../mfa/totp'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /auth/password — changing one's own password from the profile
// (decisions §13). Both passwords in the BODY (never in a URL: URLs end up in
// logs).
export class ChangePasswordDto {
  // The step-up (common/current-password.ts): the same limits as signing in
  // (LoginDto) and as the email change — one decorator for the four DTOs
  // that ask it.
  @IsCurrentPassword()
  currentPassword!: string

  // The one rule for choosing a password — the same as accepting an
  // invitation and resetting (AcceptInvitationDto, ResetPasswordDto) and as
  // the frontend's newPasswordSchema: 8 to 128 characters. 128: bcrypt only
  // reads the first 72 bytes, and a bound keeps a megabyte "password" from
  // being hashed at all.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string

  // The step-up's second half, for an account with two-factor sign-in on
  // (the service asks for it then). Optional here — the DTO can't know the
  // account — but when SENT it must be a code: `ValidateIf(isPresent)`, not
  // `IsOptional()`, so `null` is refused rather than passed on as "no code".
  @ValidateIf(isPresent)
  @IsMfaCode()
  mfaCode?: string
}
