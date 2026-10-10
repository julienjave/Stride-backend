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
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsDefined,
} from 'class-validator'
import { Type } from 'class-transformer'
import { AssignedExerciseInputDto } from './assigned-exercise-input.dto'
import { ScheduleInputDto } from './schedule-input.dto'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'

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

  // Calendar dates (YYYY-MM-DD), not timestamps — was @IsDateString(),
  // which also accepted "2026-10-12T23:30:00-04:00" and let Postgres pick
  // the day. See IsCalendarDate. The end must not be before the start
  // (checked in the service, and by the database).
  @IsCalendarDate()
  startDate!: string

  // Omitted = open-ended (decisions §5: dates are the source of truth; the
  // number of sessions is derived from them, never stored).
  @IsOptional()
  @IsCalendarDate()
  endDate?: string

  // Every assigned program has a schedule (decided 2026-10-09), set while
  // assigning. It becomes the program's FIRST schedule version, applying
  // from startDate.
  //
  // @IsDefined() because @ValidateNested() alone does nothing for a missing
  // value: it validates an object's contents, and an absent object has
  // none — the request would pass with no schedule at all. @Type() tells
  // class-transformer to build a real ScheduleInputDto from the JSON, so
  // that class's own decorators exist to be checked (same pair as
  // `exercises` above).
  @IsDefined()
  @ValidateNested()
  @Type(() => ScheduleInputDto)
  schedule!: ScheduleInputDto
}