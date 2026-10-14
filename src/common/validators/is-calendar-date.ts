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

import { ValidateBy, type ValidationOptions } from 'class-validator'
import { isCalendarDate } from '../calendar-date'

// --- DECORATOR ---------------------------------------------------------------------------------------------

// "A calendar date, exactly YYYY-MM-DD, that really exists."
//
// Why not class-validator's @IsDateString(): it accepts any ISO 8601
// string, full timestamps included ("2026-10-12T23:30:00-04:00"). For a
// `date` column Postgres would then cut the time off in ITS time zone —
// possibly giving a different day than the user meant — and code comparing
// these values as strings ("2026-10-12" < "2026-10-12T…") would get the
// wrong answer. A day is sent as a day.
//
// ValidateBy is class-validator's way to build a custom decorator from a
// plain function: a name (shown in error metadata), the check, and the
// default message ($property is replaced by the field's name).
export function IsCalendarDate(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isCalendarDate',
      validator: {
        validate: (value: unknown) => isCalendarDate(value),
        defaultMessage: () => '$property must be a date written as YYYY-MM-DD',
      },
    },
    options,
  )
}
