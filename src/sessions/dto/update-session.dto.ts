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
  IsOptional,
  IsEnum,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'
import { isPresent } from '../../common/validators/is-present'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export enum SessionStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
}

export class UpdateSessionDto {
  // `status` is a NOT NULL column: @ValidateIf(isPresent), not @IsOptional()
  // — @IsOptional() skips every check for `null` too, so `{ "status": null }`
  // reached Postgres and came back a 500 (the null trap — is-present.ts;
  // found live 2026-10-14). Not sent = unchanged; `null` = a 400. The other
  // fields are nullable columns, where `null` means "clear it": they keep
  // @IsOptional(). (WHICH status changes are allowed is the Phase 4 session
  // flow's question — today any value of the enum is accepted.)
  @ValidateIf(isPresent)
  @IsEnum(SessionStatus)
  status?: SessionStatus

  @IsOptional()
  @IsInt()
  @Min(0)
  totalDurationInSeconds?: number

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  sessionFeedback?: string
}