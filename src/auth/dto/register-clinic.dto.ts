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

import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class RegisterClinicDto {
  // Clinic fields
  @IsString()
  clinicName!: string

  @IsEmail()
  clinicEmail!: string

  @IsOptional()
  @IsString()
  clinicPhone?: string

  @IsOptional()
  @IsString()
  clinicWebsite?: string

  // Founding admin account fields
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(8)
  password!: string

  @IsString()
  firstName!: string

  @IsString()
  lastName!: string

  @IsOptional()
  @IsString()
  position?: string
}