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

import { seedSessionDays, seedSessionWorkouts } from './session-history'

// October 2026: Mon 12, Wed 14, Fri 16, Mon 19, Wed 21, Fri 23, Mon 26.
// Monday A, Wednesday B, Friday A (workout positions, as in the dataset).
const MWF = {
  type: 'weekdays' as const,
  days: [
    { weekday: 1, workoutIndex: 0 },
    { weekday: 3, workoutIndex: 1 },
    { weekday: 5, workoutIndex: 0 },
  ],
}
const d = (day: string) => `2026-10-${day}`
// Just the days the sessions were done on.
const days = (sessions: { day: string }[]) => sessions.map((s) => s.day)

describe('seedSessionDays', () => {
  // Scheduled days before Mon 26: 12, 14, 16, 19, 21, 23. Index 1 (Wed 14)
  // made up on Thu 15; index 3 (Mon 19) missed.
  // Each session also says which scheduled day it counts for: its own day,
  // except the make-up (Thu 15), which counts for Wed 14 — the seed gives it
  // Wednesday's workout.
  it('gives a weekdays history: all done, one made up the next day, one missed', () => {
    expect(
      seedSessionDays(d('12'), d('26'), MWF, {
        kind: 'weekdays',
        madeUpIndex: 1,
        missedIndex: 3,
      }),
    ).toEqual([
      { day: d('12'), forDay: d('12'), countsFor: null },
      { day: d('15'), forDay: d('14'), countsFor: null },
      { day: d('16'), forDay: d('16'), countsFor: null },
      { day: d('21'), forDay: d('21'), countsFor: null },
      { day: d('23'), forDay: d('23'), countsFor: null },
    ])
  })

  // A swap of the FIRST scheduled day (index 0; 9 = no make-up, no miss).
  // Started on Thursday 15, so program weeks run Thursday to Wednesday and
  // the scheduled days are Fri 16, Mon 19, Wed 21, Fri 23: Fri 16's day
  // before (Thu 15) is in the same week → the swap is done early, on
  // Thursday, counting for Friday.
  it('gives a swap the day before its day, in the same program week', () => {
    expect(
      seedSessionDays(d('15'), d('26'), MWF, {
        kind: 'weekdays',
        madeUpIndex: 9,
        missedIndex: 9,
        swappedIndex: 0,
      }),
    ).toEqual([
      { day: d('15'), forDay: d('16'), countsFor: d('16') },
      { day: d('19'), forDay: d('19'), countsFor: null },
      { day: d('21'), forDay: d('21'), countsFor: null },
      { day: d('23'), forDay: d('23'), countsFor: null },
    ])
  })

  // Started on Monday 12: Mon 19 starts the second program week, so the day
  // before it (Sun 18) is in the FIRST — the swap is done the day after.
  it('gives a swap the day after when the day before is in another week', () => {
    const sessions = seedSessionDays(d('12'), d('26'), MWF, {
      kind: 'weekdays',
      madeUpIndex: 9,
      missedIndex: 9,
      swappedIndex: 3,
    })
    expect(sessions).toContainEqual({
      day: d('20'),
      forDay: d('19'),
      countsFor: d('19'),
    })
    expect(sessions.map((s) => s.day)).toEqual([
      d('12'),
      d('14'),
      d('16'),
      d('20'),
      d('21'),
      d('23'),
    ])
  })

  it('refuses a swap that would land on a scheduled day', () => {
    expect(() =>
      seedSessionDays(
        d('12'),
        d('26'),
        {
          type: 'weekdays',
          days: [
            { weekday: 2, workoutIndex: 0 },
            { weekday: 3, workoutIndex: 0 },
          ],
        },
        { kind: 'weekdays', madeUpIndex: 9, missedIndex: 9, swappedIndex: 1 },
      ),
    ).toThrow('A swap on 2026-10-13 would fall on a scheduled day')
  })

  // Only days before today: today's session is left to try.
  it('stops before today', () => {
    expect(
      days(
        seedSessionDays(d('12'), d('16'), MWF, {
          kind: 'weekdays',
          madeUpIndex: 1,
          missedIndex: 3,
        }),
      ),
    ).toEqual([d('12'), d('15')])
  })

  it('skips a make-up that would fall on today', () => {
    expect(
      days(
        seedSessionDays(d('12'), d('15'), MWF, {
          kind: 'weekdays',
          madeUpIndex: 1,
          missedIndex: 3,
        }),
      ),
    ).toEqual([d('12')])
  })

  // Each counts for its own day: these histories have no make-ups.
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
    ).toEqual([
      { day: d('15'), forDay: d('15'), countsFor: null },
      { day: d('17'), forDay: d('17'), countsFor: null },
      { day: d('23'), forDay: d('23'), countsFor: null },
    ])
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
        {
          type: 'weekdays',
          days: [
            { weekday: 2, workoutIndex: 0 },
            { weekday: 3, workoutIndex: 0 },
          ],
        },
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

describe('seedSessionWorkouts', () => {
  // The schedules as STORED (workout ids): A = 101, B = 102.
  const storedMwf = {
    type: 'weekdays' as const,
    timesPerWeek: null,
    days: [
      { weekday: 1, workoutId: 101 },
      { weekday: 3, workoutId: 102 },
      { weekday: 5, workoutId: 101 },
    ],
    rotation: [],
  }
  const perWeek = (timesPerWeek: number, rotation: number[]) => ({
    type: 'times_per_week' as const,
    timesPerWeek,
    days: [],
    rotation,
  })
  const on = (day: string, forDay = day) => ({
    day: d(day),
    forDay: d(forDay),
    countsFor: null,
  })

  // The make-up done on Thursday 15 counts for Wednesday 14: B, not A.
  it('gives each session the workout of the day it counts for', () => {
    expect(
      seedSessionWorkouts(d('12'), storedMwf, [
        on('12'),
        on('15', '14'),
        on('16'),
      ]),
    ).toEqual([101, 102, 101])
  })

  it("refuses a session for a day the schedule doesn't have", () => {
    expect(() => seedSessionWorkouts(d('12'), storedMwf, [on('13')])).toThrow(
      "2026-10-13 isn't a scheduled day",
    )
  })

  // [A, B], 3 a week, from Thu 15: week 1 (15–21) needs positions 0, 1, 2
  // = A B A; week 2 (22–28) needs 3, 4, 5 = B A B — its first session is B,
  // not A again: positions go by plan, not by what was done (week 1 did
  // only two).
  it('follows the rotation by plan, week by week', () => {
    expect(
      seedSessionWorkouts(d('15'), perWeek(3, [101, 102]), [
        on('15'),
        on('17'),
        on('22'),
        on('24'),
      ]),
    ).toEqual([101, 102, 102, 101])
  })

  // The program week counts from the start (Thu 15), not from Monday: Wed
  // 21 is still week 1, so with 2 a week a third session there is too many.
  it('refuses more sessions in a program week than the schedule asks for', () => {
    expect(() =>
      seedSessionWorkouts(d('15'), perWeek(2, [101]), [
        on('15'),
        on('19'),
        on('21'),
      ]),
    ).toThrow('Program week 1 would get more than 2 sessions')
  })

  it('refuses a paused schedule', () => {
    expect(() =>
      seedSessionWorkouts(
        d('15'),
        { type: 'paused', timesPerWeek: null, days: [], rotation: [] },
        [on('15')],
      ),
    ).toThrow('A paused schedule has no sessions to seed')
  })
})