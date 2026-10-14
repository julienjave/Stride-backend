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
import { UpdateSessionDto } from '../../sessions/dto/update-session.dto'
import { UpdateSessionExerciseDto } from '../../sessions/dto/update-session-exercise.dto'
import { UpdateTemplateExerciseDto } from '../../programs/dto/update-template-exercise.dto'

// The null trap (is-present.ts), for the PATCH fields found still open on
// 2026-10-14 — checked live first: each `null` here was a 500 from Postgres.
// A NOT NULL column's field must refuse `null` (a 400), while "not sent"
// stays "unchanged". Its NEIGHBOURS — the nullable fields of the same DTOs —
// must keep accepting `null`, which means "clear it": a fix that refused
// every `null` would pass the first half and break those.

// "a class whose instances are objects" — plainToInstance can't take a
// union of constructors (TS2769).
type Dto = new () => object

async function propertiesWithErrors(dto: Dto, body: object) {
  const errors = await validate(plainToInstance(dto, body))
  return errors.map((error) => error.property)
}

describe.each([
  ['UpdateSessionDto', UpdateSessionDto, 'status', 'completed'],
  ['UpdateSessionExerciseDto', UpdateSessionExerciseDto, 'completed', true],
  ['UpdateTemplateExerciseDto', UpdateTemplateExerciseDto, 'sortOrder', 2],
] as const)('%s — %s, a NOT NULL column', (_name, dto, field, valid) => {
  it('refuses null', async () => {
    expect(await propertiesWithErrors(dto as Dto, { [field]: null })).toEqual([
      field,
    ])
  })

  it('accepts the field not sent (unchanged)', async () => {
    expect(await propertiesWithErrors(dto as Dto, {})).toEqual([])
  })

  it('accepts a valid value', async () => {
    expect(await propertiesWithErrors(dto as Dto, { [field]: valid })).toEqual(
      [],
    )
  })
})

describe.each([
  ['UpdateSessionDto', UpdateSessionDto, 'totalDurationInSeconds'],
  ['UpdateSessionDto', UpdateSessionDto, 'sessionFeedback'],
  [
    'UpdateSessionExerciseDto',
    UpdateSessionExerciseDto,
    'durationActualInSeconds',
  ],
  ['UpdateSessionExerciseDto', UpdateSessionExerciseDto, 'difficultyRating'],
  ['UpdateSessionExerciseDto', UpdateSessionExerciseDto, 'feedback'],
  ['UpdateTemplateExerciseDto', UpdateTemplateExerciseDto, 'sets'],
  ['UpdateTemplateExerciseDto', UpdateTemplateExerciseDto, 'notes'],
] as const)('%s — %s, a nullable column', (_name, dto, field) => {
  it('still accepts null (clears it)', async () => {
    expect(await propertiesWithErrors(dto as Dto, { [field]: null })).toEqual(
      [],
    )
  })
})
