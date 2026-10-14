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
// Nest loads at startup (main.ts) — a plain test file must load it itself,
// before the DTOs (their @Type() decorators run on import).
import 'reflect-metadata'
import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateAssignedProgramDto } from './create-assigned-program.dto'
import { UpdateAssignedProgramDto } from './update-assigned-program.dto'

// The title rule (program-title.decorator.ts), run through the real
// class-validator engine on BOTH DTOs that use it — describe.each, so a DTO
// that lost the decorator (or got its own, looser copy) fails here.
//
// Each case builds a request that is valid in every other way, so the ONLY
// thing that can fail is the title: the PATCH needs nothing else; the POST
// gets a patient, a start date and a schedule.
const validCreate = {
  patientId: 6,
  startDate: '2031-03-03',
  schedule: { type: 'times_per_week', timesPerWeek: 3 },
}

// `dto` is typed as "a class whose instances are objects" rather than the
// union of the two classes: plainToInstance is generic in the class it
// builds, and TypeScript can't pick one instance type for a union of two
// constructors (TS2769). Nothing here needs to know which one it is.
async function titleErrors(dto: new () => object, title: unknown) {
  const base = dto === CreateAssignedProgramDto ? validCreate : {}
  const errors = await validate(plainToInstance(dto, { ...base, title }))
  // Every error must be about the title — anything else means the fixture,
  // not the rule, failed.
  expect(errors.map((error) => error.property)).toEqual(
    errors.length > 0 ? ['title'] : [],
  )
  return errors.flatMap((error) => Object.values(error.constraints ?? {}))
}

describe.each([
  ['CreateAssignedProgramDto', CreateAssignedProgramDto],
  ['UpdateAssignedProgramDto', UpdateAssignedProgramDto],
] as const)('%s — the title', (_name, dto) => {
  it('accepts a title', async () => {
    expect(await titleErrors(dto, 'Knee Rehab — Pat')).toEqual([])
  })

  // Spaces AROUND a real title are harmless: the rule is about having
  // something visible, not about formatting.
  it('accepts a title with spaces around it', async () => {
    expect(await titleErrors(dto, '  Knee  ')).toEqual([])
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    // \s covers more than the space bar: a pasted tab or line break is
    // just as invisible.
    ['only a tab and a line break', '\t\n'],
  ])(
    'refuses a blank title (%s), with a message a person can read',
    async (_case, title) => {
      expect(await titleErrors(dto, title)).toEqual([
        "The program's title can't be blank",
      ])
    },
  )

  // The limit is 200 — exactly 200 passes, 201 doesn't (the boundary, both
  // sides, so a changed number fails one of the two).
  it('accepts 200 characters and refuses 201', async () => {
    expect(await titleErrors(dto, 'a'.repeat(200))).toEqual([])
    expect(await titleErrors(dto, 'a'.repeat(201))).toEqual([
      'title must be shorter than or equal to 200 characters',
    ])
  })
})

// Where the two DTOs differ, on purpose: whether the title may be ABSENT.
describe('the title when it is not sent', () => {
  it('is required when creating', async () => {
    const errors = await validate(
      plainToInstance(CreateAssignedProgramDto, validCreate),
    )
    expect(errors.map((error) => error.property)).toEqual(['title'])
  })

  // A PATCH changes only what it sends: no title = keep the stored one.
  it('is optional on a PATCH', async () => {
    const errors = await validate(
      plainToInstance(UpdateAssignedProgramDto, { allowSwaps: false }),
    )
    expect(errors).toEqual([])
  })

  // …but `null` isn't "not sent": the column is NOT NULL, so it must be a
  // 400, never a 500 from the database (@ValidateIf(isPresent), not
  // @IsOptional() — is-present.ts).
  it('refuses null on a PATCH', async () => {
    const errors = await validate(
      plainToInstance(UpdateAssignedProgramDto, { title: null }),
    )
    expect(errors.map((error) => error.property)).toEqual(['title'])
  })
})