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
import { ScheduleVersionInputDto } from './schedule-input.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /assigned-programs/:id/schedules — "from effectiveFrom on, the
// schedule is …". A schedule plus the day it applies from.
//
// `extends` works for validation too: class-validator reads the decorators
// of the parent class as well, so every rule of ScheduleVersionInputDto
// applies here without being repeated.
//
// The rules about WHICH days are allowed (not before the program starts,
// not after it ends, not in the past) need the program and the clock, so
// they're checked in AssignedProgramsService.addScheduleVersion, not here.
export class AddScheduleVersionDto extends ScheduleVersionInputDto {
  @IsCalendarDate()
  effectiveFrom!: string
}
