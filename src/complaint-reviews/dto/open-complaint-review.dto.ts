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

import { IsOptional, IsString, Matches, MaxLength } from 'class-validator'
import {
  COMPLAINT_REVIEW_CASE_REFERENCE_MAX,
  COMPLAINT_REVIEW_REASON_MAX,
} from '../../database/schema'

// --- MESSAGES ----------------------------------------------------------------------------------------------

export const BLANK_REASON_MESSAGE = "The reason can't be blank"
export const BLANK_CASE_REFERENCE_MESSAGE =
  "The case reference can't be blank — leave it out if there is none"

// --- DTO ---------------------------------------------------------------------------------------------------

// POST /users/:id/complaint-reviews — { reason, caseReference? }.
//
// The same "not blank" rule as titles (common/validators/title.ts): @IsString
// accepts '   ', so Matches(/\S/) asks for one character that isn't
// whitespace, anywhere. The database's CHECKs (migration 0066) say the same:
// a reason of spaces would make "accountability instead of approval" empty.
// Stored as sent — the screen trims before sending.
export class OpenComplaintReviewDto {
  @IsString()
  @MaxLength(COMPLAINT_REVIEW_REASON_MAX)
  @Matches(/\S/, { message: BLANK_REASON_MESSAGE })
  reason!: string

  // Optional: absent means none. Present, it must say something — '' is
  // refused rather than silently read as "none" (the screen omits an empty
  // field, so a '' is a client's mistake worth hearing about).
  @IsOptional()
  @IsString()
  @MaxLength(COMPLAINT_REVIEW_CASE_REFERENCE_MAX)
  @Matches(/\S/, { message: BLANK_CASE_REFERENCE_MESSAGE })
  caseReference?: string
}
