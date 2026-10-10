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

import { seedSessionDays } from './session-history'

// October 2026: Mon 12, Wed 14, Fri 16, Mon 19, Wed 21, Fri 23, Mon 26.
const MWF = { type: 'weekdays' as const, weekdays: [1, 3, 5] }
const d = (day: string) => `2026-10-${day}`

describe('seedSessionDays', () => {
  // Scheduled days before Mon 26: 12, 14, 16, 19, 21, 23. Index 1 (Wed 14)
  // made up on Thu 15; index 3 (Mon 19) missed.
  it('gives a weekdays history: all done, one made up the next day, one missed', () => {
    expect(
      seedSessionDays(d('12'), d('26'), MWF, {
        kind: 'weekdays',
        madeUpIndex: 1,
        missedIndex: 3,
      }),
    ).toEqual([d('12'), d('15'), d('16'), d('21'), d('23')])
  })

  // Only days before today: today's session is left to try.
  it('stops before today', () => {
    expect(
      seedSessionDays(d('12'), d('16'), MWF, {
        kind: 'weekdays',
        madeUpIndex: 1,
        missedIndex: 3,
      }),
    ).toEqual([d('12'), d('15')])
  })

  it('skips a make-up that would fall on today', () => {
    expect(
      seedSessionDays(d('12'), d('15'), MWF, {
        kind: 'weekdays',
        madeUpIndex: 1,
        missedIndex: 3,
      }),
    ).toEqual([d('12')])
  })

  it('gives sessions on days after the start, before today', () => {
    expect(
      seedSessionDays(
        d('15'),
        d('25'),
        { type: 'times_per_week', timesPerWeek: 3 },
        {
          kind: 'days-after-start',
          days: [0, 2, 8, 10],
        },
      ),
    ).toEqual([d('15'), d('17'), d('23')])
  })

  it('refuses a weekdays history on a times-per-week schedule', () => {
    expect(() =>
      seedSessionDays(
        d('12'),
        d('26'),
        { type: 'times_per_week', timesPerWeek: 3 },
        {
          kind: 'weekdays',
          madeUpIndex: 1,
          missedIndex: 3,
        },
      ),
    ).toThrow('A weekdays history needs a weekdays schedule')
  })

  // Tue/Wed: the day after Tuesday is scheduled, so a "next-day make-up"
  // would really be Wednesday's own session.
  it('refuses a make-up that would land on a scheduled day', () => {
    expect(() =>
      seedSessionDays(
        d('12'),
        d('26'),
        { type: 'weekdays', weekdays: [2, 3] },
        {
          kind: 'weekdays',
          madeUpIndex: 0,
          missedIndex: 3,
        },
      ),
    ).toThrow(
      'A make-up the day after 2026-10-13 would fall on a scheduled day',
    )
  })
})