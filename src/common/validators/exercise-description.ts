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
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// An exercise's DESCRIPTION — its name, muscles, equipment and instructions —
// is written in three places: the library (POST and PATCH /exercises) and a
// program's own copy (PATCH /assigned-programs/:id/exercises/:rowId, edited
// per patient). Until 2026-10-14 each DTO had its own copy of the decorators,
// and the copies had drifted: the name was limited to 200 characters in the
// library but 255 on a program's copy. They also shared the same gaps, found
// live: `null` for any field was a 500 (the null trap, is-present.ts), and a
// BLANK name or list item was stored — `primaryMuscles: ["  "]` passed
// `ArrayMinSize(1)`, which counts items, not what they hold.
//
// So the rules are written ONCE, here, as composed decorators (Nest's
// applyDecorators, as IsProgramTitle does), and every DTO uses them. What a
// decorator here does NOT decide is whether the field may be ABSENT — that
// differs per DTO (required when creating, optional on a PATCH), so each DTO
// says it with @ValidateIf(isPresent) next to the rule. Never @IsOptional():
// every one of these columns is NOT NULL, and @IsOptional() lets `null`
// through to the database.

// --- LIMITS ------------------------------------------------------------------------------------------------

// The longest name a person may type. The columns are varchar(255); 200 is
// the library's limit (its form's too), so a program's copy can't hold a name
// the library would refuse.
export const EXERCISE_NAME_MAX_LENGTH = 200

// Each list, and what it may hold. `required` = at least one item: an
// exercise with no primary muscle or no instruction isn't a usable exercise.
// The two optional lists say "none" with an empty list, [] — the one way to
// say it (decided 2026-10-14): their columns are NOT NULL DEFAULT '{}', so
// `null` is refused rather than read as [].
//
// Instruction steps: 1,000 characters (was 500). 26 exercises of the
// imported library have a longer step (up to 744 characters — "Leg
// Extensions"), and a program copies its exercises as they are. The
// frontend sends a whole list when one item changes, so with 500 a typo fixed
// in step 1 would have been refused because of step 3. The column is `text`,
// so the database sets no limit of its own.
export const EXERCISE_LISTS = {
  primaryMuscles: {
    required: true,
    maxItems: 20,
    itemMaxLength: 100,
    item: 'primary muscle',
    article: 'A',
  },
  secondaryMuscles: {
    required: false,
    maxItems: 20,
    itemMaxLength: 100,
    item: 'secondary muscle',
    article: 'A',
  },
  equipment: {
    required: false,
    maxItems: 20,
    itemMaxLength: 100,
    item: 'piece of equipment',
    article: 'A',
  },
  instructions: {
    required: true,
    maxItems: 50,
    itemMaxLength: 1000,
    item: 'instruction step',
    article: 'An',
  },
} as const

export type ExerciseListField = keyof typeof EXERCISE_LISTS

// "At least one character that isn't whitespace, anywhere." Matches() passes
// when the regex finds one ANYWHERE (it isn't anchored), so '  Squat  '
// passes and '   ', '' and '\t\n' don't. Spaces around a real value are
// harmless and stored as sent (the pages trim before sending).
const NOT_BLANK = /\S/

// --- DECORATORS --------------------------------------------------------------------------------------------

// An exercise's name: a string, at most 200 characters, not blank.
export function IsExerciseName(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MaxLength(EXERCISE_NAME_MAX_LENGTH),
    Matches(NOT_BLANK, { message: "The exercise's name can't be blank" }),
  )
}

// One of the four lists: an array of strings, within its limits, no blank
// item, and — for the two required lists — at least one item. (`article`
// is stored with each noun: "A instruction step" was the first draft.)
//
// `each: true` applies a validator to every ITEM instead of to the array.
// The messages are written for a person: the frontend shows a 400's message
// as it comes.
export function IsExerciseList(field: ExerciseListField): PropertyDecorator {
  const { required, maxItems, itemMaxLength, item, article } =
    EXERCISE_LISTS[field]
  const decorators = [
    // An optional list's message says how to say "none": the one case where
    // a client is likely to have sent `null` on purpose.
    IsArray({
      message: required
        ? `${field} must be a list`
        : `${field} must be a list: send [] for none`,
    }),
    ArrayMaxSize(maxItems),
    IsString({ each: true }),
    MaxLength(itemMaxLength, { each: true }),
    Matches(NOT_BLANK, {
      each: true,
      message: `${article} ${item} can't be blank`,
    }),
  ]
  if (required) {
    decorators.push(
      ArrayMinSize(1, { message: `An exercise needs at least one ${item}` }),
    )
  }
  return applyDecorators(...decorators)
}
