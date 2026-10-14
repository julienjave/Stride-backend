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

import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { AddAssignedProgramExerciseDto } from './add-assigned-program-exercise.dto'
import { AssignedExerciseInputDto } from './assigned-exercise-input.dto'

// Against the real class-validator engine: step 3b-0 made `sortOrder`
// optional HERE (the service appends), while the inline list at creation
// still requires it. OmitType must have kept every other field's rules.
async function errorFields<T extends object>(cls: new () => T, body: object) {
  const errors = await validate(plainToInstance(cls, body))
  return errors.map((error) => error.property).sort()
}

describe('AddAssignedProgramExerciseDto', () => {
  it('accepts an exercise with no position (the service appends it)', async () => {
    expect(
      await errorFields(AddAssignedProgramExerciseDto, { exerciseId: 5 }),
    ).toEqual([])
  })

  it('still checks a position that is given', async () => {
    expect(
      await errorFields(AddAssignedProgramExerciseDto, {
        exerciseId: 5,
        sortOrder: -1,
      }),
    ).toEqual(['sortOrder'])
    expect(
      await errorFields(AddAssignedProgramExerciseDto, {
        exerciseId: 5,
        sortOrder: 1.5,
      }),
    ).toEqual(['sortOrder'])
  })

  // The fields OmitType copied keep their decorators.
  it("keeps the other fields' rules", async () => {
    expect(
      await errorFields(AddAssignedProgramExerciseDto, {
        sets: 0,
        weight: 20,
        workoutId: 'B',
      }),
    ).toEqual(['exerciseId', 'sets', 'weightUnit', 'workoutId'])
  })

  // The inline list at creation is unchanged: there, the position is
  // required (the whole list arrives at once, in the client's order).
  it('leaves the inline list item requiring its position', async () => {
    expect(
      await errorFields(AssignedExerciseInputDto, { exerciseId: 5 }),
    ).toEqual(['sortOrder'])
  })
})
