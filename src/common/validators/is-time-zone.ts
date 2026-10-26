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

// --- HELPERS -----------------------------------------------------------------------------------------------

// True for a time zone the server can format dates in: an IANA name like
// "Europe/Paris" or "America/Montreal", or "UTC".
//
// Why a zone at all: only the person's browser knows where they are
// (is-instant.ts says the same for moments). A document written for them —
// the records export — prints "October 9, 2026 at 3:40 PM", and that is a
// different moment in Paris and in Montreal. So the browser sends
// `Intl.DateTimeFormat().resolvedOptions().timeZone`, and the server writes
// every moment in it.
//
// How it's checked: by asking Intl itself. `new Intl.DateTimeFormat` throws a
// RangeError for a zone it doesn't know, so "the server can format in it"
// is EXACTLY the property tested — nothing to keep in sync. It refuses an
// empty string and a 100,000-character one by itself, so no length check
// here could change an answer. Not `Intl.supportedValuesOf('timeZone')`:
// that list holds only the canonical names, and browsers send some of the
// older aliases ("Asia/Calcutta" rather than "Asia/Kolkata"), which
// formatting accepts.
//
// Offsets ("+02:00") are refused on purpose, though Intl accepts them: an
// offset isn't a place — it would print a winter date with a summer offset.
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || /^[+-]/.test(value)) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// --- DECORATOR ---------------------------------------------------------------------------------------------

// The decorator form, built like IsInstant (is-instant.ts).
export function IsTimeZone(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isTimeZone',
      validator: {
        validate: (value: unknown) => isTimeZone(value),
        defaultMessage: () =>
          '$property must be a time zone name, like Europe/Paris or America/Montreal',
      },
    },
    options,
  )
}
