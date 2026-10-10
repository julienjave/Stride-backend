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

const weekdays = (days: number[], from: string): SummaryScheduleVersion => ({
  type: 'weekdays',
  weekdays: days,
  timesPerWeek: null,
  effectiveFrom: d(from),
})
const perWeek = (n: number, from: string): SummaryScheduleVersion => ({
  type: 'times_per_week',
  weekdays: null,
  timesPerWeek: n,
  effectiveFrom: d(from),
})
const MWF = [1, 3, 5]

// Sessions as day numbers; ids are 1, 2, 3… in the order given.
function sessions(...days: string[]) {
  return days.map((day, i) => ({ id: i + 1, localDate: d(day) }))
}

function summarize(input: {
  start: string
  end?: string
  versions: SummaryScheduleVersion[]
  sessions?: { id: number; localDate: string }[]
  today: string
}): ScheduleSummary {
  const full: ScheduleSummaryInput = {
    startDate: d(input.start),
    endDate: input.end ? d(input.end) : null,
    versions: input.versions,
    sessions: input.sessions ?? [],
    today: d(input.today),
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
      missed: 0,
      extra: 0,
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
      state: 'made_up',
      sessionId: null,
      madeUpBy: { sessionId: 1, date: d('13') },
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
        { id: 9, localDate: d('12') },
        { id: 4, localDate: d('12') },
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
      missed: 2,
      extra: 0,
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
      missed: 3,
      extra: 0,
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