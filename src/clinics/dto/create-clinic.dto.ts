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

import {
  IsEmail,
  IsString,
  MaxLength,
  Length,
  IsOptional,
  ValidateIf,
} from 'class-validator'
import { hasStartedAddress } from '../../common/validators/has-started-address'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// logoPath is deliberately absent — same reasoning as avatarPath on users:
// a logo is a real file upload through StorageService, not a plain string
// field, and belongs as its own endpoint later.
export class CreateClinicDto {
  @IsString()
  @MaxLength(255)
  name!: string

  @IsEmail()
  @MaxLength(255)
  email!: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string

  // See has-started-address.ts for the full "optional as a unit, but
  // core fields required together once started" reasoning shared by
  // every address-bearing DTO.
  @ValidateIf(hasStartedAddress)
  @IsString()
  @MaxLength(255)
  addressLine1?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string

  @ValidateIf(hasStartedAddress)
  @IsString()
  @MaxLength(100)
  addressCity?: string

  // Not core — not every country has a state/province concept, so this
  // stays independently optional even once the rest of the address is
  // required.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressState?: string

  @ValidateIf(hasStartedAddress)
  @IsString()
  @MaxLength(20)
  addressPostalCode?: string

  // ISO 3166-1 alpha-2 — exactly 2 characters, the country dropdown's
  // value, not a display name.
  @ValidateIf(hasStartedAddress)
  @IsString()
  @Length(2, 2)
  addressCountry?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string
}
