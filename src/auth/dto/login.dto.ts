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

import { IsEmail, IsString, MaxLength, IsOptional, IsEnum } from 'class-validator'
import { UserRole } from '../../users/dto/create-user.dto'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string
 
  @IsString()
  @MaxLength(128)
  password!: string
 
  // Only required if the account holds more than one role. Now genuinely
  // validated and used directly — login() reads this DTO normally via
  // @Body(), unlike the earlier LocalStrategy-based version where this
  // field bypassed validation entirely (read straight off req.body before
  // ValidationPipe ever ran).
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole
}