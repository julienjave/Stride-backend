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

import { isInstant } from './is-instant'

describe('isInstant', () => {
  it.each([
    '2031-03-10T00:00:00Z', // UTC
    '2031-03-10T00:00:00.000Z', // what toISOString() writes
    '2031-03-10T23:59:59.5+01:00', // an offset ahead of UTC
    '2031-03-10T00:00:00-04:00', // and one behind
    '2032-02-29T12:00:00Z', // a leap day
  ])('accepts %s', (value) => {
    expect(isInstant(value)).toBe(true)
  })

  it.each([
    ['a day without a time', '2031-03-10'],
    ['a time without its offset', '2031-03-10T00:00:00'],
    ['a time without seconds', '2031-03-10T00:00Z'],
    ['a day that does not exist', '2031-02-30T00:00:00Z'],
    ['February 29th of a common year', '2031-02-29T00:00:00Z'],
    ['hour 24', '2031-03-10T24:00:00Z'],
    ['minute 60', '2031-03-10T00:60:00Z'],
    ['second 60', '2031-03-10T00:00:60Z'],
    ['an offset of 24 hours', '2031-03-10T00:00:00+24:00'],
    ['an offset without its colon', '2031-03-10T00:00:00+0100'],
    ['a lowercase z', '2031-03-10T00:00:00z'],
    ['a space instead of the T', '2031-03-10 00:00:00Z'],
    ['more than milliseconds', '2031-03-10T00:00:00.0000Z'],
    ['text after it', '2031-03-10T00:00:00Z and more'],
    ['text before it', 'on 2031-03-10T00:00:00Z'],
  ])('refuses %s', (_label, value) => {
    expect(isInstant(value)).toBe(false)
  })

  it('refuses anything but a string', () => {
    expect(isInstant(Date.UTC(2031, 2, 10))).toBe(false)
    expect(isInstant(new Date(Date.UTC(2031, 2, 10)))).toBe(false)
    expect(isInstant(undefined)).toBe(false)
  })
})
