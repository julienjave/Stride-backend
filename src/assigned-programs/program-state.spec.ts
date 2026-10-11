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

import { ConflictException } from '@nestjs/common'
import { assertProgramOpen, closingEndDate } from './program-state'

describe('assertProgramOpen', () => {
  it('lets an active program change', () => {
    expect(() =>
      assertProgramOpen({ status: 'active', isArchived: false }),
    ).not.toThrow()
  })

  it.each(['completed', 'cancelled'] as const)(
    'refuses a %s program',
    (status) => {
      expect(() => assertProgramOpen({ status, isArchived: false })).toThrow(
        new ConflictException(
          `This program is ${status}, so it can no longer change. To continue it, assign it again`,
        ),
      )
    },
  )

  // Archived wins over any status: an archived program is gone, whatever it
  // was before.
  it('refuses an archived program, even an active one', () => {
    expect(() =>
      assertProgramOpen({ status: 'active', isArchived: true }),
    ).toThrow(
      new ConflictException(
        'This program was deleted, so it can no longer change',
      ),
    )
  })
})

describe('closingEndDate', () => {
  const d = (day: string) => `2026-10-${day}`
  const close = (
    start: string,
    end: string | null,
    today: string,
    completedToday = false,
  ) =>
    closingEndDate({
      startDate: d(start),
      endDate: end === null ? null : d(end),
      today: d(today),
      completedToday,
    })

  it.each<[string, string, string | null, string, boolean, string]>([
    // Decided today: today isn't a missed day.
    ['ends yesterday', '01', '31', '20', false, '19'],
    [
      'ends today when a session was completed today',
      '01',
      '31',
      '20',
      true,
      '20',
    ],
    // Open-ended: the same.
    ['ends an open-ended program yesterday', '01', null, '20', false, '19'],
    // Closed after its end date: the end stays (and "today" doesn't move it
    // later either).
    ['keeps an end date already past', '01', '10', '20', true, '10'],
    // The end date is exactly yesterday: unchanged either way.
    ['keeps an end date of yesterday', '01', '19', '20', false, '19'],
    // Started today (or later): never before the start.
    ['never ends before the start', '20', '31', '20', false, '20'],
    ['never ends before a future start', '25', null, '20', false, '25'],
  ])('%s', (_label, start, end, today, completedToday, expected) => {
    expect(close(start, end, today, completedToday)).toBe(d(expected))
  })
})