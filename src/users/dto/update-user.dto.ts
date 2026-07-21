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


import { IsOptional, IsString } from 'class-validator';

// Deliberately narrow for now: only the fields it's actually safe to self-edit
// here. Email, role, and password changes are left out on purpose — those
// belong behind separate, more carefully guarded flows (email change often
// wants re-verification; password change belongs in AuthService, not here).
export class UpdateUserDto {
    @IsOptional()
    @IsString()
    firstName?: string

    @IsOptional()
    @IsString()
    lastName?: string

    @IsOptional()
    @IsString()
    avatarPath?: string
}