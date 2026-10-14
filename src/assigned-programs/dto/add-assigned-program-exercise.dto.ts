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

import { OmitType } from '@nestjs/mapped-types'
import { IsInt, IsOptional, Min } from 'class-validator'
import { AssignedExerciseInputDto } from './assigned-exercise-input.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /assigned-programs/:id/exercises — one exercise added to an existing
// program: the same fields as an exercise in the inline list at creation,
// plus WHICH WORKOUT it goes into.
//
// Its own class rather than a `workoutId` on AssignedExerciseInputDto: that
// class is also the shape of each item in POST /assigned-programs' inline
// `exercises` list, where the program's workouts don't exist yet — a
// workoutId there could only be ignored, and silently ignoring part of a
// request hides the client's bug. Here, the field exists only where it means
// something.
//
// `sortOrder` is OPTIONAL here (step 3b-0), unlike in the inline list:
// without it the exercise goes after the workout's last one, a position the
// service works out inside its transaction — from the data as it is, not
// from the client's possibly stale copy. OmitType(…, ['sortOrder']) copies
// every other field WITH its validation decorators (that's what the
// mapped-types helpers are for), and the field is then declared again as
// optional; a plain `sortOrder?:` in a subclass wouldn't compile, because the
// parent declares it required.
export class AddAssignedProgramExerciseDto extends OmitType(
  AssignedExerciseInputDto,
  ['sortOrder'] as const,
) {
  // Optional: without it, the program's FIRST workout (resolveWorkoutId) —
  // what today's screens, which don't know about workouts yet, rely on.
  @IsOptional()
  @IsInt()
  workoutId?: number | null

  // A position asked for explicitly is still checked as before.
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number
}
