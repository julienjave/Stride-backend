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
  MinLength,
  MaxLength,
  Length,
  IsOptional,
  ValidateIf,
} from 'class-validator'
import { hasStartedAddress } from '../../common/validators/has-started-address'
import { NormalizeEmail } from '../../common/email-address'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// This DTO carries TWO separate addresses — the clinic's and the
// founding admin's own — so hasStartedAddress (which expects
// addressLine1/addressCity/addressPostalCode/addressCountry keys) needs
// a small adapter for the clinic's differently-prefixed fields. The
// admin's own address fields match the shared helper's expected names
// exactly, so those use it directly, same as CreateUserDto.
function hasStartedClinicAddress(dto: RegisterClinicDto): boolean {
  return hasStartedAddress({
    addressLine1: dto.clinicAddressLine1,
    addressCity: dto.clinicAddressCity,
    addressPostalCode: dto.clinicAddressPostalCode,
    addressCountry: dto.clinicAddressCountry,
  })
}

export class RegisterClinicDto {
  // Clinic fields
  @IsString()
  @MaxLength(255)
  clinicName!: string

  @IsEmail()
  @MaxLength(255)
  clinicEmail!: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  clinicPhone?: string

  @ValidateIf(hasStartedClinicAddress)
  @IsString()
  @MaxLength(255)
  clinicAddressLine1?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clinicAddressLine2?: string

  @ValidateIf(hasStartedClinicAddress)
  @IsString()
  @MaxLength(100)
  clinicAddressCity?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  clinicAddressState?: string

  @ValidateIf(hasStartedClinicAddress)
  @IsString()
  @MaxLength(20)
  clinicAddressPostalCode?: string

  @ValidateIf(hasStartedClinicAddress)
  @IsString()
  @Length(2, 2)
  clinicAddressCountry?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clinicWebsite?: string

  // Founding admin account fields
  // Trimmed and A–Z lowercased before validation (emails are case-insensitive
  // — common/email-address.ts). Not clinicEmail above: that is the clinic's
  // CONTACT address, shown to patients, not anyone's sign-in — stored as
  // typed.
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(255)
  email!: string

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string

  @IsString()
  @MaxLength(100)
  firstName!: string

  @IsString()
  @MaxLength(100)
  lastName!: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string

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

  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressState?: string

  @ValidateIf(hasStartedAddress)
  @IsString()
  @MaxLength(20)
  addressPostalCode?: string

  @ValidateIf(hasStartedAddress)
  @IsString()
  @Length(2, 2)
  addressCountry?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string
}
