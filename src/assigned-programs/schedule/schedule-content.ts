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

// A schedule version's CONTENT — what it says beyond the day it applies
// from: its type, and the workouts it uses (step 2b-ii). Two pure functions
// turn what the API received into that content, one per way a schedule
// arrives:
//   - when a program is ASSIGNED, its days and rotation name workouts by
//     position in the template (`workoutIndex`), because the program's own
//     workouts are created by that same request;
//   - LATER versions name the program's own workouts by id.
// Both end in the same shape, which is what gets stored and what the
// schedule module reads. Pure (plain values in and out, the program's
// workouts passed in), so every rule is tested without a database.

import { BadRequestException } from '@nestjs/common'
import {
  orderWorkouts,
  resolveWorkoutId,
  workoutLabel,
  type WorkoutRow,
} from '../../common/workout-rules'
import {
  ScheduleType,
  type NewProgramScheduleDto,
  type ScheduleVersionInputDto,
} from '../dto/schedule-input.dto'

// --- TYPES -------------------------------------------------------------------------------------------------

// A scheduled weekday (ISO: 1 = Monday) and the workout it uses.
export interface ScheduleDay {
  weekday: number
  workoutId: number
}

export interface ScheduleContent {
  type: 'weekdays' | 'times_per_week' | 'paused'
  // Only for 'times_per_week'.
  timesPerWeek: number | null
  // Only for 'weekdays' (empty otherwise), sorted by weekday.
  days: ScheduleDay[]
  // Only for 'times_per_week' (empty otherwise): workout ids, position 0
  // first.
  rotation: number[]
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// Days in weekday order: one spelling for one schedule, whatever order the
// client sent (the same reason the old weekday array was kept sorted).
// Copies first — the caller's array stays as it was.
function sortDays(days: ScheduleDay[]): ScheduleDay[] {
  return [...days].sort((a, b) => a.weekday - b.weekday)
}

// --- WHEN ASSIGNING ----------------------------------------------------------------------------------------

// `workoutIds`: the NEW program's workouts, in order (index 0 = A) — the
// ids create() just got back. A position the template doesn't have is a
// 400 that names what exists ("the program has 2 workouts (A, B)").
// Without a rotation, every workout in order: A, B, C (the suggestion —
// decisions §5, "Settled 2026-10-10", point 3).
export function contentFromNewSchedule(
  schedule: NewProgramScheduleDto,
  workoutIds: number[],
): ScheduleContent {
  const idAt = (index: number) => {
    if (index >= workoutIds.length) {
      const labels = workoutIds.map((_, i) => workoutLabel(i)).join(', ')
      throw new BadRequestException(
        `workoutIndex ${index} doesn't exist: the program has ${workoutIds.length} workout${workoutIds.length === 1 ? '' : 's'} (${labels})`,
      )
    }
    return workoutIds[index]
  }

  if (schedule.type === ScheduleType.WEEKDAYS) {
    return {
      type: 'weekdays',
      timesPerWeek: null,
      days: sortDays(
        schedule.days!.map((day) => ({
          weekday: day.weekday,
          workoutId: idAt(day.workoutIndex),
        })),
      ),
      rotation: [],
    }
  }
  return {
    type: 'times_per_week',
    timesPerWeek: schedule.timesPerWeek!,
    days: [],
    rotation: schedule.rotation?.map(idAt) ?? [...workoutIds],
  }
}

// --- A LATER VERSION ---------------------------------------------------------------------------------------

// `workouts`: the program's workouts (any order). Every id must be one of
// them — resolveWorkoutId's 404, the same answer as for an exercise added
// to another program's workout. (The database's composite foreign keys are
// the guarantee behind it.)
export function contentFromVersionInput(
  schedule: ScheduleVersionInputDto,
  workouts: WorkoutRow[],
): ScheduleContent {
  const check = (workoutId: number) =>
    resolveWorkoutId(workoutId, workouts, 'program')

  if (schedule.type === ScheduleType.WEEKDAYS) {
    return {
      type: 'weekdays',
      timesPerWeek: null,
      days: sortDays(
        schedule.days!.map((day) => ({
          weekday: day.weekday,
          workoutId: check(day.workoutId),
        })),
      ),
      rotation: [],
    }
  }
  if (schedule.type === ScheduleType.TIMES_PER_WEEK) {
    return {
      type: 'times_per_week',
      timesPerWeek: schedule.timesPerWeek!,
      days: [],
      rotation:
        schedule.rotation?.map(check) ??
        orderWorkouts(workouts).map((workout) => workout.id),
    }
  }
  return { type: 'paused', timesPerWeek: null, days: [], rotation: [] }
}