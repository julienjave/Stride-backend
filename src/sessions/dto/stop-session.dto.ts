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
import { IsEndNote, IsPatientEndReason, IsScore } from './session-fields'
import type { PatientEndReason } from '../../database/schema'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /sessions/:id/stop — ending a session before finishing it (Phase 4
// step 1, decided 2026-10-15): it becomes 'incomplete', with the patient's
// reason. Pain after and mobility are optional — someone stopping because it
// hurts is exactly who they matter for, but they may stop for another reason
// (the person's point, 2026-10-15).
export class StopSessionDto {
  @IsPatientEndReason()
  reason!: PatientEndReason

  @IsOptional()
  @IsEndNote()
  note?: string | null

  @IsOptional()
  @IsScore()
  painAfter?: number | null

  @IsOptional()
  @IsScore()
  mobilityAfter?: number | null
}