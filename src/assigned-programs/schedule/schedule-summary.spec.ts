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

import {
  summarizeSchedule,
  type ScheduleSummary,
  type ScheduleSummaryInput,
  type SummaryAttempt,
  type SummaryScheduleVersion,
} from './schedule-summary'

// The calendar every case uses — October 2026:
//
//   Mon 12  Tue 13  Wed 14  Thu 15  Fri 16  Sat 17  Sun 18
//   Mon 19  Tue 20  Wed 21  Thu 22  Fri 23  Sat 24  Sun 25
//   Mon 26  Tue 27  Wed 28  Thu 29
//
// Dates are written as just their day number ('12' = 2026-10-12) to keep
// the tables readable.

const d = (day: string) => `2026-10-${day}`

// Workouts by name: A = 1, B = 2, C = 3. Most cases have ONE workout (A)
// — the rules that existed before workouts, unchanged; the cases about
// workouts name them.
const A = 1
const B = 2
const C = 3

// A specific-days version: weekdays alone (every day doing A), or
// [weekday, workout] pairs.
const weekdays = (
  days: (number | [number, number])[],
  from: string,
): SummaryScheduleVersion => ({
  type: 'weekdays',
  timesPerWeek: null,
  days: days.map((day) =>
    typeof day === 'number'
      ? { weekday: day, workoutId: A }
      : { weekday: day[0], workoutId: day[1] },
  ),
  rotation: [],
  effectiveFrom: d(from),
})
// N per week, with a rotation (A alone unless given).
const perWeek = (
  n: number,
  from: string,
  rotation: number[] = [A],
): SummaryScheduleVersion => ({
  type: 'times_per_week',
  timesPerWeek: n,
  days: [],
  rotation,
  effectiveFrom: d(from),
})
const paused = (from: string): SummaryScheduleVersion => ({
  type: 'paused',
  timesPerWeek: null,
  days: [],
  rotation: [],
  effectiveFrom: d(from),
})
const MWF = [1, 3, 5]

// Sessions as day numbers (each doing A), or [day, workout] pairs; ids are
// 1, 2, 3… in the order given.
function sessions(...days: (string | [string, number])[]) {
  return days.map((day, i) =>
    typeof day === 'string'
      ? { id: i + 1, localDate: d(day), workoutId: A }
      : { id: i + 1, localDate: d(day[0]), workoutId: day[1] },
  )
}

function summarize(input: {
  start: string
  end?: string
  versions: SummaryScheduleVersion[]
  sessions?: {
    id: number
    localDate: string
    workoutId: number
    countsFor?: string | null
  }[]
  attempts?: SummaryAttempt[]
  today: string
  through?: string
  lateMakeUpDays?: number | null
}): ScheduleSummary {
  const full: ScheduleSummaryInput = {
    startDate: d(input.start),
    endDate: input.end ? d(input.end) : null,
    versions: input.versions,
    sessions: input.sessions ?? [],
    attempts: input.attempts,
    today: d(input.today),
    through: input.through === undefined ? undefined : d(input.through),
    lateMakeUpDays: input.lateMakeUpDays,
  }
  return summarizeSchedule(full)
}

// The scheduled days as compact rows: [day, state] or, when made up,
// [day, 'made_up', day it was made up on].
function dayRows(summary: ScheduleSummary) {
  return summary.days.map((day) => {
    const n = day.date.slice(8)
    return day.madeUpBy
      ? [n, day.state, day.madeUpBy.date.slice(8)]
      : [n, day.state]
  })
}

// The counted weeks as [start, end, target, done, state].
function weekRows(summary: ScheduleSummary) {
  return summary.weeks.map((w) => [
    w.start.slice(8),
    w.end.slice(8),
    w.target,
    w.done,
    w.state,
  ])
}

// Extras as [day, reason].
function extraRows(summary: ScheduleSummary) {
  return summary.extraSessions.map((e) => [e.date.slice(8), e.reason])
}

// --- Specific days: done, made up, missed ------------------------------------------------------------------

describe('specific days (weekdays)', () => {
  it('marks scheduled days with a session as done', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12', '14', '16'),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'done'],
      ['16', 'done'],
    ])
    expect(s.days[0].sessionId).toBe(1)
    expect(s.totals).toEqual({
      expected: 3,
      done: 3,
      madeUp: 0,
      madeUpLate: 0,
      doneEarly: 0,
      swapped: 0,
      missed: 0,
      extra: 0,
      skipped: 0,
      incomplete: 0,
    })
  })

  it.each<[string, number[], string[], (string | undefined)[][]]>([
    // Missed Monday on Mon/Wed/Fri → Tuesday makes it up.
    [
      'Monday made up on Tuesday',
      MWF,
      ['13', '14', '16'],
      [
        ['12', 'made_up', '13'],
        ['14', 'done'],
        ['16', 'done'],
      ],
    ],
    // The session on Wednesday counts for Wednesday FIRST — it can't make
    // up Monday (a naive "nearest missed day" would use it for Monday and
    // leave the patient one behind for the rest of the program).
    [
      'a scheduled day counts for itself first',
      MWF,
      ['14', '16'],
      [
        ['12', 'missed'],
        ['14', 'done'],
        ['16', 'done'],
      ],
    ],
    // Missed Friday → Saturday or Sunday.
    [
      'Friday made up on Sunday',
      MWF,
      ['12', '14', '18'],
      [
        ['12', 'done'],
        ['14', 'done'],
        ['16', 'made_up', '18'],
      ],
    ],
    // Mondays only → the rest of the week.
    [
      'Mondays only, made up on Thursday',
      [1],
      ['15'],
      [['12', 'made_up', '15']],
    ],
    // Tue/Fri, missed Tuesday → Wednesday or Thursday.
    [
      'Tuesday made up on Thursday (Tue/Fri)',
      [2, 5],
      ['15', '16'],
      [
        ['13', 'made_up', '15'],
        ['16', 'done'],
      ],
    ],
    // Two missed in a row: a make-up only reaches back to the most recent
    // missed day — Monday's window closed when Wednesday came.
    [
      'two missed days, one make-up',
      MWF,
      ['15', '16'],
      [
        ['12', 'missed'],
        ['14', 'made_up', '15'],
        ['16', 'done'],
      ],
    ],
  ])('%s', (_label, days, done, expected) => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(days, '12')],
      sessions: sessions(...done),
      today: '19',
    })
    expect(dayRows(s)).toEqual(expected)
  })

  it('reports who made a day up, and when', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('13'),
      today: '19',
    })
    expect(s.days[0]).toStrictEqual({
      date: d('12'),
      workoutId: A,
      state: 'made_up',
      sessionId: null,
      madeUpBy: { sessionId: 1, date: d('13') },
      madeUpLateBy: null,
      doneEarlyBy: null,
      swappedBy: null,
      attempts: [],
    })
    expect(s.totals.madeUp).toBe(1)
  })

  // The Friday window ends at the next scheduled day: a session on Monday 19
  // counts for Monday, and Friday stays missed.
  it("doesn't let the next scheduled day's session make up the previous one", () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12', '14', '19'),
      today: '26',
    })
    expect(dayRows(s).slice(2, 4)).toEqual([
      ['16', 'missed'],
      ['19', 'done'],
    ])
  })
})

// --- Extras --------------------------------------------------------------------------------------------------

describe('extra sessions', () => {
  it.each<[string, string[], string, (string | number)[][]]>([
    // Nothing missed to make up.
    [
      'an unscheduled day with nothing missed',
      ['12', '13'],
      'no_missed_day',
      [['13', 'no_missed_day']],
    ],
    // Once per day: the second session that day is extra (the first, by id,
    // counts).
    [
      'a second session the same day',
      ['12', '12'],
      'same_day',
      [['12', 'same_day']],
    ],
    // Outside the program's dates.
    [
      'before the start or after the end',
      ['11', '12', '19'],
      'outside_program',
      [
        ['11', 'outside_program'],
        ['19', 'outside_program'],
      ],
    ],
  ])('reports %s', (_label, done, _reason, expected) => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions(...done),
      today: '19',
    })
    expect(extraRows(s)).toEqual(expected)
    expect(s.totals.extra).toBe(expected.length)
  })

  it('counts the earlier-created session when two share a day', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: [
        { id: 9, localDate: d('12'), workoutId: A },
        { id: 4, localDate: d('12'), workoutId: A },
      ],
      today: '19',
    })
    expect(s.days[0].sessionId).toBe(4)
    expect(s.extraSessions).toEqual([
      { sessionId: 9, date: d('12'), reason: 'same_day' },
    ])
  })

  // One missed day, one make-up: once Friday is made up on Saturday, a
  // Sunday session has nothing left to make up. (Without "consuming" the
  // missed day, Sunday would take Friday over again.)
  it('uses up the missed day once it is made up', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12', '14', '17', '18'),
      today: '19',
    })
    expect(dayRows(s)[2]).toEqual(['16', 'made_up', '17'])
    expect(extraRows(s)).toEqual([['18', 'no_missed_day']])
  })

  // Extras come back in date order, whichever pass found them: the
  // beyond-target one (found while counting weeks) on the 13th before the
  // same-day one (found first) on the 19th.
  it('lists extras in date order', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(1, '12')],
      sessions: sessions('12', '13', '19', '19'),
      today: '26',
    })
    expect(extraRows(s)).toEqual([
      ['13', 'beyond_target'],
      ['19', 'same_day'],
    ])
  })

  // A second session on an unscheduled day can't make up a SECOND missed
  // day — one session per day, and the window holds one missed day.
  it("doesn't let a same-day extra make anything up", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('13', '13'),
      today: '19',
    })
    expect(dayRows(s)[0]).toEqual(['12', 'made_up', '13'])
    expect(extraRows(s)).toEqual([['13', 'same_day']])
  })
})

// --- Today ---------------------------------------------------------------------------------------------------

describe('today, the future, and open windows', () => {
  it.each<[string, string, string[], (string | undefined)[][]]>([
    // Today's session not done yet: due, never missed.
    [
      'today, not done yet',
      '12',
      [],
      [
        ['12', 'due'],
        ['14', 'upcoming'],
        ['16', 'upcoming'],
      ],
    ],
    // Monday not done, today Tuesday: still in its make-up window.
    [
      'yesterday, still in its window',
      '13',
      [],
      [
        ['12', 'due'],
        ['14', 'upcoming'],
        ['16', 'upcoming'],
      ],
    ],
    // Today Wednesday: Monday's window (Tuesday) is over.
    [
      'a closed window',
      '14',
      [],
      [
        ['12', 'missed'],
        ['14', 'due'],
        ['16', 'upcoming'],
      ],
    ],
    // Before the program starts: everything upcoming.
    [
      'a program that has not started',
      '10',
      [],
      [
        ['12', 'upcoming'],
        ['14', 'upcoming'],
        ['16', 'upcoming'],
      ],
    ],
  ])('%s', (_label, today, done, expected) => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions(...done),
      today,
    })
    expect(dayRows(s)).toEqual(expected)
  })

  // The last scheduled day's window ends with the program: on the end date
  // it's still due, the day after it's missed.
  it.each([
    ['16', 'due'],
    ['17', 'missed'],
  ])('ends the last window at the end date (today %s → %s)', (today, state) => {
    const s = summarize({
      start: '12',
      end: '16',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12', '14'),
      today,
    })
    expect(dayRows(s)[2]).toEqual(['16', state])
  })

  // Open-ended: the summary covers up to the end of the current program
  // week, and Friday's window (to the next Monday) is still open on Saturday.
  it('keeps the last window open for an open-ended program', () => {
    const s = summarize({
      start: '12',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12', '14'),
      today: '17',
    })
    expect(s.lastDay).toBe(d('18'))
    expect(dayRows(s)[2]).toEqual(['16', 'due'])
    expect(s.totals.expected).toBeNull()
  })

  it('covers the current program week of an open-ended program', () => {
    // Started Thursday 15: program weeks run Thursday → Wednesday. Today
    // Monday 26 is in the second week, which ends Wednesday 28.
    const s = summarize({
      start: '15',
      versions: [perWeek(3, '15')],
      today: '26',
    })
    expect(s.lastDay).toBe(d('28'))
  })

  it('covers the first week of an open-ended program that has not started', () => {
    const s = summarize({
      start: '15',
      versions: [perWeek(3, '15')],
      today: '12',
    })
    expect(s.lastDay).toBe(d('21'))
  })
})

// --- N per week ----------------------------------------------------------------------------------------------

describe('N per week (times_per_week)', () => {
  // Started Thursday 15: weeks are Thursday → Wednesday, never calendar
  // weeks (decisions §5, point 6).
  it('counts in program weeks starting on the start date', () => {
    const s = summarize({
      start: '15',
      end: '28',
      versions: [perWeek(3, '15')],
      sessions: sessions('15', '17', '19', '22'),
      today: '29',
    })
    expect(weekRows(s)).toEqual([
      ['15', '21', 3, 3, 'met'],
      ['22', '28', 3, 1, 'missed'],
    ])
    expect(s.weeks[0].programWeek).toBe(1)
    expect(s.weeks[1].programWeek).toBe(2)
    expect(s.weeks[0].sessionIds).toEqual([1, 2, 3])
    expect(s.totals).toEqual({
      expected: 6,
      done: 4,
      madeUp: 0,
      madeUpLate: 0,
      doneEarly: 0,
      swapped: 0,
      missed: 2,
      extra: 0,
      skipped: 0,
      incomplete: 0,
    })
  })

  // More than the target: the rest is extra, and doesn't carry over — a
  // short week after it stays short.
  it('reports sessions beyond the target as extra, with no carry-over', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(3, '12')],
      sessions: sessions('12', '13', '14', '15', '19', '21'),
      today: '26',
    })
    expect(weekRows(s)).toEqual([
      ['12', '18', 3, 3, 'met'],
      ['19', '25', 3, 2, 'missed'],
    ])
    expect(extraRows(s)).toEqual([['15', 'beyond_target']])
  })

  // Rounded to the NEAREST: a 4-day final week of "3 a week" is
  // 3 × 4 / 7 = 1.71 → 2 (rounding down would ask for only 1).
  it('rounds a scaled target to the nearest whole session', () => {
    const s = summarize({
      start: '12',
      end: '22',
      versions: [perWeek(3, '12')],
      today: '23',
    })
    expect(s.weeks[1]).toMatchObject({
      start: d('19'),
      end: d('22'),
      target: 2,
    })
  })

  // A week starting today has begun: in progress, not upcoming.
  it('treats a week starting today as in progress', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(3, '12')],
      today: '19',
    })
    expect(s.weeks[1].state).toBe('in_progress')
  })

  // A 3-day final week of "3 a week": round(3 × 3 / 7) = round(1.29) = 1.
  it('scales a final week cut short by the end date', () => {
    const s = summarize({
      start: '12',
      end: '21',
      versions: [perWeek(3, '12')],
      today: '22',
    })
    expect(weekRows(s)).toEqual([
      ['12', '18', 3, 0, 'missed'],
      ['19', '21', 1, 0, 'missed'],
    ])
    expect(s.totals.expected).toBe(4)
  })

  it.each<[string, string[], string]>([
    ['in progress while short of the target', ['12'], 'in_progress'],
    // Met even before the week ends.
    ['met as soon as the target is reached', ['12', '13', '14'], 'met'],
  ])('a current week: %s', (_label, done, state) => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(3, '12')],
      sessions: sessions(...done),
      today: '15',
    })
    expect(s.weeks[0].state).toBe(state)
    expect(s.weeks[1].state).toBe('upcoming')
  })

  // On the week's last day it's still in progress (today is never missed).
  it("isn't missed on its own last day", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(3, '12')],
      sessions: sessions('12'),
      today: '18',
    })
    expect(s.weeks[0].state).toBe('in_progress')
    expect(s.totals.missed).toBe(0)
  })
})

// --- Across schedule versions --------------------------------------------------------------------------------

describe('across schedule versions', () => {
  // Mon/Wed/Fri, then Tue/Thu from Monday 19: each day judged by the version
  // in force that day — the first week's days don't turn into misses.
  it('judges each day by the version in force that day', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12'), weekdays([2, 4], '19')],
      sessions: sessions('12', '14', '16', '20', '22'),
      today: '26',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'done'],
      ['16', 'done'],
      ['20', 'done'],
      ['22', 'done'],
    ])
  })

  it('accepts versions in any order', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays([2, 4], '19'), weekdays(MWF, '12')],
      today: '26',
    })
    expect(dayRows(s).map(([day]) => day)).toEqual([
      '12',
      '14',
      '16',
      '20',
      '22',
    ])
  })

  // Specific days, then 2 a week from Thursday 15 (program weeks Mon → Sun):
  //   - Mon 12 and Wed 14 are judged as specific days;
  //   - Thu 15 → Sun 18 is a 4-day stretch: round(2 × 4 / 7) = 1;
  //   - Wednesday's make-up window ends with the switch: Thursday's session
  //     counts for the new schedule, not as Wednesday's make-up.
  it('splits a week at a change from specific days to N per week', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12'), perWeek(2, '15')],
      sessions: sessions('12', '15'),
      today: '26',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'missed'],
    ])
    expect(weekRows(s)).toEqual([
      ['15', '18', 1, 1, 'met'],
      ['19', '25', 2, 0, 'missed'],
    ])
    expect(s.totals).toEqual({
      expected: 5,
      done: 2,
      madeUp: 0,
      madeUpLate: 0,
      doneEarly: 0,
      swapped: 0,
      missed: 3,
      extra: 0,
      skipped: 0,
      incomplete: 0,
    })
  })

  // The switch also ends the make-up window AS OF TODAY: on Friday 16,
  // Wednesday's window closed with the switch (Thursday), so Wednesday is
  // missed — not still due.
  it('closes the make-up window at the switch, even while the week goes on', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12'), perWeek(2, '15')],
      sessions: sessions('12'),
      today: '16',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'missed'],
    ])
  })

  // 3 a week, then 4 a week from Thursday: the week is split, each part
  // scaled — Mon→Wed round(3 × 3 / 7) = 1, Thu→Sun round(4 × 4 / 7) = 2.
  it('splits a week at a change of N, scaling each part', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(3, '12'), perWeek(4, '15')],
      sessions: sessions('12', '13', '16'),
      today: '19',
    })
    expect(weekRows(s)).toEqual([
      ['12', '14', 1, 1, 'met'],
      ['15', '18', 2, 1, 'missed'],
    ])
    expect(extraRows(s)).toEqual([['13', 'beyond_target']])
  })

  // N per week, then specific days from Thursday 15.
  it('switches from N per week to specific days', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(3, '12'), weekdays([5], '15')],
      sessions: sessions('12', '16'),
      today: '19',
    })
    // Mon→Wed of "3 a week": round(3 × 3 / 7) = 1, met on Monday.
    expect(weekRows(s)).toEqual([['12', '14', 1, 1, 'met']])
    expect(dayRows(s)).toEqual([['16', 'done']])
  })

  // A make-up window can't cross into another 'weekdays' version's days in
  // a way that skips its scheduled day: Monday missed, Tue/Thu from Tuesday
  // 13 — Tuesday is scheduled, so it closes Monday's window.
  it("closes a window at the next version's first scheduled day", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays([1], '12'), weekdays([2, 4], '13')],
      sessions: sessions('13'),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'missed'],
      ['13', 'done'],
      ['15', 'missed'],
    ])
  })
})
// --- Workouts (step 2b-ii) ------------------------------------------------------------------------------------

// Specific days with a workout each: Monday A, Wednesday B, Friday A.
const MON_A_WED_B_FRI_A: [number, number][] = [
  [1, A],
  [3, B],
  [5, A],
]

describe('specific days with workouts', () => {
  it("expects each day's own workout", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A], ['14', B], ['16', A]),
      today: '19',
    })
    expect(
      s.days.map((day) => [day.date.slice(8), day.workoutId, day.state]),
    ).toEqual([
      ['12', A, 'done'],
      ['14', B, 'done'],
      ['16', A, 'done'],
    ])
  })

  // Wednesday is B's day: doing A there doesn't count for it — the day
  // stays open (a make-up of B is still possible on Thursday).
  it("doesn't count another workout for a scheduled day", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A], ['14', A]),
      today: '15',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'due'],
      ['16', 'upcoming'],
    ])
    expect(extraRows(s)).toEqual([['14', 'wrong_workout']])
  })

  // The naive "first session of the day counts" would take the wrong
  // workout (id 1) and leave Wednesday undone.
  it("counts the session doing the day's workout, even if another came first", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['14', A], ['14', B]),
      today: '19',
    })
    expect(s.days[1]).toMatchObject({ state: 'done', sessionId: 2 })
    expect(extraRows(s)).toEqual([['14', 'same_day']])
  })

  // Wednesday (B) missed: a Thursday session makes it up only if it's B.
  it("makes a day up only with that day's workout", () => {
    const withB = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A], ['15', B]),
      today: '19',
    })
    expect(dayRows(withB)[1]).toEqual(['14', 'made_up', '15'])

    const withA = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A], ['15', A]),
      today: '19',
    })
    expect(dayRows(withA)[1]).toEqual(['14', 'missed'])
    expect(extraRows(withA)).toEqual([['15', 'wrong_workout']])
  })

  // An unscheduled day with two sessions: the one doing the missed day's
  // workout makes it up, even though another was recorded first.
  it("makes a day up with the right workout of an unscheduled day's sessions", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A], ['15', A], ['15', B]),
      today: '19',
    })
    expect(s.days[1]).toMatchObject({
      state: 'made_up',
      madeUpBy: { sessionId: 3, date: d('15') },
    })
    expect(extraRows(s)).toEqual([['15', 'same_day']])
  })
})

describe('N per week with a rotation', () => {
  // A, B, C at 3 a week: the week needs one of each, in any order.
  it('needs the next N positions of the rotation, in any order', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(3, '12', [A, B, C])],
      sessions: sessions(['12', C], ['13', A], ['15', B]),
      today: '19',
    })
    expect(weekRows(s)).toEqual([['12', '18', 3, 3, 'met']])
    // Each slot names the session that filled it AND its day — the slot's
    // own order (A, B, C) is the rotation's, not the order things were done.
    expect(s.weeks[0].workouts).toStrictEqual([
      { workoutId: A, sessionId: 2, date: d('13') },
      { workoutId: B, sessionId: 3, date: d('15') },
      { workoutId: C, sessionId: 1, date: d('12') },
    ])
  })

  // A slot still open has no session and no day; one filled has the day of
  // the session that COUNTED — not a same-day extra's (both are on the
  // 13th here, so the extra is a later id: the earliest counts).
  it('dates only the slots that a counted session filled', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(2, '12', [A, B])],
      sessions: sessions(['13', A], ['13', A]),
      today: '14',
    })
    expect(s.weeks[0].workouts).toStrictEqual([
      { workoutId: A, sessionId: 1, date: d('13') },
      { workoutId: B, sessionId: null, date: null },
    ])
    expect(extraRows(s)).toStrictEqual([['13', 'same_day']])
  })

  // The case from the decision: A, A, B = 2 of 3 — the second A is a
  // repeat, and C is still owed.
  it('counts a repeated workout as extra, not toward the week', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(3, '12', [A, B, C])],
      sessions: sessions(['12', A], ['13', A], ['15', B]),
      today: '19',
    })
    expect(weekRows(s)).toEqual([['12', '18', 3, 2, 'missed']])
    expect(extraRows(s)).toEqual([['13', 'repeated_workout']])
  })

  // By PLAN: week 2 continues the rotation where week 1's NEEDS ended
  // (positions 3, 4 → A, B with a 3-long rotation at 2 a week: week 1 needs
  // A, B; week 2 needs C, A) — even though week 1 did nothing. "By what was
  // done" would ask A, B again.
  it('runs the rotation on by plan, week after week', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(2, '12', [A, B, C])],
      sessions: sessions(['19', C], ['20', A]),
      today: '26',
    })
    expect(
      s.weeks.map((w) => w.workouts.map((slot) => slot.workoutId)),
    ).toEqual([
      [A, B],
      [C, A],
    ])
    expect(weekRows(s)).toEqual([
      ['12', '18', 2, 0, 'missed'],
      ['19', '25', 2, 2, 'met'],
    ])
  })

  // A workout the week doesn't need at all, while it still needs others.
  it("counts a workout the week doesn't need as wrong", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(2, '12', [A, B, C])],
      sessions: sessions(['12', C]),
      today: '19',
    })
    expect(extraRows(s)).toEqual([['12', 'wrong_workout']])
    expect(s.weeks[0].done).toBe(0)
  })

  // Once every needed position is done, any further session is beyond the
  // target — whatever its workout.
  it('counts a session after the week is met as beyond the target', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(1, '12', [A, B])],
      sessions: sessions(['12', A], ['13', B]),
      today: '19',
    })
    expect(extraRows(s)).toEqual([['13', 'beyond_target']])
  })

  // A scaled week needs its first k positions: 3 a week over a 3-day
  // final week → round(1.29) = 1 → just the next position.
  it('needs only as many positions as a scaled week targets', () => {
    const s = summarize({
      start: '12',
      end: '21',
      versions: [perWeek(3, '12', [A, B, C])],
      today: '22',
    })
    expect(
      s.weeks.map((w) => w.workouts.map((slot) => slot.workoutId)),
    ).toEqual([[A, B, C], [A]])
  })

  // Each version counts its own positions from ITS start: a new version
  // starts again at position 0.
  it('starts a new version at the beginning of its rotation', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(2, '12', [A, B, C]), perWeek(2, '19', [B, C])],
      today: '26',
    })
    expect(
      s.weeks.map((w) => w.workouts.map((slot) => slot.workoutId)),
    ).toEqual([
      [A, B],
      [B, C],
    ])
  })
})

describe('pauses', () => {
  // Paused from Wednesday 14 to Sunday 18, Mon/Wed/Fri resuming on the 19th.
  const versions = [weekdays(MWF, '12'), paused('14'), weekdays(MWF, '19')]

  it('has nothing due while paused, and resumes after', () => {
    const s = summarize({ start: '12', end: '25', versions, today: '26' })
    expect(dayRows(s).map(([day]) => day)).toEqual(['12', '19', '21', '23'])
    expect(s.pauses).toEqual([{ from: d('14'), to: d('18') }])
  })

  it('counts a session during a pause as extra', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions,
      sessions: sessions('12', '15'),
      today: '26',
    })
    expect(extraRows(s)).toEqual([['15', 'paused']])
  })

  // Monday 12 missed; its make-up window would run to Tuesday 13 anyway —
  // here the pause starts on the 13th and closes it at once: a Tuesday
  // session is a paused-day session, not a make-up.
  it('closes an open make-up window', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12'), paused('13'), weekdays(MWF, '19')],
      sessions: sessions('13'),
      today: '26',
    })
    expect(dayRows(s)[0]).toEqual(['12', 'missed'])
    expect(extraRows(s)).toEqual([['13', 'paused']])
  })

  // N per week: the pause splits the program week, and the stretch before
  // it is scaled (3 a week over Mon 12 – Tue 13 → round(0.86) = 1).
  it('splits and scales a program week', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(3, '12'), paused('14')],
      today: '19',
    })
    expect(weekRows(s)).toEqual([['12', '13', 1, 0, 'missed']])
    expect(s.pauses).toEqual([{ from: d('14'), to: d('18') }])
  })

  it('reports an open-ended pause as running on', () => {
    const s = summarize({
      start: '12',
      versions: [weekdays(MWF, '12'), paused('14')],
      today: '15',
    })
    expect(s.pauses).toEqual([{ from: d('14'), to: null }])
    expect(s.nextWorkout).toBeNull()
  })

  // A pause can't run past the program's end.
  it('ends a pause on the end date at the latest', () => {
    const s = summarize({
      start: '12',
      end: '16',
      versions: [weekdays(MWF, '12'), paused('14')],
      today: '17',
    })
    expect(s.pauses).toEqual([{ from: d('14'), to: d('16') }])
  })

  // The end date moved earlier after a pause was planned: a pause that
  // would begin after the new end never happens, so it isn't reported.
  it('leaves out a pause that starts after the program ends', () => {
    const s = summarize({
      start: '12',
      end: '16',
      versions: [weekdays(MWF, '12'), paused('19')],
      today: '17',
    })
    expect(s.pauses).toEqual([])
  })

  // The service never stores a version before the start, but the module
  // takes any versions: one from before the start counts from the start
  // (the first day the program has).
  it('starts a pause no earlier than the program', () => {
    const s = summarize({
      start: '14',
      end: '25',
      versions: [paused('12'), weekdays(MWF, '19')],
      today: '26',
    })
    expect(s.pauses).toEqual([{ from: d('14'), to: d('18') }])
  })
})

describe('next workout', () => {
  it("is today's scheduled workout when it's not done yet", () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A]),
      today: '14',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: B,
      forDay: d('14'),
      programWeek: null,
    })
  })

  // Wednesday (B) missed, today Thursday: the make-up comes first — it
  // names the MISSED day, and it's B, though Friday (A) is the next date.
  it('is a make-up while one is possible', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A]),
      today: '15',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: B,
      forDay: d('14'),
      programWeek: null,
    })
  })

  it("is the next scheduled day's workout once today is done", () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MON_A_WED_B_FRI_A, '12')],
      sessions: sessions(['12', A], ['14', B]),
      today: '14',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: A,
      forDay: d('16'),
      programWeek: null,
    })
  })

  // N per week: the first position the current week still needs.
  it("is the week's first workout still needed", () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(3, '12', [A, B, C])],
      sessions: sessions(['12', A]),
      today: '13',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: B,
      forDay: null,
      programWeek: 1,
    })
  })

  // The current week is met: the next week's first position.
  it("is the next week's first workout once this week is met", () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(1, '12', [A, B])],
      sessions: sessions(['12', A]),
      today: '13',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: B,
      forDay: null,
      programWeek: 2,
    })
  })

  // During a pause, the first thing after it.
  it('is the first workout after a pause', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [
        weekdays(MON_A_WED_B_FRI_A, '12'),
        paused('13'),
        weekdays(MON_A_WED_B_FRI_A, '20'),
      ],
      sessions: sessions(['12', A]),
      today: '15',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: B,
      forDay: d('21'),
      programWeek: null,
    })
  })

  it('is null once the program is over', () => {
    const s = summarize({
      start: '12',
      end: '16',
      versions: [weekdays(MWF, '12')],
      today: '20',
    })
    expect(s.nextWorkout).toBeNull()
  })
})

// --- Sessions for another day: swaps and done early (step 2b-iii; split 2026-10-12) -------------------------

describe('swaps', () => {
  // Monday 12 = A (upper body), Wednesday 14 = B (lower body).
  const AB = [
    weekdays(
      [
        [1, A],
        [3, B],
      ],
      '12',
    ),
  ]
  // A session as [id, day done, workout, the day it counts for].
  const swaps = (...rows: [number, string, number, string | null][]) =>
    rows.map(([id, day, workoutId, countsFor]) => ({
      id,
      localDate: d(day),
      workoutId,
      countsFor: countsFor === null ? null : d(countsFor),
    }))
  // [day, state, the day the session for it was done on] for days
  // fulfilled from another day (swapped or done early).
  const swapRows = (summary: ScheduleSummary) =>
    summary.days.map((day) => {
      const by = day.swappedBy ?? day.doneEarlyBy
      return by
        ? [day.date.slice(8), day.state, by.date.slice(8)]
        : [day.date.slice(8), day.state]
    })

  // The case from the decision: Wednesday's B done on Monday, Monday's A
  // done on Wednesday — both days 'swapped', nothing extra, nothing missed.
  it('swaps two days both ways', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', B, '14'], [2, '14', A, '12']),
      today: '19',
    })
    expect(swapRows(s)).toEqual([
      ['12', 'swapped', '14'],
      ['14', 'swapped', '12'],
    ])
    expect(s.days[0].swappedBy).toEqual({ sessionId: 2, date: d('14') })
    expect(s.days[0].doneEarlyBy).toBeNull()
    expect(s.totals).toMatchObject({
      done: 0,
      doneEarly: 0,
      swapped: 2,
      missed: 0,
      extra: 0,
      skipped: 0,
      incomplete: 0,
    })
  })

  // DONE EARLY: Wednesday's B on Tuesday 13 — a FREE day, so not a swap
  // (nothing is exchanged). Monday, done on its own day, is unaffected.
  it('says a day done ahead on a free day was done early, not swapped', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', A, null], [2, '13', B, '14']),
      today: '19',
    })
    expect(swapRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'done_early', '13'],
    ])
    expect(s.days[1].doneEarlyBy).toEqual({ sessionId: 2, date: d('13') })
    expect(s.days[1].swappedBy).toBeNull()
    expect(s.totals).toMatchObject({
      done: 1,
      doneEarly: 1,
      swapped: 0,
      missed: 0,
      extra: 0,
      skipped: 0,
      incomplete: 0,
    })
  })

  // A day done early is fulfilled like a swapped one: its own session
  // comes second, and no make-up can replace it.
  it("makes the day's own session extra after it was done early", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '13', B, '14'], [2, '14', B, null]),
      today: '19',
    })
    expect(extraRows(s)).toEqual([['14', 'already_done']])
  })

  it('never lets a make-up replace a day done early', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '13', B, '14'], [2, '15', B, null]),
      today: '19',
    })
    expect(swapRows(s)[1]).toEqual(['14', 'done_early', '13'])
    expect(extraRows(s)).toEqual([['15', 'no_missed_day']])
  })

  // Which day the session was DONE on decides, judged by the version in
  // force THAT day. From Tuesday 13 on, the schedule is Tuesday / Thursday
  // (A / B): Tuesday 13 is now scheduled, so Thursday's B done on it is half
  // of a swap — under the first version (Mon / Wed) it was a free day.
  it("judges where a session was done by that day's version", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [
        ...AB,
        weekdays(
          [
            [2, A],
            [4, B],
          ],
          '13',
        ),
      ],
      sessions: swaps([1, '13', B, '15']),
      today: '19',
    })
    expect(swapRows(s)).toContainEqual(['15', 'swapped', '13'])
  })

  // A swap names its day AND does that day's workout: A for Wednesday (which
  // expects B) doesn't count — and isn't quietly used for Monday instead,
  // though Monday expects A.
  it("doesn't count a swap that did another workout than the day's", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', A, '14']),
      today: '19',
    })
    expect(swapRows(s)).toEqual([
      ['12', 'missed'],
      ['14', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['12', 'swap_not_counted']])
  })

  // A swap done LATE must do the day's workout too: B on Wednesday "for"
  // Monday (which expects A) doesn't count — Monday stays missed.
  it("doesn't count a late swap that did another workout than the day's", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '14', B, '12']),
      today: '19',
    })
    expect(swapRows(s)[0]).toEqual(['12', 'missed'])
    expect(extraRows(s)).toEqual([['14', 'swap_not_counted']])
  })

  // A swapped day isn't waiting for a make-up: after Wednesday's B was done
  // early (on Monday), a B on Thursday doesn't turn Wednesday into "made
  // up" — it has no missed day to make up.
  it('never lets a make-up replace a swap', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', B, '14'], [2, '15', B, null]),
      today: '19',
    })
    expect(swapRows(s)[1]).toEqual(['14', 'swapped', '12'])
    expect(extraRows(s)).toEqual([['15', 'no_missed_day']])
  })

  // The database refuses a swap for the session's own day
  // (sessions_counts_for_other_day); the module, which takes any input,
  // doesn't count one either — it never fulfils a day "by swap" on that
  // very day.
  it("doesn't count a swap for its own day", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', A, '12']),
      today: '19',
    })
    expect(swapRows(s)[0]).toEqual(['12', 'missed'])
    expect(extraRows(s)).toEqual([['12', 'swap_not_counted']])
  })

  // The earlier wins. Monday done on Monday; a swap for Monday on Wednesday
  // comes second and can't count.
  it("doesn't count a late swap for a day already done", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', A, null], [2, '14', A, '12']),
      today: '19',
    })
    expect(swapRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['14', 'swap_not_counted']])
  })

  // …and the other way round: Wednesday's B done early, on Monday; Wednesday's
  // own B session comes second.
  it("makes the day's own session extra after an early swap", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', B, '14'], [2, '14', B, null]),
      today: '19',
    })
    expect(swapRows(s)).toEqual([
      ['12', 'missed'],
      ['14', 'swapped', '12'],
    ])
    expect(extraRows(s)).toEqual([['14', 'already_done']])
  })

  // On the swapped day, a session of ANOTHER workout is what it always is: a
  // wrong workout, not "already done".
  it("keeps 'wrong_workout' for another workout on a swapped day", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '12', B, '14'], [2, '14', C, null]),
      today: '19',
    })
    expect(extraRows(s)).toEqual([['14', 'wrong_workout']])
  })

  // A late session for another day counts only from a SCHEDULED day (the
  // second half of a swap). From a free day — Tuesday 13 "for" Monday 12 —
  // it's catching up: a make-up, which needs no link (decided 2026-10-12;
  // the service refuses to record it, and rows written before are judged
  // the same way). It doesn't count; the ordinary A session that same
  // Tuesday makes Monday up, as always.
  it("doesn't count a late session from a free day — a make-up does the job", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps([1, '13', A, null], [2, '13', A, '12']),
      today: '19',
    })
    expect(swapRows(s)[0]).toEqual(['12', 'made_up'])
    expect(s.days[0].madeUpBy).toEqual({ sessionId: 1, date: d('13') })
    expect(extraRows(s)).toEqual([['13', 'swap_not_counted']])
  })

  // Only the first swap for a day can count; and a swap for a day that isn't
  // scheduled (Tuesday) — or that the walk never reaches (past the end) —
  // never counts.
  it.each<[string, [number, string, number, string | null][], string]>([
    [
      'the second swap for one day',
      [
        [1, '12', B, '14'],
        [2, '13', B, '14'],
      ],
      '13',
    ],
    ['a swap for an unscheduled day', [[1, '12', A, '13']], '12'],
    ['a swap for a day after the end', [[1, '16', A, '19']], '16'],
  ])("doesn't count %s", (_label, rows, day) => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: AB,
      sessions: swaps(...rows),
      today: '19',
    })
    expect(extraRows(s)).toContainEqual([day, 'swap_not_counted'])
    expect(s.totals.swapped).toBe(rows.length === 2 ? 1 : 0)
  })

  // A swap never counts in a weekly count (that schedule has no days to
  // swap — the service refuses it; the module still keeps it out).
  it('keeps a swap out of a weekly count', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [perWeek(2, '12')],
      sessions: swaps([1, '12', A, '13']),
      today: '19',
    })
    expect(weekRows(s)).toEqual([['12', '18', 2, 0, 'missed']])
    expect(extraRows(s)).toEqual([['12', 'swap_not_counted']])
  })

  // What's next skips a day already fulfilled ahead of time: Wednesday's B
  // was done early, on Tuesday, so after Monday the next thing is Friday.
  it('skips a day done early in what comes next', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [
        weekdays(
          [
            [1, A],
            [3, B],
            [5, A],
          ],
          '12',
        ),
      ],
      sessions: swaps([1, '12', A, null], [2, '13', B, '14']),
      today: '13',
    })
    expect(s.nextWorkout).toEqual({
      workoutId: A,
      forDay: d('16'),
      programWeek: null,
    })
  })
})

// Phase 4 step 1b (decided 2026-10-15): sessions SKIPPED or STOPPED are
// labels. Filed by the day they happened — the scheduled day, else the
// weekly stretch around it, else apart — oldest first, all of them; they
// never change what counts. 2026-10-12 is a Monday.
describe('attempts (skipped and stopped sessions — labels only)', () => {
  const skip = (
    id: number,
    day: string,
    endReason = 'illness',
  ): SummaryAttempt => ({ id, localDate: d(day), status: 'skipped', endReason })
  const stop = (
    id: number,
    day: string,
    endReason = 'pain',
  ): SummaryAttempt => ({
    id,
    localDate: d(day),
    status: 'incomplete',
    endReason,
  })

  it('labels a missed scheduled day with its skip — still missed', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12', '16'),
      attempts: [skip(10, '14')],
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'missed'],
      ['16', 'done'],
    ])
    expect(s.days[1].attempts).toStrictEqual([
      { sessionId: 10, status: 'skipped', endReason: 'illness' },
    ])
    expect(s.days[0].attempts).toEqual([])
    expect(s.days[2].attempts).toEqual([])
    expect(s.otherAttempts).toEqual([])
    expect(s.totals).toMatchObject({ missed: 1, skipped: 1, incomplete: 0 })
  })

  // Several on one day: all kept, oldest first (by day, then id — the input
  // order doesn't matter). A day can be DONE and still carry an attempt: a
  // session stopped, then another one finished.
  it('keeps every attempt of a day, oldest first, whatever its state', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('12'),
      attempts: [stop(21, '12', 'no_time'), skip(20, '12')],
      today: '19',
    })
    expect(s.days[0].state).toBe('done')
    expect(s.days[0].attempts).toStrictEqual([
      { sessionId: 20, status: 'skipped', endReason: 'illness' },
      { sessionId: 21, status: 'incomplete', endReason: 'no_time' },
    ])
    expect(s.totals).toMatchObject({ done: 1, skipped: 1, incomplete: 1 })
  })

  // A free day of a specific-days schedule (a catch-up stopped) is no
  // scheduled day: the attempt goes apart — and the missed Monday is still
  // waiting to be made up (an attempt never makes up anything).
  it('puts an attempt on a free day apart, making nothing up', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      sessions: sessions('14', '16'),
      attempts: [stop(30, '13')],
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'missed'],
      ['14', 'done'],
      ['16', 'done'],
    ])
    expect(s.days.every((day) => day.attempts.length === 0)).toBe(true)
    expect(s.otherAttempts).toStrictEqual([
      { sessionId: 30, status: 'incomplete', endReason: 'pain', date: d('13') },
    ])
  })

  // N a week: no day — the stretch around the attempt carries it, with its
  // date; a stretch split by a version change gets only its own.
  it('files a weekly attempt in its own stretch, with its date', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(3, '12'), perWeek(2, '15')],
      sessions: sessions('12'),
      attempts: [skip(40, '13'), stop(41, '16'), stop(42, '20')],
      today: '26',
    })
    expect(weekRows(s)).toEqual([
      ['12', '14', 1, 1, 'met'],
      ['15', '18', 1, 0, 'missed'],
      ['19', '25', 2, 0, 'missed'],
    ])
    expect(
      s.weeks.map((w) => w.attempts.map((a) => [a.sessionId, a.date])),
    ).toEqual([[[40, d('13')]], [[41, d('16')]], [[42, d('20')]]])
    expect(s.weeks[1].attempts[0]).toStrictEqual({
      sessionId: 41,
      status: 'incomplete',
      endReason: 'pain',
      date: d('16'),
    })
    expect(s.otherAttempts).toEqual([])
  })

  // A stretch's first and last days are both inside it: an attempt on the
  // edge goes to that stretch — never apart, never the neighbour.
  it('files an attempt on the first or last day of a stretch in that stretch', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [perWeek(3, '12'), perWeek(2, '15')],
      sessions: [],
      attempts: [
        skip(40, '14'),
        stop(41, '15'),
        stop(42, '18'),
        skip(43, '19'),
      ],
      today: '26',
    })
    expect(s.weeks.map((w) => w.attempts.map((a) => a.sessionId))).toEqual([
      [40],
      [41, 42],
      [43],
    ])
    expect(s.otherAttempts).toEqual([])
  })

  // A pause has no days and no stretches; neither has a day before the
  // start or after the end. All apart, oldest first.
  it('puts attempts during a pause or outside the program apart, oldest first', () => {
    const s = summarize({
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12'), paused('14'), weekdays(MWF, '19')],
      attempts: [stop(52, '26'), skip(51, '16'), stop(50, '11')],
      today: '27',
    })
    expect(s.otherAttempts.map((a) => [a.sessionId, a.date])).toEqual([
      [50, d('11')],
      [51, d('16')],
      [52, d('26')],
    ])
    expect(s.days.every((day) => day.attempts.length === 0)).toBe(true)
    expect(s.totals).toMatchObject({ skipped: 1, incomplete: 2 })
  })

  // The guarantee: the same history with and without attempts gives the
  // same summary, apart from the labels themselves.
  it('changes nothing else in the summary', () => {
    const input = {
      start: '12',
      end: '25',
      versions: [weekdays(MWF, '12'), perWeek(2, '19')],
      sessions: sessions('12', '15', '19'),
      today: '22',
    }
    const without = summarize(input)
    const withAttempts = summarize({
      ...input,
      attempts: [
        skip(60, '14'),
        stop(61, '16'),
        stop(62, '20'),
        skip(63, '13'),
      ],
    })
    const strip = (s: ScheduleSummary) => ({
      ...s,
      totals: { ...s.totals, skipped: 0, incomplete: 0 },
      days: s.days.map((day) => ({ ...day, attempts: [] })),
      weeks: s.weeks.map((week) => ({ ...week, attempts: [] })),
      otherAttempts: [],
    })
    expect(strip(withAttempts)).toStrictEqual(without)
    expect(withAttempts.totals).toMatchObject({ skipped: 2, incomplete: 2 })
  })

  it('has empty labels when no attempt is given', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [weekdays(MWF, '12')],
      today: '19',
    })
    expect(s.days.map((day) => day.attempts)).toEqual([[], [], []])
    expect(s.otherAttempts).toEqual([])
    expect(s.totals).toMatchObject({ skipped: 0, incomplete: 0 })
  })
})

describe('through (covering further ahead — the patient home)', () => {
  // Open-ended, Mon/Wed/Fri from Monday 12: program weeks run Monday to
  // Sunday. Today is Wednesday 14, so by default the summary stops on Sunday
  // 18, the end of the current program week.
  const openEnded = (through?: string, today = '14') =>
    summarize({ start: '12', versions: [weekdays(MWF, '12')], today, through })

  it.each<[string, string | undefined, string]>([
    ['by default: the end of the current program week', undefined, '18'],
    ['a day in the next week: to the end of THAT week', '21', '25'],
    ['the first day of the next week: that whole week', '19', '25'],
    ["the current week's last day: no further", '18', '18'],
    ['an earlier day never shortens the summary', '13', '18'],
  ])('%s', (_label, through, lastDay) => {
    expect(openEnded(through).lastDay).toBe(d(lastDay))
  })

  it('lists the further scheduled days as upcoming, and judges the rest as before', () => {
    expect(dayRows(openEnded('21'))).toStrictEqual([
      ['12', 'missed'],
      ['14', 'due'],
      ['16', 'upcoming'],
      ['19', 'upcoming'],
      ['21', 'upcoming'],
      ['23', 'upcoming'],
    ])
  })

  it("doesn't change what's next", () => {
    expect(openEnded('21').nextWorkout).toStrictEqual(openEnded().nextWorkout)
  })

  it('never goes past an end date', () => {
    const s = summarize({
      start: '12',
      end: '20',
      versions: [weekdays(MWF, '12')],
      today: '14',
      through: '28',
    })
    expect(s.lastDay).toBe(d('20'))
    expect(dayRows(s).map(([day]) => day)).toStrictEqual([
      '12',
      '14',
      '16',
      '19',
    ])
  })

  it("counts from a program's start when it hasn't started yet", () => {
    // Starts Monday 19; today Wednesday 14. By default: its first week (to
    // Sunday 25). Through Wednesday 28: its second week too.
    const notStarted = (through?: string) =>
      summarize({
        start: '19',
        versions: [weekdays(MWF, '19')],
        today: '14',
        through,
      })
    expect(notStarted().lastDay).toBe(d('25'))
    // Its week 2 runs Monday 26 to Sunday 1 November (past the helper's
    // October, hence the full date).
    expect(notStarted('28').lastDay).toBe('2026-11-01')
  })

  it('adds the coming weeks of an N-a-week program as upcoming, with no total', () => {
    const s = summarize({
      start: '12',
      versions: [perWeek(3, '12')],
      today: '14',
      through: '21',
    })
    expect(weekRows(s)).toStrictEqual([
      ['12', '18', 3, 0, 'in_progress'],
      ['19', '25', 3, 0, 'upcoming'],
    ])
    expect(s.totals.expected).toBeNull()
  })
})

// --- One session a day, across every kind of session (decided 2026-10-16) ----------------------------------

// Sessions as [id, day done, workout, the day it counts for (null = an
// ordinary session)] — the ids say which was created first.
const linked = (...rows: [number, string, number, string | null][]) =>
  rows.map(([id, day, workoutId, countsFor]) => ({
    id,
    localDate: d(day),
    workoutId,
    countsFor: countsFor === null ? null : d(countsFor),
  }))

// Monday = A, Wednesday = B, Friday = A.
const MWF_ABA = [
  weekdays(
    [
      [1, A],
      [3, B],
      [5, A],
    ],
    '12',
  ),
]

describe('one session a day', () => {
  // The gap found 2026-10-16: on Tuesday (free), Wednesday's B done early
  // AND an A making up Monday — both used to count. Now the one created
  // first does. The two cases below are the same day with the ids swapped:
  // the rule is "created first", not "the link first" or "the make-up first".
  it('on a free day, counts the session done early when it came first', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '13', B, '14'], [2, '13', A, null]),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'missed'],
      ['14', 'done_early'],
      ['16', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['13', 'same_day']])
  })

  it('on a free day, counts the make-up when it came first', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '13', A, null], [2, '13', B, '14']),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'made_up', '13'],
      ['14', 'missed'],
      ['16', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['13', 'same_day']])
  })

  // On a scheduled day: Monday's own A and a swap half (Wednesday's B).
  it('on a scheduled day, counts the swap half when it came first', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '12', B, '14'], [2, '12', A, null]),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'missed'],
      ['14', 'swapped'],
      ['16', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['12', 'same_day']])
  })

  it("on a scheduled day, counts the day's own session when it came first", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '12', A, null], [2, '12', B, '14']),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'done'],
      ['14', 'missed'],
      ['16', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['12', 'same_day']])
  })

  // Two sessions for two DIFFERENT later days, done the same day: still one.
  it('counts one of two sessions done early the same day', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '13', B, '14'], [2, '13', A, '16']),
      today: '19',
    })
    expect(dayRows(s)).toEqual([
      ['12', 'missed'],
      ['14', 'done_early'],
      ['16', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['13', 'same_day']])
  })

  // Two sessions done the same day for the SAME later day: the second can't
  // count for that day anyway — it's taken — and its reason says so, not
  // merely "another session that day".
  it("says why a second session for the same day can't count", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '13', B, '14'], [2, '13', B, '14']),
      today: '19',
    })
    expect(dayRows(s)[1]).toEqual(['14', 'done_early'])
    expect(extraRows(s)).toEqual([['13', 'swap_not_counted']])
  })

  // A week changing kind on Wednesday: Monday–Tuesday "2 a week" (A), then
  // Wednesday = B. On Tuesday a weekly session and Wednesday's B done early.
  const weeklyThenWednesday = [perWeek(2, '12'), weekdays([[3, B]], '14')]

  it("on a weekly day, lets the day's own session come first", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: weeklyThenWednesday,
      sessions: linked([1, '13', B, '14'], [2, '13', A, null]),
      today: '19',
    })
    expect(dayRows(s)).toEqual([['14', 'missed']])
    expect(s.weeks[0].sessionIds).toEqual([2])
    expect(extraRows(s)).toEqual([['13', 'same_day']])
  })

  it('on a weekly day with no session of its own, counts a session done early', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: weeklyThenWednesday,
      sessions: linked([1, '13', B, '14']),
      today: '19',
    })
    expect(dayRows(s)).toEqual([['14', 'done_early']])
    expect(extraRows(s)).toEqual([])
  })

  // A paused day's own session never counts, so a session done early there
  // has nothing to compete with.
  it('on a paused day, counts a session done early beside a paused one', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [paused('12'), weekdays([[3, B]], '14')],
      sessions: linked([1, '13', A, null], [2, '13', B, '14']),
      today: '19',
    })
    expect(dayRows(s)).toEqual([['14', 'done_early']])
    expect(extraRows(s)).toEqual([['13', 'paused']])
  })
})

// --- Late make-ups (decided 2026-10-16) --------------------------------------------------------------------

describe('late make-ups', () => {
  // Monday 12 (A) missed: its window ends Tuesday 13 — Wednesday closes it.
  // Wednesday's B and Friday's A are done on their days in most cases, so
  // the only question is Monday.
  const onTime: [number, string, number, string | null][] = [
    [10, '14', B, null],
    [11, '16', A, null],
  ]

  it('makes up a missed day late, from a free day after its window', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked(...onTime, [12, '15', A, '12']),
      today: '19',
    })
    expect(s.days[0]).toStrictEqual({
      date: d('12'),
      workoutId: A,
      state: 'made_up_late',
      sessionId: null,
      madeUpBy: null,
      madeUpLateBy: { sessionId: 12, date: d('15') },
      doneEarlyBy: null,
      swappedBy: null,
      attempts: [],
    })
    // Counted apart: never in madeUp, no longer missed. (No lateMakeUpDays
    // given: the setting governs new sessions, never recorded ones.)
    expect(s.totals).toMatchObject({
      done: 2,
      madeUp: 0,
      madeUpLate: 1,
      missed: 0,
      extra: 0,
    })
  })

  it("doesn't count one done while the day's window is still open", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked(...onTime, [12, '13', A, '12']),
      today: '19',
    })
    // Not reinterpreted as an ordinary make-up either: links are explicit.
    expect(s.days[0].state).toBe('missed')
    expect(extraRows(s)).toEqual([['13', 'swap_not_counted']])
  })

  it("doesn't count one of another workout than the day's", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked(...onTime, [12, '15', B, '12']),
      today: '19',
    })
    expect(s.days[0].state).toBe('missed')
    expect(extraRows(s)).toEqual([['15', 'swap_not_counted']])
  })

  it("doesn't count one for a day already done", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '12', A, null], ...onTime, [12, '15', A, '12']),
      today: '19',
    })
    expect(dayRows(s)[0]).toEqual(['12', 'done'])
    expect(extraRows(s)).toEqual([['15', 'swap_not_counted']])
  })

  it('counts only the first of two for the same day', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked(...onTime, [12, '15', A, '12'], [13, '17', A, '12']),
      today: '19',
    })
    expect(s.days[0].madeUpLateBy).toEqual({ sessionId: 12, date: d('15') })
    expect(extraRows(s)).toEqual([['17', 'swap_not_counted']])
  })

  // Only from a free day of SPECIFIC days: Thursday paused here.
  it("doesn't count one done during a pause", () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: [...MWF_ABA, paused('15')],
      sessions: linked([10, '14', B, null], [12, '15', A, '12']),
      today: '19',
    })
    expect(s.days[0].state).toBe('missed')
    expect(extraRows(s)).toEqual([['15', 'swap_not_counted']])
  })

  // …and from a free day, not a scheduled one: from a scheduled day, a
  // session for an earlier day is a swap half — judged as one.
  it('judges one done on a scheduled day as a swap', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([10, '14', B, null], [12, '16', A, '12']),
      today: '19',
    })
    expect(s.days[0].state).toBe('swapped')
    expect(s.days[0].madeUpLateBy).toBeNull()
  })

  // One session a day applies: Wednesday missed too, and on Thursday (inside
  // Wednesday's window) both an ordinary B and Monday's late A. Ids swapped
  // between the two cases.
  it('on a free day, lets the ordinary make-up count when it came first', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '15', B, null], [2, '15', A, '12']),
      today: '19',
    })
    expect(dayRows(s).slice(0, 2)).toEqual([
      ['12', 'missed'],
      ['14', 'made_up', '15'],
    ])
    expect(extraRows(s)).toEqual([['15', 'same_day']])
  })

  it('on a free day, lets the late make-up count when it came first', () => {
    const s = summarize({
      start: '12',
      end: '18',
      versions: MWF_ABA,
      sessions: linked([1, '15', A, '12'], [2, '15', B, null]),
      today: '19',
    })
    expect(dayRows(s).slice(0, 2)).toEqual([
      ['12', 'made_up_late'],
      ['14', 'missed'],
    ])
    expect(extraRows(s)).toEqual([['15', 'same_day']])
  })
})

// --- What can still be made up late (lateMakeUps) ----------------------------------------------------------

describe('lateMakeUps', () => {
  // Monday 12 (A) missed; Wednesday 14 done unless a case says otherwise.
  const wednesday: [number, string, number, string | null] = [10, '14', B, null]
  const wednesdayDone = linked(wednesday)

  it('lists nothing when the program has no late make-ups', () => {
    for (const lateMakeUpDays of [undefined, null]) {
      const s = summarize({
        start: '12',
        versions: MWF_ABA,
        sessions: wednesdayDone,
        today: '15',
        lateMakeUpDays,
      })
      expect(s.lateMakeUps).toStrictEqual({ days: [], blockedToday: null })
    }
  })

  // 12 + 7 = Monday 19, a scheduled day: the last free day is Sunday 18.
  it('lists a missed day with the last free day it can be done on', () => {
    const s = summarize({
      start: '12',
      versions: MWF_ABA,
      sessions: wednesdayDone,
      today: '15',
      lateMakeUpDays: 7,
    })
    expect(s.lateMakeUps).toStrictEqual({
      days: [{ forDay: d('12'), workoutId: A, until: d('18') }],
      blockedToday: null,
    })
  })

  // 12 + 3 = Thursday 15: still possible on the 15th, not on the 16th; 12 + 2
  // = Wednesday 14 is already past on the 15th.
  it('counts the limit from the missed day, the last day included', () => {
    const at = (today: string, lateMakeUpDays: number) =>
      summarize({
        start: '12',
        versions: MWF_ABA,
        sessions: wednesdayDone,
        today,
        lateMakeUpDays,
      }).lateMakeUps.days
    expect(at('15', 3)).toEqual([
      { forDay: d('12'), workoutId: A, until: d('15') },
    ])
    expect(at('16', 3)).toEqual([])
    expect(at('15', 2)).toEqual([])
  })

  it('never offers a day after the end date', () => {
    const s = summarize({
      start: '12',
      end: '17',
      versions: MWF_ABA,
      sessions: wednesdayDone,
      today: '15',
      lateMakeUpDays: 7,
    })
    expect(s.lateMakeUps.days).toEqual([
      { forDay: d('12'), workoutId: A, until: d('17') },
    ])
  })

  // Monday 12 and Wednesday 14 missed, Friday done; on Saturday both are
  // listed, the one that runs out first first. (14 + 7 = Wednesday 21,
  // scheduled → Tuesday 20.)
  it('lists several missed days, oldest first', () => {
    const s = summarize({
      start: '12',
      versions: MWF_ABA,
      sessions: linked([11, '16', A, null]),
      today: '17',
      lateMakeUpDays: 7,
    })
    expect(s.lateMakeUps.days).toEqual([
      { forDay: d('12'), workoutId: A, until: d('18') },
      { forDay: d('14'), workoutId: B, until: d('20') },
    ])
  })

  it('no longer lists a day made up late, nor one still in its window', () => {
    // Monday made up late on Thursday; on Saturday, Friday (missed — no
    // session) is still in its window: due, not listed.
    const s = summarize({
      start: '12',
      versions: MWF_ABA,
      sessions: linked(wednesday, [12, '15', A, '12']),
      today: '17',
      lateMakeUpDays: 7,
    })
    expect(s.lateMakeUps.days).toEqual([])
  })

  // Why none can be started TODAY. Each block is checked where the others
  // don't apply, and in the order that decides when two do.
  describe('blockedToday', () => {
    const blocked = (input: {
      today: string
      sessions?: ReturnType<typeof linked>
      versions?: SummaryScheduleVersion[]
      end?: string
    }) =>
      summarize({
        start: '12',
        end: input.end,
        versions: input.versions ?? MWF_ABA,
        sessions: input.sessions ?? wednesdayDone,
        today: input.today,
        lateMakeUpDays: 7,
      }).lateMakeUps

    it('is not_a_free_day on a scheduled day — the days are still listed', () => {
      expect(blocked({ today: '16' })).toStrictEqual({
        days: [{ forDay: d('12'), workoutId: A, until: d('18') }],
        blockedToday: 'not_a_free_day',
      })
    })

    it('is not_a_free_day during a pause, before the start and after the end', () => {
      expect(
        blocked({ today: '15', versions: [...MWF_ABA, paused('15')] })
          .blockedToday,
      ).toBe('not_a_free_day')
      // Before the start — even under a version starting earlier (the
      // module doesn't rely on the first version starting on the start
      // date: it takes any input).
      expect(
        blocked({
          today: '11',
          versions: [
            weekdays(
              [
                [1, A],
                [3, B],
                [5, A],
              ],
              '05',
            ),
          ],
        }).blockedToday,
      ).toBe('not_a_free_day')
      expect(blocked({ today: '18', end: '17' }).blockedToday).toBe(
        'not_a_free_day',
      )
    })

    it('is not_a_free_day on a weekly count', () => {
      expect(
        blocked({
          today: '15',
          versions: [...MWF_ABA, perWeek(2, '15')],
        }).blockedToday,
      ).toBe('not_a_free_day')
    })

    it('is session_done_today when a session was completed today', () => {
      // Thursday's session counts for nothing (no missed day open) — it
      // still uses up the day.
      expect(
        blocked({
          today: '15',
          sessions: linked(wednesday, [12, '15', A, null]),
        }),
      ).toStrictEqual({
        days: [{ forDay: d('12'), workoutId: A, until: d('18') }],
        blockedToday: 'session_done_today',
      })
    })

    // Changed 2026-10-17: an on-time catch-up is a SUGGESTION (the home's
    // button), not a block — the patient may choose the late one instead.
    it('is not blocked while another missed day can be made up on time', () => {
      // No Wednesday session: on Thursday, Wednesday is due (its window runs
      // to Thursday), Monday is missed — and can be made up late today.
      expect(blocked({ today: '15', sessions: [] })).toStrictEqual({
        days: [{ forDay: d('12'), workoutId: A, until: d('18') }],
        blockedToday: null,
      })
    })

    it('says a session done today before an open catch-up', () => {
      // Wednesday due, and a session of the wrong workout (A) done today.
      expect(
        blocked({ today: '15', sessions: linked([12, '15', A, null]) })
          .blockedToday,
      ).toBe('session_done_today')
    })

    it('says not_a_free_day before a session done today', () => {
      expect(
        blocked({
          today: '16',
          sessions: linked(wednesday, [11, '16', A, null]),
        }).blockedToday,
      ).toBe('not_a_free_day')
    })
  })
})
