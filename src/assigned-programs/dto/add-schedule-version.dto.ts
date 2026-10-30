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

import { ValidateIf } from 'class-validator'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'
import {
  OnlyForType,
  ScheduleType,
  ScheduleVersionInputDto,
  sentWith,
} from './schedule-input.dto'

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

  // A PAUSE WITH AN END (roadmap Phase 6.5): "paused from effectiveFrom,
  // BACK ON resumeOn" — the first day the schedule applies again (the
  // person's choice, 2026-10-29: the same meaning as any version's
  // effectiveFrom, so "back on Monday 26" is a version starting on the
  // 26th). Optional, and only with type 'paused' (OnlyForType — refused,
  // not ignored, on another type: a client sending it there has a bug).
  // Its relation to effectiveFrom and to the program's dates needs the
  // program, so the service checks those.
  @ValidateIf(sentWith('resumeOn'))
  @OnlyForType(ScheduleType.PAUSED)
  @IsCalendarDate()
  resumeOn?: string | null
}
