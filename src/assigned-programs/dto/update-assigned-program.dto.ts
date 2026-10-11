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
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator'
import { isPresent } from '../../common/validators/is-present'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// No `status` here any more (step 2b-iii): a program is completed or
// cancelled through its own routes — POST /assigned-programs/:id/complete
// and …/cancel — which apply the rules (the end date, archiving a program
// with no sessions); a PATCH could only skip them. Sending `status` is now a
// 400 (the global pipe's forbidNonWhitelisted), so an old client fails
// loudly. (`on_hold` was already gone, step 2b-ii: a pause is a schedule
// version.)
//
// title, startDate and allowSwaps are NOT NULL columns: @ValidateIf(isPresent)
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

  // May the patient swap two days' workouts within a week (sessions'
  // `countsFor`)? Turning it off stops NEW swaps; recorded ones still count.
  @ValidateIf(isPresent)
  @IsBoolean()
  allowSwaps?: boolean
}