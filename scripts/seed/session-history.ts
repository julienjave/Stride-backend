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
import type { PatientEndReason } from '../../src/database/schema'
import type { SeedSchedule } from './dataset'

// Which days the seed gives a completed session, so the program pages have a
// history to show (done, made up, missed, done early, swapped) as soon as the
// seed has run.
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
  //
  // `doneEarlyIndex` (optional): that scheduled day is DONE EARLY instead —
  // a session on the day before it, saying it counts for it (`countsFor`).
  // The day before must be a free day of the same program week (checked:
  // done early is never across weeks, and a session on a scheduled day
  // would be half of a swap instead).
  //
  // `swappedWeek` (optional, 0 = the first program week): a SWAP in that
  // week — the first two consecutive scheduled days doing DIFFERENT
  // workouts exchange them, each session counting for the other day. (Two
  // days doing the same workout have nothing to exchange: Friday A and
  // Monday A, on Mon/Wed/Fri. Any three consecutive days of Mon/Wed/Fri A/B/A
  // contain a pair that differs — checked anyway.)
  //
  // (Split 2026-10-12: one `swappedIndex` used to cover both, and could
  // even put a session on the day AFTER its day — catching up, a make-up's
  // job, refused since.)
  //
  // ATTEMPTS (Phase 4 step 1b — seedAttempts below): `skippedMissed` — the
  // MISSED day was skipped, with that reason; `stoppedBeforeMakeUp` — on the
  // day later MADE UP, a session was started and stopped (that reason, that
  // pain after), then made up the next day.
  | {
      kind: 'weekdays'
      madeUpIndex: number
      missedIndex: number
      doneEarlyIndex?: number
      swappedWeek?: number
      skippedMissed?: PatientEndReason
      stoppedBeforeMakeUp?: { reason: PatientEndReason; painAfter: number }
    }
  // Any schedule: sessions on these days after the start (0 = the start).
  | { kind: 'days-after-start'; days: number[] }

// One seeded session: the day it was done, and the scheduled day it counts
// for — the same day, except for a make-up (the missed day before it), a
// session done early and each half of a swap (the other day) — and each
// does that day's workout. `countsFor` is what's stored in
// sessions.counts_for: the day, for a session done early or swapped only (a
// make-up is inferred by the schedule module, never stored).
export interface SeedSession {
  day: string
  forDay: string
  countsFor: string | null
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
      .map((day) => ({ day, forDay: day, countsFor: null }))
  }

  if (schedule.type !== 'weekdays') {
    throw new Error('A weekdays history needs a weekdays schedule')
  }
  const weekdays = schedule.days.map((day) => day.weekday)
  const workoutOf = (day: string) =>
    schedule.days.find((d) => d.weekday === isoWeekday(day))!.workoutIndex
  const weekOf = (day: string) => Math.floor(daysBetween(startDate, day) / 7)
  const scheduled = scheduledDaysBefore(startDate, today, weekdays)

  // The swap's two days: in the chosen program week, the first two
  // consecutive scheduled days whose workouts differ.
  const swapped = new Map<string, string>()
  if (history.swappedWeek !== undefined) {
    const inWeek = scheduled.filter(
      (day) => weekOf(day) === history.swappedWeek,
    )
    const pairAt = inWeek.findIndex(
      (day, i) =>
        i + 1 < inWeek.length && workoutOf(day) !== workoutOf(inWeek[i + 1]),
    )
    if (pairAt === -1) {
      throw new Error(
        `Program week ${history.swappedWeek + 1} has no two days with different workouts to swap`,
      )
    }
    const [first, second] = [inWeek[pairAt], inWeek[pairAt + 1]]
    swapped.set(first, second)
    swapped.set(second, first)
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
      if (nextDay < today) {
        result.push({ day: nextDay, forDay: day, countsFor: null })
      }
      return
    }
    if (index === history.doneEarlyIndex) {
      const before = addDays(day, -1)
      if (before < startDate || weekOf(before) !== weekOf(day)) {
        throw new Error(
          `${day} starts a program week: it can't be done early in the same week`,
        )
      }
      if (weekdays.includes(isoWeekday(before))) {
        throw new Error(
          `Done early on ${before} would fall on a scheduled day (a swap, not done early)`,
        )
      }
      result.push({ day: before, forDay: day, countsFor: day })
      return
    }
    // Half of the swap: done on this scheduled day, with the OTHER day's
    // workout, counting for it.
    const other = swapped.get(day)
    if (other) {
      result.push({ day, forDay: other, countsFor: other })
      return
    }
    result.push({ day, forDay: day, countsFor: null })
  })
  // Already in day order: a make-up or a session done early lands on a FREE
  // day between its neighbours (both checked above), and each half of a
  // swap on its own scheduled day.
  return result
}

// The scheduled days from the start up to, not including, today.
function scheduledDaysBefore(
  startDate: string,
  today: string,
  weekdays: number[],
): string[] {
  const scheduled: string[] = []
  for (let day = startDate; day < today; day = addDays(day, 1)) {
    if (weekdays.includes(isoWeekday(day))) scheduled.push(day)
  }
  return scheduled
}

// One seeded ATTEMPT (Phase 4 step 1b): a session skipped, or started and
// stopped — on a past day, with the patient's reason (and, for a stopped
// one, how much it hurt afterwards). They count for nothing; the summary
// shows them as labels ("Missed · skipped (illness)").
export interface SeedAttempt {
  day: string
  status: 'skipped' | 'incomplete'
  reason: PatientEndReason
  painAfter: number | null
}

// The attempts a weekdays history asks for (none for the others), in day
// order: a stop on the day that is later MADE UP, and a skip on the MISSED
// day — each only if that day is before today. Pure, like seedSessionDays.
export function seedAttempts(
  startDate: string,
  today: string,
  schedule: SeedSchedule,
  history: SeedHistory,
): SeedAttempt[] {
  if (history.kind !== 'weekdays') return []
  if (schedule.type !== 'weekdays') {
    throw new Error('A weekdays history needs a weekdays schedule')
  }
  const scheduled = scheduledDaysBefore(
    startDate,
    today,
    schedule.days.map((day) => day.weekday),
  )
  const result: SeedAttempt[] = []
  const madeUpDay = scheduled[history.madeUpIndex]
  if (history.stoppedBeforeMakeUp && madeUpDay !== undefined) {
    result.push({
      day: madeUpDay,
      status: 'incomplete',
      reason: history.stoppedBeforeMakeUp.reason,
      painAfter: history.stoppedBeforeMakeUp.painAfter,
    })
  }
  const missedDay = scheduled[history.missedIndex]
  if (history.skippedMissed && missedDay !== undefined) {
    result.push({
      day: missedDay,
      status: 'skipped',
      reason: history.skippedMissed,
      painAfter: null,
    })
  }
  return result.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
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