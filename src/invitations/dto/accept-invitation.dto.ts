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

import { IsString, MaxLength, MinLength } from 'class-validator'
import { InvitationTokenDto } from './invitation-token.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// The token plus the password the person chooses. Same password rules as
// every other place a password is set (ResetPasswordDto, CreateUserDto): at
// least 8 characters, at most 128 — bcrypt only reads the first 72 bytes,
// and the cap stops someone sending megabytes to be hashed.
//
// Field named `password`, like registration: the request logger redacts
// req.body.password (app.module.ts), should bodies ever be logged.
export class AcceptInvitationDto extends InvitationTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string
}