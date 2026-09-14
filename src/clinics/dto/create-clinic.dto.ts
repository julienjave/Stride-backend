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

import { IsEmail, IsString, MaxLength, IsOptional } from 'class-validator'

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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string
}
