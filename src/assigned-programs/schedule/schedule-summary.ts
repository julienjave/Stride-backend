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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { addDays, daysBetween, isoWeekday } from '../../common/calendar-date'

// THE schedule module (decisions §5): given a program's dates, its schedule
// versions, its completed sessions and "today", it says what was due, done,
// made up and missed — for both kinds of schedule, across versions. Every
// screen (the practitioner's program page now; the patient's home and
// progress pages in Phase 4; practitioner alerts later) asks this module and
// none of them branches on the schedule type itself — so a third kind of
// schedule would change this file, not every screen.
//
// Pure: plain values in, plain values out — no database, no clock (today is
// a parameter), no Nest. So every rule is tested with tables of plain cases
// (schedule-summary.spec.ts), and the service only fetches and passes data.
//
// The rules, all decided with the person (decisions §5, 2026-10-09/10):
//   - A day is judged by the schedule version in force that day: the latest
//     one starting on or before it.
//   - Only COMPLETED sessions count, at most ONE per day (more are "extra").
//   - Specific days ('weekdays'): a scheduled day with a session is DONE. A
//     missed scheduled day can be MADE UP by a session on an unscheduled day
//     before the next scheduled day; a session on a scheduled day always
//     counts for THAT day first. After that window it is MISSED.
//   - N per week ('times_per_week'): counted in PROGRAM weeks, starting on
//     the program's start date. A week cut short — by the end date, or by a
//     change of schedule — has its target scaled to its length, rounded:
//     round(N × days / 7). Each week stands alone: extra sessions don't
//     carry over to another week.
//   - "Today" is never missed: the make-up window always runs past it.

// --- TYPES -------------------------------------------------------------------------------------------------

export interface SummaryScheduleVersion {
  type: 'weekdays' | 'times_per_week'
  weekdays: number[] | null
  timesPerWeek: number | null
  effectiveFrom: string
}

// A completed session: its id and the patient's own day (sessions.local_date).
export interface SummarySession {
  id: number
  localDate: string
}

export interface ScheduleSummaryInput {
  startDate: string
  endDate: string | null
  // Any order; the module sorts them.
  versions: SummaryScheduleVersion[]
  // COMPLETED sessions only (the caller filters); any order.
  sessions: SummarySession[]
  // The viewer's today (a calendar date sent by their app).
  today: string
}

export type DayState = 'done' | 'made_up' | 'missed' | 'due' | 'upcoming'

// A scheduled day of a 'weekdays' schedule.
export interface ScheduledDay {
  date: string
  state: DayState
  // The session done ON that day (state 'done').
  sessionId: number | null
  // The session that made it up (state 'made_up'), and its day.
  madeUpBy: { sessionId: number; date: string } | null
}

export type WeekState = 'met' | 'missed' | 'in_progress' | 'upcoming'

// A stretch of a program week under one 'times_per_week' version: the whole
// week usually; a part of it when the end date or a schedule change cuts it.
export interface CountedWeek {
  // 1 = the program's first week (starting on the start date).
  programWeek: number
  start: string
  end: string
  timesPerWeek: number
  // timesPerWeek, scaled when the stretch is shorter than 7 days.
  target: number
  // Sessions that count, capped at the target.
  done: number
  state: WeekState
  sessionIds: number[]
}

export type ExtraReason =
  // A second (third…) session on a day that already has one.
  | 'same_day'
  // Before the start date or after the end date.
  | 'outside_program'
  // On an unscheduled day, with no missed day to make up.
  | 'no_missed_day'
  // In a counted week that had already reached its target.
  | 'beyond_target'

export interface ExtraSession {
  sessionId: number
  date: string
  reason: ExtraReason
}

export interface ScheduleSummary {
  // The days covered: the start date up to the end date — or, for an
  // open-ended program, up to the end of the current program week.
  firstDay: string
  lastDay: string
  today: string
  totals: {
    // The program's whole target (scheduled days + weekly targets); null
    // for an open-ended program, which has no total (decisions §5: show a
    // count instead of a progress bar).
    expected: number | null
    done: number
    madeUp: number
    missed: number
    extra: number
  }
  days: ScheduledDay[]
  weeks: CountedWeek[]
  extraSessions: ExtraSession[]
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// The version in force on `day`: the latest starting on or before it.
// `sorted` is oldest first. Undefined before the first version — which
// can't happen inside a program today (the first version starts on the
// start date), but the module doesn't rely on it.
function versionOn(
  sorted: SummaryScheduleVersion[],
  day: string,
): SummaryScheduleVersion | undefined {
  let found: SummaryScheduleVersion | undefined
  for (const version of sorted) {
    if (version.effectiveFrom <= day) found = version
    else break
  }
  return found
}

// The last day the summary covers. With an end date: the end date. Open-
// ended: the last day of the program week containing today (so the current
// week is complete), or the first week if the program hasn't started.
function lastDayCovered(input: ScheduleSummaryInput): string {
  if (input.endDate !== null) return input.endDate
  const reference =
    input.today < input.startDate ? input.startDate : input.today
  const weekIndex = Math.floor(daysBetween(input.startDate, reference) / 7)
  return addDays(input.startDate, weekIndex * 7 + 6)
}

// --- THE SUMMARY -------------------------------------------------------------------------------------------

export function summarizeSchedule(
  input: ScheduleSummaryInput,
): ScheduleSummary {
  const { startDate, endDate, today } = input
  const lastDay = lastDayCovered(input)
  const versions = [...input.versions].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom
      ? -1
      : a.effectiveFrom > b.effectiveFrom
        ? 1
        : 0,
  )
  const extraSessions: ExtraSession[] = []

  // --- 1. One counted session per day ---
  // Sorted by day, then id (the earlier-created session counts; the rest of
  // that day are 'same_day' extras). Sessions outside the program's dates
  // are extras too. (For an open-ended program, "after lastDay" can only be
  // a session on a day past the current week — not possible for a session
  // dated today, but not counted if it ever happened.)
  const sessionOnDay = new Map<string, SummarySession>()
  const sortedSessions = [...input.sessions].sort((a, b) =>
    a.localDate === b.localDate
      ? a.id - b.id
      : a.localDate < b.localDate
        ? -1
        : 1,
  )
  for (const session of sortedSessions) {
    if (session.localDate < startDate || session.localDate > lastDay) {
      extraSessions.push({
        sessionId: session.id,
        date: session.localDate,
        reason: 'outside_program',
      })
    } else if (sessionOnDay.has(session.localDate)) {
      extraSessions.push({
        sessionId: session.id,
        date: session.localDate,
        reason: 'same_day',
      })
    } else {
      sessionOnDay.set(session.localDate, session)
    }
  }

  // --- 2. Walk the program, day by day ---
  // Specific days: judged as we go, with at most one missed day "open" for a
  // make-up at a time (the windows between consecutive scheduled days don't
  // overlap). N per week: days are grouped into stretches — one per program
  // week AND version — counted at the end.
  const days: ScheduledDay[] = []
  // For each scheduled day not done yet: the last day of its make-up window.
  const windowEnd = new Map<ScheduledDay, string>()
  let openMissed: ScheduledDay | null = null

  interface Stretch {
    programWeek: number
    version: SummaryScheduleVersion
    timesPerWeek: number
    start: string
    end: string
    sessions: SummarySession[]
  }
  const stretches: Stretch[] = []

  // Closing the open window: the missed day's make-up window ends the day
  // before `day` (a new scheduled day, or a change to another kind of
  // schedule).
  const closeWindow = (day: string) => {
    if (openMissed) windowEnd.set(openMissed, addDays(day, -1))
    openMissed = null
  }

  for (let day = startDate; day <= lastDay; day = addDays(day, 1)) {
    const version = versionOn(versions, day)
    const session = sessionOnDay.get(day)

    if (version?.type === 'weekdays') {
      if (version.weekdays!.includes(isoWeekday(day))) {
        // A scheduled day ends the previous missed day's window, then is
        // judged itself: a session ON it counts for it first.
        closeWindow(day)
        const entry: ScheduledDay = {
          date: day,
          state: session ? 'done' : 'upcoming', // settled in step 3
          sessionId: session?.id ?? null,
          madeUpBy: null,
        }
        days.push(entry)
        if (!session) openMissed = entry
      } else if (session) {
        // An unscheduled day: a session makes up the open missed day, if
        // there is one — otherwise it's extra.
        if (openMissed) {
          openMissed.state = 'made_up'
          openMissed.madeUpBy = { sessionId: session.id, date: day }
          openMissed = null
        } else {
          extraSessions.push({
            sessionId: session.id,
            date: day,
            reason: 'no_missed_day',
          })
        }
      }
      continue
    }

    // Not a 'weekdays' day: any open make-up window ends here.
    closeWindow(day)

    if (version?.type === 'times_per_week') {
      const programWeek = Math.floor(daysBetween(startDate, day) / 7) + 1
      const current = stretches[stretches.length - 1]
      // Same program week and same version → the same stretch. (Versions
      // are objects: "same version" is identity. Days of one version are
      // always consecutive — once a later version starts, an earlier one
      // never applies again — so no gap check is needed.)
      if (
        current &&
        current.programWeek === programWeek &&
        current.version === version
      ) {
        current.end = day
        if (session) current.sessions.push(session)
      } else {
        stretches.push({
          programWeek,
          version,
          timesPerWeek: version.timesPerWeek!,
          start: day,
          end: day,
          sessions: session ? [session] : [],
        })
      }
    } else if (session) {
      // No version in force (not possible inside a program today).
      extraSessions.push({
        sessionId: session.id,
        date: day,
        reason: 'no_missed_day',
      })
    }
  }
  // A window still open at the end of the walk runs to the last day covered
  // (the end date). For an open-ended program the next scheduled day lies
  // beyond lastDay, which is never before today — so it's still open.
  if (openMissed) windowEnd.set(openMissed, lastDay)

  // --- 3. Settle the specific days that weren't done or made up ---
  for (const entry of days) {
    if (entry.state === 'done' || entry.state === 'made_up') continue
    if (entry.date > today) entry.state = 'upcoming'
    else entry.state = windowEnd.get(entry)! >= today ? 'due' : 'missed'
  }

  // --- 4. Count the weeks ---
  // round(N × days / 7): a full week keeps N; a 3-day week of "3 a week"
  // gets round(1.29) = 1. No ties are possible (N × days = 3.5 × 7 would
  // need 7 to divide N × days, i.e. N = 7 or days = 7, both exact).
  const weeks: CountedWeek[] = stretches.map((stretch) => {
    const length = daysBetween(stretch.start, stretch.end) + 1
    const target = Math.round((stretch.timesPerWeek * length) / 7)
    const counted = stretch.sessions.slice(0, target)
    for (const session of stretch.sessions.slice(target)) {
      extraSessions.push({
        sessionId: session.id,
        date: session.localDate,
        reason: 'beyond_target',
      })
    }
    const done = counted.length
    let state: WeekState
    if (stretch.start > today) state = 'upcoming'
    else if (done >= target) state = 'met'
    else state = stretch.end < today ? 'missed' : 'in_progress'
    return {
      programWeek: stretch.programWeek,
      start: stretch.start,
      end: stretch.end,
      timesPerWeek: stretch.timesPerWeek,
      target,
      done,
      state,
      sessionIds: counted.map((s) => s.id),
    }
  })

  // --- 5. Totals ---
  const count = (state: DayState) =>
    days.filter((d) => d.state === state).length
  const weeklyMissed = weeks
    .filter((w) => w.state === 'missed')
    .reduce((sum, w) => sum + (w.target - w.done), 0)
  extraSessions.sort((a, b) =>
    a.date === b.date ? a.sessionId - b.sessionId : a.date < b.date ? -1 : 1,
  )

  return {
    firstDay: startDate,
    lastDay,
    today,
    totals: {
      expected:
        endDate === null
          ? null
          : days.length + weeks.reduce((sum, w) => sum + w.target, 0),
      done: count('done') + weeks.reduce((sum, w) => sum + w.done, 0),
      madeUp: count('made_up'),
      missed: count('missed') + weeklyMissed,
      extra: extraSessions.length,
    },
    days,
    weeks,
    extraSessions,
  }
}