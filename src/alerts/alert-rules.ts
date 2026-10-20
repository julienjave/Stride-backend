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

import { addDays } from '../common/calendar-date'
import type {
  CountedWeek,
  Pause,
  ScheduledDay,
} from '../assigned-programs/schedule/schedule-summary'

// The practitioner's To-do (decided with the person 2026-10-19, decisions
// §3): WHICH programs and sessions need a look. Pure, like the schedule
// module it reads: plain values in, plain values out — no database, no
// clock (`today` is a parameter) — so every threshold is tested with tables
// of plain cases (alert-rules.spec.ts), and AlertsService only fetches.
//
// Two families:
//   - ATTENDANCE, one per program: sessions missed in a row, or no activity
//     for days. It clears ITSELF when the patient acts (a make-up, a new
//     session) — nothing to mark, the data changed.
//   - A SESSION TO REVIEW: pain, a hard exercise, words from the patient. A
//     finished session never changes, so it would stay forever — hence the
//     review (session_reviews, one per practitioner) and a 14-day window.

// --- THRESHOLDS --------------------------------------------------------------------------------------------

// Every number the rules use, in ONE place — proposed and accepted
// 2026-10-19. Constants for now; per-practitioner settings would be their
// own item (deferred-improvements.md). `as const` makes each a literal type,
// read-only — nothing can change a threshold at run time by accident.
export const ALERT_THRESHOLDS = {
  // Scheduled days missed one after another (specific-days schedules) …
  missedDaysInARow: 3,
  // … or program weeks ended below target (N per week).
  missedWeeksInARow: 2,
  // Days without any session — started, finished, stopped or skipped.
  inactiveDays: 7,
  // Pain after a session, on the 0–10 scale (0 = no pain).
  painAfterHigh: 7,
  // A rise from before to after the same session.
  painRise: 3,
  // Difficulty of one exercise, on the 1–10 scale.
  hardExercise: 8,
  // How far back a session can still be a to-do (today included): 14 days.
  reviewWindowDays: 14,
  // How long a reviewed attendance alert stays off the reviewer's list when
  // nothing changes — then it comes back as a reminder (2026-10-19).
  attendanceReminderDays: 14,
} as const

// --- ATTENDANCE --------------------------------------------------------------------------------------------

// A run of misses, ending with the most recent judged day or week.
export interface MissedRun {
  // How many scheduled days and program weeks the run holds (one of them is
  // usually 0: a run mixes both only across a change of schedule type).
  days: number
  weeks: number
  // Its first missed day — the day itself, or the first day of a week.
  since: string
}

// One judged outcome: a scheduled day or a program week the module has
// already decided (met or missed), on one time line.
interface Outcome {
  end: string
  start: string
  missed: boolean
  unit: 'day' | 'week'
}

// The misses in a row at the END of the program's history — the patient's
// current streak, not their worst ever: an old streak already broken by a
// session is history, not a to-do.
//
// Only what the schedule module has JUDGED counts. A day still 'due' (its
// make-up window is open) or 'upcoming' is not a miss yet, and is skipped —
// never a break either: the patient might still make it up. A week still
// 'in_progress' or 'upcoming', the same. Everything else breaks the run:
// done, made up (on time or late), done early, swapped, a week met.
//
// Days and weeks are put on ONE time line (by the day each ends), because a
// program can change from specific days to N a week; sorting by END makes a
// week sit after the days that came before its last day.
export function missedRun(
  days: Pick<ScheduledDay, 'date' | 'state'>[],
  weeks: Pick<CountedWeek, 'start' | 'end' | 'state'>[],
): MissedRun | null {
  const outcomes: Outcome[] = [
    ...days
      .filter((day) => day.state !== 'due' && day.state !== 'upcoming')
      .map((day) => ({
        end: day.date,
        start: day.date,
        missed: day.state === 'missed',
        unit: 'day' as const,
      })),
    ...weeks
      .filter((week) => week.state === 'met' || week.state === 'missed')
      .map((week) => ({
        end: week.end,
        start: week.start,
        missed: week.state === 'missed',
        unit: 'week' as const,
      })),
  ]
  // Newest first. Dates are 'YYYY-MM-DD', so comparing the TEXT orders them
  // by date — the format was chosen for that (a fixed width, biggest unit
  // first). localeCompare, not `<`, because sort() wants a number.
  outcomes.sort((a, b) => b.end.localeCompare(a.end))

  // Walk back in time while the outcomes are misses; the first one that
  // isn't ends the run. Each miss met is earlier than the last, so `since`
  // ends on the run's first day.
  let missedDays = 0
  let missedWeeks = 0
  let since: string | null = null
  for (const outcome of outcomes) {
    if (!outcome.missed) break
    if (outcome.unit === 'day') missedDays++
    else missedWeeks++
    since = outcome.start
  }
  return since === null ? null : { days: missedDays, weeks: missedWeeks, since }
}

// Whether a run is long enough to be a to-do: either count reaching its
// threshold. (A mixed run — 2 days then 1 week — reaches neither; the
// inactivity rule is there for a patient who has really stopped.)
export function isLongRun(run: MissedRun | null): run is MissedRun {
  return (
    run !== null &&
    (run.days >= ALERT_THRESHOLDS.missedDaysInARow ||
      run.weeks >= ALERT_THRESHOLDS.missedWeeksInARow)
  )
}

// How long since the patient last did anything in this program.
export interface Inactivity {
  // Program days without a session, paused days not counted.
  days: number
  // The day of the last session of any kind — null when there was none
  // since the program started.
  lastSessionDate: string | null
}

// The days with no session of ANY status — a skip and a stop are the
// patient acting too ("not today, I'm ill" is contact, not silence) — from
// the day after the last session (or from the start date) up to YESTERDAY:
// today isn't over, and a patient who trains every evening is not inactive
// at 9 am. Paused days don't count: the practitioner chose them.
export function inactivity(input: {
  startDate: string
  endDate: string | null
  today: string
  pauses: Pause[]
  // The days of the program's sessions, any status, in any order.
  sessionDates: string[]
}): Inactivity {
  const last = input.sessionDates.reduce<string | null>(
    (latest, date) => (latest === null || date > latest ? date : latest),
    null,
  )
  // The first day that counts: after the last session, never before the
  // program's start (a session dated before it is impossible today, but a
  // pure function answers any input).
  let first = last === null ? input.startDate : addDays(last, 1)
  if (first < input.startDate) first = input.startDate
  // The last day that counts: yesterday, or the end date if earlier.
  let lastCounted = addDays(input.today, -1)
  if (input.endDate !== null && input.endDate < lastCounted) {
    lastCounted = input.endDate
  }

  let days = 0
  for (let day = first; day <= lastCounted; day = addDays(day, 1)) {
    const paused = input.pauses.some(
      (pause) => pause.from <= day && (pause.to === null || day <= pause.to),
    )
    if (!paused) days++
  }
  return { days, lastSessionDate: last }
}

// Whether a program is RUNNING today: started, not past its end date, and
// not paused today. Attendance alerts only make sense then: before the start
// nothing was expected; after the end the program is waiting to be closed
// (its page says so); and a pause is the practitioner's own decision — often
// the very answer to a patient missing sessions, so it silences the alert.
export function isRunning(input: {
  startDate: string
  endDate: string | null
  today: string
  pauses: Pause[]
}): boolean {
  if (input.today < input.startDate) return false
  if (input.endDate !== null && input.today > input.endDate) return false
  return !input.pauses.some(
    (pause) =>
      pause.from <= input.today &&
      (pause.to === null || input.today <= pause.to),
  )
}

// The attendance part of a program's to-do: each fact when it passes its
// threshold, or null when neither does (no alert).
export interface AttendanceFacts {
  missedInARow: MissedRun | null
  inactive: Inactivity | null
}

export function attendanceFacts(input: {
  startDate: string
  endDate: string | null
  today: string
  pauses: Pause[]
  days: Pick<ScheduledDay, 'date' | 'state'>[]
  weeks: Pick<CountedWeek, 'start' | 'end' | 'state'>[]
  sessionDates: string[]
}): AttendanceFacts | null {
  if (!isRunning(input)) return null
  const run = missedRun(input.days, input.weeks)
  const idle = inactivity(input)
  const facts: AttendanceFacts = {
    missedInARow: isLongRun(run) ? run : null,
    inactive: idle.days >= ALERT_THRESHOLDS.inactiveDays ? idle : null,
  }
  return facts.missedInARow === null && facts.inactive === null ? null : facts
}

// --- REVIEWING AN ATTENDANCE ALERT (added 2026-10-19) -----------------------------------------------------

// What identifies an attendance alert's SITUATION: the first day of each
// fact — the run of misses (`missedSince`) and the stretch without a session
// (`inactiveSince`) — or null when that fact isn't part of it. Two alerts
// with the same keys describe the same situation, however much longer it
// has lasted since (a run of 3 that became 5 still started on the same
// day); a different key is a NEW situation (the patient came back, then
// stopped again).
export interface AttendanceKeys {
  missedSince: string | null
  inactiveSince: string | null
}

export function attendanceKeys(
  facts: AttendanceFacts,
  startDate: string,
): AttendanceKeys {
  let inactiveSince: string | null = null
  if (facts.inactive !== null) {
    // The first day counted by `inactivity`: the day after the last
    // session, or the start date — never before the start.
    const after =
      facts.inactive.lastSessionDate === null
        ? startDate
        : addDays(facts.inactive.lastSessionDate, 1)
    inactiveSince = after < startDate ? startDate : after
  }
  return { missedSince: facts.missedInARow?.since ?? null, inactiveSince }
}

// A practitioner's latest review of a program's alert: the keys it saw,
// and when (the database's moment — migration 0046).
export interface AttendanceReview extends AttendanceKeys {
  reviewedAt: Date
}

// Whether the alert stays OFF this practitioner's list (decided with the
// person 2026-10-19: "until it changes, and back after 14 days anyway"):
//   - only their LATEST review counts — it saw the situation most recently;
//   - each fact the alert has NOW must be one that review saw (the same
//     key). A fact that has since gone away is fine (the patient skipped:
//     no more inactivity, the run still the same — still reviewed); a fact
//     that is NEW, or a new start for one, brings the alert back;
//   - and the review is less than 14 days old — a FIXED duration (14 × 24
//     hours from the review's moment, the lesson of the invitations'
//     lifetime), so the reminder never depends on a time zone.
// `now` is a parameter: the rule never reads a clock (tests pin it).
export function isAttendanceReviewed(
  keys: AttendanceKeys,
  review: AttendanceReview | null,
  now: Date,
): boolean {
  if (review === null) return false
  const reminderAt =
    review.reviewedAt.getTime() +
    ALERT_THRESHOLDS.attendanceReminderDays * 24 * 60 * 60 * 1000
  if (now.getTime() >= reminderAt) return false
  const seen = (current: string | null, reviewed: string | null) =>
    current === null || current === reviewed
  return (
    seen(keys.missedSince, review.missedSince) &&
    seen(keys.inactiveSince, review.inactiveSince)
  )
}

// --- SESSIONS TO REVIEW ------------------------------------------------------------------------------------

// Why a session is on the list. Several can apply; they are listed in this
// order (the most clinical first), each at most once.
export type SessionAlertReason =
  | 'ended_for_pain'
  | 'pain_high'
  | 'pain_rise'
  | 'hard_exercise'
  | 'patient_note'

// What the rules read of a session and its checklist.
export interface ReviewableSession {
  status: 'in_progress' | 'completed' | 'incomplete' | 'skipped'
  endReason: string | null
  painBefore: number | null
  painAfter: number | null
  sessionFeedback: string | null
  endNote: string | null
  exercises: {
    name: string
    difficultyRating: number | null
    feedback: string | null
  }[]
}

export interface SessionReview {
  reasons: SessionAlertReason[]
  // The exercises rated hard, in checklist order — named on the row, so the
  // practitioner knows which one before opening the session.
  hardExercises: { name: string; rating: number }[]
}

// Why this session needs a look — or null when it doesn't. A session still
// IN PROGRESS never does: nothing about it is final (the patient may yet
// rate an exercise, or stop for pain), and it can't be marked reviewed.
//
// The PATIENT's words count as a reason (the person's choice, 2026-10-19):
// a note on an exercise, the session's feedback, or the note given when
// stopping or skipping. Only THAT a note exists reaches the alert, never its
// text — the list shows what the row needs (minimum necessary, HIPAA's
// standard for uses of health data); the session page shows the words.
export function sessionReview(
  session: ReviewableSession,
): SessionReview | null {
  if (session.status === 'in_progress') return null
  const { painBefore, painAfter } = session
  const hardExercises = session.exercises.flatMap((exercise) =>
    exercise.difficultyRating !== null &&
    exercise.difficultyRating >= ALERT_THRESHOLDS.hardExercise
      ? [{ name: exercise.name, rating: exercise.difficultyRating }]
      : [],
  )
  // A list of [reason, does it apply?] pairs, kept in the order above.
  const checks: [SessionAlertReason, boolean][] = [
    ['ended_for_pain', session.endReason === 'pain'],
    [
      'pain_high',
      painAfter !== null && painAfter >= ALERT_THRESHOLDS.painAfterHigh,
    ],
    [
      'pain_rise',
      painBefore !== null &&
        painAfter !== null &&
        painAfter - painBefore >= ALERT_THRESHOLDS.painRise,
    ],
    ['hard_exercise', hardExercises.length > 0],
    [
      'patient_note',
      session.sessionFeedback !== null ||
        session.endNote !== null ||
        session.exercises.some((exercise) => exercise.feedback !== null),
    ],
  ]
  const reasons = checks
    .filter(([, applies]) => applies)
    .map(([reason]) => reason)
  return reasons.length === 0 ? null : { reasons, hardExercises }
}

// The first day a session can still be a to-do: 13 days before today, so
// the window holds 14 days, today included. Older sessions drop off the list
// — reviewed or not: the To-do is about what is happening now; the program
// page keeps the whole history.
export function reviewWindowStart(today: string): string {
  return addDays(today, 1 - ALERT_THRESHOLDS.reviewWindowDays)
}
