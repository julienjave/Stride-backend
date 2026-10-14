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

import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator'
import { isPresent } from '../../common/validators/is-present'
import { IsTitle } from '../../common/validators/title'
import { TEMPLATE_DESCRIPTION_MAX_LENGTH } from './create-template.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Written out field by field, no longer `PartialType(CreateTemplateDto)`.
// PartialType makes every field optional by adding @IsOptional() — and
// @IsOptional() skips the checks for `null` as well as for "not sent". The
// title's column is NOT NULL, so `PATCH /programs/:id { "title": null }`
// passed validation and reached the database: a NOT NULL violation, a 500
// instead of a 400 (the null trap — is-present.ts; the exercise DTOs left
// PartialType for the same reason in step D-1).
//
// So each field says how it may be absent, by what its column allows:
// - title: NOT NULL → @ValidateIf(isPresent): not sent = keep the stored
//   one; sent (null included) = checked by the same rule as when creating.
// - description: nullable, and null MEANS something — "clear the
//   description" (programs.e2e-spec.ts tests it) → @IsOptional().
export class UpdateTemplateDto {
  @ValidateIf(isPresent)
  @IsTitle('template')
  title?: string

  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_DESCRIPTION_MAX_LENGTH)
  description?: string | null
}
