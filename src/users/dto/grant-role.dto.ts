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

import { IsEnum, IsString, IsOptional, IsArray, IsDateString, ValidateIf } from 'class-validator'
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
  licenseNumber?: string

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.PRACTITIONER)
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialties?: string[]

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.PATIENT)
  @IsDateString()
  dateOfBirth?: string

  @ValidateIf((dto: GrantRoleDto) => dto.role === UserRole.ADMIN)
  @IsOptional()
  @IsString()
  position?: string
}