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

// The rules of WORKOUTS (decisions §5, "Settled 2026-10-10", point 1), shared
// by templates (ProgramsService) and assigned programs
// (AssignedProgramsService). A workout is one set of exercises done together
// in a session — "upper body", "lower body". Templates and programs follow
// the SAME rules, so the rules live once, here, as plain functions: two
// copies would drift (one side allowing 12 workouts, the other 10), and pure
// functions are tested with plain values, no database.
//
// What lives here: the limits, how a workout is labelled, how a name is
// cleaned up, which workout an exercise goes to, the order exercises are
// listed in, and when a workout may be deleted. What doesn't: reading and
// writing rows — each service does that with its own tables.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// At most 10 workouts per template or program — labelled A to J. A program
// rarely has more than three or four; the limit exists so a client can't
// create thousands, and so every label is a single letter.
export const MAX_WORKOUTS = 10

// The column is varchar(100); the DTOs use the same number.
export const WORKOUT_NAME_MAX_LENGTH = 100

// --- TYPES -------------------------------------------------------------------------------------------------

// The fields of a workout row these rules look at — both workout tables
// have them, so either can be passed.
export interface WorkoutRow {
  id: number
  name: string | null
  sortOrder: number
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// The label a screen shows for the workout at this position: 0 → "A",
// 1 → "B"… Derived from the ORDER, never stored, so reordering workouts
// can't leave a stale letter behind. (String.fromCharCode(65) is "A": 65 is
// its character code.)
export function workoutLabel(index: number): string {
  return String.fromCharCode(65 + index)
}

// A workout's name as stored: trimmed, and NULL when nothing is left. "No
// name" then has exactly one spelling (NULL), never also '' or '   ' — the
// database's *_name_not_blank CHECK refuses blank names, and this is what
// keeps the API from ever sending one.
export function normalizeWorkoutName(
  name: string | null | undefined,
): string | null {
  const trimmed = name?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

// The workouts in display order: by position, then by id when two share a
// position (it can't happen through the API, but an order that depends on
// how the database happened to return rows is a bug waiting to happen).
// Copies first: sort() reorders the array it's given, and callers pass
// arrays they still use.
export function orderWorkouts<T extends WorkoutRow>(workouts: T[]): T[] {
  return [...workouts].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
}

// Which workout an exercise goes to (or a reorder applies to):
//   - none asked for (absent or null) → the FIRST workout. This is what keeps the current
//     screens working unchanged: they don't know about workouts yet, and a
//     one-workout template or program behaves exactly as before.
//   - one asked for → it must be one of THESE workouts. A 404 otherwise — a
//     workout of another template is "not found" from here; checking it
//     here gives a clear message, and the database's composite foreign key
//     is the guarantee behind it.
// `workouts` is never empty: every template and program has at least one.
export function resolveWorkoutId(
  requested: number | null | undefined,
  workouts: WorkoutRow[],
  where: 'template' | 'program',
): number {
  if (requested == null) {
    return orderWorkouts(workouts)[0].id
  }
  if (!workouts.some((workout) => workout.id === requested)) {
    throw new NotFoundException(
      `Workout ${requested} not found in this ${where}`,
    )
  }
  return requested
}

// Exercises in the order a screen lists them: workout by workout (A's
// exercises, then B's…), and within a workout by their own position. One
// flat list, so the screens that don't know about workouts yet keep showing
// every exercise; each exercise carries its workoutId for those that do.
export function orderExercisesByWorkout<
  T extends { id: number; workoutId: number; sortOrder: number },
>(exercises: T[], workouts: WorkoutRow[]): T[] {
  const position = new Map(
    orderWorkouts(workouts).map((workout, index) => [workout.id, index]),
  )
  // `?? MAX_WORKOUTS`: an exercise whose workout isn't in the list can't
  // exist (foreign key), but if it ever did, it goes last rather than
  // breaking the sort with `undefined`.
  const rank = (exercise: T) => position.get(exercise.workoutId) ?? MAX_WORKOUTS
  return [...exercises].sort(
    (a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.id - b.id,
  )
}

// True when `order` lists exactly the ids in `ids`, each once, in any order.
// THREE conditions together — the same check the exercise reorders already
// made (see ProgramsService.reorderExercises for the exploit it closes): the
// same length, no id twice, and every id one of ours. Two of them alone can
// be fooled: [1, 1] against [1, 2] has the right length and only our ids.
export function isPermutationOf(order: number[], ids: number[]): boolean {
  const known = new Set(ids)
  return (
    order.length === ids.length &&
    new Set(order).size === order.length &&
    order.every((id) => known.has(id))
  )
}

// Adding a workout: refused once there are already MAX_WORKOUTS.
export function assertCanAddWorkout(workoutCount: number) {
  if (workoutCount >= MAX_WORKOUTS) {
    throw new BadRequestException(
      `A program can have at most ${MAX_WORKOUTS} workouts`,
    )
  }
}

// Deleting a workout. 409 Conflict, not 400: the request itself is fine —
// it's the workout's current STATE that stands in the way, and the message
// says what would have to change first.
//   - Never the last one: every template and program has a workout, so an
//     exercise always has somewhere to go.
//   - Only an EMPTY one: deleting a workout must never silently delete
//     exercises with it. The practitioner moves or removes them first — a
//     deliberate act for each.
//   - (Programs only) never one that sessions recorded: those sessions are
//     the patient's history, and they say which workout they did.
export function assertWorkoutRemovable(state: {
  label: string
  workoutCount: number
  exerciseCount: number
  sessionCount?: number
}) {
  if (state.workoutCount <= 1) {
    throw new ConflictException(
      'This is the last workout, and there must always be at least one',
    )
  }
  if (state.exerciseCount > 0) {
    throw new ConflictException(
      `Workout ${state.label} still has exercises: move or remove them first`,
    )
  }
  if ((state.sessionCount ?? 0) > 0) {
    throw new ConflictException(
      `Workout ${state.label} has recorded sessions, so it is part of the patient's history and can't be deleted`,
    )
  }
}