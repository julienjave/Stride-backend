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

import 'reflect-metadata'
import { validate } from 'class-validator'
import {
  IsAmendmentReason,
  amendmentReasonMessages,
  amendmentReasonProblem,
} from './amendment-reason'

// The rule shared by the medical file and range of motion. The two DTOs'
// own specs check it in place; this pins the rule itself, once.

const messages = amendmentReasonMessages('a record')

describe('amendmentReasonMessages', () => {
  it('names the record in the first sentence only', () => {
    expect(messages).toStrictEqual({
      withoutAmendment:
        'Only an amendment (a record with amendsId) has an amendment reason',
      needsReason: 'An amendment needs a reason',
      blank: "The amendment reason can't be blank",
      tooLong: 'The amendment reason can be at most 500 characters',
    })
  })
})

describe('amendmentReasonProblem', () => {
  it.each<[string, unknown, unknown, string | null]>([
    ['no amendment, no reason', undefined, undefined, null],
    ['amendsId null, reason null', null, null, null],
    [
      'a reason without an amendment',
      undefined,
      'Why',
      messages.withoutAmendment,
    ],
    ['an amendment without a reason', 3, undefined, messages.needsReason],
    ['an amendment with a non-string reason', 3, 42, messages.needsReason],
    ['a blank reason', 3, ' \t', messages.blank],
    ['a 501-character reason', 3, 'x'.repeat(501), messages.tooLong],
    ['a 500-character reason', 3, 'x'.repeat(500), null],
    // amendsId 0 is still an amendment (a number, not absent): the reason is due.
    ['amendsId 0', 0, undefined, messages.needsReason],
  ])('%s', (_label, amendsId, value, problem) => {
    expect(amendmentReasonProblem(amendsId, value, messages)).toBe(problem)
  })
})

describe('IsAmendmentReason', () => {
  class Dto {
    amendsId?: number | null
    @IsAmendmentReason(messages)
    amendmentReason?: string | null
  }

  it('reads amendsId from the same object, and reports the problem as its message', async () => {
    const dto = Object.assign(new Dto(), { amendsId: 3 })
    const [error] = await validate(dto)
    expect(error.constraints).toStrictEqual({
      amendmentReason: 'An amendment needs a reason',
    })
    expect(
      await validate(
        Object.assign(new Dto(), { amendsId: 3, amendmentReason: 'Typo' }),
      ),
    ).toEqual([])
  })
})
