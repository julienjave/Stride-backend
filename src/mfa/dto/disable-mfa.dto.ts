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

import { IsCurrentPassword } from '../../common/current-password'
import { IsSecondFactorCode } from '../second-factor'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /auth/mfa/disable — turning two-factor sign-in OFF removes a factor,
// so it asks for both (decided with the person, MFA enrolment): the current
// password AND a current code. The code alone (as before) let anyone holding
// the phone and a session turn it off; the password alone would let anyone
// with a phished password and a session do it. The step-up rule
// (StepUpService) — here the code is always required, since the account has
// MFA on. A recovery code counts (the person's choice): someone who lost the
// phone has nothing else to turn it off with.
export class DisableMfaDto {
  @IsCurrentPassword()
  currentPassword!: string

  @IsSecondFactorCode()
  code!: string
}
