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

// --- ONE ENTRY PER PATIENT ---------------------------------------------------------------------------------

// A list can show several patients at once (a practitioner's programs, the
// To-do's alerts). The person chose ONE read entry PER PATIENT (2026-10-21 —
// the same exception as removing someone from a clinic): "who has seen
// patient X's data" then stays one query on target_user_id, served by its
// index (migration 0051). An entry naming several patients in its details
// would hide them inside JSON.
//
// So: the rows of a list, grouped by the patient they belong to, in the
// order each patient first appears — [patientId, that patient's rows].
// Pure, so it is tested with plain values.
export function perPatient<T>(
  rows: readonly T[],
  patientIdOf: (row: T) => number,
): [number, T[]][] {
  const groups = new Map<number, T[]>()
  for (const row of rows) {
    const patientId = patientIdOf(row)
    const group = groups.get(patientId)
    if (group) {
      group.push(row)
    } else {
      groups.set(patientId, [row])
    }
  }
  // A Map remembers insertion order, so its entries come out in the order
  // each patient was first met.
  return [...groups]
}
