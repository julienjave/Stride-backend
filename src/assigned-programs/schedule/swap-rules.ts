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

// SWAPS (decisions §5, "Settled 2026-10-11", point 1): a patient may do
// another day's workout — Wednesday's lower body on Monday — and say so:
// the session "counts for" that day (`sessions.counts_for`).
//
// This file holds what can be checked WHEN THE SESSION STARTS, as one pure
// function (plain values in, the workout or a 400 out), so every rule is a
// unit test with no database. The one rule that can't be checked then —
// "was that day already done by then?" — depends on sessions that may not
// exist yet; the schedule module judges it (schedule-summary.ts).

// --- TYPES -------------------------------------------------------------------------------------------------

export interface SwapRequest {
  program: {
    startDate: string
    endDate: string | null
    allowSwaps: boolean
  }
  // The schedule version in force on `countsFor` (the latest starting on or
  // before it), or null when there's none (a day before the program).
  version: {
    type: 'weekdays' | 'times_per_week' | 'paused'
    days: ScheduleDay[]
  } | null
  // The patient's today (the session's own day), and the day it counts for.
  localDate: string
  countsFor: string
  // The workout the patient named, if any.
  requestedWorkoutId: number | null | undefined
}

// --- THE RULES ---------------------------------------------------------------------------------------------

// The workout a swap session does: the one scheduled on `countsFor`. Each
// check answers 400 with a sentence the app can show as it is, in the order
// a person would think of them: are swaps allowed at all → is it another
// day of this program → the same program week → a day with a workout to
// swap → the workout named, if any, is that one.
export function swapWorkoutId(request: SwapRequest): number {
  const { program, version, localDate, countsFor } = request

  // The practitioner's switch. It governs NEW swaps only: swaps already
  // recorded keep counting (the summary doesn't look at it).
  if (!program.allowSwaps) {
    throw new BadRequestException(
      'Swaps are turned off for this program: do the workout scheduled today, or ask your practitioner',
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
  // the weekly counts): a swap rearranges a week, it doesn't move a workout
  // from one week into another. Math.floor also puts a localDate before the
  // start (negative) in a different week from any day of the program.
  const weekOf = (day: string) =>
    Math.floor(daysBetween(program.startDate, day) / 7)
  if (weekOf(countsFor) !== weekOf(localDate)) {
    throw new BadRequestException(
      'A swap stays within the program week: countsFor must be in the same week as today',
    )
  }
  // Only specific days have days to swap. With "N per week", any order
  // within the week already counts; a paused day expects nothing.
  if (version?.type !== 'weekdays') {
    throw new BadRequestException(
      version?.type === 'times_per_week'
        ? 'Swaps are for schedules with specific days: with a weekly count, any order within the week already counts'
        : `${countsFor} has no workout to swap (the program is paused then)`,
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
  return day.workoutId
}