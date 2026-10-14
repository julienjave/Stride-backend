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
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'
import {
  IsExerciseList,
  IsExerciseName,
} from '../../common/validators/exercise-description'
import { hasStartedWeight } from '../../common/validators/has-started-weight'
import { isPresent } from '../../common/validators/is-present'

// --- DATA TRANSFER OBJECT -----------------------------------------------------------------------------------

// No longer PartialType(OmitType(AssignedExerciseInputDto, [...])) —
// that derivation stopped being the right mechanism once name/muscles/
// equipment/instructions became independently editable HERE. Those
// fields don't exist on AssignedExerciseInputDto at all (a client never
// supplies them at creation time; they're always server-snapshotted from
// the referenced exercise — see AssignedProgramsService's
// fetchExerciseSnapshots), so deriving this class from that one would
// mean either adding fields to the CREATE dto that make no sense there,
// or not being able to express this dto's real shape at all. An
// explicit class says plainly what this endpoint actually accepts.
export class UpdateAssignedProgramExerciseDto {
  // --- The program's own copy of the description, editable per patient -----
  // The same rules as the library's exercises (exercise-description.ts —
  // one definition shared by CreateExerciseDto, UpdateExerciseDto and this
  // DTO): it is the same KIND of data, just this patient's copy of it.
  //
  // Each field optional (PATCH: only what is sent changes), but with
  // @ValidateIf(isPresent), never @IsOptional(): the five columns are NOT
  // NULL, and @IsOptional() let `{ "name": null }` through to Postgres — a
  // 500, checked live 2026-10-14 for each of the five. Now `null` is a 400.
  // For the two optional lists "none" is [] (the message says so), the one
  // way to spell it — decided with the person, 2026-10-14. Also refused now:
  // a blank name, and a blank item in any list (`primaryMuscles: ["  "]` used
  // to satisfy "at least one primary muscle").

  @ValidateIf(isPresent)
  @IsExerciseName()
  name?: string

  @ValidateIf(isPresent)
  @IsExerciseList('primaryMuscles')
  primaryMuscles?: string[]

  @ValidateIf(isPresent)
  @IsExerciseList('secondaryMuscles')
  secondaryMuscles?: string[]

  @ValidateIf(isPresent)
  @IsExerciseList('equipment')
  equipment?: string[]

  @ValidateIf(isPresent)
  @IsExerciseList('instructions')
  instructions?: string[]

  // --- Per-patient prescription fields ------------------------------------
  // Unchanged from the previous PartialType(OmitType(...)) derivation —
  // same fields, same validators, just now written out explicitly here
  // instead of inherited.

  @IsOptional()
  @IsInt()
  @Min(1)
  sets?: number

  @IsOptional()
  @IsInt()
  @Min(1)
  reps?: number

  @IsOptional()
  @IsInt()
  @Min(1)
  durationInSeconds?: number

  @ValidateIf(hasStartedWeight)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weight?: number

  @ValidateIf(hasStartedWeight)
  @IsIn(['kg', 'lbs'])
  weightUnit?: 'kg' | 'lbs'

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string

  // --- Which workout ------------------------------------------------------
  // Moves the exercise to another workout of the program (it goes to the
  // end of that workout's list). @ValidateIf(isPresent), not @IsOptional():
  // workout_id is NOT NULL, so an explicit `null` must be a 400 here rather
  // than a NOT NULL violation (a 500) at the database — the null trap,
  // is-present.ts.
  @ValidateIf(isPresent)
  @IsInt()
  workoutId?: number
}
