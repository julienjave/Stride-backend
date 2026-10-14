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

// Deliberately no "source" or "createdBy" field here — both are set
// server-side (source is always 'custom' for anything created through this
// endpoint; createdBy comes from the authenticated session, never the
// request body).
//
// The rules for each field live in exercise-description.ts, shared with
// UpdateExerciseDto and a program's own copy (UpdateAssignedProgramExerciseDto)
// — one definition of "a valid exercise description". Here: the name and the
// two required lists must be sent; the two optional lists may be left out
// (the service stores [] — "none"), but not sent as `null`
// (@ValidateIf(isPresent), not @IsOptional(): "none" is spelled [], one way
// only — decided 2026-10-14).
export class CreateExerciseDto {
  @IsExerciseName()
  name!: string

  @IsExerciseList('primaryMuscles')
  primaryMuscles!: string[]

  @ValidateIf(isPresent)
  @IsExerciseList('secondaryMuscles')
  secondaryMuscles?: string[]

  @ValidateIf(isPresent)
  @IsExerciseList('equipment')
  equipment?: string[]

  @IsExerciseList('instructions')
  instructions!: string[]
}