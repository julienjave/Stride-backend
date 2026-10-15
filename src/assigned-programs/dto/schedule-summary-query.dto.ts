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
import { IsCalendarDate } from '../../common/validators/is-calendar-date'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /assigned-programs/:id/summary?today=YYYY-MM-DD
//
// `today` is the VIEWER's calendar date, sent by their app (decided
// 2026-10-09): "is Monday missed yet?" depends on which day it is where the
// viewer is, and only their device knows. Required — a server-side default
// would be UTC's date, wrong for half the world every evening. The service
// also refuses a date that can't be today anywhere (more than a day from
// UTC's).
export class ScheduleSummaryQueryDto {
  @IsCalendarDate()
  today!: string
}

// GET /assigned-programs/:id/summary only: `today`, plus an optional
// `through=YYYY-MM-DD` — cover at least up to that day (the patient home
// reads "upcoming" two weeks ahead; an open-ended program's summary
// otherwise stops at the end of the current program week). Its range is
// checked by the service (on or after today, at most a year ahead).
//
// A subclass, not a field on ScheduleSummaryQueryDto: the closing preview
// uses that one too, and with `forbidNonWhitelisted` a `through` sent there
// is refused (400) instead of silently meaning nothing.
//
// @IsOptional() is safe here (unlike on a body's NOT NULL field — the null
// trap): a query string has no null, only absent or text, and an EMPTY
// `?through=` is text — refused by @IsCalendarDate().
export class ProgramSummaryQueryDto extends ScheduleSummaryQueryDto {
  @IsOptional()
  @IsCalendarDate()
  through?: string
}
