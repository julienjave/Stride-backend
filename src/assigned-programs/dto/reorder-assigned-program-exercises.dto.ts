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
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  IsOptional,
} from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// The exercises of ONE workout in their new order: `workoutId`, or the
// program's first workout when it's omitted (what today's screens send —
// for a one-workout program, every exercise).
export class ReorderAssignedProgramExercisesDto {
  @IsOptional()
  @IsInt()
  workoutId?: number | null

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  order!: number[]
}