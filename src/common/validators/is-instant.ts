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

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// YYYY-MM-DDTHH:MM:SS, optional milliseconds, then the offset — `Z` or
// ±HH:MM. What JavaScript's `toISOString()` writes, and what a person's
// offset-carrying timestamp looks like.
const INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/

// --- HELPERS -----------------------------------------------------------------------------------------------

// True for one MOMENT, written with its offset, that really exists.
//
// The twin of isCalendarDate (a DAY, no zone): an audit entry's created_at
// is a moment, and "21 October" starts at a different moment in Paris and in
// Montreal. Only the person's browser knows their zone, so it sends the
// moments that bound their days, and the server compares instants.
//
// Why the offset is REQUIRED: "2026-10-21T00:00:00" without one means
// "midnight somewhere" — Postgres would read it in ITS zone, JavaScript in
// the server's. Why not `Date.parse`: it rolls impossible dates over
// ("2026-02-30T…" becomes March 2nd) and accepts "T24:00". So: the
// pattern for the shape (hours 00–23, minutes and seconds 00–59), and
// isCalendarDate for the date part (February 30th refused).
export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = INSTANT_PATTERN.exec(value)
  return match !== null && isCalendarDate(match[1])
}

// --- DECORATOR ---------------------------------------------------------------------------------------------

// The decorator form, built like IsCalendarDate (is-calendar-date.ts).
export function IsInstant(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isInstant',
      validator: {
        validate: (value: unknown) => isInstant(value),
        defaultMessage: () =>
          '$property must be a date and time with its offset, like 2026-10-21T00:00:00+02:00',
      },
    },
    options,
  )
}
