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
  addDays,
  daysBetween,
  isoWeekday,
} from '../../src/common/calendar-date'
import type { ScheduleContent } from '../../src/assigned-programs/schedule/schedule-content'
import type { SeedSchedule } from './dataset'

// Which days the seed gives a completed session, so the program pages have a
// history to show (done, made up, missed) as soon as the seed has run.
//
// Pure — the dates in, the dates out — because which weekdays fall in the
// past depends on the day the seed runs: the plan is written relative to
// the program (its scheduled days, or days after its start), never as fixed
// dates, and this function turns it into dates for "today".
//
// Only days BEFORE today: today's session is left for whoever tries the app.

export type SeedHistory =
  // For a specific-days schedule, over its scheduled days so far (0 = the
  // first): every one done, except one MADE UP the next day and one MISSED.
  // (The next day must be unscheduled for a make-up — true for Mon/Wed/Fri,
  // which this is used with; the dataset test checks the pairing.)
  | { kind: 'weekdays'; madeUpIndex: number; missedIndex: number }
  // Any schedule: sessions on these days after the start (0 = the start).
  | { kind: 'days-after-start'; days: number[] }

// One seeded session: the day it was done, and the scheduled day it counts
// for — the same day, except for a make-up, which counts for the missed
// day before it (and so does that day's workout).
export interface SeedSession {
  day: string
  forDay: string
}

export function seedSessionDays(
  startDate: string,
  today: string,
  schedule: SeedSchedule,
  history: SeedHistory,
): SeedSession[] {
  if (history.kind === 'days-after-start') {
    return history.days
      .map((offset) => addDays(startDate, offset))
      .filter((day) => day < today)
      .map((day) => ({ day, forDay: day }))
  }

  if (schedule.type !== 'weekdays') {
    throw new Error('A weekdays history needs a weekdays schedule')
  }
  const weekdays = schedule.days.map((day) => day.weekday)
  const scheduled: string[] = []
  for (let day = startDate; day < today; day = addDays(day, 1)) {
    if (weekdays.includes(isoWeekday(day))) scheduled.push(day)
  }
  const result: SeedSession[] = []
  scheduled.forEach((day, index) => {
    if (index === history.missedIndex) return
    if (index === history.madeUpIndex) {
      const nextDay = addDays(day, 1)
      if (weekdays.includes(isoWeekday(nextDay))) {
        throw new Error(
          `A make-up the day after ${day} would fall on a scheduled day`,
        )
      }
      if (nextDay < today) result.push({ day: nextDay, forDay: day })
      return
    }
    result.push({ day, forDay: day })
  })
  return result
}

// The workout each seeded session did: the one the program's schedule asks
// for, as stored (the version create() wrote, with real workout ids) — so
// the seeded history counts as done in the summary, the way a patient
// following the schedule would have done it.
//   - specific days: the workout of the weekday of the day the session
//     counts for (a make-up does the missed day's workout).
//   - N times a week: program week w needs rotation positions w×N to
//     w×N + N − 1 (decisions §5: by plan, from the version's start), and
//     that week's sessions do them in order. A rotation [A] gives A every
//     time; [A, B] with 3 a week gives A B A, then B A B.
// Only for a program with ONE schedule version that started with it — what
// the seed creates. A history that doesn't fit (more sessions in a week
// than N, a day the schedule doesn't have) throws: a wrong dataset entry
// should fail the seed, not seed a history the summary calls extra.
export function seedSessionWorkouts(
  startDate: string,
  schedule: ScheduleContent,
  sessions: SeedSession[],
): number[] {
  if (schedule.type === 'weekdays') {
    return sessions.map(({ forDay }) => {
      const day = schedule.days.find((d) => d.weekday === isoWeekday(forDay))
      if (!day) throw new Error(`${forDay} isn't a scheduled day`)
      return day.workoutId
    })
  }
  if (schedule.type !== 'times_per_week') {
    throw new Error('A paused schedule has no sessions to seed')
  }
  const timesPerWeek = schedule.timesPerWeek!
  const { rotation } = schedule
  const doneInWeek = new Map<number, number>()
  return sessions.map(({ forDay }) => {
    const week = Math.floor(daysBetween(startDate, forDay) / 7)
    const slot = doneInWeek.get(week) ?? 0
    if (slot >= timesPerWeek) {
      throw new Error(
        `Program week ${week + 1} would get more than ${timesPerWeek} sessions`,
      )
    }
    doneInWeek.set(week, slot + 1)
    return rotation[(week * timesPerWeek + slot) % rotation.length]
  })
}