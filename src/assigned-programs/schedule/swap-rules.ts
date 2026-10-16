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
// And a third kind (decided 2026-10-16, with late make-ups):
//   - A LATE MAKE-UP: on a FREE day, for an EARLIER scheduled day that was
//     missed — catching it up after its make-up window closed. Opt-in per
//     program (`lateMakeUpDays`). Within the window it isn't one: that's an
//     ordinary make-up, which the schedule module infers without any link.
//     (Until 2026-10-16 this whole case — a free day counting for an
//     earlier day — was refused, waiting for this design.)
//
// The two switches: `allowSwaps` governs swaps and done early ("rearranging
// the week"), `lateMakeUpDays` governs late make-ups — separate clinical
// choices, so the request is CLASSIFIED first, then checked against its own.
//
// This file holds what can be checked from the program and its schedule
// alone, as one pure function (plain values in, the kind and the workout or
// a 400 out), so every rule is a unit test with no database. What depends
// on the sessions — "was that day already done by then?" for a swap, "is
// the day missed, and can it still be made up?" for a late make-up — is
// the schedule module's (schedule-summary.ts); the service asks it
// (assertLateMakeUpAllowed, session-rules.ts).

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
    lateMakeUpDays: number | null
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

// The three kinds of session for another day, told apart by where the
// session is done: on a scheduled day — a swap (half of one); on a free day
// for a LATER day — done early; on a free day for an EARLIER day — a late
// make-up. ("Free" here = not a scheduled day: a pause or a weekly count
// too, which the checks below then refuse as needed.)
export type OtherDayKind = 'swap' | 'done_early' | 'late_make_up'

export function otherDayKind(
  versions: SwapVersion[],
  localDate: string,
  countsFor: string,
): OtherDayKind {
  if (isScheduledDay(versions, localDate)) return 'swap'
  return countsFor > localDate ? 'done_early' : 'late_make_up'
}

// The kind of a session for another day, and the workout it does: the one
// scheduled on `countsFor`. Each check answers 400 with a sentence the app
// can show as it is, in the order a person would think of them: is it
// another day of this program → which kind → is that kind allowed (and, for
// a swap or done early, the same program week) → a day with a workout → the
// workout named, if any, is that one.
export function sessionForOtherDay(request: SwapRequest): {
  kind: OtherDayKind
  workoutId: number
} {
  const { program, versions, localDate, countsFor } = request

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

  const kind = otherDayKind(versions, localDate, countsFor)
  // A late make-up's own rules — the setting, how late, a free day, the day
  // really missed — all depend on the summary, and are checked from it
  // (assertLateMakeUpAllowed): the "is it still in its window?" answer must
  // come first, whatever the setting, so a patient catching up on time is
  // told to just start. No program-week limit: being ill can cross a week.
  if (kind !== 'late_make_up') {
    // The practitioner's switch (`allow_swaps`) covers both other kinds: it
    // says whether the patient may rearrange the week. It governs NEW
    // sessions only: those already recorded keep counting (the summary
    // doesn't look at it).
    if (!program.allowSwaps) {
      throw new BadRequestException(
        'Rearranging the week is turned off for this program: do the workout scheduled today, or ask your practitioner',
      )
    }
    // The same PROGRAM week (weeks start on the program's start date, like
    // the weekly counts): rearranging a week doesn't move a workout from
    // one week into another. Math.floor also puts a localDate before the
    // start (negative) in a different week from any day of the program.
    const weekOf = (day: string) =>
      Math.floor(daysBetween(program.startDate, day) / 7)
    if (weekOf(countsFor) !== weekOf(localDate)) {
      throw new BadRequestException(
        'A session for another day stays within the program week: countsFor must be in the same week as today',
      )
    }
  }
  // Only specific days have days to rearrange or make up. With "N per
  // week", any order within the week already counts; a paused day expects
  // nothing.
  const version = versionOn(versions, countsFor)
  if (version?.type !== 'weekdays') {
    throw new BadRequestException(
      version?.type !== 'times_per_week'
        ? `${countsFor} has no workout (the program is paused then)`
        : kind === 'late_make_up'
          ? 'Only schedules with specific days have late make-ups: a weekly count starts again each week'
          : 'Only schedules with specific days can be rearranged: with a weekly count, any order within the week already counts',
    )
  }
  const day = version.days.find((d) => d.weekday === isoWeekday(countsFor))
  if (!day) {
    throw new BadRequestException(
      `${countsFor} isn't a scheduled day of this program`,
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
  return { kind, workoutId: day.workoutId }
}
