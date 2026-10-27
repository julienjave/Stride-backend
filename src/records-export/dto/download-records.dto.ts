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

import { IsString, MaxLength } from 'class-validator'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'
import { ExportRecordsQueryDto } from './export-records-query.dto'

// --- DTO ---------------------------------------------------------------------------------------------------

// POST /records-export/download — the emailed link's page (decisions §20,
// pass 2). Extends the patient's own query DTO for its optional timeZone:
// the copy is written in the browser's zone either way.
//
// Everything in the BODY, never in the URL: the request logger records every
// URL, and neither the token nor a date of birth belongs in a log (the
// invitations' reasoning, InvitationTokenDto).
export class DownloadRecordsDto extends ExportRecordsQueryDto {
  // No format check (64 hex characters): a malformed token matches no link
  // and gets the same 404 as a wrong one. The cap keeps a huge body from
  // being hashed for nothing.
  @IsString()
  @MaxLength(256)
  token!: string

  // Exactly YYYY-MM-DD — compared as a string with the date on file, which
  // Postgres hands back in that same shape.
  @IsCalendarDate()
  dateOfBirth!: string
}
