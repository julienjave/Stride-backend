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

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// What a TITLE must be — a program template's and an assigned program's —
// written once for the four DTOs that take one: creating and renaming a
// template (POST / PATCH /programs), creating and renaming a program (POST /
// PATCH /assigned-programs). It began as IsProgramTitle (step 3b-2,
// 2026-10-14), in assigned-programs/dto/, when neither program DTO refused a
// blank title; the templates' DTOs had the same gap (and the null trap on
// the PATCH), so the rule moved here and both resources use it ("Blank titles
// refused everywhere", 2026-10-14). Same pattern as exercise-description.ts.

// --- LIMITS ------------------------------------------------------------------------------------------------

// The longest title a person may type — templates and programs alike (the
// columns are varchar(255)). ONE number on purpose: assigning a template
// copies its title into the new program (the assign form prefills it), and
// duplicating a template builds "Copy of …" trimmed to this limit
// (ProgramsService.buildDuplicateTitle). Two constants that happened to be
// equal could drift, and a template's title would then open the assign form
// as "too long" before the practitioner typed anything.
export const TITLE_MAX_LENGTH = 200

// --- MESSAGES ----------------------------------------------------------------------------------------------

// Which resource a title belongs to — a union of two words rather than any
// string, so every message is one of two known sentences, and a typo in a
// DTO ('templte') is a compile error, not a strange message.
export type TitledResource = 'template' | 'program'

// "The template's title can't be blank" / "The program's title can't be
// blank": each names its resource (decided 2026-10-14), and the program's is
// exactly the sentence 3b-2 used. Exported because two places say it: the
// decorator below (the request's check) and the exception filter, which
// gives the same 400 if a blank title ever reaches the database's CHECK
// (migration 0035) without passing through these DTOs.
export function blankTitleMessage(resource: TitledResource): string {
  return `The ${resource}'s title can't be blank`
}

// --- DECORATOR ---------------------------------------------------------------------------------------------

// - a string, at most TITLE_MAX_LENGTH characters;
// - NOT BLANK: at least one character that isn't whitespace. @IsString()
//   accepts '' and '   ', and @MaxLength only limits the top, so both used to
//   be stored — a template or program with no visible name in every list and
//   in the audit log. `\S` is "any character that is not whitespace";
//   Matches() passes when the regex finds one ANYWHERE (it isn't anchored),
//   so '  Knee  ' passes and '   ' doesn't. Spaces around a real title are
//   harmless and stored as sent (the screens trim before sending).
//
// applyDecorators (from Nest) combines several decorators into one; the
// result is applied exactly like the three written one under the other.
// What it does NOT include: whether the field may be absent. That differs
// per DTO — required when creating, @ValidateIf(isPresent) on a PATCH (never
// @IsOptional(): the column is NOT NULL — is-present.ts) — so each DTO says
// it next to this one.
export function IsTitle(resource: TitledResource): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MaxLength(TITLE_MAX_LENGTH),
    Matches(/\S/, { message: blankTitleMessage(resource) }),
  )
}