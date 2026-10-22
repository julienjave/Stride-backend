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

// POST /auth/email-change/confirm and /cancel — the token from the emailed
// link, in the BODY (a URL ends up in server and proxy logs, and the confirm
// token moves an account for 24 hours). The same rule as the reset token
// (CheckResetTokenDto): a string of bounded length; any other value simply
// matches no request.
export class EmailChangeTokenDto {
  @IsString()
  @MaxLength(256)
  token!: string
}
