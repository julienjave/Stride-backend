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

import { ConflictException } from '@nestjs/common'
import {
  identityName,
  POSSIBLE_DUPLICATE_MESSAGE,
  possibleDuplicateConflict,
  sameName,
} from './possible-duplicates'

// The rule on its own; who is told what is proven through the API
// (test/possible-duplicates.e2e-spec.ts).
describe('identityName', () => {
  it.each([
    ['Zoë', 'zoe'],
    ['JEAN-LUC', 'jeanluc'],
    ['Jean Luc', 'jeanluc'],
    [" O'Brien ", 'obrien'],
    ['Ångström', 'angstrom'],
    ['Strauß', 'strauss'],
    ['Æsir', 'aesir'],
    ['Œuvre', 'oeuvre'],
    ['Søren', 'soren'],
    ['Łukasz', 'lukasz'],
    ['Đorđe', 'dorde'],
    ['Þóra', 'thora'],
    ['İsmail', 'ismail'],
    ['Iı', 'ii'],
    // Other scripts keep their letters (marks removed all the same).
    ['Μαρία', 'μαρια'],
    ['Мария', 'мария'],
    ['Louis XIV 2', 'louisxiv2'],
    // Compatibility forms (NFKD): the ligature "ﬁ" is two letters.
    ['ﬁona', 'fiona'],
  ])('reads %j as %j', (name, expected) => {
    expect(identityName(name)).toBe(expected)
  })
})

describe('sameName', () => {
  const marie = { firstName: 'Marie-Hélène', lastName: "D'Arcy" }

  it('matches the same name written differently', () => {
    expect(
      sameName(marie, { firstName: 'marie helene', lastName: 'DARCY' }),
    ).toBe(true)
  })

  it('matches the first and last names swapped', () => {
    expect(
      sameName(marie, { firstName: 'Darcy', lastName: 'Marie Hélène' }),
    ).toBe(true)
  })

  // Each half must agree: neither the first name alone…
  it('does not match when only the first names agree', () => {
    expect(
      sameName(marie, { firstName: 'Marie-Hélène', lastName: 'Dupont' }),
    ).toBe(false)
  })

  // …nor the last name alone.
  it('does not match when only the last names agree', () => {
    expect(sameName(marie, { firstName: 'Anne', lastName: "D'Arcy" })).toBe(
      false,
    )
  })

  // A swap needs BOTH halves crossed: one crossed half isn't a swap.
  it('does not match half a swap', () => {
    expect(sameName(marie, { firstName: 'Darcy', lastName: 'Dupont' })).toBe(
      false,
    )
    expect(
      sameName(marie, { firstName: 'Anne', lastName: 'Marie Hélène' }),
    ).toBe(false)
  })

  // Names with no letter at all say nothing: no warning rather than a false
  // one — whichever half is empty.
  it('never matches a name that normalises to nothing', () => {
    expect(
      sameName(
        { firstName: '—', lastName: 'Fox' },
        { firstName: '…', lastName: 'Fox' },
      ),
    ).toBe(false)
    expect(
      sameName(
        { firstName: 'Ann', lastName: '🙂' },
        { firstName: 'Ann', lastName: '🙃' },
      ),
    ).toBe(false)
  })
})

describe('possibleDuplicateConflict', () => {
  // The body the exception filter answers: the message, the reason a screen
  // reads, and what this requester may be shown — nothing else.
  it('is a 409 carrying the reason and what may be shown', () => {
    const error = possibleDuplicateConflict({
      inYourClinics: [],
      elsewhere: true,
    })

    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getStatus()).toBe(409)
    expect(error.getResponse()).toStrictEqual({
      message: POSSIBLE_DUPLICATE_MESSAGE,
      reason: 'possible_duplicate',
      inYourClinics: [],
      elsewhere: true,
    })
    expect(POSSIBLE_DUPLICATE_MESSAGE).toBe(
      'A patient with this name and date of birth may already be in Stride.',
    )
  })
})
