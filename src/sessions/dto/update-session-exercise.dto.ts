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
  IsOptional,
  IsBoolean,
  IsInt,
  IsString,
  MaxLength,
  Min,
  Max,
} from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class UpdateSessionExerciseDto {
  @IsOptional()
  @IsBoolean()
  completed?: boolean

  @IsOptional()
  @IsInt()
  @Min(0)
  durationActualInSeconds?: number

  // Matches the database's own CHECK constraint — validated here too, so a
  // bad value gets a clean 400 instead of a raw Postgres constraint error.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  difficultyRating?: number

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  feedback?: string
}
