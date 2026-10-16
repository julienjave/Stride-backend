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
import {
  sessionForOtherDay,
  versionOn,
  type SwapRequest,
  type SwapVersion,
} from './swap-rules'

// October 2026: Thursday 15 is the start, so program weeks run Thursday to
// Wednesday (15–21, 22–28) — deliberately NOT calendar weeks, so a rule
// using Monday-to-Sunday weeks gets cases wrong. Mon 19 = A (11),
// Wed 21 = B (12), Fri 16 = A.
const d = (day: string) => `2026-10-${day}`
const A = 11
const B = 12

const MWF: SwapVersion = {
  type: 'weekdays',
  days: [
    { weekday: 1, workoutId: A },
    { weekday: 3, workoutId: B },
    { weekday: 5, workoutId: A },
  ],
  effectiveFrom: d('15'),
}

function request(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    program: {
      startDate: d('15'),
      endDate: d('31'),
      allowSwaps: true,
      lateMakeUpDays: null,
    },
    versions: [MWF],
    // Done on Monday 19, for Wednesday 21 (B).
    localDate: d('19'),
    countsFor: d('21'),
    requestedWorkoutId: undefined,
    ...overrides,
  }
}

// The program fixture with some fields changed.
const program = (changes: Partial<SwapRequest['program']>) => ({
  ...request().program,
  ...changes,
})

describe('sessionForOtherDay', () => {
  // The day's workout — whether or not the patient named it.
  it.each([undefined, null, B])(
    "answers the counted day's workout (workout sent: %p)",
    (requestedWorkoutId) => {
      expect(sessionForOtherDay(request({ requestedWorkoutId }))).toStrictEqual(
        { kind: 'swap', workoutId: B },
      )
    },
  )

  // Both directions within the week — done early or the first half of a
  // swap (above: Monday 19, a scheduled day, for Wednesday 21), and the
  // second half of a swap: Friday 16's A done on Monday 19, a scheduled
  // day — the same program week (15–21), though a calendar week would put
  // them apart.
  it('accepts an earlier day from a scheduled day (a swap)', () => {
    expect(sessionForOtherDay(request({ countsFor: d('16') }))).toStrictEqual({
      kind: 'swap',
      workoutId: A,
    })
  })

  // Done early on a FREE day: Tuesday 20 for Wednesday 21.
  it('accepts a later day from a free day (done early)', () => {
    expect(sessionForOtherDay(request({ localDate: d('20') }))).toStrictEqual({
      kind: 'done_early',
      workoutId: B,
    })
  })

  // A FREE day for an EARLIER day — Tuesday 20 for Monday 19: a late
  // make-up (refused as "case 3" from 2026-10-12 until late make-ups were
  // designed, 2026-10-16). Whether it's allowed, and whether Monday really
  // was missed, is the summary's to say (assertLateMakeUpAllowed): here it
  // is only classified — even with late make-ups off.
  it('classifies an earlier day from a free day as a late make-up', () => {
    expect(
      sessionForOtherDay(request({ localDate: d('20'), countsFor: d('19') })),
    ).toStrictEqual({ kind: 'late_make_up', workoutId: A })
  })

  // Rearranging is one switch, late make-ups another: with swaps off, a
  // late make-up still goes on to its own checks…
  it("doesn't ask the swap switch about a late make-up", () => {
    expect(
      sessionForOtherDay(
        request({
          program: program({ allowSwaps: false }),
          localDate: d('20'),
          countsFor: d('19'),
        }),
      ),
    ).toStrictEqual({ kind: 'late_make_up', workoutId: A })
  })

  // …and isn't held to one program week: Thursday 22 (week 22–28) making
  // up Monday 19 (week 15–21) — being ill can cross a week.
  it('lets a late make-up cross into the next program week', () => {
    expect(
      sessionForOtherDay(request({ localDate: d('22'), countsFor: d('19') })),
    ).toStrictEqual({ kind: 'late_make_up', workoutId: A })
  })

  // Which version says whether TODAY is scheduled: the one in force today,
  // not the counted day's. From Monday 19 on, the schedule is Tuesday /
  // Thursday: Friday 16 was scheduled (old version), Tuesday 20 now is.
  const TUE_THU: SwapVersion = {
    type: 'weekdays',
    days: [
      { weekday: 2, workoutId: B },
      { weekday: 4, workoutId: A },
    ],
    effectiveFrom: d('19'),
  }
  it("judges today by today's version: Tuesday 20 is scheduled under the new one", () => {
    expect(
      sessionForOtherDay(
        request({
          versions: [MWF, TUE_THU],
          localDate: d('20'),
          countsFor: d('16'),
        }),
      ),
    ).toStrictEqual({ kind: 'swap', workoutId: A })
  })

  // …and the other way: under Tue/Thu from Monday 19, Wednesday 21 is
  // free — though the counted day's version (MWF) schedules it — so a
  // session there for Friday 16 is a late make-up, not a swap.
  it("judges today by today's version: Wednesday 21 is free under the new one", () => {
    expect(
      sessionForOtherDay(
        request({
          versions: [MWF, TUE_THU],
          localDate: d('21'),
          countsFor: d('16'),
        }),
      ),
    ).toStrictEqual({ kind: 'late_make_up', workoutId: A })
  })

  it.each<[string, Partial<SwapRequest>, string]>([
    [
      'a swap when swaps are turned off',
      { program: program({ allowSwaps: false }) },
      'Rearranging the week is turned off for this program: do the workout scheduled today, or ask your practitioner',
    ],
    [
      'done early when swaps are turned off',
      { program: program({ allowSwaps: false }), localDate: d('20') },
      'Rearranging the week is turned off for this program: do the workout scheduled today, or ask your practitioner',
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
        program: program({ endDate: d('20') }),
        countsFor: d('21'),
      },
      'countsFor must be a day of the program',
    ],
    // Wednesday 21 → Thursday 22 starts the next program week; a calendar
    // week (Mon 19 – Sun 25) would call it the same.
    [
      'a day of the next program week',
      { localDate: d('21'), countsFor: d('22') },
      'A session for another day stays within the program week: countsFor must be in the same week as today',
    ],
    [
      'a weekly-count schedule',
      {
        versions: [
          { type: 'times_per_week', days: [], effectiveFrom: d('15') },
        ],
      },
      'Only schedules with specific days can be rearranged: with a weekly count, any order within the week already counts',
    ],
    [
      'a late make-up on a weekly-count schedule',
      {
        versions: [
          { type: 'times_per_week', days: [], effectiveFrom: d('15') },
        ],
        localDate: d('20'),
        countsFor: d('19'),
      },
      'Only schedules with specific days have late make-ups: a weekly count starts again each week',
    ],
    [
      'a paused day',
      // Paused from Tuesday 20: Wednesday 21 has no workout, though the
      // first version (in force on Monday, today) gives it one.
      { versions: [MWF, { type: 'paused', days: [], effectiveFrom: d('20') }] },
      '2026-10-21 has no workout (the program is paused then)',
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
    expect(() => sessionForOtherDay(request(overrides))).toThrow(
      new BadRequestException(message),
    )
  })

  // An open-ended program has no last day to be after.
  it('accepts any day of an open-ended program', () => {
    expect(
      sessionForOtherDay(request({ program: program({ endDate: null }) })),
    ).toStrictEqual({ kind: 'swap', workoutId: B })
  })
})

describe('versionOn', () => {
  const later: SwapVersion = { ...MWF, effectiveFrom: d('22') }

  // Given in any order: the latest starting on or before the day.
  it('picks the latest version started on or before the day, in any order', () => {
    expect(versionOn([later, MWF], d('21'))).toBe(MWF)
    expect(versionOn([later, MWF], d('22'))).toBe(later)
    expect(versionOn([MWF, later], d('30'))).toBe(later)
  })

  it('has none before the first version', () => {
    expect(versionOn([MWF], d('14'))).toBeNull()
  })
})
