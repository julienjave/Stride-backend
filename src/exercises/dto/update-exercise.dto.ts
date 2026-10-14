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

import { ValidateIf } from 'class-validator'
import {
  IsExerciseList,
  IsExerciseName,
} from '../../common/validators/exercise-description'
import { isPresent } from '../../common/validators/is-present'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A PATCH: every field optional — only what is sent changes. Written out,
// no longer `PartialType(CreateExerciseDto)`: PartialType makes a field
// optional by adding @IsOptional(), which skips every validator for `null`
// as well as for a missing field — and all five columns are NOT NULL, so
// `{ "name": null }` passed validation and failed in Postgres, a 500 (checked
// live 2026-10-14, for each of the five). @ValidateIf(isPresent) skips only a
// field that wasn't sent; `null` meets the rules and gets a 400.
//
// The rules are the ones CreateExerciseDto uses (exercise-description.ts), so
// "valid when creating" and "valid when editing" can't drift apart. An empty
// list is still refused for the two required ones (primaryMuscles,
// instructions) and accepted for the two optional ones — [] = "none".
export class UpdateExerciseDto {
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
}
