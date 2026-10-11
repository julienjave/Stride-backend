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
} from "class-validator";
import { hasStartedWeight } from "../../common/validators/has-started-weight";

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class AddTemplateExerciseDto {
  @IsInt()
  exerciseId!: number;

  // Which of the template's workouts the exercise goes into. Optional:
  // without it, the FIRST workout (resolveWorkoutId) — so the current
  // screens, which don't know about workouts yet, keep working unchanged.
  // The service checks it's a workout of THIS template (404 otherwise).
  @IsOptional()
  @IsInt()
  workoutId?: number | null;

  // Deliberately all nullable — a timed hold has no reps; a rep-based
  // exercise has no duration. Same reasoning as the schema's own columns.
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

  // weight and weightUnit are each optional independently, but the
  // moment EITHER is provided, both become required together — see
  // hasStartedWeight's own comment for why. maxDecimalPlaces: 2 allows
  // real-world plate increments (62.5, even 61.25) without permitting
  // meaningless false precision (62.5555555).
  @ValidateIf(hasStartedWeight)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weight?: number;

  @ValidateIf(hasStartedWeight)
  @IsIn(["kg", "lbs"])
  weightUnit?: "kg" | "lbs";

  @IsInt()
  @Min(0)
  sortOrder!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}