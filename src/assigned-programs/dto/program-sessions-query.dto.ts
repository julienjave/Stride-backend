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

import { IsOptional } from 'class-validator'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /assigned-programs/:id/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD
// (Phase 4 step 1b, decided 2026-10-15): the program's sessions whose day
// (the patient's local date) is within [from, to] — both ends included,
// both optional (absent = no limit on that side). Calendar dates, compared
// with `local_date` as dates — no time zone involved. The service refuses
// `from` after `to` (a 400: the range is empty by mistake, not "nothing").
export class ProgramSessionsQueryDto {
  @IsOptional()
  @IsCalendarDate()
  from?: string

  @IsOptional()
  @IsCalendarDate()
  to?: string
}
