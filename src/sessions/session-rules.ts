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

import { BadRequestException, ConflictException } from '@nestjs/common'
import { isoWeekday, isPossibleToday } from '../common/calendar-date'
import {
  versionOn,
  type SwapVersion,
} from '../assigned-programs/schedule/swap-rules'
import type { ScheduleSummary } from '../assigned-programs/schedule/schedule-summary'
import type { PatientEndReason } from '../database/schema'

// A SESSION'S LIFE (Phase 4 step 1, decided with the person 2026-10-15):
//
//     start ──► in_progress ──► completed     (Finish: counts for the schedule)
//                    │
//                    └────────► incomplete    (Stop, with a reason — or closed
//                                              by the app: a newer session
//                                              started, the program closed)
//     skip ───────────────────► skipped       (never started, with a reason)
//
// Only an OPEN (in_progress) session changes; the three others are FINAL.
// Finality is what makes the record trustworthy: the schedule summary judges
// the patient's adherence from completed sessions, and the design never
// rewrites judged history (schedule versions, care-team links, retired
// exercises all follow the same idea).
//
// This file holds those rules as plain functions — values in, an answer or
// an exception out — so every one is a unit test with no database. The
// service calls them; migration 0038's triggers say the same in SQL, for any
// query that doesn't go through the service.

// --- MESSAGES ----------------------------------------------------------------------------------------------

// Shared with HttpExceptionFilter, which gives the database's refusal of the
// same thing (migration 0038) these words too.
export const SESSION_FINISHED_MESSAGE =
  'This session is finished, so it can no longer change'

// Starting while a session of the same program is open TODAY (the unique
// index allows one open session per program; an open one from an earlier
// day is closed instead — see SessionsService.create).
export const SESSION_OPEN_TODAY_MESSAGE =
  'A session of this program is already in progress today: finish it or stop it first'

// Skipping a day that already has a session — started, done or skipped.
export const DAY_HAS_SESSION_MESSAGE =
  'Today already has a session for this program, so it can no longer be skipped'

// Starting a session on a day that already has a COMPLETED one of the same
// program (decided 2026-10-16, with the person: blocked, not just left
// uncounted). It says what happened and why — the patient may well have
// meant well. Shared with HttpExceptionFilter, which gives the database's
// refusal of the same thing (migration 0041) these words too.
export const ONE_SESSION_A_DAY_MESSAGE =
  "You've already completed a session of this program today. Only one session a day counts, because sessions too close together can be too much for your body: do the next one on another day"

// --- THE RULES ---------------------------------------------------------------------------------------------

// Only an open session changes (409: the request is fine, the session it
// targets can't change any more).
export function assertSessionOpen(session: { status: string }) {
  if (session.status !== 'in_progress') {
    throw new ConflictException(SESSION_FINISHED_MESSAGE)
  }
}

// Completing happens on the session's own day. The schedule files a session
// under its local date — the day it STARTED — so finishing it days later
// would turn that day into "done" after the fact: a session started on a
// missed Monday and completed on Thursday would make Monday's miss vanish, a
// late make-up nobody allowed. "Its own day" is tested the way starting
// tests it (isPossibleToday: UTC's date, the day before or the day after —
// the server doesn't know the patient's time zone), so this opens no gap the
// start didn't already have. Stopping has no such limit: a stopped session
// counts for nothing. `now` is the DATABASE's clock (read in the same
// transaction), so this check and the trigger's agree exactly.
export function assertCompletableOnItsDay(localDate: string, now: Date) {
  if (!isPossibleToday(localDate, now)) {
    throw new ConflictException(
      `This session was started on ${localDate} and can only be completed on that day: stop it instead`,
    )
  }
}

// The duration the patient's app reports — its own timer, which can leave out
// a pause — can't be LONGER than the time since the session started: that
// would be a number the server knows to be false. Absent or null: nothing to
// check.
export function assertDurationPossible(
  totalDurationInSeconds: number | null | undefined,
  startedAt: Date,
  now: Date,
) {
  if (totalDurationInSeconds == null) return
  const elapsed = Math.floor((now.getTime() - startedAt.getTime()) / 1000)
  if (totalDurationInSeconds > elapsed) {
    throw new BadRequestException(
      `totalDurationInSeconds can't be longer than the time since the session started (${elapsed} seconds)`,
    )
  }
}

// A skip records a pain level only when pain is why the patient skipped
// (decided 2026-10-15): for any other reason, "how much does it hurt" isn't
// what the skip is about. The CHECK sessions_skip_records_no_work says the
// same in the database.
export function assertSkipPain(
  reason: PatientEndReason,
  painBefore: number | null | undefined,
) {
  if (painBefore != null && reason !== 'pain') {
    throw new BadRequestException(
      'A pain level is recorded with a skip only when pain is the reason',
    )
  }
}

// Which workout a skip of `localDate` skips — or a 400 saying why there is
// nothing to skip that day. A skip says "I won't do TODAY's scheduled
// session", so only a day that HAS one can be skipped (decided 2026-10-15):
// a scheduled day of a specific-days version in force on it. Under "N times
// a week" no particular day is due, and under a pause nothing is — so
// nothing to skip. The workout is the day's, never asked for: a skip of the
// wrong workout couldn't mean anything. Checked in the order a person would
// think of it: is the program running that day → what kind of schedule →
// is that day scheduled.
export function skippedWorkoutId(input: {
  program: { startDate: string; endDate: string | null }
  versions: SwapVersion[]
  localDate: string
}): number {
  const { program, versions, localDate } = input
  if (localDate < program.startDate) {
    throw new BadRequestException(
      `The program starts on ${program.startDate}: there is nothing to skip before then`,
    )
  }
  if (program.endDate !== null && localDate > program.endDate) {
    throw new BadRequestException(
      `The program ended on ${program.endDate}: there is nothing left to skip`,
    )
  }
  const version = versionOn(versions, localDate)
  if (version?.type === 'paused') {
    throw new BadRequestException(
      'The program is paused today: nothing is due, so there is nothing to skip',
    )
  }
  if (version?.type === 'times_per_week') {
    throw new BadRequestException(
      'This program has no set days: nothing is due on a given day, so there is nothing to skip',
    )
  }
  const day = version?.days.find((d) => d.weekday === isoWeekday(localDate))
  if (!day) {
    throw new BadRequestException(
      'Nothing is scheduled today, so there is nothing to skip',
    )
  }
  return day.workoutId
}

// A LATE MAKE-UP (decided 2026-10-16): may the patient start, today, a
// session making up `countsFor` late? Asked of the program's SUMMARY for
// today — the same answer the home and the start page read — so what the
// screens offer and what this accepts can't disagree. sessionForOtherDay
// (swap-rules.ts) has already checked the rest: `countsFor` is an earlier
// scheduled day of the program, the workout is its own, and today isn't a
// scheduled day. Checked in the order a person would think of it: does the
// day still need making up at all → may it be made up late here → is it
// too late → can it be today.
export function assertLateMakeUpAllowed(
  summary: Pick<ScheduleSummary, 'days' | 'lateMakeUps'>,
  countsFor: string,
  lateMakeUpDays: number | null,
) {
  // (Always found: an earlier scheduled day of the program is among the
  // days the summary covers — from the start date up to today at least.)
  const day = summary.days.find((d) => d.date === countsFor)
  // Its window is still open: an ordinary make-up, which needs no link —
  // answered first, whatever the setting, so a patient on time is told
  // simply to start.
  if (day?.state === 'due') {
    throw new BadRequestException(
      `${countsFor} can still be made up on time: start the session without countsFor, before the next scheduled day`,
    )
  }
  if (day?.state !== 'missed') {
    throw new ConflictException(
      `${countsFor} is already done: there is nothing to make up`,
    )
  }
  if (lateMakeUpDays === null) {
    throw new BadRequestException(
      'Late make-ups are turned off for this program: ask your practitioner',
    )
  }
  const { blockedToday } = summary.lateMakeUps
  // Before "too late": on a day that isn't free, no missed day may be
  // listed at all (the summary looks for a free day to do it on), and
  // "too late" would be the wrong reason.
  if (blockedToday === 'not_a_free_day') {
    throw new BadRequestException(
      'A late make-up is done on a day with nothing scheduled: not during a pause, nor on a weekly count',
    )
  }
  if (!summary.lateMakeUps.days.some((late) => late.forDay === countsFor)) {
    throw new BadRequestException(
      `${countsFor} is more than ${lateMakeUpDays} days ago: it can no longer be made up`,
    )
  }
  if (blockedToday === 'session_done_today') {
    throw new ConflictException(ONE_SESSION_A_DAY_MESSAGE)
  }
  if (blockedToday === 'catch_up_first') {
    // The day that can still be made up on time. (Only an earlier day can
    // be 'due' here: a due day TODAY would make today a scheduled day,
    // answered above as not_a_free_day.)
    const due = summary.days.find((d) => d.state === 'due')
    throw new BadRequestException(
      `Catch up ${due?.date} first: it can still be made up on time, before the next scheduled day`,
    )
  }
}
