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

import { IsCalendarDate } from '../../common/validators/is-calendar-date'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /assigned-programs/:id/cancel and …/complete
//
// `today` is the practitioner's calendar date, sent by their app — the same
// reason as the summary's (schedule-summary-query.dto.ts): the end date the
// program gets ("yesterday", or today if a session was completed today)
// depends on which day it is where they are, and only their device knows.
// The service also refuses a date that can't be today anywhere.
export class CloseAssignedProgramDto {
  @IsCalendarDate()
  today!: string
}
