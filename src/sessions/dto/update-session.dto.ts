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
import { IsScore } from './session-fields'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// PATCH /sessions/:id — what may change while a session is OPEN, and nothing
// else (Phase 4 step 1, decided 2026-10-15). Today that is the pain check-in
// alone: correcting the number given when starting. `null` clears it (the
// column is nullable).
//
// The STATUS is no longer sent here — it changed through this PATCH before,
// which let any status follow any other (a completed session sent back to
// pending and re-rated). Each change of status is now its own action
// (POST …/complete, …/stop, /sessions/skip), with its own rules and audit
// entry; sending `status` here is a 400 like any unknown field.
export class UpdateSessionDto {
  @IsOptional()
  @IsScore()
  painBefore?: number | null
}
