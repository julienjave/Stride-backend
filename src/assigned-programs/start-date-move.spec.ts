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

import { BadRequestException } from '@nestjs/common'
import { assertStartDateMovable, planStartDateMove } from './start-date-move'

// Pinned far from the day this was written (a clock pinned to "today" once
// hid a function ignoring it — see sessions.service.spec.ts). UTC's today is
// the 15th, so the earliest allowed day (one day of slack) is the 14th.
const now = new Date('2031-06-15T12:00:00Z')

describe('assertStartDateMovable', () => {
  it.each([
    ['a future start to another future day', '2031-06-20', '2031-06-25'],
    ['a future start to an earlier future day', '2031-06-20', '2031-06-16'],
    ['a start that is today', '2031-06-15', '2031-06-18'],
    // Yesterday in UTC is someone's today: not started for them yet.
    ['a start that is yesterday in UTC', '2031-06-14', '2031-06-18'],
    ['a future start to yesterday in UTC', '2031-06-20', '2031-06-14'],
  ])('allows %s', (_label, current, next) => {
    expect(() => assertStartDateMovable(current, next, now)).not.toThrow()
  })

  it.each([
    [
      'a program that started two days ago',
      '2031-06-13',
      '2031-06-20',
      "The start date can't change once the program has started (it started on 2031-06-13)",
    ],
    [
      'a future start moved two days into the past',
      '2031-06-20',
      '2031-06-13',
      "The start date can't be moved into the past",
    ],
  ])('refuses %s', (_label, current, next, message) => {
    expect(() => assertStartDateMovable(current, next, now)).toThrow(
      new BadRequestException(message),
    )
  })
})

describe('planStartDateMove', () => {
  // Versions with readable ids: A from the 20th (the first, on the old
  // start), B a change planned from the 25th.
  // Each carries some content (any shape — the plan doesn't look at it):
  // the plan must hand back the very version whose content is copied.
  const A = { id: 1, effectiveFrom: '2031-06-20', content: 'Mon/Wed/Fri' }
  const B = { id: 2, effectiveFrom: '2031-06-25', content: '2 a week' }

  it.each([
    // Single version: it simply moves (deleted, re-created on the new day).
    ['earlier, one version', [A], '2031-06-16', { deleteIds: [1], insert: A }],
    ['later, one version', [A], '2031-06-22', { deleteIds: [1], insert: A }],
    // A planned change after the new start stays where it is.
    [
      'earlier, with a planned change',
      [A, B],
      '2031-06-16',
      { deleteIds: [1], insert: A },
    ],
    [
      'later, before the planned change',
      [A, B],
      '2031-06-22',
      { deleteIds: [1], insert: A },
    ],
    // The cases a naive "move the first version" gets wrong:
    // - past the planned change: B was meant to be in force by the 28th, so
    //   B's schedule is what starts on the new day (moving A would hide it);
    [
      'later, past the planned change',
      [A, B],
      '2031-06-28',
      { deleteIds: [1, 2], insert: B },
    ],
    // - exactly onto it: B already starts there — nothing to re-create (a
    //   moved A would collide with B: one version per day).
    [
      'later, exactly onto the planned change',
      [A, B],
      '2031-06-25',
      { deleteIds: [1], insert: null },
    ],
  ])('moves the start %s', (_label, versions, newStart, expected) => {
    expect(planStartDateMove(versions, newStart)).toStrictEqual(expected)
  })

  it('refuses an empty list (every program has a schedule)', () => {
    expect(() => planStartDateMove([], '2031-06-20')).toThrow(
      'A program always has at least one schedule version',
    )
  })
})