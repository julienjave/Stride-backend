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
import { IsTimeZone } from '../../common/validators/is-time-zone'

// --- DTO ---------------------------------------------------------------------------------------------------

// GET /records-export?timeZone=Europe/Paris
//
// The zone the document's moments are written in — the browser's own
// (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Optional: without
// it the copy is written in UTC and says so on its first page
// ("… (UTC time)"), rather than guessing a place.
export const DEFAULT_TIME_ZONE = 'UTC'

export class ExportRecordsQueryDto {
  @IsOptional()
  @IsTimeZone()
  timeZone?: string
}
