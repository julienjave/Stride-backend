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

import { IsInt, IsOptional } from 'class-validator'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'
import { IsEndNote, IsPatientEndReason, IsScore } from './session-fields'
import type { PatientEndReason } from '../../database/schema'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /sessions/skip — "I won't do today's session" (Phase 4 step 1,
// decided 2026-10-15). Only a scheduled day of a specific-days schedule can
// be skipped, and the workout is that day's (session-rules.ts,
// skippedWorkoutId), so neither a workout nor a day to count for is asked.
export class SkipSessionDto {
  @IsInt()
  assignedProgramId!: number

  // The patient's own calendar day, from their device — the day being
  // skipped, which must be today (the same rule as starting).
  @IsCalendarDate()
  localDate!: string

  // Required: a skip without a reason tells the practitioner nothing a
  // plain miss doesn't.
  @IsPatientEndReason()
  reason!: PatientEndReason

  @IsOptional()
  @IsEndNote()
  note?: string | null

  // The pain that made the patient skip — only with reason 'pain' (a 400
  // otherwise: SessionsService.skip, assertSkipPain). Optional.
  @IsOptional()
  @IsScore()
  painBefore?: number | null
}
