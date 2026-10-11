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
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { hasStartedWeight } from "../../common/validators/has-started-weight";
import { isPresent } from "../../common/validators/is-present";

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
  // --- Snapshotted exercise fields, editable per patient -----------------
  // Same validation shape as CreateExerciseDto's own fields — this is
  // the same KIND of data, just stored per-assigned-program-exercise now
  // rather than only on the shared exercise. All optional here (PATCH
  // semantics: only touch what's provided), but a PROVIDED array still
  // has to satisfy the same real-world minimums an exercise itself
  // would — an exercise with a name but zero primary muscles or zero
  // instructions isn't a meaningfully valid state just because it's a
  // per-patient copy now.

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  primaryMuscles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  secondaryMuscles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  equipment?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  instructions?: string[];

  // --- Per-patient prescription fields ------------------------------------
  // Unchanged from the previous PartialType(OmitType(...)) derivation —
  // same fields, same validators, just now written out explicitly here
  // instead of inherited.

  @IsOptional()
  @IsInt()
  @Min(1)
  sets?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  reps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationInSeconds?: number;

  @ValidateIf(hasStartedWeight)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weight?: number;

  @ValidateIf(hasStartedWeight)
  @IsIn(["kg", "lbs"])
  weightUnit?: "kg" | "lbs";

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  // --- Which workout ------------------------------------------------------
  // Moves the exercise to another workout of the program (it goes to the
  // end of that workout's list). @ValidateIf(isPresent), not @IsOptional():
  // workout_id is NOT NULL, so an explicit `null` must be a 400 here rather
  // than a NOT NULL violation (a 500) at the database — the null trap,
  // is-present.ts.
  @ValidateIf(isPresent)
  @IsInt()
  workoutId?: number;
}