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

import { perPatient } from './clinical-reads'

describe('perPatient', () => {
  const program = (id: number, patientId: number) => ({ id, patientId })

  // Each patient once, with all their rows, in the order patients were
  // first met — even when their rows are not next to each other.
  it('groups the rows by patient, in order of first appearance', () => {
    const rows = [program(1, 20), program(2, 21), program(3, 20)]

    expect(perPatient(rows, (row) => row.patientId)).toEqual([
      [20, [program(1, 20), program(3, 20)]],
      [21, [program(2, 21)]],
    ])
  })

  it('answers nothing for an empty list', () => {
    expect(perPatient([], () => 1)).toEqual([])
  })
})
