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
  IsEnum,
  IsString,
  MaxLength,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  IsDateString,
  ValidateIf,
  IsBoolean,
} from 'class-validator'
import { UserRole } from './create-user.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Mirrors CreateUserDto's conditional-field pattern: granting a NEW role to
// an existing user still needs that role's own profile data (a license
// number for a newly-granted practitioner role, etc.), since the account
// may never have needed those fields before.
export class GrantRoleDto {
  @IsEnum(UserRole)
  role!: UserRole

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.PRACTITIONER)
  @IsString()
  @MaxLength(100)
  licenseNumber?: string

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.PRACTITIONER)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  specialties?: string[]

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.PRACTITIONER)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.PATIENT)
  @IsDateString()
  dateOfBirth?: string

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.ADMIN)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string

  // "I've seen the warning, create it anyway" (decisions §27, pass 2). A
  // patient with the same name and date of birth found elsewhere makes the
  // request answer 409 `possible_duplicate`; sent again with this flag, the
  // creation goes ahead and its audit entry names the possible duplicates.
  // A warning, not a rule — two real people can share a name and a birthday.
  // Ignored for other roles, and when the account already has a patient
  // profile (no new patient record is made then).
  @IsOptional()
  @IsBoolean()
  allowPossibleDuplicate?: boolean
}
