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

import { BadRequestException, ConflictException } from '@nestjs/common'
import {
  assertCompletableOnItsDay,
  assertDurationPossible,
  assertSessionOpen,
  assertSkipPain,
  SESSION_FINISHED_MESSAGE,
  skippedWorkoutId,
} from './session-rules'
import type { SwapVersion } from '../assigned-programs/schedule/swap-rules'

// Clocks are pinned far from today (2031): a rule that ignored its `now`
// and read the real clock would fail here instead of passing by luck.
// 2031-03-12 is a Wednesday (ISO weekday 3).
const NOW = new Date('2031-03-12T15:00:00Z')

describe('assertSessionOpen', () => {
  it('lets an open session through', () => {
    expect(() => assertSessionOpen({ status: 'in_progress' })).not.toThrow()
  })

  it.each(['completed', 'incomplete', 'skipped'])(
    'refuses a %s session — final — with a 409',
    (status) => {
      expect(() => assertSessionOpen({ status })).toThrow(
        new ConflictException(SESSION_FINISHED_MESSAGE),
      )
    },
  )
})

describe('assertCompletableOnItsDay', () => {
  // UTC's day and the days on either side are each "today" somewhere.
  it.each(['2031-03-11', '2031-03-12', '2031-03-13'])(
    'allows completing a session of %s (today somewhere)',
    (localDate) => {
      expect(() => assertCompletableOnItsDay(localDate, NOW)).not.toThrow()
    },
  )

  it.each(['2031-03-10', '2031-03-14'])(
    'refuses completing a session of %s — its day is over (or not yet) everywhere',
    (localDate) => {
      expect(() => assertCompletableOnItsDay(localDate, NOW)).toThrow(
        new ConflictException(
          `This session was started on ${localDate} and can only be completed on that day: stop it instead`,
        ),
      )
    },
  )
})

describe('assertDurationPossible', () => {
  const startedAt = new Date('2031-03-12T14:30:00Z') // 30 minutes before NOW

  it.each([undefined, null])('has nothing to check for %s', (duration) => {
    expect(() => assertDurationPossible(duration, startedAt, NOW)).not.toThrow()
  })

  it('allows exactly the time since the start, and less', () => {
    expect(() => assertDurationPossible(1800, startedAt, NOW)).not.toThrow()
    expect(() => assertDurationPossible(0, startedAt, NOW)).not.toThrow()
  })

  it('refuses one second more than the time since the start', () => {
    expect(() => assertDurationPossible(1801, startedAt, NOW)).toThrow(
      new BadRequestException(
        "totalDurationInSeconds can't be longer than the time since the session started (1800 seconds)",
      ),
    )
  })

  // Whole seconds, rounded DOWN: 1800.9 s elapsed allows 1800, not 1801.
  it('counts whole seconds elapsed, rounding down', () => {
    const later = new Date(NOW.getTime() + 900)
    expect(() => assertDurationPossible(1801, startedAt, later)).toThrow(
      BadRequestException,
    )
  })
})

describe('assertSkipPain', () => {
  it('accepts a pain level when pain is the reason', () => {
    expect(() => assertSkipPain('pain', 7)).not.toThrow()
  })

  it.each([undefined, null])(
    'accepts no pain level (%s) whatever the reason',
    (pain) => {
      expect(() => assertSkipPain('illness', pain)).not.toThrow()
    },
  )

  it.each(['illness', 'no_time', 'other'] as const)(
    'refuses a pain level with the reason %s',
    (reason) => {
      expect(() => assertSkipPain(reason, 7)).toThrow(
        new BadRequestException(
          'A pain level is recorded with a skip only when pain is the reason',
        ),
      )
    },
  )

  // 0 is a real answer ("no pain"), not "nothing": still a pain level.
  it('treats 0 as a pain level, not as nothing', () => {
    expect(() => assertSkipPain('other', 0)).toThrow(BadRequestException)
  })
})

describe('skippedWorkoutId', () => {
  const program = { startDate: '2031-03-03', endDate: null }
  // Mon (1) = workout 10, Wed (3) = workout 11 — from the start.
  const weekdays: SwapVersion = {
    type: 'weekdays',
    effectiveFrom: '2031-03-03',
    days: [
      { weekday: 1, workoutId: 10 },
      { weekday: 3, workoutId: 11 },
    ],
  }

  it("answers the scheduled day's workout", () => {
    expect(
      skippedWorkoutId({
        program,
        versions: [weekdays],
        localDate: '2031-03-12', // a Wednesday
      }),
    ).toBe(11)
  })

  it('refuses a free day', () => {
    expect(() =>
      skippedWorkoutId({
        program,
        versions: [weekdays],
        localDate: '2031-03-11', // a Tuesday
      }),
    ).toThrow(
      new BadRequestException(
        'Nothing is scheduled today, so there is nothing to skip',
      ),
    )
  })

  // The version in force ON that day decides: from the 12th the schedule is
  // Tuesdays only — so the Wednesday the first version scheduled is free,
  // and the Tuesday after is skippable.
  it('judges the day by the version in force on it', () => {
    const tuesdaysFrom12th: SwapVersion = {
      type: 'weekdays',
      effectiveFrom: '2031-03-12',
      days: [{ weekday: 2, workoutId: 12 }],
    }
    const versions = [tuesdaysFrom12th, weekdays] // any order
    expect(() =>
      skippedWorkoutId({ program, versions, localDate: '2031-03-12' }),
    ).toThrow(BadRequestException)
    expect(
      skippedWorkoutId({ program, versions, localDate: '2031-03-18' }),
    ).toBe(12)
    // …and before the 12th, the first version still applies.
    expect(
      skippedWorkoutId({ program, versions, localDate: '2031-03-10' }),
    ).toBe(10)
  })

  it('refuses under a weekly count: no day is due', () => {
    expect(() =>
      skippedWorkoutId({
        program,
        versions: [
          { type: 'times_per_week', effectiveFrom: '2031-03-03', days: [] },
        ],
        localDate: '2031-03-12',
      }),
    ).toThrow(
      new BadRequestException(
        'This program has no set days: nothing is due on a given day, so there is nothing to skip',
      ),
    )
  })

  it('refuses during a pause: nothing is due', () => {
    expect(() =>
      skippedWorkoutId({
        program,
        versions: [
          weekdays,
          { type: 'paused', effectiveFrom: '2031-03-10', days: [] },
        ],
        localDate: '2031-03-12',
      }),
    ).toThrow(
      new BadRequestException(
        'The program is paused today: nothing is due, so there is nothing to skip',
      ),
    )
  })

  it('refuses a day before the program starts', () => {
    expect(() =>
      skippedWorkoutId({
        program: { startDate: '2031-03-16', endDate: null },
        versions: [{ ...weekdays, effectiveFrom: '2031-03-16' }],
        localDate: '2031-03-12',
      }),
    ).toThrow(
      new BadRequestException(
        'The program starts on 2031-03-16: there is nothing to skip before then',
      ),
    )
  })

  // The last day still counts; the day after doesn't — even though the
  // version (which has no end of its own) would still name a workout.
  it('allows the last day and refuses the day after the program ends', () => {
    const ended = { startDate: '2031-03-03', endDate: '2031-03-11' }
    expect(() =>
      skippedWorkoutId({
        program: ended,
        versions: [weekdays],
        localDate: '2031-03-12',
      }),
    ).toThrow(
      new BadRequestException(
        'The program ended on 2031-03-11: there is nothing left to skip',
      ),
    )
    expect(
      skippedWorkoutId({
        program: { ...ended, endDate: '2031-03-12' },
        versions: [weekdays],
        localDate: '2031-03-12',
      }),
    ).toBe(11)
  })

  // The first day is the start: skippable when scheduled.
  it('allows the first day of the program', () => {
    expect(
      skippedWorkoutId({
        program: { startDate: '2031-03-12', endDate: null },
        versions: [{ ...weekdays, effectiveFrom: '2031-03-12' }],
        localDate: '2031-03-12',
      }),
    ).toBe(11)
  })
})
