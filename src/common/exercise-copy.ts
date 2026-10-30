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

import { NotFoundException } from '@nestjs/common'
import { orderExercisesByWorkout, type WorkoutRow } from './workout-rules'

// --- COPYING SEVERAL EXERCISES AT ONCE ---------------------------------------------------------------------
//
// Roadmap Phase 6.5, "Copying several exercises, or a whole workout, at
// once" (decided with the person 2026-10-29: the workout's menu, its
// exercises ticked, a target workout or a new one). The same rules for a
// template and an assigned program, so they live here once, as pure
// functions; each service only reads the rows and writes the copies.

// At most this many exercises per copy. A workout rarely holds more than a
// dozen; the limit only keeps a client from asking for thousands in one
// transaction (and one audit entry). The DTO says the same number.
export const MAX_EXERCISES_PER_COPY = 50

// The exercises a copy takes, CHECKED and ORDERED:
//   - every requested id must be an exercise of THIS template or program
//     (`rows` — the caller reads only this resource's rows). One that isn't
//     is a 404 naming it: from here, another resource's exercise doesn't
//     exist — the same answer, and the same IDOR protection, as editing one
//     through the wrong URL. Nothing is copied when one is wrong: a copy of
//     "the four that worked" would be a surprise.
//   - the copies are written in the order the screen SHOWS the sources —
//     workout by workout, then by position (orderExercisesByWorkout) — not
//     in the order the ids happened to be sent: ticking boxes in another
//     order mustn't scramble a warm-up.
export function orderCopySources<
  T extends { id: number; workoutId: number; sortOrder: number },
>(
  rows: T[],
  requestedIds: number[],
  workouts: WorkoutRow[],
  where: 'template' | 'program',
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missing = requestedIds.find((id) => !byId.has(id))
  if (missing !== undefined) {
    throw new NotFoundException(
      `Exercise ${missing} not found in this ${where}`,
    )
  }
  return orderExercisesByWorkout(
    requestedIds.map((id) => byId.get(id)!),
    workouts,
  )
}
