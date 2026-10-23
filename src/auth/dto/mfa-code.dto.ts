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

import { IsMfaCode } from '../../mfa/totp'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A two-factor code alone: the second step of signing in (POST
// /auth/mfa/verify) and confirming set-up (POST /auth/mfa/enable). 6 digits
// (mfa/totp.ts — it used to be any 6 characters).
export class MfaCodeDto {
  @IsMfaCode()
  code!: string
}
