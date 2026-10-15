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

// What an edit really changed, for its audit entry (the convention: "before →
// after for edits", and "a request that changes nothing writes nothing").
// Moved here from AssignedProgramsService on 2026-10-15, when sessions became
// the second module to need it.

// Two stored values are "the same" for an audit entry: equal scalars, or
// arrays with the same items in the same order. Arrays need their own case
// because `===` compares arrays by IDENTITY — a re-sent `primaryMuscles:
// ["legs"]` is a different array object than the stored ["legs"], and would
// otherwise be reported as a change that isn't one. (The array columns
// compared here hold strings, so comparing items with `===` is enough.)
function sameValue(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i])
  }
  return a === b
}

// The fields a PATCH really changed, as { field: { from, to } } — a field
// sent with the value it already had isn't a change, and isn't listed; a
// field not sent (undefined) isn't either.
export function changedFields(
  before: Record<string, unknown>,
  dto: Record<string, unknown>,
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const [field, to] of Object.entries(dto)) {
    if (to !== undefined && !sameValue(before[field], to)) {
      changes[field] = { from: before[field], to }
    }
  }
  return changes
}