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

import { applyDecorators } from '@nestjs/common'
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import { PATIENT_END_REASONS } from '../../database/schema'

// The value rules the session DTOs share (Phase 4 step 1, 2026-10-15), each
// written ONCE — the IsTitle() pattern (src/common/validators/title.ts):
// Nest's applyDecorators() stacks several class-validator decorators into
// one. Whether a field may be ABSENT is each DTO's own business (a reason is
// required to stop, a score never is), so these say only what a PRESENT
// value must be.

// A 0–10 score: pain (the clinical Numeric Rating Scale, 0 = no pain) or
// self-assessed mobility (10 = moving freely) — decisions §6. Whole numbers
// only, as the scales are. The database's CHECKs (sessions_*_range) say the
// same.
export function IsScore() {
  return applyDecorators(IsInt(), Min(0), Max(10))
}

// Why the patient stops or skips: one of THEIR four reasons. The app's own
// two (not_finished_in_time, program_closed) are refused here — a client
// can't claim the app closed something.
export const PATIENT_REASON_MESSAGE = `reason must be one of: ${PATIENT_END_REASONS.join(', ')}`
export function IsPatientEndReason() {
  return applyDecorators(
    IsIn(PATIENT_END_REASONS, { message: PATIENT_REASON_MESSAGE }),
  )
}

// The patient's own words — a note, some feedback. Optional, but never
// BLANK: "nothing to say" is spelled by leaving it out (or null), one way
// only — the rule titles and exercise names follow. `noun` names the field
// in the message, so each DTO's refusal says what was blank.
function isPatientText(noun: string, maxLength: number) {
  return applyDecorators(
    IsString(),
    MaxLength(maxLength),
    Matches(/\S/, {
      message: `The ${noun} can't be blank: leave it out instead`,
    }),
  )
}

// Why the patient stopped or skipped, in their words — at most 500
// characters (the column is varchar(500)).
export const END_NOTE_MAX_LENGTH = 500
export function IsEndNote() {
  return isPatientText('note', END_NOTE_MAX_LENGTH)
}

// How an exercise or a whole session went, in the patient's words — at most
// 2,000 characters (the columns are `text`; the limit is the API's). Blank
// was accepted until 2026-10-16 (found while planning the session flow):
// "   " was stored as feedback, which the practitioner would then see as a
// comment with nothing in it.
export const FEEDBACK_MAX_LENGTH = 2000
export function IsFeedback() {
  return isPatientText('feedback', FEEDBACK_MAX_LENGTH)
}
