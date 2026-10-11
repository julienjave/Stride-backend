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

import { PartialType, OmitType } from '@nestjs/mapped-types'
import { IsIn, IsInt, IsNumber, Min, ValidateIf } from 'class-validator'
import { AddTemplateExerciseDto } from './add-template-exercise.dto'
import { hasStartedWeight } from '../../common/validators/has-started-weight'
import { isPresent } from '../../common/validators/is-present'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// OmitType strips exerciseId before PartialType makes everything else
// optional — changing WHICH exercise a slot points to isn't really an
// "update," it's closer to removing this slot and adding a different one.
// Combining the two mapped-type helpers avoids hand-writing a near-duplicate
// of AddTemplateExerciseDto just to drop one field.
//
// weight/weightUnit are ALSO omitted from the derivation, then redeclared
// below — because PartialType silently broke them. PartialType works by
// adding @IsOptional() to every inherited field, and @IsOptional() is a
// "skip ALL of this field's validators when the value is null or
// undefined" switch. On weight/weightUnit, that switch overrode
// @ValidateIf(hasStartedWeight): a PATCH of { weight: 50 } with no unit,
// or { weight: 50, weightUnit: null }, skipped the unit's check entirely
// and passed — exactly the ambiguous "50 of what?" state the
// both-or-neither rule exists to prevent. (Found 2026-09-23 while fixing
// weight clearing; UpdateAssignedProgramExerciseDto never had this
// problem, since it declares its fields explicitly.)
//
// Declaring them here, WITHOUT @IsOptional(), puts @ValidateIf(
// hasStartedWeight) back in sole charge: a pair is either fully provided
// (both validated), fully absent/null (both skipped — which is how a
// weight gets cleared), or rejected.
export class UpdateTemplateExerciseDto extends PartialType(
  OmitType(AddTemplateExerciseDto, [
    'exerciseId',
    'workoutId',
    'weight',
    'weightUnit',
  ] as const),
) {
  // Moving the exercise to another workout of the template. Omitted from
  // the PartialType derivation for the same reason as weight below:
  // PartialType's @IsOptional() would let `null` through, and workout_id is
  // NOT NULL — a 500 at the database instead of a 400 here (the null trap,
  // is-present.ts). @ValidateIf(isPresent) skips only an ABSENT key.
  @ValidateIf(isPresent)
  @IsInt()
  workoutId?: number

  @ValidateIf(hasStartedWeight)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weight?: number | null

  @ValidateIf(hasStartedWeight)
  @IsIn(['kg', 'lbs'])
  weightUnit?: 'kg' | 'lbs' | null
}