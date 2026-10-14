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

// The decorators record their rules with the Reflect metadata API, which
// Nest loads at startup (main.ts) — a plain test file must load it itself.
import 'reflect-metadata'
import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateExerciseDto } from '../../exercises/dto/create-exercise.dto'
import { UpdateExerciseDto } from '../../exercises/dto/update-exercise.dto'
import { UpdateAssignedProgramExerciseDto } from '../../assigned-programs/dto/update-assigned-program-exercise.dto'

// The description rules (exercise-description.ts), run through the REAL
// class-validator engine on all THREE DTOs that use them — describe.each, so
// a DTO that lost a decorator, or kept its own looser copy, fails here.
// (Replaces update-assigned-program-exercise-validation.spec.ts, which tested
// the program's copy alone — with the old limits, 255 and 500.)
//
// Each case builds a request that is valid in every other way, so the ONLY
// thing that can fail is the field under test: the two PATCH DTOs need
// nothing else; the create DTO gets a complete, valid exercise.
const validExercise = {
  name: 'Squat',
  primaryMuscles: ['quadriceps'],
  instructions: ['Stand up.'],
}

type Field =
  'name' | 'primaryMuscles' | 'secondaryMuscles' | 'equipment' | 'instructions'

// `dto` is typed as "a class whose instances are objects" (not the union of
// the three classes): plainToInstance is generic in the class it builds, and
// TypeScript can't pick one instance type for a union of constructors.
async function fieldErrors(
  dto: new () => object,
  field: Field,
  value: unknown,
) {
  const base = dto === CreateExerciseDto ? validExercise : {}
  const errors = await validate(
    plainToInstance(dto, { ...base, [field]: value }),
  )
  // Every error must be about the field under test — anything else means the
  // fixture, not the rule, failed.
  expect(errors.map((error) => error.property)).toEqual(
    errors.length > 0 ? [field] : [],
  )
  return errors.flatMap((error) => Object.values(error.constraints ?? {}))
}

// The lists, with what differs between them: required or not, the limits,
// and the words of their messages.
const lists = [
  {
    field: 'primaryMuscles',
    required: true,
    maxItems: 20,
    itemMaxLength: 100,
    blank: "A primary muscle can't be blank",
    empty: 'An exercise needs at least one primary muscle',
  },
  {
    field: 'secondaryMuscles',
    required: false,
    maxItems: 20,
    itemMaxLength: 100,
    blank: "A secondary muscle can't be blank",
    empty: null,
  },
  {
    field: 'equipment',
    required: false,
    maxItems: 20,
    itemMaxLength: 100,
    blank: "A piece of equipment can't be blank",
    empty: null,
  },
  {
    field: 'instructions',
    required: true,
    maxItems: 50,
    itemMaxLength: 1000,
    blank: "An instruction step can't be blank",
    empty: 'An exercise needs at least one instruction step',
  },
] as const

describe.each([
  ['CreateExerciseDto', CreateExerciseDto],
  ['UpdateExerciseDto', UpdateExerciseDto],
  ['UpdateAssignedProgramExerciseDto', UpdateAssignedProgramExerciseDto],
] as const)('%s — the description', (_name, dto) => {
  describe('the name', () => {
    it('accepts a name, spaces around it included', async () => {
      expect(await fieldErrors(dto, 'name', 'Squat')).toEqual([])
      expect(await fieldErrors(dto, 'name', '  Squat  ')).toEqual([])
    })

    it.each([
      ['empty', ''],
      ['only spaces', '   '],
      // \s covers more than the space bar: a pasted tab or line break is
      // just as invisible.
      ['only a tab and a line break', '\t\n'],
    ])('refuses a blank name (%s)', async (_case, name) => {
      expect(await fieldErrors(dto, 'name', name)).toEqual([
        "The exercise's name can't be blank",
      ])
    })

    // 200, both sides of the boundary — the program's copy allowed 255.
    it('accepts 200 characters and refuses 201', async () => {
      expect(await fieldErrors(dto, 'name', 'a'.repeat(200))).toEqual([])
      expect(await fieldErrors(dto, 'name', 'a'.repeat(201))).toEqual([
        'name must be shorter than or equal to 200 characters',
      ])
    })

    // The null trap: the column is NOT NULL, so `null` must be a 400 here,
    // never a 500 from the database. (The other two messages come from the
    // same value failing the length and not-blank rules too.)
    it('refuses null', async () => {
      expect(await fieldErrors(dto, 'name', null)).toEqual([
        'name must be a string',
        'name must be shorter than or equal to 200 characters',
        "The exercise's name can't be blank",
      ])
    })
  })

  describe.each(lists)(
    'the list $field',
    ({ field, required, maxItems, itemMaxLength, blank, empty }) => {
      it('accepts a list', async () => {
        expect(await fieldErrors(dto, field, ['one', 'two'])).toEqual([])
      })

      if (required) {
        it('refuses an empty list', async () => {
          expect(await fieldErrors(dto, field, [])).toEqual([empty])
        })
      } else {
        // [] is how "none" is said for the two optional lists.
        it('accepts an empty list — "none"', async () => {
          expect(await fieldErrors(dto, field, [])).toEqual([])
        })
      }

      // A blank ITEM, among real ones too: for a required list, ["  "] used
      // to count as "at least one".
      it.each([
        ['alone', ['  ']],
        ['empty, after a real item', ['real', '']],
        ['only a tab', ['\t']],
      ])('refuses a blank item (%s)', async (_case, value) => {
        expect(await fieldErrors(dto, field, value)).toEqual([blank])
      })

      it(`accepts ${itemMaxLength} characters in an item and refuses ${itemMaxLength + 1}`, async () => {
        expect(
          await fieldErrors(dto, field, ['a'.repeat(itemMaxLength)]),
        ).toEqual([])
        expect(
          await fieldErrors(dto, field, ['a'.repeat(itemMaxLength + 1)]),
        ).toEqual([
          `each value in ${field} must be shorter than or equal to ${itemMaxLength} characters`,
        ])
      })

      it(`accepts ${maxItems} items and refuses ${maxItems + 1}`, async () => {
        expect(
          await fieldErrors(dto, field, Array<string>(maxItems).fill('a')),
        ).toEqual([])
        expect(
          await fieldErrors(dto, field, Array<string>(maxItems + 1).fill('a')),
        ).toEqual([`${field} must contain no more than ${maxItems} elements`])
      })

      // The null trap again. Its FIRST message is the one that explains;
      // the rest are the same `null` failing the other rules. For an
      // optional list it says how "none" is spelled.
      it('refuses null, saying what to send', async () => {
        const messages = await fieldErrors(dto, field, null)
        expect(messages[0]).toBe(
          required
            ? `${field} must be a list`
            : `${field} must be a list: send [] for none`,
        )
      })
    },
  )
})

// Where the DTOs differ, on purpose: whether a field may be ABSENT.
describe('a description field that is not sent', () => {
  it('creating needs the name, the primary muscles and the instructions', async () => {
    const errors = await validate(plainToInstance(CreateExerciseDto, {}))
    expect(errors.map((error) => error.property)).toEqual([
      'name',
      'primaryMuscles',
      'instructions',
    ])
  })

  // The service stores [] for a list that wasn't sent ("none").
  it('creating may leave out the two optional lists', async () => {
    const errors = await validate(
      plainToInstance(CreateExerciseDto, validExercise),
    )
    expect(errors).toEqual([])
  })

  // A PATCH changes only what it sends.
  it.each([
    ['UpdateExerciseDto', UpdateExerciseDto, {}],
    [
      'UpdateAssignedProgramExerciseDto',
      UpdateAssignedProgramExerciseDto,
      { sets: 3 },
    ],
  ] as const)('%s needs none of them', async (_name, dto, body) => {
    const errors = await validate(plainToInstance(dto, body))
    expect(errors).toEqual([])
  })
})
