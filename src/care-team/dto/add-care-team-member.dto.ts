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

import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /users/:id/care-team. Every field is optional: an empty body is the
// most common request of all — "Join", a practitioner adding THEMSELVES.
export class AddCareTeamMemberDto {
  // Omitted → the caller joins. Set → "add a colleague" (or an admin adding
  // someone, where it's required — checked in CareTeamService, since the
  // rule depends on who is asking, which a DTO can't see).
  @IsOptional()
  @IsInt()
  @Min(1)
  practitionerId?: number

  // A planned end ("covering until 12 October"). Omitted → open-ended.
  // strict: true rejects impossible dates such as 2026-02-30 instead of
  // letting them roll over into March. "Must be in the future" is checked
  // in the service, because it depends on the current time.
  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string

  // Why this person joined ("covering for Dr Martin"). Shown in the care
  // team's history and recorded in the audit log.
  @IsOptional()
  @IsString()
  @MaxLength(255) // matches care_team_members.reason's varchar(255)
  reason?: string
}