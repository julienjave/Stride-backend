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
import { CreateSessionDto } from './create-session.dto'
import { SkipSessionDto } from './skip-session.dto'
import { CompleteSessionDto } from './complete-session.dto'
import { StopSessionDto } from './stop-session.dto'
import { UpdateSessionDto } from './update-session.dto'
import { UpdateSessionExerciseDto } from './update-session-exercise.dto'

// The session DTOs' value rules (session-fields.ts), run through the real
// class-validator engine. The limits and messages are written out HERE, not
// read from session-fields.ts, so a changed rule fails until this spec
// agrees (the lesson of the description rules, D-1).

type Dto = new () => object

async function messages(dto: Dto, body: object) {
  const errors = await validate(plainToInstance(dto, body))
  return errors.flatMap((error) => Object.values(error.constraints ?? {}))
}

// A minimal valid body for each DTO, for the fields under test to join.
const START = { assignedProgramId: 5, localDate: '2031-03-12' }
const SKIP = { assignedProgramId: 5, localDate: '2031-03-12', reason: 'pain' }
const STOP = { reason: 'pain' }

// --- The 0–10 scores (pain before / after, mobility after) -----------------

describe.each([
  ['CreateSessionDto', CreateSessionDto, START, 'painBefore'],
  ['SkipSessionDto', SkipSessionDto, SKIP, 'painBefore'],
  ['UpdateSessionDto', UpdateSessionDto, {}, 'painBefore'],
  ['CompleteSessionDto', CompleteSessionDto, {}, 'painAfter'],
  ['CompleteSessionDto', CompleteSessionDto, {}, 'mobilityAfter'],
  ['StopSessionDto', StopSessionDto, STOP, 'painAfter'],
  ['StopSessionDto', StopSessionDto, STOP, 'mobilityAfter'],
] as const)('%s — %s, a 0–10 score', (_name, dto, base, field) => {
  it.each([0, 10])('accepts %s', async (value) => {
    expect(await messages(dto, { ...base, [field]: value })).toEqual([])
  })

  it.each([
    [-1, `${field} must not be less than 0`],
    [11, `${field} must not be greater than 10`],
    [4.5, `${field} must be an integer number`],
  ])('refuses %s', async (value, message) => {
    expect(await messages(dto, { ...base, [field]: value })).toEqual([message])
  })

  // Optional, never blocking (decisions §6): absent, or null — "not
  // answered" (or, on the PATCH, "clear it").
  it.each([undefined, null])('accepts %s', async (value) => {
    expect(await messages(dto, { ...base, [field]: value })).toEqual([])
  })
})

// --- The reason (stop and skip) ---------------------------------------------

describe.each([
  ['SkipSessionDto', SkipSessionDto, SKIP],
  ['StopSessionDto', StopSessionDto, STOP],
] as const)('%s — reason', (_name, dto, base) => {
  const REASON_MESSAGE = 'reason must be one of: pain, illness, no_time, other'

  it.each(['pain', 'illness', 'no_time', 'other'])(
    "accepts the patient's reason %s",
    async (reason) => {
      expect(await messages(dto, { ...base, reason })).toEqual([])
    },
  )

  // The app's own two are never a client's to send.
  it.each(['not_finished_in_time', 'program_closed', 'tired'])(
    'refuses %s',
    async (reason) => {
      expect(await messages(dto, { ...base, reason })).toEqual([REASON_MESSAGE])
    },
  )

  it.each([undefined, null])('requires one (%s refused)', async (reason) => {
    expect(await messages(dto, { ...base, reason })).toEqual([REASON_MESSAGE])
  })
})

// --- The note (stop and skip) -----------------------------------------------

describe.each([
  ['SkipSessionDto', SkipSessionDto, SKIP],
  ['StopSessionDto', StopSessionDto, STOP],
] as const)('%s — note', (_name, dto, base) => {
  it('accepts 500 characters', async () => {
    expect(await messages(dto, { ...base, note: 'a'.repeat(500) })).toEqual([])
  })

  it('refuses 501', async () => {
    expect(await messages(dto, { ...base, note: 'a'.repeat(501) })).toEqual([
      'note must be shorter than or equal to 500 characters',
    ])
  })

  // "No note" is spelled one way: leave it out (or null).
  it.each(['', '   ', '\t\n'])('refuses a blank note (%j)', async (note) => {
    expect(await messages(dto, { ...base, note })).toEqual([
      "The note can't be blank: leave it out instead",
    ])
  })

  it.each([undefined, null])('accepts no note (%s)', async (note) => {
    expect(await messages(dto, { ...base, note })).toEqual([])
  })
})

// --- Feedback (an exercise's, the whole session's) ---------------------------
// Refused when blank since 2026-10-16 — the end note's rule, its own noun.

describe.each([
  ['UpdateSessionExerciseDto', UpdateSessionExerciseDto, 'feedback'],
  ['CompleteSessionDto', CompleteSessionDto, 'sessionFeedback'],
] as const)('%s — %s', (_name, dto, field) => {
  it('accepts 2,000 characters', async () => {
    expect(await messages(dto, { [field]: 'a'.repeat(2000) })).toEqual([])
  })

  it('refuses 2,001', async () => {
    expect(await messages(dto, { [field]: 'a'.repeat(2001) })).toEqual([
      `${field} must be shorter than or equal to 2000 characters`,
    ])
  })

  it.each(['', '   ', '\t\n'])('refuses blank feedback (%j)', async (value) => {
    expect(await messages(dto, { [field]: value })).toEqual([
      "The feedback can't be blank: leave it out instead",
    ])
  })

  it('accepts words with spaces around them', async () => {
    expect(await messages(dto, { [field]: '  felt easy  ' })).toEqual([])
  })

  it.each([undefined, null])('accepts no feedback (%s)', async (value) => {
    expect(await messages(dto, { [field]: value })).toEqual([])
  })
})
