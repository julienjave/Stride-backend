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

import { NotFoundException } from '@nestjs/common'
import { orderCopySources } from './exercise-copy'

// Roadmap Phase 6.5: which exercises a copy takes, and in which order.

// Two workouts: B (id 2) is FIRST in the program (position 0), A (id 1)
// second — so "display order" and "id order" disagree, as they must for the
// test to tell them apart.
const workouts = [
  { id: 1, name: null, sortOrder: 1 },
  { id: 2, name: null, sortOrder: 0 },
]
const row = (id: number, workoutId: number, sortOrder: number) => ({
  id,
  workoutId,
  sortOrder,
})

describe('orderCopySources', () => {
  it('orders the sources as the screen shows them: workout by workout, then by position', () => {
    const rows = [row(10, 1, 0), row(11, 2, 5), row(12, 2, 1)]
    // Sent in yet another order: the request's order doesn't count.
    expect(
      orderCopySources(rows, [10, 11, 12], workouts, 'program').map(
        (r) => r.id,
      ),
    ).toEqual([12, 11, 10])
  })

  it('takes only the rows asked for', () => {
    const rows = [row(10, 1, 0), row(11, 1, 1), row(12, 1, 2)]
    expect(
      orderCopySources(rows, [12, 10], workouts, 'template').map((r) => r.id),
    ).toEqual([10, 12])
  })

  it("refuses (404) an id that isn't one of this resource's rows, naming it", () => {
    const rows = [row(10, 1, 0)]
    expect(() =>
      orderCopySources(rows, [10, 99], workouts, 'template'),
    ).toThrow(new NotFoundException('Exercise 99 not found in this template'))
    expect(() => orderCopySources(rows, [98], workouts, 'program')).toThrow(
      new NotFoundException('Exercise 98 not found in this program'),
    )
  })

  it('leaves the rows it was given unchanged', () => {
    const rows = [row(11, 1, 1), row(10, 1, 0)]
    orderCopySources(rows, [10, 11], workouts, 'program')
    expect(rows.map((r) => r.id)).toEqual([11, 10])
  })
})
