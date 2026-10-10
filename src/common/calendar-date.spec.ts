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

import { addDays, isCalendarDate, utcToday } from './calendar-date'

describe('isCalendarDate', () => {
  it.each([
    '2026-10-09',
    '2028-02-29', // a leap year's 29 February
    '2026-12-31',
  ])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true)
  })

  it.each([
    // Right shape, impossible day: Date.UTC would quietly roll these over
    // (into 2 March, 1 March, 1 January 2027), which is how they're caught.
    ['30 February', '2026-02-30'],
    ['29 February of a non-leap year', '2026-02-29'],
    ['month 13', '2026-13-01'],
    ['day 0', '2026-10-00'],
    // Date.UTC reads years 0–99 as 1900–1999: only the year comparison
    // notices that "0026" came back as 1926.
    ['a year before 100', '0026-01-01'],
    // Wrong shape.
    ['a timestamp', '2026-10-09T10:00:00Z'],
    ['no leading zeros', '2026-1-9'],
    ['slashes', '2026/10/09'],
    ['an empty string', ''],
    ['surrounding spaces', ' 2026-10-09 '],
  ])('refuses %s', (_label, value) => {
    expect(isCalendarDate(value)).toBe(false)
  })

  it.each([
    ['a number', 20261009],
    ['null', null],
    ['undefined', undefined],
    ['a Date', new Date('2026-10-09')],
  ])('refuses %s (not a string)', (_label, value) => {
    expect(isCalendarDate(value)).toBe(false)
  })
})

describe('utcToday', () => {
  // The whole point: UTC's date, whatever the machine's own time zone is.
  // 23:30 in Montreal (UTC−4) on the 9th is already the 10th in UTC.
  it("gives UTC's date, not the local one", () => {
    expect(utcToday(new Date('2026-10-09T23:30:00-04:00'))).toBe('2026-10-10')
  })

  it('changes exactly at midnight UTC', () => {
    expect(utcToday(new Date('2026-10-09T23:59:59.999Z'))).toBe('2026-10-09')
    expect(utcToday(new Date('2026-10-10T00:00:00.000Z'))).toBe('2026-10-10')
  })
})

describe('addDays', () => {
  it.each([
    ['the next day', '2026-10-09', 1, '2026-10-10'],
    ['the day before', '2026-10-09', -1, '2026-10-08'],
    ['zero days', '2026-10-09', 0, '2026-10-09'],
    ['across a month', '2026-10-31', 1, '2026-11-01'],
    ['across a year, backwards', '2027-01-01', -1, '2026-12-31'],
    ['into a leap day', '2028-02-28', 1, '2028-02-29'],
    // Europe's clocks go back on 25 October 2026: a 25-hour LOCAL day.
    // Working in UTC, where every day is 24 hours, makes it irrelevant.
    ['across a daylight-saving change', '2026-10-24', 2, '2026-10-26'],
    ['several weeks', '2026-10-09', 28, '2026-11-06'],
  ])('%s', (_label, date, days, expected) => {
    expect(addDays(date, days)).toBe(expected)
  })
})