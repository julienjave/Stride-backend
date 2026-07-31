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

import { IsEmail, IsString, MinLength, MaxLength, IsDateString } from 'class-validator'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Deliberately has NO role field at all — unlike CreateUserDto. This endpoint
// only ever creates patient accounts; there's nothing for a client to
// override, because there's nothing to send in the first place.
export class RegisterDto {
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
 
  @IsDateString()
  dateOfBirth!: string
}