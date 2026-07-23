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
  IsEnum,
  IsOptional,
  IsArray,
  IsDateString,
  IsInt,
  ValidateIf,
} from 'class-validator'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A plain TS enum, kept in sync by hand with the roleEnum values in users.schema.ts.
// Used both for validation here AND for the if/else branching in the service below.
export enum UserRole {
  ADMIN = 'admin',
  PRACTITIONER = 'practitioner',
  PATIENT = 'patient',
}

export class CreateUserDto {
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(8)
  password!: string // the PLAIN password from the request — never stored as-is, see service

  @IsEnum(UserRole)
  role!: UserRole

  @IsString()
  firstName!: string

  @IsString()
  lastName!: string

  // --- Practitioner-only fields ---
  // @ValidateIf runs its callback against the whole DTO; the field below it is
  // only validated (and only required) when that callback returns true. For
  // every OTHER role, this field can be omitted entirely with no error.
  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PRACTITIONER)
  @IsString()
  licenseNumber?: string

  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PRACTITIONER)
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialties?: string[]

  // --- Patient-only field ---
  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.PATIENT)
  @IsDateString()
  dateOfBirth?: string

  // --- Admin-only field ---
  @ValidateIf((dto: CreateUserDto) => dto.role === UserRole.ADMIN)
  @IsOptional()
  @IsString()
  position?: string


  // Optional — links the new user to a clinic via user_clinics at creation
  // time. This is what makes clinic-scoped queries (e.g. "this practitioner's
  // patients") actually have data to work with, rather than being correct
  // queries against permanently empty relationships.
  @IsOptional()
  @IsInt()
  clinicId?: number
}
