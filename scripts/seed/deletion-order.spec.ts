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

import { deletionOrder, type ForeignKey } from './deletion-order'

// "Every table comes before every table it points at" — the one property
// that makes the DELETEs succeed. Checked on each answer, rather than
// comparing to one hard-coded order (any valid order would do).
function expectReferencingTablesFirst(
  order: string[],
  foreignKeys: ForeignKey[],
) {
  for (const { from, to } of foreignKeys) {
    if (from === to) continue
    expect(order.indexOf(from)).toBeLessThan(order.indexOf(to))
  }
}

describe('deletionOrder', () => {
  // A slice of Stride's real graph (read from the catalog on 2026-10-08).
  const tables = [
    'users',
    'clinics',
    'user_clinics',
    'invitations',
    'exercises',
    'program_templates',
    'template_exercises',
    'session',
  ]
  const foreignKeys: ForeignKey[] = [
    { from: 'user_clinics', to: 'users' },
    { from: 'user_clinics', to: 'clinics' },
    { from: 'invitations', to: 'users' },
    { from: 'exercises', to: 'users' },
    { from: 'program_templates', to: 'users' },
    { from: 'template_exercises', to: 'program_templates' },
    { from: 'template_exercises', to: 'exercises' },
  ]

  it('puts every table before the tables it references, and includes every table once', () => {
    const order = deletionOrder(tables, foreignKeys)

    expect([...order].sort()).toEqual([...tables].sort())
    expectReferencingTablesFirst(order, foreignKeys)
  })

  // Within a "round", alphabetical: the same order on every run.
  it('is deterministic', () => {
    expect(deletionOrder(tables, foreignKeys)).toEqual([
      'invitations',
      'session',
      'template_exercises',
      'user_clinics',
      'clinics',
      'exercises',
      'program_templates',
      'users',
    ])
  })

  it('ignores a table referencing itself (one DELETE empties it)', () => {
    expect(
      deletionOrder(
        ['users', 'notes'],
        [
          { from: 'notes', to: 'notes' },
          { from: 'notes', to: 'users' },
        ],
      ),
    ).toEqual(['notes', 'users'])
  })

  it('ignores a key to a table outside the list', () => {
    expect(deletionOrder(['a'], [{ from: 'a', to: 'elsewhere' }])).toEqual([
      'a',
    ])
  })

  it('refuses a cycle, naming the tables in it', () => {
    expect(() =>
      deletionOrder(
        ['a', 'b', 'c'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
          { from: 'c', to: 'a' },
        ],
      ),
    ).toThrow(
      'Foreign keys form a cycle between: a, b — no deletion order exists.',
    )
  })
})