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
import { CreateAssignedProgramDto } from '../../assigned-programs/dto/create-assigned-program.dto'
import { UpdateAssignedProgramDto } from '../../assigned-programs/dto/update-assigned-program.dto'
import { CreateTemplateDto } from '../../programs/dto/create-template.dto'
import { UpdateTemplateDto } from '../../programs/dto/update-template.dto'
import { TITLE_MAX_LENGTH } from './title'

// The title rule (title.ts), run through the real class-validator engine on
// ALL FOUR DTOs that use it — describe.each, so a DTO that lost the decorator
// (or got its own, looser copy, or the other resource's message) fails here.
//
// Each case builds a request that is valid in every other way, so the ONLY
// thing that can fail is the title: the PATCHes and the template's POST need
// nothing else; the program's POST gets a patient, a start date and a
// schedule.
const validCreateProgram = {
  patientId: 6,
  startDate: '2031-03-03',
  schedule: { type: 'times_per_week', timesPerWeek: 3 },
}

// `dto` is typed as "a class whose instances are objects" rather than the
// union of the classes: plainToInstance is generic in the class it builds,
// and TypeScript can't pick one instance type for a union of constructors
// (TS2769). Nothing here needs to know which one it is.
type Dto = new () => object

async function titleErrors(dto: Dto, title: unknown) {
  const base = dto === CreateAssignedProgramDto ? validCreateProgram : {}
  const errors = await validate(plainToInstance(dto, { ...base, title }))
  // Every error must be about the title — anything else means the fixture,
  // not the rule, failed.
  expect(errors.map((error) => error.property)).toEqual(
    errors.length > 0 ? ['title'] : [],
  )
  return errors.flatMap((error) => Object.values(error.constraints ?? {}))
}

describe.each([
  [
    'CreateAssignedProgramDto',
    CreateAssignedProgramDto,
    "The program's title can't be blank",
  ],
  [
    'UpdateAssignedProgramDto',
    UpdateAssignedProgramDto,
    "The program's title can't be blank",
  ],
  [
    'CreateTemplateDto',
    CreateTemplateDto,
    "The template's title can't be blank",
  ],
  [
    'UpdateTemplateDto',
    UpdateTemplateDto,
    "The template's title can't be blank",
  ],
] as const)('%s — the title', (_name, dto, blankMessage) => {
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
    'refuses a blank title (%s), with a message that names the resource',
    async (_case, title) => {
      expect(await titleErrors(dto, title)).toEqual([blankMessage])
    },
  )

  // The limit is 200 — exactly 200 passes, 201 doesn't (the boundary, both
  // sides, so a changed number fails one of the two). Written as the literal
  // 200 AND checked against the constant: the test pins the number itself,
  // not just "whatever the constant says".
  it('accepts 200 characters and refuses 201', async () => {
    expect(TITLE_MAX_LENGTH).toBe(200)
    expect(await titleErrors(dto, 'a'.repeat(200))).toEqual([])
    expect(await titleErrors(dto, 'a'.repeat(201))).toEqual([
      'title must be shorter than or equal to 200 characters',
    ])
  })

  // `null` is never a title — on a POST it's "missing", on a PATCH it's not
  // "not sent" (the column is NOT NULL: a 400, never a 500 from the
  // database — @ValidateIf(isPresent), not @IsOptional(), is-present.ts).
  it('refuses null', async () => {
    // All three rules fail, listed in the decorator's order.
    expect(await titleErrors(dto, null)).toEqual([
      'title must be a string',
      'title must be shorter than or equal to 200 characters',
      blankMessage,
    ])
  })
})

// Where the DTOs differ, on purpose: whether the title may be ABSENT.
describe('the title when it is not sent', () => {
  it.each([
    ['CreateAssignedProgramDto', CreateAssignedProgramDto, validCreateProgram],
    ['CreateTemplateDto', CreateTemplateDto, {}],
  ] as const)('is required when creating (%s)', async (_name, dto, base) => {
    const errors = await validate(plainToInstance(dto as Dto, base))
    expect(errors.map((error) => error.property)).toEqual(['title'])
  })

  // A PATCH changes only what it sends: no title = keep the stored one. Each
  // sends another field, so the request isn't empty.
  it.each([
    [
      'UpdateAssignedProgramDto',
      UpdateAssignedProgramDto,
      { allowSwaps: false },
    ],
    ['UpdateTemplateDto', UpdateTemplateDto, { description: 'For knees' }],
  ] as const)('is optional on a PATCH (%s)', async (_name, dto, body) => {
    expect(await validate(plainToInstance(dto as Dto, body))).toEqual([])
  })
})

// The template's description, on the PATCH now written out (no PartialType):
// its column is nullable and `null` means "clear it", so null must still
// pass — the neighbour of the title's null refusal, same DTO.
describe('UpdateTemplateDto — the description', () => {
  it('accepts null (clears it), a description, and refuses one too long', async () => {
    const errorsFor = async (description: unknown) =>
      (await validate(plainToInstance(UpdateTemplateDto, { description }))).map(
        (error) => Object.values(error.constraints ?? {}),
      )
    expect(await errorsFor(null)).toEqual([])
    expect(await errorsFor('d'.repeat(2000))).toEqual([])
    expect(await errorsFor('d'.repeat(2001))).toEqual([
      ['description must be shorter than or equal to 2000 characters'],
    ])
  })
})