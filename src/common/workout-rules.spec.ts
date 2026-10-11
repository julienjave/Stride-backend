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
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import {
  MAX_WORKOUTS,
  assertCanAddWorkout,
  assertWorkoutRemovable,
  isPermutationOf,
  normalizeWorkoutName,
  orderExercisesByWorkout,
  orderWorkouts,
  resolveWorkoutId,
  workoutLabel,
} from './workout-rules'

// The workout rules shared by templates and assigned programs. Pure
// functions, so every rule is a plain call with plain values. Each rule has
// at least one case a naive version gets WRONG (noted where it isn't
// obvious) — a test that a naive version also passes proves nothing.

// Three workouts, deliberately NOT in position order (as a database may
// return them): C's row first, then A, then B.
const WORKOUTS = [
  { id: 30, name: 'Core', sortOrder: 2 },
  { id: 10, name: null, sortOrder: 0 },
  { id: 20, name: 'Lower body', sortOrder: 1 },
]

describe('workoutLabel', () => {
  it.each([
    [0, 'A'],
    [1, 'B'],
    [MAX_WORKOUTS - 1, 'J'],
  ])('labels position %i as %s', (index, label) => {
    expect(workoutLabel(index)).toBe(label)
  })
})

describe('normalizeWorkoutName', () => {
  it('trims a name', () => {
    expect(normalizeWorkoutName('  Upper body  ')).toBe('Upper body')
  })

  // One spelling for "no name": NULL — never '' or spaces, which the
  // database's *_name_not_blank CHECK would refuse anyway.
  it.each([[''], ['   '], [null], [undefined]])(
    'turns %p into null',
    (name) => {
      expect(normalizeWorkoutName(name)).toBeNull()
    },
  )
})

describe('orderWorkouts', () => {
  it('orders by position, without changing the array it was given', () => {
    const input = [...WORKOUTS]
    expect(orderWorkouts(input).map((w) => w.id)).toEqual([10, 20, 30])
    expect(input.map((w) => w.id)).toEqual([30, 10, 20])
  })

  // Equal positions can't come from the API, but the order must still not
  // depend on how rows happened to be read: the lower id first.
  it('breaks a tie on position by id', () => {
    const tied = [
      { id: 8, name: null, sortOrder: 0 },
      { id: 7, name: null, sortOrder: 0 },
    ]
    expect(orderWorkouts(tied).map((w) => w.id)).toEqual([7, 8])
  })
})

describe('resolveWorkoutId', () => {
  // "The first workout" means the first BY POSITION — the naive "first row
  // in the array" would give 30 (C) here.
  it.each([[undefined], [null]])(
    'gives the first workout by position when none is asked for (%p)',
    (requested) => {
      expect(resolveWorkoutId(requested, WORKOUTS, 'template')).toBe(10)
    },
  )

  it('gives the workout asked for, when it is one of these', () => {
    expect(resolveWorkoutId(20, WORKOUTS, 'program')).toBe(20)
  })

  it('refuses a workout that is not one of these, naming where', () => {
    expect(() => resolveWorkoutId(99, WORKOUTS, 'program')).toThrow(
      new NotFoundException('Workout 99 not found in this program'),
    )
    expect(() => resolveWorkoutId(99, WORKOUTS, 'template')).toThrow(
      new NotFoundException('Workout 99 not found in this template'),
    )
  })
})

describe('orderExercisesByWorkout', () => {
  // A's exercise has a HIGHER position (5) than B's (0): sorting by the
  // exercises' own positions alone — the naive version — would list B's
  // first. Workout first, then position within it.
  it('lists workout by workout, then by position within each', () => {
    const exercises = [
      { id: 1, workoutId: 20, sortOrder: 0 },
      { id: 2, workoutId: 10, sortOrder: 5 },
      { id: 3, workoutId: 30, sortOrder: 0 },
      { id: 4, workoutId: 10, sortOrder: 1 },
    ]
    expect(
      orderExercisesByWorkout(exercises, WORKOUTS).map((e) => e.id),
    ).toEqual([4, 2, 1, 3])
    // A copy: the caller's array is unchanged.
    expect(exercises.map((e) => e.id)).toEqual([1, 2, 3, 4])
  })

  // Can't happen (foreign key), but must not break the sort: last.
  it('puts an exercise of an unknown workout last', () => {
    const exercises = [
      { id: 1, workoutId: 999, sortOrder: 0 },
      { id: 2, workoutId: 30, sortOrder: 9 },
    ]
    expect(
      orderExercisesByWorkout(exercises, WORKOUTS).map((e) => e.id),
    ).toEqual([2, 1])
  })

  it('breaks a tie on position by id', () => {
    const exercises = [
      { id: 6, workoutId: 10, sortOrder: 0 },
      { id: 5, workoutId: 10, sortOrder: 0 },
    ]
    expect(
      orderExercisesByWorkout(exercises, WORKOUTS).map((e) => e.id),
    ).toEqual([5, 6])
  })
})

describe('isPermutationOf', () => {
  it.each([
    ['the same order', [1, 2, 3], true],
    ['another order', [3, 1, 2], true],
    ['one missing', [1, 2], false],
    ['one extra', [1, 2, 3, 4], false],
    // The right length and only known ids — but 3 is missing. The check
    // that compared de-duplicated sizes only would accept a padded list.
    ['a duplicate standing in for a missing id', [1, 1, 2], false],
    // The right length, no duplicates — but 9 isn't one of ours.
    ['an unknown id', [1, 2, 9], false],
  ])('%s → %s', (_label, order, expected) => {
    expect(isPermutationOf(order, [1, 2, 3])).toBe(expected)
  })
})

describe('assertCanAddWorkout', () => {
  // The boundary on both sides: the 10th may be added, an 11th may not.
  it('allows adding up to the limit', () => {
    expect(() => assertCanAddWorkout(MAX_WORKOUTS - 1)).not.toThrow()
  })

  it('refuses beyond the limit', () => {
    expect(() => assertCanAddWorkout(MAX_WORKOUTS)).toThrow(
      new BadRequestException('A program can have at most 10 workouts'),
    )
  })
})

describe('assertWorkoutRemovable', () => {
  it('allows an empty workout that is not the last, with no sessions', () => {
    expect(() =>
      assertWorkoutRemovable({
        label: 'B',
        workoutCount: 2,
        exerciseCount: 0,
        sessionCount: 0,
      }),
    ).not.toThrow()
    // Templates have no sessions: the count is simply not given.
    expect(() =>
      assertWorkoutRemovable({ label: 'B', workoutCount: 2, exerciseCount: 0 }),
    ).not.toThrow()
  })

  // Never the last — even when it's empty.
  it('refuses the last workout', () => {
    expect(() =>
      assertWorkoutRemovable({ label: 'A', workoutCount: 1, exerciseCount: 0 }),
    ).toThrow(
      new ConflictException(
        'This is the last workout, and there must always be at least one',
      ),
    )
  })

  it('refuses a workout that still has exercises', () => {
    expect(() =>
      assertWorkoutRemovable({ label: 'C', workoutCount: 3, exerciseCount: 1 }),
    ).toThrow(
      new ConflictException(
        'Workout C still has exercises: move or remove them first',
      ),
    )
  })

  it('refuses a workout with recorded sessions', () => {
    expect(() =>
      assertWorkoutRemovable({
        label: 'B',
        workoutCount: 2,
        exerciseCount: 0,
        sessionCount: 1,
      }),
    ).toThrow(
      new ConflictException(
        "Workout B has recorded sessions, so it is part of the patient's history and can't be deleted",
      ),
    )
  })
})