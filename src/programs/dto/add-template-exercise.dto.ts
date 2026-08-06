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

import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class AddTemplateExerciseDto {
  @IsInt()
  exerciseId!: number

  // Deliberately all nullable — a timed hold has no reps; a rep-based
  // exercise has no duration. Same reasoning as the schema's own columns.
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

  @IsInt()
  @Min(0)
  sortOrder!: number

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string
}
