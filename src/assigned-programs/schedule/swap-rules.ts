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

import { BadRequestException } from '@nestjs/common'
import { daysBetween, isoWeekday } from '../../common/calendar-date'
import type { ScheduleDay } from './schedule-content'

// A SESSION FOR ANOTHER DAY (`sessions.counts_for`): the patient does
// another scheduled day's workout and says so — the session "counts for"
// that day. Two kinds, told apart by WHERE the session is done
// (decided 2026-10-12, with the person):
//   - DONE EARLY: on a day before the counted day — Wednesday's workout on
//     Tuesday, ahead of time. Nothing was missed.
//   - A SWAP: on another SCHEDULED day — Monday does Wednesday's workout,
//     and Wednesday Monday's: the two days exchange workouts (each half is
//     one session counting for the other day).
// And one thing it is NOT: a session on a FREE day counting for an EARLIER
// day. That's catching up a missed day — a make-up, which the schedule
// module already infers (before the next scheduled day) without any link;
// later than that, it would be a late make-up, a separate feature to design
// with the patient's session flow (Phase 4), opt-in per program. Refused.
//
// This file holds what can be checked WHEN THE SESSION STARTS, as one pure
// function (plain values in, the workout or a 400 out), so every rule is a
// unit test with no database. The one rule that can't be checked then —
// "was that day already done by then?" — depends on sessions that may not
// exist yet; the schedule module judges it (schedule-summary.ts).

// --- TYPES -------------------------------------------------------------------------------------------------

// One schedule version, with what the rules need: its type, its scheduled
// days, and the day it applies from.
export interface SwapVersion {
  type: 'weekdays' | 'times_per_week' | 'paused'
  days: ScheduleDay[]
  effectiveFrom: string
}

export interface SwapRequest {
  program: {
    startDate: string
    endDate: string | null
    allowSwaps: boolean
  }
  // The program's versions starting on or before the later of the two days
  // (any order): enough to know the version in force on each of them.
  versions: SwapVersion[]
  // The patient's today (the session's own day), and the day it counts for.
  localDate: string
  countsFor: string
  // The workout the patient named, if any.
  requestedWorkoutId: number | null | undefined
}

// --- THE RULES ---------------------------------------------------------------------------------------------

// The version in force on `day`: the latest starting on or before it — the
// schedule module's rule (decisions §5, point 5). Null before the first.
export function versionOn(
  versions: SwapVersion[],
  day: string,
): SwapVersion | null {
  let found: SwapVersion | null = null
  for (const version of versions) {
    if (
      version.effectiveFrom <= day &&
      (found === null || version.effectiveFrom > found.effectiveFrom)
    ) {
      found = version
    }
  }
  return found
}

// Whether `day` is a scheduled day — a day of a specific-days version in
// force on it.
function isScheduledDay(versions: SwapVersion[], day: string): boolean {
  const version = versionOn(versions, day)
  return (
    version?.type === 'weekdays' &&
    version.days.some((d) => d.weekday === isoWeekday(day))
  )
}

// The workout a session for another day does: the one scheduled on
// `countsFor`. Each check answers 400 with a sentence the app can show as
// it is, in the order a person would think of them: is rearranging allowed
// at all → is it another day of this program → the same program week → a
// day with a workout → an earlier day only from a scheduled day → the
// workout named, if any, is that one.
export function swapWorkoutId(request: SwapRequest): number {
  const { program, versions, localDate, countsFor } = request

  // The practitioner's switch (`allow_swaps`) covers both kinds: it says
  // whether the patient may rearrange the week. It governs NEW sessions
  // only: those already recorded keep counting (the summary doesn't look
  // at it).
  if (!program.allowSwaps) {
    throw new BadRequestException(
      'Rearranging the week is turned off for this program: do the workout scheduled today, or ask your practitioner',
    )
  }
  // The database refuses it too (sessions_counts_for_other_day): a session
  // already counts for its own day.
  if (countsFor === localDate) {
    throw new BadRequestException(
      'countsFor must be another day: a session already counts for its own',
    )
  }
  if (
    countsFor < program.startDate ||
    (program.endDate !== null && countsFor > program.endDate)
  ) {
    throw new BadRequestException('countsFor must be a day of the program')
  }
  // The same PROGRAM week (weeks start on the program's start date, like
  // the weekly counts): rearranging a week doesn't move a workout from one
  // week into another. Math.floor also puts a localDate before the start
  // (negative) in a different week from any day of the program.
  const weekOf = (day: string) =>
    Math.floor(daysBetween(program.startDate, day) / 7)
  if (weekOf(countsFor) !== weekOf(localDate)) {
    throw new BadRequestException(
      'A session for another day stays within the program week: countsFor must be in the same week as today',
    )
  }
  // Only specific days have days to rearrange. With "N per week", any order
  // within the week already counts; a paused day expects nothing.
  const version = versionOn(versions, countsFor)
  if (version?.type !== 'weekdays') {
    throw new BadRequestException(
      version?.type === 'times_per_week'
        ? 'Only schedules with specific days can be rearranged: with a weekly count, any order within the week already counts'
        : `${countsFor} has no workout (the program is paused then)`,
    )
  }
  const day = version.days.find((d) => d.weekday === isoWeekday(countsFor))
  if (!day) {
    throw new BadRequestException(
      `${countsFor} isn't a scheduled day of this program`,
    )
  }
  // An EARLIER day only from a scheduled day — the second half of a swap.
  // From a free day it would be a make-up (inferred, no link needed) or a
  // late make-up (not offered): see the top of this file.
  if (countsFor < localDate && !isScheduledDay(versions, localDate)) {
    throw new BadRequestException(
      `A session can count for an earlier day only when it's done on a scheduled day, as a swap. To catch up ${countsFor}, do its workout before the next scheduled day: it counts as a make-up`,
    )
  }
  // Naming the workout is optional — the day already says which one — but
  // naming ANOTHER one is a contradiction, refused rather than resolved.
  if (
    request.requestedWorkoutId != null &&
    request.requestedWorkoutId !== day.workoutId
  ) {
    throw new BadRequestException(
      `Workout ${request.requestedWorkoutId} isn't the workout scheduled on ${countsFor}`,
    )
  }
  return day.workoutId
}
