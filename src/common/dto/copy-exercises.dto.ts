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

import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator'
import { MAX_EXERCISES_PER_COPY } from '../exercise-copy'
import { WORKOUT_NAME_MAX_LENGTH } from '../workout-rules'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /programs/:id/exercises/copy and POST /assigned-programs/:id/exercises/copy
// (roadmap Phase 6.5) — one body for both:
//
//   { exerciseIds: [12, 13, 14], targetWorkoutId: 7 }             → into workout 7
//   { exerciseIds: [12, 13, 14], targetWorkoutId: null,
//     newWorkoutName: 'Warm-up' }                                  → into a NEW workout
//
// `targetWorkoutId: null` means "a new workout" — written out, never left
// to the key's absence: a client that forgot the field gets a 400, not a
// new workout it never asked for.
export class CopyExercisesDto {
  // The rows to copy (exercise ROWS of this template / program, not library
  // exercise ids). Each once: copying the same row twice in one request is
  // a client bug, not a request for two copies.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EXERCISES_PER_COPY)
  @ArrayUnique()
  @IsInt({ each: true })
  exerciseIds!: number[]

  // An existing workout of this resource (checked by the service — 404
  // otherwise), or null for a new one. Validated as an integer unless it is
  // exactly null — so undefined (the key missing) is refused.
  @ValidateIf((dto: CopyExercisesDto) => dto.targetWorkoutId !== null)
  @IsInt()
  targetWorkoutId!: number | null

  // The new workout's name, optional (blank = no name, normalizeWorkoutName
  // — like "Add a workout"). Only with targetWorkoutId: null: a name for an
  // existing workout would be ignored, so it's refused instead.
  @ValidateIf((dto: CopyExercisesDto) => dto.newWorkoutName != null)
  @ValidateBy({
    name: 'onlyForNewWorkout',
    validator: {
      validate: (_value: unknown, args) =>
        (args?.object as CopyExercisesDto).targetWorkoutId === null,
      defaultMessage: () =>
        'newWorkoutName is only allowed when targetWorkoutId is null',
    },
  })
  @IsString()
  @MaxLength(WORKOUT_NAME_MAX_LENGTH)
  newWorkoutName?: string | null
}
