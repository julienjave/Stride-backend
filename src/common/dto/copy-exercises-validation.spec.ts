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

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CopyExercisesDto } from './copy-exercises.dto'

// Roadmap Phase 6.5: the body of both copy routes.

async function errors(body: object) {
  const found = await validate(plainToInstance(CopyExercisesDto, body))
  return found.flatMap((error) => Object.values(error.constraints ?? {}))
}

describe('CopyExercisesDto', () => {
  it.each([
    ['into an existing workout', { exerciseIds: [1, 2], targetWorkoutId: 7 }],
    [
      'into a new workout, unnamed',
      { exerciseIds: [1], targetWorkoutId: null },
    ],
    [
      'into a new workout, named',
      { exerciseIds: [1], targetWorkoutId: null, newWorkoutName: 'Warm-up' },
    ],
    [
      'a name sent as null with an existing workout',
      { exerciseIds: [1], targetWorkoutId: 7, newWorkoutName: null },
    ],
    [
      '50 exercises',
      { exerciseIds: [...Array(50).keys()], targetWorkoutId: 7 },
    ],
  ])('accepts %s', async (_label, body) => {
    expect(await errors(body)).toEqual([])
  })

  it.each([
    [
      'no exercise',
      { exerciseIds: [], targetWorkoutId: 7 },
      'exerciseIds must contain at least 1 elements',
    ],
    [
      '51 exercises',
      { exerciseIds: [...Array(51).keys()], targetWorkoutId: 7 },
      'exerciseIds must contain no more than 50 elements',
    ],
    [
      'the same exercise twice',
      { exerciseIds: [1, 1], targetWorkoutId: 7 },
      "All exerciseIds's elements must be unique",
    ],
    [
      'an id that is not an integer',
      { exerciseIds: [1.5], targetWorkoutId: 7 },
      'each value in exerciseIds must be an integer number',
    ],
    [
      'no target at all — never read as "a new workout"',
      { exerciseIds: [1] },
      'targetWorkoutId must be an integer number',
    ],
    [
      'a target that is not an integer',
      { exerciseIds: [1], targetWorkoutId: '7' },
      'targetWorkoutId must be an integer number',
    ],
    [
      'a new name for an existing workout',
      { exerciseIds: [1], targetWorkoutId: 7, newWorkoutName: 'Warm-up' },
      'newWorkoutName is only allowed when targetWorkoutId is null',
    ],
    [
      'a name over 100 characters',
      {
        exerciseIds: [1],
        targetWorkoutId: null,
        newWorkoutName: 'x'.repeat(101),
      },
      'newWorkoutName must be shorter than or equal to 100 characters',
    ],
  ])('refuses %s', async (_label, body, message) => {
    expect(await errors(body)).toEqual([message])
  })
})
