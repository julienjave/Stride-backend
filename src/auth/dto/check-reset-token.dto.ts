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

import { IsString, MaxLength } from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /auth/reset-password/check — the token alone, with the same rule as
// ResetPasswordDto's. In the BODY, not the URL: a URL ends up in server and
// proxy logs, and this token is a key to the account for an hour.
export class CheckResetTokenDto {
  @IsString()
  @MaxLength(256)
  token!: string
}
