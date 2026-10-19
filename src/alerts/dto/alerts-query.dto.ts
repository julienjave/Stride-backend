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

// GET /alerts?today=YYYY-MM-DD
//
// `today` is the PRACTITIONER's calendar date, sent by their app — the same
// reasoning as the program summary's (decided 2026-10-09): "was Monday
// missed?" depends on which day it is where the viewer is, and only their
// device knows. Required: a server default would be UTC's date, wrong for
// half the world every evening. The service also refuses a date that can't
// be today anywhere (more than a day from UTC's).
//
// Its own class rather than the summary's (assigned-programs/dto): the two
// routes belong to different features, and a field added to one later must
// not silently appear on the other.
export class AlertsQueryDto {
  @IsCalendarDate()
  today!: string
}
