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
  Min,
  Max,
  ValidateIf,
} from 'class-validator'
import { isPresent } from '../../common/validators/is-present'
import { IsFeedback } from './session-fields'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class UpdateSessionExerciseDto {
  // NOT NULL column (default false): @ValidateIf(isPresent), so `null` is a
  // 400 instead of a 500 from Postgres (the null trap — is-present.ts;
  // found live 2026-10-14). The other fields are nullable: `null` clears
  // them, so they keep @IsOptional().
  @ValidateIf(isPresent)
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

  // The patient's words about this exercise: never blank (IsFeedback);
  // `null` clears a note written earlier.
  @IsOptional()
  @IsFeedback()
  feedback?: string | null
}
