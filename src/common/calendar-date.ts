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

// Calendar dates ("2026-10-12") as plain strings, the way Postgres `date`
// columns arrive through Drizzle — a DAY, not a moment. No time zone is
// involved anywhere in this file: a calendar date means the same day for
// everyone, which is exactly why program dates, schedule versions and a
// session's local date are stored this way (decisions §5, point 4).
//
// Why strings and not Date objects: a JavaScript Date is a MOMENT. Turning
// "2026-10-12" into one picks a time and a zone (new Date("2026-10-12") is
// midnight UTC — still Sunday the 11th in Montreal), which is the very
// confusion these columns exist to avoid. The one place below that uses a
// Date (addDays) does all its work in UTC, where a day is exactly a day.
//
// A useful property of the YYYY-MM-DD format: comparing two of these
// strings alphabetically gives the same answer as comparing the dates
// ("2026-09-30" < "2026-10-01" both ways), so `<`, `>=` and sorting work
// directly — as long as every value really has this exact shape, which is
// what isCalendarDate guarantees at the API's door.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const MS_PER_DAY = 24 * 60 * 60 * 1000

// --- HELPERS -----------------------------------------------------------------------------------------------

// True for a real calendar date written exactly as YYYY-MM-DD.
//
// The pattern alone isn't enough: "2026-02-30" has the right shape but
// isn't a day. Date.UTC() quietly "rolls over" impossible values (February
// 30th becomes March 2nd), so building the date and reading its parts back
// tells us whether it existed: if anything rolled over, the parts differ.
// (Strictly, the day comparison is implied by the month one — a day can't
// roll over without changing the month; a mutation check confirmed it.
// Comparing all three parts is kept because it reads as what it means.)
// The year comparison does matter: Date.UTC maps years 0–99 to 1900–1999.
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = CALENDAR_DATE_PATTERN.exec(value)
  if (!match) return false
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

// Today's date in UTC. The SERVER's notion of today: it doesn't know the
// user's time zone, so callers that compare it with a user's date must
// allow one day either way (every time zone's date is within one day of
// UTC's — from UTC−12 to UTC+14).
//
// `now` is a parameter so tests can pin the clock instead of depending on
// when they run.
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

// The calendar date `days` days after `date` (negative = before).
//
// Done in UTC on purpose: a UTC day is always exactly 24 hours. In a local
// time zone, the day clocks change is 23 or 25 hours long, and adding
// 24 hours can land on the same date or skip one.
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const start = Date.UTC(year, month - 1, day)
  return new Date(start + days * MS_PER_DAY).toISOString().slice(0, 10)
}

// The number of days from `from` to `to` (negative when `to` is earlier):
// daysBetween('2026-10-09', '2026-10-12') is 3. Exact, for the same reason
// as addDays: in UTC every day is 24 hours, so the division has no remainder.
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY
}

// The ISO weekday of a calendar date: 1 = Monday … 7 = Sunday — the
// numbering schedules use. getUTCDay() counts 0 = Sunday … 6 = Saturday, so
// Sunday is moved from 0 to 7. In UTC, so the answer is the date's own
// weekday whatever the machine's time zone.
export function isoWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

// Could `date` be "today" for someone, somewhere, at the moment `now`?
// Every time zone's date is UTC's date, the day before or the day after
// (UTC−12 to UTC+14), so those three days are the only possible answers.
// Used where a client sends its own today (a session's local date, the
// summary's ?today=) — the server can't know which of the three is right,
// but it can refuse anything else.
export function isPossibleToday(date: string, now: Date = new Date()): boolean {
  const today = utcToday(now)
  return date >= addDays(today, -1) && date <= addDays(today, 1)
}
