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

import { applyDecorators } from '@nestjs/common'
import { IsString, Matches, MaxLength } from 'class-validator'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The longest title a person may type (the column itself is varchar(255)).
export const PROGRAM_TITLE_MAX_LENGTH = 200

// --- DECORATOR ---------------------------------------------------------------------------------------------

// What a program's title must be, written ONCE for the two DTOs that take
// one: creating a program (POST /assigned-programs) and renaming it (PATCH
// /assigned-programs/:id). Two copies of three decorators would one day
// disagree — the first gap found here was exactly that kind: neither DTO
// refused a blank title (step 3b-2, 2026-10-14).
//
// - a string, at most PROGRAM_TITLE_MAX_LENGTH characters;
// - NOT BLANK: at least one character that isn't whitespace. @IsString()
//   accepts '' and '   ', and @MaxLength only limits the top, so both used to
//   be stored — a program with no visible name in every list and in the
//   audit log. `\S` is "any character that is not whitespace"; Matches()
//   passes when the regex finds one ANYWHERE (it isn't anchored), so
//   '  Knee  ' passes and '   ' doesn't. Spaces around a real title are
//   harmless and stored as sent (the program page trims before sending).
//
// applyDecorators (from Nest) combines several decorators into one; the
// result is applied exactly like the three written one under the other.
// What it does NOT include: whether the field may be absent. That differs
// per DTO — required when creating, @ValidateIf(isPresent) on the PATCH —
// so each DTO says it next to this one.
export function IsProgramTitle(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MaxLength(PROGRAM_TITLE_MAX_LENGTH),
    Matches(/\S/, { message: "The program's title can't be blank" }),
  )
}