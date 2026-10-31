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
import { validate, type ValidationError } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateRomAssessmentDto } from './create-rom-assessment.dto'

// CreateRomAssessmentDto through the real class-validator engine. The e2e
// suite checks each refusal's sentence through the API; these pin what only
// a unit test can see cheaply: WHICH rule speaks when several could (one
// problem, one message), and what the DTO leaves to the database.

const KNEE = {
  movement: 'knee_flexion',
  side: 'right',
  mode: 'active',
  degrees: 95,
}
const base = { patientId: 20, measuredOn: '2031-03-12', measurements: [KNEE] }

// The messages of the FIRST measurement, by property.
async function measurementErrors(change: Record<string, unknown>) {
  const errors = await validate(
    plainToInstance(CreateRomAssessmentDto, {
      ...base,
      measurements: [{ ...KNEE, ...change }],
    }),
  )
  const nested: ValidationError[] =
    errors.find((error) => error.property === 'measurements')?.children?.[0]
      ?.children ?? []
  return Object.fromEntries(
    nested.map((error) => [
      error.property,
      Object.values(error.constraints ?? {}),
    ]),
  )
}

describe('CreateRomAssessmentDto', () => {
  it('accepts an assessment, and an amendment with its reason', async () => {
    expect(
      await validate(plainToInstance(CreateRomAssessmentDto, base)),
    ).toEqual([])
    expect(
      await validate(
        plainToInstance(CreateRomAssessmentDto, {
          ...base,
          medicalFileEntryId: 4,
          amendsId: 3,
          amendmentReason: 'Misread',
        }),
      ),
    ).toEqual([])
  })

  // An unknown movement can't say whether a side is needed, nor what its
  // bounds are: only @IsIn speaks — not three messages for one mistake.
  it('lets only the movement’s own rule speak when the movement is unknown', async () => {
    expect(
      await measurementErrors({
        movement: 'knee_twist',
        side: undefined,
        degrees: 9999,
      }),
    ).toStrictEqual({
      movement: [
        expect.stringContaining('movement must be one of the following values'),
      ],
    })
  })

  // A fractional value: @IsInt says it; the bounds rule stays silent rather
  // than judging a number that isn't a reading.
  it('lets only @IsInt speak for a value that isn’t whole', async () => {
    expect(await measurementErrors({ degrees: 300.5 })).toStrictEqual({
      degrees: ['degrees must be an integer number'],
    })
  })

  it('accepts null for an absent side and an absent note', async () => {
    expect(
      await measurementErrors({
        movement: 'cervical_flexion',
        side: null,
        degrees: 40,
        note: null,
      }),
    ).toStrictEqual({})
  })

  // A rule across the list's items is the unique index's alone (one judge):
  // the DTO lets a duplicate through.
  it('lets a duplicate measurement through — the database decides', async () => {
    expect(
      await validate(
        plainToInstance(CreateRomAssessmentDto, {
          ...base,
          measurements: [KNEE, KNEE],
        }),
      ),
    ).toEqual([])
  })

  // The future is the database clock's to judge (the CHECK against
  // created_at): the DTO only asks for a real day.
  it('lets a future day through — the database decides', async () => {
    expect(
      await validate(
        plainToInstance(CreateRomAssessmentDto, {
          ...base,
          measuredOn: '2999-01-01',
        }),
      ),
    ).toEqual([])
  })
})
