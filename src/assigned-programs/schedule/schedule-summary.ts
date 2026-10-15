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

import { addDays, daysBetween, isoWeekday } from '../../common/calendar-date'

// THE schedule module (decisions §5): given a program's dates, its schedule
// versions, its completed sessions and "today", it says what was due, done,
// made up and missed — for every kind of schedule, across versions. Every
// screen (the practitioner's program page now; the patient's home and
// progress pages in Phase 4; practitioner alerts later) asks this module and
// none of them branches on the schedule type itself — so a new kind of
// schedule (like 'paused', step 2b-ii) changes this file, not every screen.
//
// Pure: plain values in, plain values out — no database, no clock (today is
// a parameter), no Nest. So every rule is tested with tables of plain cases
// (schedule-summary.spec.ts), and the service only fetches and passes data.
//
// The rules, all decided with the person (decisions §5, 2026-10-09/10/11):
//   - A day is judged by the schedule version in force that day: the latest
//     one starting on or before it.
//   - Only COMPLETED sessions count, at most ONE per day (more are "extra").
//     When a day has several, the one doing the workout the day expects
//     counts — not merely the earliest.
//   - Specific days ('weekdays'): each scheduled day expects ITS workout
//     (Monday A, Wednesday B). A session of that workout on that day: DONE.
//     Another workout on that day doesn't count for it ('wrong_workout').
//     A day not done can be MADE UP by a session of THAT DAY'S WORKOUT on an
//     unscheduled day before the next scheduled day; after that window it
//     is MISSED.
//   - N per week ('times_per_week'): counted in PROGRAM weeks, starting on
//     the program's start date. Each week needs the NEXT N positions of the
//     version's rotation (A, B, C, A…), in any order within the week — the
//     positions run on BY PLAN from the version's start, whatever was done.
//     A week cut short — by the end date, a schedule change, a pause — has
//     its target scaled to its length, rounded: round(N × days / 7), and
//     needs that many positions. A workout done again when the week no
//     longer needs it is 'repeated_workout'; one the week doesn't need at
//     all is 'wrong_workout'. Each week stands alone: no carry-over.
//   - Paused ('paused'): nothing is due. A pause ends any open make-up
//     window, and a session during it is extra ('paused').
//   - "Today" is never missed: the make-up window always runs past it.
//   - A SESSION FOR ANOTHER DAY (step 2b-iii; split 2026-10-12): a session
//     with `countsFor` = D explicitly fulfils the scheduled day D — never
//     its own day, never a make-up. What D becomes depends on where the
//     session was done (swap-rules.ts has the full reasoning):
//       · on another SCHEDULED day — half of a SWAP (Monday does
//         Wednesday's workout, Wednesday Monday's): D is 'swapped';
//       · on a FREE day BEFORE D — DONE EARLY (Wednesday's workout on
//         Tuesday): D is 'done_early';
//       · on a FREE day AFTER D — catching up, which is a make-up (inferred,
//         never linked) or a late make-up (not offered): it doesn't count
//         ('swap_not_counted'). The service refuses to record it since
//         2026-10-12; rows written before are judged by the same rule.
//     It counts only if D is a scheduled day expecting that workout and D
//     isn't already fulfilled when the session happens: the EARLIER of the
//     two wins (D's own session or make-up, or this one). One that can't
//     count is extra ('swap_not_counted') — never reinterpreted as
//     something else; and D's own session after one done earlier for it is
//     extra ('already_done'). (The service checks, when the session starts,
//     the rest of what was decided: the same program week, rearranging
//     allowed.)
//   - ATTEMPTS — sessions skipped or stopped (Phase 4 step 1b, decided
//     2026-10-15): they never count (a skip or a stopped session is not done;
//     the day is still missed, due or made up by the rules above), but they
//     are LABELS the screens show — "Missed · skipped (illness)". Each is
//     filed by the day it happened: on that scheduled day if there is one,
//     else in the weekly stretch around it, else in `otherAttempts` (a free
//     day, a pause, outside the program). Several on one day are all kept,
//     oldest first — nothing to choose. Totals count them apart; `missed` is
//     unchanged.

// --- TYPES -------------------------------------------------------------------------------------------------

export interface SummaryScheduleVersion {
  type: 'weekdays' | 'times_per_week' | 'paused'
  timesPerWeek: number | null
  // 'weekdays' only: each scheduled weekday (ISO, 1 = Monday) and its
  // workout. Empty for the other types.
  days: { weekday: number; workoutId: number }[]
  // 'times_per_week' only: workout ids, position 0 first. Empty otherwise.
  rotation: number[]
  effectiveFrom: string
}

// A completed session: its id, the patient's own day (sessions.local_date)
// and the workout it did.
export interface SummarySession {
  id: number
  localDate: string
  workoutId: number
  // A swap: the scheduled day this session fulfils (sessions.counts_for).
  // Absent or null = an ordinary session.
  countsFor?: string | null
}

// A session skipped or stopped (status `skipped` or `incomplete`): its id,
// the patient's day, and why it ended (sessions.end_reason).
export interface SummaryAttempt {
  id: number
  localDate: string
  status: 'skipped' | 'incomplete'
  endReason: string
}

export interface ScheduleSummaryInput {
  startDate: string
  endDate: string | null
  // Any order; the module sorts them.
  versions: SummaryScheduleVersion[]
  // COMPLETED sessions only (the caller filters); any order.
  sessions: SummarySession[]
  // SKIPPED and INCOMPLETE sessions (the caller filters); any order. Absent
  // = none. Labels only: they never change what counts.
  attempts?: SummaryAttempt[]
  // The viewer's today (a calendar date sent by their app).
  today: string
}

// An attempt as the summary reports it — on a scheduled day (whose date it
// is), or with its own date (in a week, or apart).
export interface Attempt {
  sessionId: number
  status: 'skipped' | 'incomplete'
  endReason: string
}
export interface DatedAttempt extends Attempt {
  date: string
}

export type DayState =
  'done' | 'made_up' | 'done_early' | 'swapped' | 'missed' | 'due' | 'upcoming'

// A scheduled day of a 'weekdays' schedule.
export interface ScheduledDay {
  date: string
  // The workout the day expects.
  workoutId: number
  state: DayState
  // The session done ON that day (state 'done').
  sessionId: number | null
  // The session that made it up (state 'made_up'), and its day.
  madeUpBy: { sessionId: number; date: string } | null
  // The session that fulfilled it AHEAD of time, on a free day before it
  // (state 'done_early'), and its day.
  doneEarlyBy: { sessionId: number; date: string } | null
  // The session that fulfilled it from another SCHEDULED day — half of a
  // swap, before or after the day (state 'swapped') — and that day.
  swappedBy: { sessionId: number; date: string } | null
  // The sessions skipped or stopped ON that day, oldest first — labels
  // ("Missed · skipped (illness)"), whatever the day's state.
  attempts: Attempt[]
}

export type WeekState = 'met' | 'missed' | 'in_progress' | 'upcoming'

// A stretch of a program week under one 'times_per_week' version: the whole
// week usually; a part of it when the end date, a schedule change or a
// pause cuts it.
export interface CountedWeek {
  // 1 = the program's first week (starting on the start date).
  programWeek: number
  start: string
  end: string
  timesPerWeek: number
  // timesPerWeek, scaled when the stretch is shorter than 7 days.
  target: number
  // The rotation positions this stretch needs — `target` of them, in
  // rotation order — and the session that did each (null = not yet).
  workouts: { workoutId: number; sessionId: number | null }[]
  // Positions done (the sessions that count).
  done: number
  state: WeekState
  sessionIds: number[]
  // The sessions skipped or stopped within the stretch, oldest first.
  attempts: DatedAttempt[]
}

export type ExtraReason =
  // A second (third…) session on a day that already has one that counts.
  | 'same_day'
  // Before the start date or after the end date.
  | 'outside_program'
  // On an unscheduled day, with no missed day to make up.
  | 'no_missed_day'
  // In a counted week that had already reached its target.
  | 'beyond_target'
  // Not the workout the day — or the missed day it could make up, or the
  // week — expects.
  | 'wrong_workout'
  // A workout the week needed, but already done as often as it's needed.
  | 'repeated_workout'
  // During a pause.
  | 'paused'
  // A session for another day that couldn't count: its day was already
  // fulfilled, isn't a scheduled day expecting that workout (any more), or
  // — for an earlier day — it was done on a free day.
  | 'swap_not_counted'
  // On a scheduled day already fulfilled — earlier — by a session for it
  // (done early, or half of a swap).
  | 'already_done'

export interface ExtraSession {
  sessionId: number
  date: string
  reason: ExtraReason
}

// A paused stretch of the program: from its first day to its last — null
// when nothing ends it (no later version, no end date).
export interface Pause {
  from: string
  to: string | null
}

// What the patient should do next — for a "Today" or "Up next" line. A
// specific day: the workout and the day it's for (a make-up names the
// MISSED day). A weekly count: the next workout the week still needs, and
// the program week.
export interface NextWorkout {
  workoutId: number
  forDay: string | null
  programWeek: number | null
}

export interface ScheduleSummary {
  // The days covered: the start date up to the end date — or, for an
  // open-ended program, up to the end of the current program week.
  firstDay: string
  lastDay: string
  today: string
  totals: {
    // The program's whole target (scheduled days + weekly targets); null
    // for an open-ended program, which has no total (decisions §5: show a
    // count instead of a progress bar).
    expected: number | null
    // `done` counts days done on the day (and weekly positions); made-up,
    // done-early and swapped days are counted apart, so a screen can tell
    // them apart.
    done: number
    madeUp: number
    doneEarly: number
    swapped: number
    missed: number
    extra: number
    // Sessions skipped / stopped (attempts), wherever they fall. Not part of
    // `missed`: a skipped day is ALSO missed (or made up) — these say how
    // many times the patient said "not today" or stopped.
    skipped: number
    incomplete: number
  }
  days: ScheduledDay[]
  weeks: CountedWeek[]
  extraSessions: ExtraSession[]
  // Attempts on no scheduled day and in no weekly stretch: a free day of a
  // specific-days schedule (a catch-up stopped, say), a pause, outside the
  // program's dates. Oldest first.
  otherAttempts: DatedAttempt[]
  pauses: Pause[]
  // null when nothing is left to do (the program is over, or paused with
  // nothing planned after the pause within the days covered).
  nextWorkout: NextWorkout | null
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// The version in force on `day`: the latest starting on or before it.
// `sorted` is oldest first. Undefined before the first version — which
// can't happen inside a program today (the first version starts on the
// start date), but the module doesn't rely on it.
function versionOn(
  sorted: SummaryScheduleVersion[],
  day: string,
): SummaryScheduleVersion | undefined {
  let found: SummaryScheduleVersion | undefined
  for (const version of sorted) {
    if (version.effectiveFrom <= day) found = version
    else break
  }
  return found
}

// The last day the summary covers. With an end date: the end date. Open-
// ended: the last day of the program week containing today (so the current
// week is complete), or the first week if the program hasn't started.
function lastDayCovered(input: ScheduleSummaryInput): string {
  if (input.endDate !== null) return input.endDate
  const reference =
    input.today < input.startDate ? input.startDate : input.today
  const weekIndex = Math.floor(daysBetween(input.startDate, reference) / 7)
  return addDays(input.startDate, weekIndex * 7 + 6)
}

// The session of one day that counts: the first (lowest id) that `wanted`
// accepts — or, if none does, simply the first. The others are returned
// too: they're that day's 'same_day' extras. `list` is in id order.
function pickSession(
  list: SummarySession[],
  wanted: (session: SummarySession) => boolean,
): { chosen: SummarySession; others: SummarySession[] } {
  const chosen = list.find(wanted) ?? list[0]
  return { chosen, others: list.filter((session) => session !== chosen) }
}

// --- THE SUMMARY -------------------------------------------------------------------------------------------

export function summarizeSchedule(
  input: ScheduleSummaryInput,
): ScheduleSummary {
  const { startDate, endDate, today } = input
  const lastDay = lastDayCovered(input)
  const versions = [...input.versions].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom
      ? -1
      : a.effectiveFrom > b.effectiveFrom
        ? 1
        : 0,
  )
  const extraSessions: ExtraSession[] = []
  const extra = (session: SummarySession, reason: ExtraReason) =>
    extraSessions.push({
      sessionId: session.id,
      date: session.localDate,
      reason,
    })

  // --- 1. Sessions by day ---
  // Sorted by day, then id. Sessions outside the program's dates are extras
  // at once. (For an open-ended program, "after lastDay" can only be a
  // session on a day past the current week — not possible for a session
  // dated today, but not counted if it ever happened.) Which session of a
  // day counts is decided during the walk, when the day's expectation is
  // known.
  const sessionsOnDay = new Map<string, SummarySession[]>()
  const sortedSessions = [...input.sessions].sort((a, b) =>
    a.localDate === b.localDate
      ? a.id - b.id
      : a.localDate < b.localDate
        ? -1
        : 1,
  )
  // Swaps are kept apart, by the day they were DONE on: they never count for
  // that day, and are applied as the walk reaches that day (step 2).
  const swapsOnDay = new Map<string, SummarySession[]>()
  for (const session of sortedSessions) {
    if (session.localDate < startDate || session.localDate > lastDay) {
      extra(session, 'outside_program')
    } else {
      const byDay = session.countsFor ? swapsOnDay : sessionsOnDay
      byDay.set(session.localDate, [
        ...(byDay.get(session.localDate) ?? []),
        session,
      ])
    }
  }

  // --- 2. Walk the program, day by day ---
  // Specific days: judged as we go, with at most one missed day "open" for a
  // make-up at a time (the windows between consecutive scheduled days don't
  // overlap). N per week: days are grouped into stretches — one per program
  // week AND version — counted at the end, once each stretch's length (and
  // so its target) is known.
  const days: ScheduledDay[] = []
  // For each scheduled day not done yet: the last day of its make-up window.
  const windowEnd = new Map<ScheduledDay, string>()
  let openMissed: ScheduledDay | null = null

  interface Stretch {
    programWeek: number
    version: SummaryScheduleVersion
    start: string
    end: string
    // The sessions of each day that has some, in day order.
    sessionDays: SummarySession[][]
  }
  const stretches: Stretch[] = []

  // Closing the open window: the missed day's make-up window ends the day
  // before `day` (a new scheduled day, a change to another kind of
  // schedule, or a pause).
  const closeWindow = (day: string) => {
    if (openMissed) windowEnd.set(openMissed, addDays(day, -1))
    openMissed = null
  }

  // Sessions done BEFORE the day they count for (D later than the
  // session): waiting for the walk to reach D, which then starts out
  // fulfilled — that session came first. `fromScheduledDay` says which:
  // done on a scheduled day, it's half of a swap; on a free day, done early.
  const earlySessions = new Map<
    string,
    { session: SummarySession; fromScheduledDay: boolean }
  >()
  const fulfilled = (entry: ScheduledDay) =>
    entry.state === 'done' ||
    entry.state === 'made_up' ||
    entry.state === 'done_early' ||
    entry.state === 'swapped'
  // The sessions for another day done on `day`. One for a day already
  // walked (done late) counts now — only from a scheduled day (the second
  // half of a swap), only for a day still unfulfilled; one for a later day
  // waits in `earlySessions` (only the first for a given day: a second one
  // can't count).
  const applySessionsForOtherDays = (day: string, dayIsScheduled: boolean) => {
    for (const session of swapsOnDay.get(day) ?? []) {
      const target = session.countsFor!
      if (target > day) {
        if (earlySessions.has(target)) extra(session, 'swap_not_counted')
        else
          earlySessions.set(target, {
            session,
            fromScheduledDay: dayIsScheduled,
          })
        continue
      }
      const entry = days.find((d) => d.date === target)
      if (
        !dayIsScheduled ||
        !entry ||
        entry.workoutId !== session.workoutId ||
        fulfilled(entry)
      ) {
        extra(session, 'swap_not_counted')
        continue
      }
      entry.state = 'swapped'
      entry.swappedBy = { sessionId: session.id, date: day }
      // No make-up window to close here: `day` is a scheduled day, and the
      // walk closes the open window on every scheduled day, right after
      // this. (Before 2026-10-12, a late link from a FREE day could leave
      // the day it fulfilled open for a make-up, and this cleared it.)
    }
  }

  for (let day = startDate; day <= lastDay; day = addDays(day, 1)) {
    const version = versionOn(versions, day)
    const list = sessionsOnDay.get(day) ?? []
    const scheduled =
      version?.type === 'weekdays'
        ? version.days.find((d) => d.weekday === isoWeekday(day))
        : undefined
    // The day's sessions for other days first: a late one (from a
    // scheduled day) fulfils its day before this day is judged; an early
    // one is set aside until the walk reaches its day.
    applySessionsForOtherDays(day, scheduled !== undefined)

    if (version?.type === 'weekdays') {
      if (scheduled) {
        // A scheduled day ends the previous missed day's window, then is
        // judged itself: a session ON it counts for it — if it's the
        // day's workout. (Even a session of the open missed day's workout
        // can't make that day up here: a scheduled day's session never
        // makes up an earlier one — decided 2026-10-10.)
        closeWindow(day)
        const entry: ScheduledDay = {
          date: day,
          workoutId: scheduled.workoutId,
          state: 'upcoming', // settled in step 3 unless done now
          sessionId: null,
          madeUpBy: null,
          doneEarlyBy: null,
          swappedBy: null,
          attempts: [], // filled in step 8
        }
        days.push(entry)
        // A session done earlier for this day: it came first, so the day is
        // already fulfilled — if it did this day's workout. Done on a
        // scheduled day: half of a swap; on a free day: done early.
        const early = earlySessions.get(day)
        if (early) {
          earlySessions.delete(day)
          const by = {
            sessionId: early.session.id,
            date: early.session.localDate,
          }
          if (early.session.workoutId !== scheduled.workoutId) {
            extra(early.session, 'swap_not_counted')
          } else if (early.fromScheduledDay) {
            entry.state = 'swapped'
            entry.swappedBy = by
          } else {
            entry.state = 'done_early'
            entry.doneEarlyBy = by
          }
        }
        if (list.length > 0) {
          const { chosen, others } = pickSession(
            list,
            (s) => s.workoutId === scheduled.workoutId,
          )
          others.forEach((s) => extra(s, 'same_day'))
          if (fulfilled(entry)) {
            // Fulfilled by the session done earlier for it: today's own
            // session — even of the right workout — comes second.
            extra(
              chosen,
              chosen.workoutId === scheduled.workoutId
                ? 'already_done'
                : 'wrong_workout',
            )
          } else if (chosen.workoutId === scheduled.workoutId) {
            entry.state = 'done'
            entry.sessionId = chosen.id
          } else {
            extra(chosen, 'wrong_workout')
          }
        }
        if (!fulfilled(entry)) openMissed = entry
      } else if (list.length > 0) {
        // An unscheduled day: a session of the open missed day's workout
        // makes it up; any other session is extra.
        const missed: ScheduledDay | null = openMissed
        if (missed) {
          const { chosen, others } = pickSession(
            list,
            (s) => s.workoutId === missed.workoutId,
          )
          others.forEach((s) => extra(s, 'same_day'))
          if (chosen.workoutId === missed.workoutId) {
            missed.state = 'made_up'
            missed.madeUpBy = { sessionId: chosen.id, date: day }
            openMissed = null
          } else {
            extra(chosen, 'wrong_workout')
          }
        } else {
          extra(list[0], 'no_missed_day')
          list.slice(1).forEach((s) => extra(s, 'same_day'))
        }
      }
      continue
    }

    // Not a 'weekdays' day: any open make-up window ends here.
    closeWindow(day)

    if (version?.type === 'times_per_week') {
      const programWeek = Math.floor(daysBetween(startDate, day) / 7) + 1
      const current = stretches[stretches.length - 1]
      // Same program week and same version → the same stretch. (Versions
      // are objects: "same version" is identity. Days of one version are
      // always consecutive — once a later version starts, an earlier one
      // never applies again — so no gap check is needed.)
      const stretch =
        current &&
        current.programWeek === programWeek &&
        current.version === version
          ? current
          : undefined
      if (stretch) {
        stretch.end = day
        if (list.length > 0) stretch.sessionDays.push(list)
      } else {
        stretches.push({
          programWeek,
          version,
          start: day,
          end: day,
          sessionDays: list.length > 0 ? [list] : [],
        })
      }
    } else if (list.length > 0) {
      // Paused — or no version in force (not possible inside a program).
      const reason: ExtraReason =
        version?.type === 'paused' ? 'paused' : 'no_missed_day'
      extra(list[0], reason)
      list.slice(1).forEach((s) => extra(s, 'same_day'))
    }
  }
  // A window still open at the end of the walk runs to the last day covered
  // (the end date). For an open-ended program the next scheduled day lies
  // beyond lastDay, which is never before today — so it's still open.
  if (openMissed) windowEnd.set(openMissed, lastDay)
  // A session done early still waiting: the walk reached its day and found
  // no scheduled day there (the schedule changed since), or never reached
  // it (past the end date). Either way it couldn't count.
  for (const { session } of earlySessions.values()) {
    extra(session, 'swap_not_counted')
  }

  // --- 3. Settle the specific days that weren't fulfilled ---
  for (const entry of days) {
    if (fulfilled(entry)) continue
    if (entry.date > today) entry.state = 'upcoming'
    else entry.state = windowEnd.get(entry)! >= today ? 'due' : 'missed'
  }

  // --- 4. Count the weeks ---
  // Rotation positions run on through a version's stretches: a stretch
  // needs the next `target` positions after those its version's earlier
  // stretches needed (by plan — whether or not they were done).
  const positionsUsed = new Map<SummaryScheduleVersion, number>()
  const weeks: CountedWeek[] = stretches.map((stretch) => {
    const { version } = stretch
    const length = daysBetween(stretch.start, stretch.end) + 1
    // round(N × days / 7): a full week keeps N; a 3-day week of "3 a week"
    // gets round(1.29) = 1. No ties are possible (N × days = 3.5 × 7 would
    // need 7 to divide N × days, i.e. N = 7 or days = 7, both exact).
    const timesPerWeek = version.timesPerWeek!
    const target = Math.round((timesPerWeek * length) / 7)
    const first = positionsUsed.get(version) ?? 0
    positionsUsed.set(version, first + target)
    // `% length`: the rotation repeats. (A rotation is never empty — the
    // service refuses one — but an empty one must not divide by zero here:
    // it simply needs nothing.)
    const rotation = version.rotation
    const slots: { workoutId: number; sessionId: number | null }[] =
      rotation.length === 0
        ? []
        : Array.from({ length: target }, (_, i) => ({
            workoutId: rotation[(first + i) % rotation.length],
            sessionId: null,
          }))

    // Each day with sessions, in order: the session that fills the
    // earliest open slot of its workout counts; a day's other sessions are
    // 'same_day'. A session that fills nothing is beyond the target, a
    // repeat, or a workout this week doesn't need.
    const counted: SummarySession[] = []
    for (const list of stretch.sessionDays) {
      const openSlot = (s: SummarySession) =>
        slots.find(
          (slot) => slot.sessionId === null && slot.workoutId === s.workoutId,
        )
      const { chosen, others } = pickSession(list, (s) => !!openSlot(s))
      others.forEach((s) => extra(s, 'same_day'))
      const slot = openSlot(chosen)
      if (slot) {
        slot.sessionId = chosen.id
        counted.push(chosen)
      } else if (slots.every((s) => s.sessionId !== null)) {
        extra(chosen, 'beyond_target')
      } else if (slots.some((s) => s.workoutId === chosen.workoutId)) {
        extra(chosen, 'repeated_workout')
      } else {
        extra(chosen, 'wrong_workout')
      }
    }

    const done = counted.length
    let state: WeekState
    if (stretch.start > today) state = 'upcoming'
    else if (done >= target) state = 'met'
    else state = stretch.end < today ? 'missed' : 'in_progress'
    return {
      programWeek: stretch.programWeek,
      start: stretch.start,
      end: stretch.end,
      timesPerWeek,
      target,
      workouts: slots,
      done,
      state,
      sessionIds: counted.map((s) => s.id),
      attempts: [], // filled in step 8
    }
  })

  // --- 5. Pauses ---
  // Each paused version, from the later of its own start and the program's,
  // to the day before the next version starts — or the end date, or open
  // (null) when nothing ends it.
  const pauses: Pause[] = []
  versions.forEach((version, i) => {
    if (version.type !== 'paused') return
    const from =
      version.effectiveFrom < startDate ? startDate : version.effectiveFrom
    // A pause starting after the program ends never applies.
    if (endDate !== null && from > endDate) return
    const next = versions[i + 1]
    const resumesOn = next?.effectiveFrom ?? null
    // Its last day: the day before the next version — but never past the
    // end date; with neither, it runs on (null).
    let to: string | null = resumesOn === null ? null : addDays(resumesOn, -1)
    if (endDate !== null && (to === null || to > endDate)) to = endDate
    pauses.push({ from, to })
  })

  // --- 6. What's next ---
  // The earliest thing still to do: a scheduled day that is due (oldest
  // first — a make-up names the missed day) or upcoming, or the next
  // workout a current or coming week still needs. "When" for something due
  // or in progress is today; for something upcoming, its day or week start.
  // On a tie (can't happen today: one version is in force on a given day),
  // the scheduled day wins.
  const candidates: { when: string; next: NextWorkout }[] = []
  for (const day of days) {
    if (day.state === 'due' || day.state === 'upcoming') {
      candidates.push({
        when: day.state === 'due' ? today : day.date,
        next: { workoutId: day.workoutId, forDay: day.date, programWeek: null },
      })
    }
  }
  for (const week of weeks) {
    if (week.state !== 'in_progress' && week.state !== 'upcoming') continue
    const open = week.workouts.find((slot) => slot.sessionId === null)
    if (!open) continue
    candidates.push({
      when: week.state === 'in_progress' ? today : week.start,
      next: {
        workoutId: open.workoutId,
        forDay: null,
        programWeek: week.programWeek,
      },
    })
  }
  const [first] = candidates.sort((a, b) =>
    a.when < b.when ? -1 : a.when > b.when ? 1 : 0,
  )

  // --- 7. Totals ---
  const count = (state: DayState) =>
    days.filter((d) => d.state === state).length
  const weeklyMissed = weeks
    .filter((w) => w.state === 'missed')
    .reduce((sum, w) => sum + (w.target - w.done), 0)
  extraSessions.sort((a, b) =>
    a.date === b.date ? a.sessionId - b.sessionId : a.date < b.date ? -1 : 1,
  )

  // --- 8. Attempts (labels only) ---
  // Oldest first (day, then id — creation order). Each goes to the scheduled
  // day of its date, else the weekly stretch around it, else apart. Done
  // last, and on its own: nothing above reads them, so they can't change
  // what counts.
  const attempts = [...(input.attempts ?? [])].sort((a, b) =>
    a.localDate === b.localDate
      ? a.id - b.id
      : a.localDate < b.localDate
        ? -1
        : 1,
  )
  const otherAttempts: DatedAttempt[] = []
  for (const attempt of attempts) {
    const label: Attempt = {
      sessionId: attempt.id,
      status: attempt.status,
      endReason: attempt.endReason,
    }
    const day = days.find((d) => d.date === attempt.localDate)
    const week = weeks.find(
      (w) => w.start <= attempt.localDate && attempt.localDate <= w.end,
    )
    if (day) day.attempts.push(label)
    else if (week) week.attempts.push({ ...label, date: attempt.localDate })
    else otherAttempts.push({ ...label, date: attempt.localDate })
  }

  return {
    firstDay: startDate,
    lastDay,
    today,
    totals: {
      expected:
        endDate === null
          ? null
          : days.length + weeks.reduce((sum, w) => sum + w.target, 0),
      done: count('done') + weeks.reduce((sum, w) => sum + w.done, 0),
      madeUp: count('made_up'),
      doneEarly: count('done_early'),
      swapped: count('swapped'),
      missed: count('missed') + weeklyMissed,
      extra: extraSessions.length,
      skipped: attempts.filter((a) => a.status === 'skipped').length,
      incomplete: attempts.filter((a) => a.status === 'incomplete').length,
    },
    days,
    weeks,
    extraSessions,
    otherAttempts,
    pauses,
    nextWorkout: first?.next ?? null,
  }
}
