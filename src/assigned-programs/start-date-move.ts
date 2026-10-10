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
import { addDays, utcToday } from '../common/calendar-date'

// Moving a program's start date (decided 2026-10-10, decisions §5): allowed
// only while the program hasn't started, and then the schedule moves with it.
// Two pure functions — the rule, and the plan for the schedule versions — so
// both are tested with plain values; the service only applies them.

// --- TYPES -------------------------------------------------------------------------------------------------

// What the plan needs from a schedule version (a program_schedules row has
// more; any row fits this shape).
export interface ScheduleVersionLike {
  id: number
  type: 'weekdays' | 'times_per_week'
  weekdays: number[] | null
  timesPerWeek: number | null
  effectiveFrom: string
}

export interface StartDateMovePlan {
  // Versions to delete.
  deleteIds: number[]
  // The schedule to re-create ON the new start date, or null when a version
  // already starts exactly there.
  insert: Pick<ScheduleVersionLike, 'type' | 'weekdays' | 'timesPerWeek'> | null
}

// --- RULE --------------------------------------------------------------------------------------------------

// May the start date change from `currentStart` to `newStart`?
//
// Only while BOTH are still ahead — "ahead" with the usual one day of slack
// (yesterday in UTC is someone's today; calendar-date.ts):
//   - once the program has started, its start date is history: program
//     weeks ("3× a week · weeks start Thursday") are counted from it, so
//     moving it would re-cut weeks already judged, and a patient's "3 of 3"
//     could turn into "2 of 3" after the fact;
//   - moving a future start INTO the past would put days that have already
//     gone by under the schedule, without anyone having seen them as due.
// A typo in a program that has already started is fixed by archiving it and
// assigning it again: an honest, visible correction.
export function assertStartDateMovable(
  currentStart: string,
  newStart: string,
  now: Date = new Date(),
) {
  const earliest = addDays(utcToday(now), -1)
  if (currentStart < earliest) {
    throw new BadRequestException(
      `The start date can't change once the program has started (it started on ${currentStart})`,
    )
  }
  if (newStart < earliest) {
    throw new BadRequestException("The start date can't be moved into the past")
  }
}

// --- PLAN --------------------------------------------------------------------------------------------------

// The schedule versions after a start-date move, as deletes and at most one
// insert. `versions` must be sorted by effectiveFrom, oldest first (as the
// service reads them), and is never empty (every program has a schedule).
//
// The rule: on the new start date, the schedule is whichever version would
// have been in force that day — and every version starting BEFORE the new
// start goes (no day before the start is ever judged). Concretely:
//   - the version in force on newStart is the latest one starting on or
//     before it; when the start moves EARLIER there is none, and the first
//     version is the one to bring forward;
//   - delete every version starting before newStart, and re-create the
//     in-force one ON newStart — unless it already starts exactly there;
//   - versions starting after newStart are untouched (planned changes stay).
//
// Why not just "move the first version": with a change already planned
// (first from the 20th, Tue/Thu from the 25th) and the start moved to the
// 28th, the first version moved to the 28th would hide Tue/Thu, which was
// meant to be in force by then; and with the start moved to exactly the
// 25th, it would collide with the planned version (one version per day).
//
// All of this only ever touches versions that haven't judged a day yet: the
// program hasn't started (assertStartDateMovable), so every version starts
// on or after yesterday (UTC) — which is also what the database's DELETE
// and INSERT policies on program_schedules allow.
export function planStartDateMove(
  versions: ScheduleVersionLike[],
  newStart: string,
): StartDateMovePlan {
  if (versions.length === 0) {
    throw new Error('A program always has at least one schedule version')
  }
  const startingBefore = versions.filter((v) => v.effectiveFrom < newStart)
  const inForce =
    [...versions].reverse().find((v) => v.effectiveFrom <= newStart) ??
    versions[0]

  if (inForce.effectiveFrom === newStart) {
    return { deleteIds: startingBefore.map((v) => v.id), insert: null }
  }

  // inForce either starts before newStart (already in startingBefore) or
  // after it (the first version, when the start moves earlier) — the Set
  // keeps it from being listed twice in the first case.
  const deleteIds = [
    ...new Set([...startingBefore.map((v) => v.id), inForce.id]),
  ]
  return {
    deleteIds,
    insert: {
      type: inForce.type,
      weekdays: inForce.weekdays,
      timesPerWeek: inForce.timesPerWeek,
    },
  }
}