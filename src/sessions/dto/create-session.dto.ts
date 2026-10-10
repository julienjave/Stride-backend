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

import { IsInt, IsOptional, IsDateString } from 'class-validator'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class CreateSessionDto {
  @IsInt()
  assignedProgramId!: number

  // Defaults to now if omitted
  @IsOptional()
  @IsDateString()
  scheduledDate?: string

  // The patient's own calendar day, from their device (decisions §5,
  // point 4): what the schedule judges ("was Monday done?"). Required —
  // only the patient's device knows their time zone, so the server can't
  // fill it in. The service also refuses a day more than one day away from
  // UTC's (no real time zone is further), so a session can't be filed
  // under last month.
  @IsCalendarDate()
  localDate!: string
}