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
  IsEnum,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  IsDateString,
  IsInt,
  ValidateIf,
  IsBoolean,
} from 'class-validator'
import { hasStartedAddress } from '../../common/validators/has-started-address'
import { NormalizeEmail } from '../../common/email-address'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A plain TS enum, kept in sync by hand with the roleEnum values in users.schema.ts.
// Used both for validation here AND for the if/else branching in the service below.
export enum UserRole {
  ADMIN = 'admin',
  PRACTITIONER = 'practitioner',
  PATIENT = 'patient',
}

export class CreateUserDto {
  // Trimmed and A–Z lowercased before validation (emails are case-insensitive
  // — common/email-address.ts): the account is stored, and invited, under the
  // one spelling the database accepts.
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(255)
  email!: string

  // No password field (removed with invitations, 2026-10-07): the person
  // chooses their own when accepting the invitation this creates. Sending
  // one now gets a 400 — the global ValidationPipe rejects unknown fields
  // (forbidNonWhitelisted), so an old client fails loudly instead of having
  // its password silently ignored.

  @IsEnum(UserRole)
  role!: UserRole

  @IsString()
  @MaxLength(100)
  firstName!: string

  @IsString()
  @MaxLength(100)
  lastName!: string

  // --- Common fields (every role) ---
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

  // --- Practitioner-only fields ---
  // @ValidateIf runs its callback against the whole DTO; the field below it is
  // only validated (and only required) when that callback returns true. For
  // every OTHER role, this field can be omitted entirely with no error.
  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PRACTITIONER)
  @IsString()
  @MaxLength(100)
  licenseNumber?: string

  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PRACTITIONER)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  specialties?: string[]

  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PRACTITIONER)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string

  // --- Patient-only field ---
  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PATIENT)
  @IsDateString()
  dateOfBirth?: string

  // --- Admin-only field ---
  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.ADMIN)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string

  // Optional — links the new user to a clinic via user_clinics at creation
  // time. This is what makes clinic-scoped queries (e.g. "this practitioner's
  // patients") actually have data to work with, rather than being correct
  // queries against permanently empty relationships.
  @IsOptional()
  @IsInt()
  clinicId?: number

  // "I've seen the warning, create it anyway" (decisions §27, pass 2). A
  // patient with the same name and date of birth found elsewhere makes the
  // request answer 409 `possible_duplicate`; sent again with this flag, the
  // creation goes ahead and its audit entry names the possible duplicates.
  // A warning, not a rule — two real people can share a name and a birthday.
  // Ignored for other roles (only a patient has a date of birth to match).
  @IsOptional()
  @IsBoolean()
  allowPossibleDuplicate?: boolean
}
