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
    IsInt, 
    IsOptional, 
    IsString, 
    MaxLength, 
    IsDateString, 
    IsArray, 
    ArrayMaxSize, 
    ValidateNested 
} from 'class-validator'
import { Type } from 'class-transformer'
import { AssignedExerciseInputDto } from './assigned-exercise-input.dto'


// --- DATA TRANSFER OBJECT -----------------------------------------------------------------------------------

export class CreateAssignedProgramDto {
  @IsInt()
  patientId!: number
 
  // Provide EITHER basedOnTemplateId (server copies the template's current
  // exercises) OR exercises (an ad-hoc list) — validated together in the
  // service, since "required unless the other is present" isn't expressible
  // with a simple per-field decorator.
  @IsOptional()
  @IsInt()
  basedOnTemplateId?: number
 
  // ValidateNested + @Type() is what's new here: for an array of PLAIN
  // VALUES (like specialties: string[]), @IsString({ each: true }) alone is
  // enough. For an array of OBJECTS, each one needs its own full DTO
  // validation — @Type() tells class-transformer which class to actually
  // instantiate each array element as, and ValidateNested({ each: true })
  // is what makes class-validator recurse into each of those instances
  // rather than only checking that the array itself exists. Each item's own
  // fields (notes, etc.) are capped inside AssignedExerciseInputDto itself —
  // ArrayMaxSize here caps how MANY exercises can be submitted at once,
  // a separate dimension from each item's own internal limits.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AssignedExerciseInputDto)
  exercises?: AssignedExerciseInputDto[]
 
  @IsString()
  @MaxLength(200)
  title!: string
 
  @IsDateString()
  startDate!: string
 
  @IsOptional()
  @IsDateString()
  endDate?: string
}