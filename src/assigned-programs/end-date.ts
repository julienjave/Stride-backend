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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { BadRequestException } from '@nestjs/common'
import { addDays, utcToday } from '../common/calendar-date'

// Moving a program's END date (step 3b-0, decided 2026-10-13) — the twin of
// start-date-move.ts's rule for the start. A pure function: the new end date
// and a clock in, a 400 or nothing out.

// --- RULE --------------------------------------------------------------------------------------------------

// May the end date become `newEnd`? (Called only when it really changes.)
//
// - `null` — open-ended from now on: always. It only adds days to come.
// - A day from yesterday in UTC on — the usual one day of slack, since
//   yesterday in UTC is someone's today (calendar-date.ts): yes. Later than
//   before extends the program; earlier SHORTENS it, cutting off days that
//   haven't come yet — schedule versions planned after it simply never apply
//   (decisions §5, step 1b), and a program week cut short gets its target
//   scaled. That's a legitimate change of plan.
// - An earlier day: refused. The days between it and today have been
//   JUDGED — done, made up, missed — and moving the end before them would
//   make them vanish from the summary, misses included: the same rewriting
//   of history the start date's rule forbids. Ending a program NOW is what
//   "Complete" and "Cancel" do, with their own rule for the end date
//   (closingEndDate — yesterday, or today if a session was done today) and
//   their own audit entry.
//
// Checked whatever the program's start: a program that hasn't started has a
// start from yesterday on (start-date-move.ts) and an end after its start, so
// the rule can't refuse anything new for it.
export function assertEndDateMovable(
  newEnd: string | null,
  now: Date = new Date(),
) {
  if (newEnd !== null && newEnd < addDays(utcToday(now), -1)) {
    throw new BadRequestException(
      "The end date can't be moved into the past: to end the program now, complete or cancel it",
    )
  }
}
