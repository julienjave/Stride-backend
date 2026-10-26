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

import { isTimeZone } from './is-time-zone'

describe('isTimeZone', () => {
  it.each([
    'Europe/Paris',
    'America/Montreal',
    'America/Argentina/ComodRivadavia', // the longest name
    'UTC',
    'Asia/Calcutta', // an older alias some browsers still send
  ])('accepts %s', (value) => {
    expect(isTimeZone(value)).toBe(true)
  })

  it.each([
    ['an unknown place', 'Europe/Atlantis'],
    ['an empty string', ''],
    ['an offset', '+02:00'],
    ['a negative offset', '-04:00'],
  ])('refuses %s', (_label, value) => {
    expect(isTimeZone(value)).toBe(false)
  })

  it('refuses anything but a string', () => {
    expect(isTimeZone(undefined)).toBe(false)
    expect(isTimeZone(2)).toBe(false)
  })
})
