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

// POST /users/:id/merge — the account in the address is merged AWAY into
// `intoUserId` (the one the admin chose to keep). The admin's own password
// (and a two-factor code, when theirs is on) — the step-up every change that
// can't be undone asks for (decisions §16), the person's choice for merges.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { IsInt, Min, ValidateIf } from 'class-validator'
import { IsCurrentPassword } from '../../common/current-password'
import { isPresent } from '../../common/validators/is-present'
import { IsSecondFactorCode } from '../../mfa/second-factor'

// --- DTO ---------------------------------------------------------------------------------------------------

export class MergePatientDto {
  // A user id: a positive integer (ids start at 1 — 0 or a negative number
  // is a mistake to answer with a 400, not a lookup that finds nothing).
  @IsInt()
  @Min(1)
  intoUserId!: number

  @IsCurrentPassword()
  currentPassword!: string

  @ValidateIf(isPresent)
  @IsSecondFactorCode()
  mfaCode?: string
}
