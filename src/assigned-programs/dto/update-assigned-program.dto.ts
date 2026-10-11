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
  IsString,
  MaxLength,
  IsEnum,
  ValidateIf,
} from 'class-validator'
import { isPresent } from '../../common/validators/is-present'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// `on_hold` is gone (step 2b-ii): a pause is a schedule version — POST
// /assigned-programs/:id/schedules with type 'paused' — which, unlike a
// status, says since when.
export enum AssignedProgramStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// title, startDate and status are NOT NULL columns: @ValidateIf(isPresent)
// rather than @IsOptional(), so an explicit null gets a 400 instead of
// reaching the database as a NOT NULL violation (a 500) — the null trap
// described in is-present.ts. endDate is nullable, and null is meaningful
// there ("no end date any more": the program becomes open-ended), so it
// keeps @IsOptional().
export class UpdateAssignedProgramDto {
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(200)
  title?: string

  @ValidateIf(isPresent)
  @IsCalendarDate()
  startDate?: string

  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null

  @ValidateIf(isPresent)
  @IsEnum(AssignedProgramStatus)
  status?: AssignedProgramStatus
}