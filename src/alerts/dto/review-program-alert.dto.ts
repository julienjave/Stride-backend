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

// POST /alerts/programs/:programId/review { today }
//
// Only the practitioner's `today` (the list's own question — which day the
// alert is judged on). Never the facts being reviewed: the server computes
// them, so a review always records what the alert really said. The global
// ValidationPipe's `forbidNonWhitelisted` refuses any other field.
export class ReviewProgramAlertDto {
  @IsCalendarDate()
  today!: string
}
