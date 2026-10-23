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

import { IsSecondFactorCode } from '../../mfa/second-factor'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// The second step of signing in (POST /auth/mfa/verify): a code from the
// authenticator app (6 digits) or one of the recovery codes
// (mfa/second-factor.ts). Confirming set-up has its own DTO (EnableMfaDto):
// it takes only an app code.
export class MfaCodeDto {
  @IsSecondFactorCode()
  code!: string
}
