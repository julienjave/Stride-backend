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
  assertLateMakeUpAllowed,
  assertSessionOpen,
  assertSkipPain,
  ONE_SESSION_A_DAY_MESSAGE,
  SESSION_FINISHED_MESSAGE,
  skippedWorkoutId,
} from './session-rules'
import type { SwapVersion } from '../assigned-programs/schedule/swap-rules'
import type {
  DayState,
  LateMakeUpBlock,
  ScheduledDay,
} from '../assigned-programs/schedule/schedule-summary'

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

describe('assertLateMakeUpAllowed', () => {
  // Monday 2031-03-03 (A) is the day to make up; Wednesday 2031-03-05 a
  // second scheduled day. The summary is written by hand — the module's
  // own rules are tested in schedule-summary.spec.ts; this is only about
  // reading its answer.
  const MONDAY = '2031-03-03'
  const WEDNESDAY = '2031-03-05'
  const day = (date: string, state: DayState): ScheduledDay => ({
    date,
    workoutId: 1,
    state,
    sessionId: null,
    madeUpBy: null,
    madeUpLateBy: null,
    doneEarlyBy: null,
    swappedBy: null,
    attempts: [],
  })
  const summary = (
    monday: DayState,
    options: {
      wednesday?: DayState
      listed?: boolean
      blockedToday?: LateMakeUpBlock | null
    } = {},
  ) => ({
    days: [day(MONDAY, monday), day(WEDNESDAY, options.wednesday ?? 'done')],
    lateMakeUps: {
      days:
        options.listed === false
          ? []
          : [{ forDay: MONDAY, workoutId: 1, until: '2031-03-09' }],
      blockedToday: options.blockedToday ?? null,
    },
  })

  it('lets a missed day, listed, be made up late today', () => {
    expect(() =>
      assertLateMakeUpAllowed(summary('missed'), MONDAY, 7),
    ).not.toThrow()
  })

  // Still in its window: an ordinary make-up. Said even with late make-ups
  // off — the patient on time is told simply to start.
  it.each([7, null])(
    'sends a day still in its window to an ordinary make-up (late make-ups: %p)',
    (lateMakeUpDays) => {
      expect(() =>
        assertLateMakeUpAllowed(summary('due'), MONDAY, lateMakeUpDays),
      ).toThrow(
        new BadRequestException(
          `${MONDAY} can still be made up on time: start the session without countsFor, before the next scheduled day`,
        ),
      )
    },
  )

  it.each<DayState>([
    'done',
    'made_up',
    'made_up_late',
    'done_early',
    'swapped',
  ])('refuses a day already fulfilled (%s) with a 409', (state) => {
    expect(() => assertLateMakeUpAllowed(summary(state), MONDAY, 7)).toThrow(
      new ConflictException(
        `${MONDAY} is already done: there is nothing to make up`,
      ),
    )
  })

  it('refuses when the program has no late make-ups', () => {
    expect(() =>
      assertLateMakeUpAllowed(summary('missed'), MONDAY, null),
    ).toThrow(
      new BadRequestException(
        'Late make-ups are turned off for this program: ask your practitioner',
      ),
    )
  })

  // Not a free day — said before "too late": on such a day the summary may
  // list nothing, and "too late" would be the wrong reason.
  it("refuses on a day that isn't free, before saying it is too late", () => {
    expect(() =>
      assertLateMakeUpAllowed(
        summary('missed', { listed: false, blockedToday: 'not_a_free_day' }),
        MONDAY,
        7,
      ),
    ).toThrow(
      new BadRequestException(
        'A late make-up is done on a day with nothing scheduled: not during a pause, nor on a weekly count',
      ),
    )
  })

  it('refuses a missed day the summary no longer lists', () => {
    expect(() =>
      assertLateMakeUpAllowed(summary('missed', { listed: false }), MONDAY, 7),
    ).toThrow(
      new BadRequestException(
        `${MONDAY} is more than 7 days ago: it can no longer be made up`,
      ),
    )
  })

  it('refuses when a session was already completed today', () => {
    expect(() =>
      assertLateMakeUpAllowed(
        summary('missed', { blockedToday: 'session_done_today' }),
        MONDAY,
        7,
      ),
    ).toThrow(new ConflictException(ONE_SESSION_A_DAY_MESSAGE))
  })

  // Wednesday can still be made up on time: that comes first, and the
  // message names it.
  it('sends the patient to the ordinary catch-up first', () => {
    expect(() =>
      assertLateMakeUpAllowed(
        summary('missed', { wednesday: 'due', blockedToday: 'catch_up_first' }),
        MONDAY,
        7,
      ),
    ).toThrow(
      new BadRequestException(
        `Catch up ${WEDNESDAY} first: it can still be made up on time, before the next scheduled day`,
      ),
    )
  })
})
