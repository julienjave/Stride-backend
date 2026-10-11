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
import { swapWorkoutId, type SwapRequest } from './swap-rules'

// October 2026: Thursday 15 is the start, so program weeks run Thursday to
// Wednesday (15–21, 22–28) — deliberately NOT calendar weeks, so a rule
// using Monday-to-Sunday weeks gets cases wrong. Mon 19 = A (11),
// Wed 21 = B (12), Fri 16 = A.
const d = (day: string) => `2026-10-${day}`
const A = 11
const B = 12

function request(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    program: { startDate: d('15'), endDate: d('31'), allowSwaps: true },
    version: {
      type: 'weekdays',
      days: [
        { weekday: 1, workoutId: A },
        { weekday: 3, workoutId: B },
        { weekday: 5, workoutId: A },
      ],
    },
    // Done on Monday 19, for Wednesday 21 (B).
    localDate: d('19'),
    countsFor: d('21'),
    requestedWorkoutId: undefined,
    ...overrides,
  }
}

describe('swapWorkoutId', () => {
  // The day's workout — whether or not the patient named it.
  it.each([undefined, null, B])(
    "answers the counted day's workout (workout sent: %p)",
    (requestedWorkoutId) => {
      expect(swapWorkoutId(request({ requestedWorkoutId }))).toBe(B)
    },
  )

  // Both directions within the week: done early (above) or late — Friday
  // 16's A done on Monday 19 is the same program week (15–21), though a
  // calendar week would put them apart.
  it('accepts a day earlier in the same program week', () => {
    expect(swapWorkoutId(request({ countsFor: d('16') }))).toBe(A)
  })

  it.each<[string, Partial<SwapRequest>, string]>([
    [
      'swaps turned off',
      { program: { startDate: d('15'), endDate: d('31'), allowSwaps: false } },
      'Swaps are turned off for this program: do the workout scheduled today, or ask your practitioner',
    ],
    [
      'today itself',
      { countsFor: d('19') },
      'countsFor must be another day: a session already counts for its own',
    ],
    [
      'a day before the start',
      { localDate: d('15'), countsFor: d('14') },
      'countsFor must be a day of the program',
    ],
    [
      'a day after the end',
      {
        program: { startDate: d('15'), endDate: d('20'), allowSwaps: true },
        countsFor: d('21'),
      },
      'countsFor must be a day of the program',
    ],
    // Wednesday 21 → Thursday 22 starts the next program week; a calendar
    // week (Mon 19 – Sun 25) would call it the same.
    [
      'a day of the next program week',
      { localDate: d('21'), countsFor: d('22') },
      'A swap stays within the program week: countsFor must be in the same week as today',
    ],
    [
      'a weekly-count schedule',
      { version: { type: 'times_per_week', days: [] } },
      'Swaps are for schedules with specific days: with a weekly count, any order within the week already counts',
    ],
    [
      'a paused day',
      { version: { type: 'paused', days: [] } },
      '2026-10-21 has no workout to swap (the program is paused then)',
    ],
    [
      'an unscheduled day',
      { countsFor: d('20') },
      "2026-10-20 isn't a scheduled day of this program",
    ],
    [
      "another workout than the day's",
      { requestedWorkoutId: A },
      "Workout 11 isn't the workout scheduled on 2026-10-21",
    ],
  ])('refuses %s', (_label, overrides, message) => {
    expect(() => swapWorkoutId(request(overrides))).toThrow(
      new BadRequestException(message),
    )
  })

  // An open-ended program has no last day to be after.
  it('accepts any day of an open-ended program', () => {
    expect(
      swapWorkoutId(
        request({
          program: { startDate: d('15'), endDate: null, allowSwaps: true },
        }),
      ),
    ).toBe(B)
  })
})