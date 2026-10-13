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

import { BadRequestException } from '@nestjs/common'
import { assertEndDateMovable } from './end-date'
import { addDays, utcToday } from '../common/calendar-date'

// Pinned far from the day this was written (start-date-move.spec.ts says
// why). UTC's today is the 15th, so the earliest allowed day is the 14th.
const now = new Date('2031-06-15T12:00:00Z')

describe('assertEndDateMovable', () => {
  it.each([
    ['open-ended (null)', null],
    ['a day in the future', '2031-09-01'],
    ['today in UTC', '2031-06-15'],
    // The boundary: yesterday in UTC is someone's today.
    ['yesterday in UTC', '2031-06-14'],
  ])('allows %s', (_label, newEnd) => {
    expect(() => assertEndDateMovable(newEnd, now)).not.toThrow()
  })

  it.each([
    // Just past the boundary — the case a "≤ instead of <" would get wrong.
    ['two days ago', '2031-06-13'],
    ['a month ago', '2031-05-15'],
  ])('refuses %s, pointing at complete / cancel', (_label, newEnd) => {
    expect(() => assertEndDateMovable(newEnd, now)).toThrow(
      new BadRequestException(
        "The end date can't be moved into the past: to end the program now, complete or cancel it",
      ),
    )
  })

  // The clock it is GIVEN decides: the same day is past for a later clock.
  // (Every case above uses one clock — a version that ignored `now` and
  // compared with a fixed date would pass them all.)
  it('follows the clock it is given', () => {
    const later = new Date('2040-03-10T12:00:00Z')
    expect(() => assertEndDateMovable('2035-01-01', later)).toThrow(
      BadRequestException,
    )
    expect(() => assertEndDateMovable('2040-03-09', later)).not.toThrow()
  })

  // And by default, the real one: around TODAY, not around a fixed date —
  // two days ago refused, yesterday allowed, whatever day the tests run.
  it('uses the real clock by default', () => {
    const today = utcToday()
    expect(() => assertEndDateMovable(addDays(today, -2))).toThrow(
      BadRequestException,
    )
    expect(() => assertEndDateMovable(addDays(today, -1))).not.toThrow()
  })
})