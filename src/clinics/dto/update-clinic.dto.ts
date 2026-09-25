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

import { OmitType, PartialType } from '@nestjs/mapped-types'
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator'
import { CreateClinicDto } from './create-clinic.dto'
import { isPresent } from '../../common/validators/is-present'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// PartialType makes every CreateClinicDto field optional — right for a
// PATCH — by adding @IsOptional() to each. But @IsOptional() also lets
// `null` through, and `name`/`email` are NOT NULL columns: `{ name: null }`
// used to pass validation and fail in Postgres as a 500.
//
// So those two are LEFT OUT of the PartialType (OmitType removes them
// first) and declared again below with `@ValidateIf(isPresent)`: they may
// be omitted, but a value that IS sent must be a real one. The same fix,
// and the same helper, as UpdateUserDto's required fields; the same trap
// as the weight both-or-neither bug (see deferred-improvements.md).
//
// Every other field keeps PartialType's @IsOptional(), where null is
// meaningful: "clear the phone / website / address".
export class UpdateClinicDto extends PartialType(
  OmitType(CreateClinicDto, ['name', 'email'] as const),
) {
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string

  @ValidateIf(isPresent)
  @IsEmail()
  @MaxLength(255)
  email?: string
}