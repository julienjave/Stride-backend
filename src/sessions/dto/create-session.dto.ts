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

  // Which of the program's workouts this session is. Required when the
  // program has several (the service refuses to guess — see
  // chooseSessionWorkout); optional for a one-workout program, which then
  // works exactly as before workouts existed.
  @IsOptional()
  @IsInt()
  workoutId?: number | null

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

  // A SWAP (step 2b-iii): the scheduled day — of the same program week —
  // whose workout this session does ("Wednesday's lower body, today").
  // Optional: absent or null = an ordinary session, counting for today.
  // With it, `workoutId` may be left out: the day says which workout.
  @IsOptional()
  @IsCalendarDate()
  countsFor?: string | null
}
