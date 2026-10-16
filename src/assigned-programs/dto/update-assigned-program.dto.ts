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
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator'
import { LATE_MAKE_UP_DAYS_MAX } from '../../database/schema'
import { isPresent } from '../../common/validators/is-present'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'
import { IsTitle } from '../../common/validators/title'

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
//
// The title: the same rule as when creating (common/validators/title.ts) —
// not blank, at most 200 characters. Before step 3b-2 a PATCH could store ''
// or '   ' (nothing refused them, and the program page's rename was about to
// make the route easy to reach).
export class UpdateAssignedProgramDto {
  @ValidateIf(isPresent)
  @IsTitle('program')
  title?: string

  @ValidateIf(isPresent)
  @IsCalendarDate()
  startDate?: string

  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null

  // May the patient rearrange the week — do a later day's workout early, or
  // swap two days' workouts (sessions' `countsFor`, swap-rules.ts)? Turning
  // it off stops NEW ones; those recorded still count.
  @ValidateIf(isPresent)
  @IsBoolean()
  allowSwaps?: boolean

  // Late make-ups (decided 2026-10-16): up to how many days after a missed
  // day the patient may still make it up — 1 to 28 — or null: not allowed.
  // The column is nullable and null MEANS something here (turning them
  // off), so @IsOptional() — which lets null through — is right, as for
  // endDate. Turning them off, or shortening the limit, stops NEW ones;
  // those recorded still count.
  @IsOptional()
  @IsInt({ message: 'lateMakeUpDays must be a whole number of days, or null' })
  @Min(1, {
    message: 'lateMakeUpDays must be at least 1 (null turns late make-ups off)',
  })
  @Max(LATE_MAKE_UP_DAYS_MAX, {
    message: `lateMakeUpDays can be at most ${LATE_MAKE_UP_DAYS_MAX}`,
  })
  lateMakeUpDays?: number | null
}
