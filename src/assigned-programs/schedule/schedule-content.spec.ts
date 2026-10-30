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

import { BadRequestException, NotFoundException } from '@nestjs/common'
import {
  contentBeforePause,
  contentFromNewSchedule,
  contentFromVersionInput,
  type DatedContent,
} from './schedule-content'
import { ScheduleType } from '../dto/schedule-input.dto'

// How a schedule as the API received it becomes the content that's stored.
// Pure, so plain values in, plain values out.

describe('contentFromNewSchedule (when assigning)', () => {
  // The new program's workouts, in order: A = 101, B = 102.
  const ids = [101, 102]

  // Positions become ids, days come out in weekday order (sent Friday
  // first), and the caller's array is left as it was.
  it("turns workout positions into the new program's ids, days in order", () => {
    const days = [
      { weekday: 5, workoutIndex: 0 },
      { weekday: 1, workoutIndex: 0 },
      { weekday: 3, workoutIndex: 1 },
    ]
    expect(
      contentFromNewSchedule({ type: ScheduleType.WEEKDAYS, days }, ids),
    ).toStrictEqual({
      type: 'weekdays',
      timesPerWeek: null,
      days: [
        { weekday: 1, workoutId: 101 },
        { weekday: 3, workoutId: 102 },
        { weekday: 5, workoutId: 101 },
      ],
      rotation: [],
    })
    expect(days.map((d) => d.weekday)).toEqual([5, 1, 3])
  })

  it('maps a rotation of positions, repeats included', () => {
    expect(
      contentFromNewSchedule(
        {
          type: ScheduleType.TIMES_PER_WEEK,
          timesPerWeek: 3,
          rotation: [1, 0, 1],
        },
        ids,
      ),
    ).toStrictEqual({
      type: 'times_per_week',
      timesPerWeek: 3,
      days: [],
      rotation: [102, 101, 102],
    })
  })

  // The suggestion: every workout, in order (decisions §5).
  it('suggests every workout in order when no rotation is given', () => {
    expect(
      contentFromNewSchedule(
        { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 2 },
        ids,
      ).rotation,
    ).toEqual([101, 102])
  })

  // The boundary: position 1 exists (B), 2 doesn't.
  it("refuses a position the program doesn't have, saying what it has", () => {
    expect(() =>
      contentFromNewSchedule(
        {
          type: ScheduleType.WEEKDAYS,
          days: [{ weekday: 1, workoutIndex: 2 }],
        },
        ids,
      ),
    ).toThrow(
      new BadRequestException(
        "workoutIndex 2 doesn't exist: the program has 2 workouts (A, B)",
      ),
    )
    expect(() =>
      contentFromNewSchedule(
        { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 1, rotation: [1] },
        [101],
      ),
    ).toThrow(
      new BadRequestException(
        "workoutIndex 1 doesn't exist: the program has 1 workout (A)",
      ),
    )
  })
})

describe('contentFromVersionInput (a later version)', () => {
  // The program's workouts, read back OUT of position order: B's row first.
  const workouts = [
    { id: 12, name: 'Lower body', sortOrder: 1 },
    { id: 11, name: null, sortOrder: 0 },
  ]

  it('keeps the ids, days in weekday order', () => {
    expect(
      contentFromVersionInput(
        {
          type: ScheduleType.WEEKDAYS,
          days: [
            { weekday: 4, workoutId: 12 },
            { weekday: 2, workoutId: 11 },
          ],
        },
        workouts,
      ),
    ).toStrictEqual({
      type: 'weekdays',
      timesPerWeek: null,
      days: [
        { weekday: 2, workoutId: 11 },
        { weekday: 4, workoutId: 12 },
      ],
      rotation: [],
    })
  })

  // "Every workout in order" means by POSITION (A, then B) — not the order
  // the rows were read in (which would give B, A here).
  it('suggests every workout in position order when no rotation is given', () => {
    expect(
      contentFromVersionInput(
        { type: ScheduleType.TIMES_PER_WEEK, timesPerWeek: 2 },
        workouts,
      ).rotation,
    ).toEqual([11, 12])
  })

  it('keeps a rotation as given', () => {
    expect(
      contentFromVersionInput(
        {
          type: ScheduleType.TIMES_PER_WEEK,
          timesPerWeek: 2,
          rotation: [12, 12, 11],
        },
        workouts,
      ).rotation,
    ).toEqual([12, 12, 11])
  })

  it('makes a pause empty', () => {
    expect(
      contentFromVersionInput({ type: ScheduleType.PAUSED }, workouts),
    ).toStrictEqual({
      type: 'paused',
      timesPerWeek: null,
      days: [],
      rotation: [],
    })
  })

  // Another program's workout, in a day or in a rotation.
  it.each([
    [
      'a day',
      { type: ScheduleType.WEEKDAYS, days: [{ weekday: 1, workoutId: 99 }] },
    ],
    [
      'a rotation',
      {
        type: ScheduleType.TIMES_PER_WEEK,
        timesPerWeek: 1,
        rotation: [11, 99],
      },
    ],
  ])("refuses another program's workout in %s", (_label, schedule) => {
    expect(() => contentFromVersionInput(schedule, workouts)).toThrow(
      new NotFoundException('Workout 99 not found in this program'),
    )
  })
})

// A pause with an end (roadmap Phase 6.5): what comes back on the back-on
// day.
describe('contentBeforePause', () => {
  const weekdays = (
    effectiveFrom: string,
    weekdays: number[],
  ): DatedContent => ({
    effectiveFrom,
    type: 'weekdays',
    timesPerWeek: null,
    days: weekdays.map((weekday) => ({ weekday, workoutId: 101 })),
    rotation: [],
  })
  const pause = (effectiveFrom: string): DatedContent => ({
    effectiveFrom,
    type: 'paused',
    timesPerWeek: null,
    days: [],
    rotation: [],
  })
  const count = (effectiveFrom: string): DatedContent => ({
    effectiveFrom,
    type: 'times_per_week',
    timesPerWeek: 3,
    days: [],
    rotation: [101, 102],
  })

  it('takes the version in force just before the pause — the latest one before it', () => {
    // Listed out of date order on purpose: the rule sorts, it doesn't
    // trust the order it's given.
    const versions = [count('2026-10-05'), weekdays('2026-10-01', [1, 3, 5])]
    expect(contentBeforePause(versions, '2026-10-12')).toStrictEqual({
      type: 'times_per_week',
      timesPerWeek: 3,
      days: [],
      rotation: [101, 102],
    })
  })

  it('ignores a version starting on the pause day or later — the pause replaces it', () => {
    const versions = [
      weekdays('2026-10-01', [1, 3, 5]),
      count('2026-10-12'),
      count('2026-10-20'),
    ]
    expect(contentBeforePause(versions, '2026-10-12')?.type).toBe('weekdays')
  })

  it('skips a pause already in force: it resumes the schedule before THAT one', () => {
    const versions = [weekdays('2026-10-01', [2, 4]), pause('2026-10-08')]
    expect(contentBeforePause(versions, '2026-10-12')).toStrictEqual({
      type: 'weekdays',
      timesPerWeek: null,
      days: [
        { weekday: 2, workoutId: 101 },
        { weekday: 4, workoutId: 101 },
      ],
      rotation: [],
    })
  })

  it('answers null when there is nothing before the pause to come back to', () => {
    expect(contentBeforePause([], '2026-10-12')).toBeNull()
    expect(contentBeforePause([pause('2026-10-08')], '2026-10-12')).toBeNull()
  })

  it('gives copies: changing the result leaves the versions as they were', () => {
    const source = weekdays('2026-10-01', [1])
    const result = contentBeforePause([source], '2026-10-12')!
    result.days[0].weekday = 7
    result.days.push({ weekday: 3, workoutId: 102 })
    expect(source.days).toEqual([{ weekday: 1, workoutId: 101 }])
  })

  it('copies a rotation too', () => {
    const source = count('2026-10-01')
    contentBeforePause([source], '2026-10-12')!.rotation.push(103)
    expect(source.rotation).toEqual([101, 102])
  })
})
