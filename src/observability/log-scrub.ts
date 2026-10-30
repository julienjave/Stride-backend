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

// What a log line may say (decisions §32). The logs leave the server — Better
// Stack's Vector agent ships them, and Better Stack is not HIPAA compliant —
// so THE RULE is: nothing in a log line names or locates a patient. User ids,
// request ids, paths, status codes, SQL with its placeholders and stack
// traces are fine; email addresses, names, search terms, bodies, the values a
// query was given, IP addresses are not.
//
// Pure functions only, used by logger-options.ts (the logger's serializers
// and its hook) and by the exception filters. No I/O, so every rule is a unit
// test away.

// --- PATHS -------------------------------------------------------------------------------------------------

// A URL as it may be logged: its PATH, never its query string or fragment.
// The query is where search terms live — `/admin/users?search=Jane Doe`,
// the patient directory's `?search=` — so it never reaches a log line. The
// path itself holds only route words and numeric ids (tokens travel in
// bodies, never in URLs — auth.controller.ts), so it is kept whole: it's
// what tells which route failed.
export function pathOnly(url: string | undefined): string {
  if (!url) return ''
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}

// --- TEXT --------------------------------------------------------------------------------------------------

// Anything that looks like an email address: something@something.tld. Kept
// deliberately loose — a false positive costs a "[email]" in a log line; a
// miss costs an address shipped to a third party.
const EMAIL = /[^\s@<>"'(),;:[\]]+@[^\s@<>"'(),;:[\]]+\.[A-Za-z]{2,}/g

// Drizzle's DrizzleQueryError writes the query's VALUES into its own message
// ("Failed query: insert into … \nparams: Jane,Doe,jane@…") — exactly what a
// patient typed. Everything from "\nparams: " up to the stack's first frame
// (or the end of the text) goes.
const DRIZZLE_PARAMS = /\nparams: [\s\S]*?(?=\n {4}at |$)/g

// Postgres repeats a value it couldn't read inside its own message:
// `invalid input syntax for type integer: "Jane"`, `invalid input value for
// enum session_status: "…"`. The kind of error stays; the value goes.
const PG_INPUT_VALUE =
  /(invalid input (?:syntax|value) for (?:type|enum) [^:\n]+): "[^\n]*"/g

// A free-text message (a log line's message, an error's message or stack)
// with the three kinds of personal data above taken out.
export function scrubText(text: string): string {
  return text
    .replace(DRIZZLE_PARAMS, '\nparams: [redacted]')
    .replace(PG_INPUT_VALUE, '$1: [redacted]')
    .replace(EMAIL, '[email]')
}

// --- ERRORS ------------------------------------------------------------------------------------------------

// An error as a log line holds it. An ALLOW-LIST, not a deny-list: pino's
// standard error serializer copies every enumerable property of the error —
// Drizzle's `params` (the values) included — and node-postgres's error
// carries `detail` ("Key (email)=(jane@…) already exists", "Failing row
// contains (…every column…)"). A list of what may go out can't be widened by
// a library adding a property one day; a list of what may not, can.
//
// Kept: what says WHERE and WHY, never WHAT was written —
//   type, message, stack   (scrubbed: scrubText)
//   code                   (Postgres's SQLSTATE: 23505, 23514…; Node's ECONNREFUSED…)
//   constraint, table, column, schema, routine   (names from the schema)
//   query                  (Drizzle's SQL, with $1, $2 placeholders — no values)
//   cause                  (the same, one level down — so Postgres's own reason
//                           behind Drizzle's wrapper is still there)
export interface LoggedError {
  type: string
  message: string
  stack?: string
  code?: string
  constraint?: string
  table?: string
  column?: string
  schema?: string
  routine?: string
  query?: string
  cause?: LoggedError
}

const KEPT_STRING_FIELDS = [
  'code',
  'constraint',
  'table',
  'column',
  'schema',
  'routine',
  'query',
] as const

// How deep a cause chain is followed: Drizzle → pg is two; anything deeper
// than this is almost certainly a cycle (an error whose cause leads back to
// itself), which would otherwise never end.
const MAX_CAUSE_DEPTH = 5

export function serializeError(error: unknown, depth = 0): LoggedError {
  if (!(error instanceof Error)) {
    // Something thrown that isn't an Error (a string, an object): its text,
    // scrubbed like any message.
    return { type: typeof error, message: scrubText(String(error)) }
  }
  const logged: LoggedError = {
    type: error.constructor?.name || error.name || 'Error',
    message: scrubText(error.message),
  }
  if (error.stack) logged.stack = scrubText(error.stack)
  const fields = error as unknown as Record<string, unknown>
  for (const field of KEPT_STRING_FIELDS) {
    const value = fields[field]
    // Scrubbed too, though none should need it: belt and braces for a
    // query written with sql.raw() around a value one day.
    if (typeof value === 'string') logged[field] = scrubText(value)
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    logged.cause = serializeError(error.cause, depth + 1)
  }
  return logged
}
