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

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Postgres reports every failure with a five-character SQLSTATE code. 23505
// is "unique_violation": an INSERT or UPDATE tried to store a value that a
// UNIQUE constraint already holds for another row. The code is part of the
// SQL standard, so it is stable across Postgres versions — safer to match
// on than the human-readable error message, which can change.
export const PG_UNIQUE_VIOLATION = '23505'

// 23P01 is "exclusion_violation": a row would break an EXCLUDE constraint —
// a rule of the form "no two rows may have X equal AND Y overlapping". The
// care team uses one: no two OVERLAPPING periods for the same patient and
// practitioner (migration 0019).
export const PG_EXCLUSION_VIOLATION = '23P01'

// Constraint names this app translates into a 409. Drizzle names a column's
// .unique() constraint `<table>_<column>_unique` (see migration 0000).
// Kept as named constants so the service and its tests can't disagree on
// the spelling.
export const PRACTITIONER_LICENSE_NUMBER_UNIQUE =
  'practitioner_profiles_license_number_unique'

// Named by hand in migration 0019 (Drizzle can't declare EXCLUDE
// constraints), so it must match that file exactly.
export const CARE_TEAM_NO_OVERLAP = 'care_team_members_no_overlap'

// The partial unique index allowing at most one OPEN invitation per account
// (migration 0020). Hit when two "send invitation" requests race: the loser's
// INSERT finds the winner's fresh open invitation. InvitationsService turns it
// into a 409.
export const INVITATIONS_ONE_OPEN = 'invitations_one_open_per_user'

// --- HELPER ------------------------------------------------------------------------------------------------

// The shape we read off a Postgres error. node-postgres's DatabaseError
// carries `code` and `constraint`; everything is optional because the value
// being inspected is `unknown` until proven otherwise.
interface PgErrorFields {
  code?: unknown
  constraint?: unknown
  cause?: unknown
}

// True when `error` is (or wraps) a Postgres error with this SQLSTATE `code`
// — optionally on one specific constraint. The shared engine behind
// isUniqueViolation and isExclusionViolation below.
//
// Why walk `cause`: drizzle-orm (0.44+) does not rethrow the driver's error
// as-is. It wraps it in a DrizzleQueryError (which adds the failing SQL and
// its parameters) and puts the original node-postgres error in `.cause`.
// Checking only the top-level error would therefore never match. The loop
// follows the `cause` chain a few levels down, so this keeps working
// whether the error arrives wrapped, unwrapped, or wrapped twice.
//
// Why a constraint name, not just the code: a table can have several
// unique constraints, and each deserves its own message ("license number
// already in use" must not be shown when the real collision was on
// something else). Passing no constraint matches ANY unique violation.
function isPgError(error: unknown, code: string, constraint?: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== 'object') {
      return false
    }
    const fields = current as PgErrorFields
    if (fields.code === code) {
      return constraint === undefined || fields.constraint === constraint
    }
    current = fields.cause
  }
  return false
}

// A unique violation (23505), optionally on one named constraint.
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return isPgError(error, PG_UNIQUE_VIOLATION, constraint)
}

// An exclusion violation (23P01), optionally on one named constraint.
// Same reasoning as isUniqueViolation: the constraint decides atomically,
// so translating ITS verdict into a 409 is correct under concurrency,
// where a "check first, then insert" would have a race window.
export function isExclusionViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return isPgError(error, PG_EXCLUSION_VIOLATION, constraint)
}