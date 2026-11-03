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

import { addDays } from '../../src/common/calendar-date'
import { summarizeSchedule } from '../../src/assigned-programs/schedule/schedule-summary'
import {
  ALERT_THRESHOLDS,
  attendanceFacts,
  reviewWindowStart,
  sessionReview,
} from '../../src/alerts/alert-rules'
import {
  seedAttempts,
  seedSessionDays,
  seedSessionScores,
  seedSessionWorkouts,
} from './session-history'
import { MESSAGE_MAX_LENGTH } from '../../src/database/schema/messaging.schema'
import {
  AMENDMENT_REASON_MAX_LENGTH,
  MEDICAL_FILE_SECTION_MAX_LENGTH,
} from '../../src/database/schema/medical-files.schema'
import { SOAP_SECTIONS } from '../../src/medical-files/medical-file-rules'
import { ROM_NOTE_MAX_LENGTH } from '../../src/database/schema/range-of-motion.schema'
import {
  LOWEST_DEGREES,
  SIDED_MOVEMENTS,
  highestDegrees,
} from '../../src/range-of-motion/movement-catalogue'
import {
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../../src/mfa/recovery-codes'
import { DEMO_CARD_ACCOUNTS } from '../../src/demo/demo-accounts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCOUNTS,
  ASSIGNED_PROGRAMS,
  CLINICS,
  CONVERSATIONS,
  CUSTOM_EXERCISES,
  DEMO_MFA_SECRET,
  DEMO_PASSWORD,
  DEMO_RECOVERY_CODES,
  MEDICAL_FILES,
  ROM_ASSESSMENTS,
  TEMPLATES,
  type AccountKey,
  type PatientAccount,
  type PractitionerAccount,
} from './dataset'

// The rules the seed script RELIES ON, checked here so a bad edit to the
// data fails in a second — not halfway through a seed, against a
// half-filled database.

const byKey = new Map(ACCOUNTS.map((account) => [account.key, account]))
const patients = ACCOUNTS.filter(
  (a): a is PatientAccount => a.kind === 'patient',
)
const positionOf = (key: AccountKey) => ACCOUNTS.findIndex((a) => a.key === key)
// Who is on a patient's care team once the seed is done: the creator and
// those who joined, minus those who left (step 9 of the seed).
const currentCareTeam = (patient: PatientAccount) =>
  [patient.createdBy, ...(patient.alsoOnCareTeam ?? [])].filter(
    (key) => !(patient.leftCareTeam ?? []).includes(key),
  )
const practitioners = ACCOUNTS.filter(
  (a): a is PractitionerAccount => a.kind === 'practitioner',
)

describe('the seed dataset', () => {
  it('has unique keys and emails, all on the undeliverable .test domain', () => {
    expect(new Set(ACCOUNTS.map((a) => a.key)).size).toBe(ACCOUNTS.length)
    expect(new Set(ACCOUNTS.map((a) => a.email)).size).toBe(ACCOUNTS.length)
    for (const account of ACCOUNTS) {
      expect(account.email).toMatch(/@([a-z]+\.)?stride\.test$/)
    }
    for (const clinic of CLINICS) {
      expect(clinic.email).toMatch(/\.stride\.test$/)
    }
  })

  it('starts with the one founding admin, in the first clinic', () => {
    expect(ACCOUNTS[0].kind).toBe('founder')
    expect(ACCOUNTS.filter((a) => a.kind === 'founder')).toHaveLength(1)
    expect(ACCOUNTS[0].clinics[0]).toBe(CLINICS[0].key)
  })

  it('only names clinics that exist', () => {
    const clinicKeys = new Set(CLINICS.map((c) => c.key))
    for (const account of ACCOUNTS) {
      for (const clinic of account.clinics) {
        expect(clinicKeys).toContain(clinic)
      }
    }
  })

  // The seed acts AS these people: they must exist, be practitioners with
  // a password, and come earlier in the list.
  it("has every patient created by an earlier practitioner who shares the patient's clinic", () => {
    for (const patient of patients) {
      const creator = byKey.get(patient.createdBy)
      expect(creator?.kind).toBe('practitioner')
      expect(positionOf(patient.createdBy)).toBeLessThan(
        positionOf(patient.key),
      )
      expect(creator?.clinics).toContain(patient.clinics[0])
    }
  })

  // "Join care team" needs a shared clinic (CareTeamService).
  it('only adds practitioners to a care team who share a clinic with the patient', () => {
    for (const patient of patients) {
      for (const joiner of patient.alsoOnCareTeam ?? []) {
        const practitioner = byKey.get(joiner)
        expect(practitioner?.kind).toBe('practitioner')
        expect(
          practitioner?.clinics.some((c) => patient.clinics.includes(c)),
        ).toBe(true)
        expect(joiner).not.toBe(patient.createdBy) // already on it
      }
    }
  })

  // CareTeamService.endMembership: a practitioner ends only their OWN link,
  // and only a link that exists.
  it('only lets a practitioner leave a care team they are on', () => {
    for (const patient of patients) {
      for (const leaver of patient.leftCareTeam ?? []) {
        expect(byKey.get(leaver)?.kind).toBe('practitioner')
        expect([
          patient.createdBy,
          ...(patient.alsoOnCareTeam ?? []),
        ]).toContain(leaver)
      }
    }
  })

  // Removing a practitioner from their clinics would END their care-team
  // links (no shared clinic left) and leave the patients they created
  // without them — not what the dataset says. So such a practitioner
  // creates and treats nobody.
  it('removes from their clinics only a practitioner who treats nobody', () => {
    for (const practitioner of practitioners.filter(
      (p) => p.removedFromClinics,
    )) {
      for (const patient of patients) {
        expect(patient.createdBy).not.toBe(practitioner.key)
        expect(patient.alsoOnCareTeam ?? []).not.toContain(practitioner.key)
      }
    }
  })

  // The admin home's "Needs attention" (decisions §17) shows something in
  // the demo: a patient nobody treats who can log in (her Team page shows
  // the past member), a practitioner in no clinic who can log in, and —
  // since 2026-10-25 (§19) — invitations to send again: one expired, one
  // whose email couldn't be sent, both on active accounts.
  it('gives each of the admin home\'s "needs attention" groups an account', () => {
    const untreated = patients.filter(
      (p) =>
        currentCareTeam(p).length === 0 &&
        p.invitation === 'accepted' &&
        !p.deactivated,
    )
    expect(untreated.map((p) => p.key)).toEqual(['dana'])
    expect(
      practitioners.filter((p) => p.removedFromClinics).map((p) => p.key),
    ).toEqual(['taylor'])
    expect(
      patients
        .filter(
          (p) =>
            (p.invitation === 'expired' || p.invitation === 'email-failed') &&
            !p.deactivated,
        )
        .map((p) => p.invitation),
    ).toEqual(['email-failed', 'expired'])
  })

  it('shows each invitation state at least once', () => {
    const outcomes = new Set(patients.map((p) => p.invitation))
    expect([...outcomes].sort()).toEqual([
      'accepted',
      'email-failed',
      'expired',
      'pending',
    ])
    expect(patients.some((p) => p.deactivated)).toBe(true)
  })

  // The patient's Team page has two looks for a practitioner: with a bio,
  // and without one (no "No bio" line). Both must be visible to a seeded
  // patient: Alex (Pat's and Jo's team) and Sam (Jo's, Robin's) have one;
  // Blake (Robin's team) doesn't. Morgan, on nobody's team, has one too.
  it('gives bios to most practitioners, but not to all', () => {
    const withBio = practitioners.filter((p) => p.bio !== undefined)
    expect(withBio.map((p) => p.key)).toEqual([
      'morgan',
      'alex',
      'sam',
      'taylor',
    ])
    // ...and the no-bio case is on the team of a patient who can log in
    // (created them, or joined them), so it shows without any set-up.
    const visibleToAPatient = (key: AccountKey) =>
      patients.some(
        (patient) =>
          patient.invitation === 'accepted' &&
          !patient.deactivated &&
          (patient.createdBy === key ||
            (patient.alsoOnCareTeam ?? []).includes(key)),
      )
    const withoutBio = practitioners.filter((p) => p.bio === undefined)
    expect(withoutBio.map((p) => p.key)).toEqual(['blake'])
    expect(withoutBio.some((p) => visibleToAPatient(p.key))).toBe(true)
    // A bio passes the API's own limit (CreateUserDto: 2000 characters)
    // and isn't blank — the seed goes through the real validation.
    for (const p of withBio) {
      expect(p.bio?.trim().length).toBeGreaterThan(0)
      expect(p.bio?.length).toBeLessThanOrEqual(2000)
    }
  })

  it('builds templates only from known custom exercises', () => {
    const customNames = new Set(CUSTOM_EXERCISES.map((e) => e.name))
    for (const template of TEMPLATES) {
      for (const line of template.workouts.flatMap((w) => w.lines)) {
        if ('custom' in line.exercise) {
          expect(customNames).toContain(line.exercise.custom)
        }
      }
    }
  })

  // The seed shows both shapes: a template with several workouts, and one
  // with a single workout (the shape every template had before workouts).
  it('includes a several-workout template and a one-workout template', () => {
    const counts = TEMPLATES.map((t) => t.workouts.length)
    expect(counts.some((n) => n > 1)).toBe(true)
    expect(counts).toContain(1)
  })

  // Every workout a schedule names (a day's, or a rotation position's) is
  // one the template has — the API would refuse the assignment otherwise
  // (400), and the seed would stop halfway.
  it('schedules only workouts the template has', () => {
    for (const assignment of ASSIGNED_PROGRAMS) {
      const { schedule } = assignment
      const positions =
        schedule.type === 'weekdays'
          ? schedule.days.map((day) => day.workoutIndex)
          : (schedule.rotation ?? [])
      const template = TEMPLATES.find((t) => t.title === assignment.template)
      for (const position of positions) {
        expect(position).toBeGreaterThanOrEqual(0)
        expect(position).toBeLessThan(template?.workouts.length ?? 0)
      }
    }
  })

  // The several-workout template is scheduled with more than one workout,
  // so the seeded program shows days of different workouts.
  it('schedules a program with different workouts on different days', () => {
    const workoutsUsed = ASSIGNED_PROGRAMS.map(({ schedule }) =>
      schedule.type === 'weekdays'
        ? new Set(schedule.days.map((day) => day.workoutIndex)).size
        : 0,
    )
    expect(Math.max(...workoutsUsed)).toBeGreaterThan(1)
  })

  // AssignedProgramsService.create requires the assigning practitioner to
  // manage the patient — i.e. to be on the care team.
  it('assigns programs from existing templates, by someone on the patient’s care team', () => {
    const titles = new Set(TEMPLATES.map((t) => t.title))
    for (const assignment of ASSIGNED_PROGRAMS) {
      expect(titles).toContain(assignment.template)
      const patient = patients.find((p) => p.key === assignment.patient)
      expect(patient).toBeDefined()
      expect(patient && currentCareTeam(patient)).toContain(assignment.by)
    }
  })

  // Every history fits its schedule (a weekdays history on a weekdays
  // schedule, make-ups and swaps on unscheduled days, no week with more
  // sessions than it asks for) — whatever day the seed runs: the dates are
  // relative, so the weekdays they land on change with the day. Checked for
  // seven consecutive fixed days (every weekday once), so the test doesn't
  // depend on the day it runs either. The workouts are checked with the
  // POSITIONS standing in for ids (any distinct numbers would do).
  it.each([20, 21, 22, 23, 24, 25, 26])(
    'gives every program a history that fits its schedule (seed run on Oct %i)',
    (dayOfMonth) => {
      const today = `2026-10-${dayOfMonth}`
      for (const assignment of ASSIGNED_PROGRAMS) {
        const start = addDays(today, -assignment.startsDaysAgo)
        const sessions = seedSessionDays(
          start,
          today,
          assignment.schedule,
          assignment.history,
        )
        const { schedule } = assignment
        const content =
          schedule.type === 'weekdays'
            ? {
                type: 'weekdays' as const,
                timesPerWeek: null,
                days: schedule.days.map((d) => ({
                  weekday: d.weekday,
                  workoutId: d.workoutIndex,
                })),
                rotation: [],
              }
            : {
                type: 'times_per_week' as const,
                timesPerWeek: schedule.timesPerWeek,
                days: [],
                rotation: schedule.rotation ?? [0],
              }
        expect(() =>
          seedSessionWorkouts(start, content, sessions),
        ).not.toThrow()
      }
    },
  )

  // The histories JUDGED: the real schedule module run on each program's
  // seeded sessions, for every weekday the seed could run on. Pat's history
  // must show exactly one of each kind of day — what the demo is for — and
  // no seeded session may be an extra (one that counts for nothing would
  // be a seed bug: the old generator could put a "swap" on the day AFTER
  // its day, which stopped counting on 2026-10-12). Workout POSITIONS stand
  // in for ids; session ids are their order.
  it.each([20, 21, 22, 23, 24, 25, 26])(
    'gives histories the schedule module counts as planned (seed run on Oct %i)',
    (dayOfMonth) => {
      const today = `2026-10-${dayOfMonth}`
      for (const assignment of ASSIGNED_PROGRAMS) {
        const start = addDays(today, -assignment.startsDaysAgo)
        const { schedule } = assignment
        const content =
          schedule.type === 'weekdays'
            ? {
                type: 'weekdays' as const,
                timesPerWeek: null,
                days: schedule.days.map((d) => ({
                  weekday: d.weekday,
                  workoutId: d.workoutIndex,
                })),
                rotation: [],
              }
            : {
                type: 'times_per_week' as const,
                timesPerWeek: schedule.timesPerWeek,
                days: [],
                rotation: schedule.rotation ?? [0],
              }
        const sessions = seedSessionDays(
          start,
          today,
          schedule,
          assignment.history,
        )
        const workouts = seedSessionWorkouts(start, content, sessions)
        const attempts = seedAttempts(
          start,
          today,
          schedule,
          assignment.history,
        )
        const summary = summarizeSchedule({
          startDate: start,
          endDate: null,
          versions: [{ ...content, effectiveFrom: start }],
          sessions: sessions.map((session, index) => ({
            id: index + 1,
            localDate: session.day,
            workoutId: workouts[index],
            countsFor: session.countsFor,
          })),
          attempts: attempts.map((attempt, index) => ({
            id: 100 + index,
            localDate: attempt.day,
            status: attempt.status,
            endReason: attempt.reason,
          })),
          today,
        })
        expect(summary.extraSessions).toEqual([])
        expect(summary.otherAttempts).toEqual([])
        // The To-do's attendance alert (2026-10-19), judged by the real
        // rules on the same summary: Jo's last two program weeks ended below
        // target; Pat, who keeps up, raises none. (Robin's first program is
        // cancelled by the seed: no attendance alert for a closed program.)
        const attendance = attendanceFacts({
          startDate: start,
          endDate: null,
          today,
          pauses: summary.pauses,
          days: summary.days,
          weeks: summary.weeks,
          sessionDates: [...sessions, ...attempts].map((s) => s.day),
        })
        if (assignment.patient === 'jo') {
          expect(attendance?.missedInARow?.weeks).toBe(
            ALERT_THRESHOLDS.missedWeeksInARow,
          )
        }
        if (assignment.patient === 'pat') expect(attendance).toBeNull()
        if (assignment.patient === 'pat') {
          expect(summary.totals).toMatchObject({
            done: 4,
            madeUp: 1,
            doneEarly: 1,
            swapped: 2,
            missed: 1,
            extra: 0,
            skipped: 1,
            incomplete: 1,
          })
          // The skip labels the MISSED day; the stop, the day MADE UP.
          const labelled = summary.days
            .filter((day) => day.attempts.length > 0)
            .map((day) => [day.state, day.attempts.map((a) => a.endReason)])
          expect(labelled).toEqual([
            ['made_up', ['pain']],
            ['missed', ['illness']],
          ])
        } else {
          expect(attempts).toEqual([])
        }
      }
    },
  )

  // The progress page (2026-10-18): one set of scores per seeded session
  // — whatever weekday the seed runs on, since seed-dev pairs them by
  // position and seedSessionScores throws on a mismatch — and each a score
  // the database's CHECKs accept (an integer 0–10) or no answer.
  it.each([20, 21, 22, 23, 24, 25, 26])(
    'gives every program one set of valid scores per seeded session (seed run on Oct %i)',
    (dayOfMonth) => {
      const today = `2026-10-${dayOfMonth}`
      for (const assignment of ASSIGNED_PROGRAMS) {
        const start = addDays(today, -assignment.startsDaysAgo)
        const sessions = seedSessionDays(
          start,
          today,
          assignment.schedule,
          assignment.history,
        )
        expect(() =>
          seedSessionScores(sessions.length, assignment.scores),
        ).not.toThrow()
      }
    },
  )

  // The To-do's sessions to review (2026-10-19): feedback and reviews name
  // seeded sessions (by position, like scores) whatever weekday the seed
  // runs on; the ratings are ones the CHECK accepts (1–10) and the notes
  // hold something. And the demo shows what it's for — judged by the real
  // rules: a session with a hard exercise and a note, one with high and
  // rising pain, each inside the review window; and a review by ONE member
  // of a care team of two, so the other still has it on their To-do.
  it.each([20, 21, 22, 23, 24, 25, 26])(
    'gives the To-do a session of each kind to review (seed run on Oct %i)',
    (dayOfMonth) => {
      const today = `2026-10-${dayOfMonth}`
      const reasons = new Set<string>()
      let reviewedWithColleague = false
      for (const assignment of ASSIGNED_PROGRAMS) {
        const start = addDays(today, -assignment.startsDaysAgo)
        const sessions = seedSessionDays(
          start,
          today,
          assignment.schedule,
          assignment.history,
        )
        const scores = seedSessionScores(sessions.length, assignment.scores)
        for (const entry of assignment.feedback ?? []) {
          expect(entry.session).toBeLessThan(sessions.length)
          for (const rating of entry.difficulty) {
            if (rating === null) continue
            expect(Number.isInteger(rating)).toBe(true)
            expect(rating).toBeGreaterThanOrEqual(1)
            expect(rating).toBeLessThanOrEqual(10)
          }
          for (const note of entry.notes ?? []) {
            if (note !== null) expect(note.trim()).not.toBe('')
          }
        }
        for (const [index, { day }] of sessions.entries()) {
          if (day < reviewWindowStart(today)) continue
          const entry = assignment.feedback?.find((f) => f.session === index)
          const review = sessionReview({
            status: 'completed',
            endReason: null,
            painBefore: scores[index].painBefore,
            painAfter: scores[index].painAfter,
            sessionFeedback: entry?.sessionFeedback ?? null,
            endNote: null,
            exercises: (entry?.difficulty ?? []).map((rating, position) => ({
              name: `exercise ${position}`,
              difficultyRating: rating,
              feedback: entry?.notes?.[position] ?? null,
            })),
          })
          for (const reason of review?.reasons ?? []) reasons.add(reason)
        }
        const patient = patients.find((p) => p.key === assignment.patient)
        const careTeam = [
          patient?.createdBy,
          ...(patient?.alsoOnCareTeam ?? []),
        ]
        for (const review of assignment.reviews ?? []) {
          expect(review.session).toBeLessThan(sessions.length)
          expect(careTeam).toContain(review.by)
          if (careTeam.some((member) => member !== review.by)) {
            reviewedWithColleague = true
          }
        }
      }
      expect([...reasons].sort()).toEqual([
        'hard_exercise',
        'pain_high',
        'pain_rise',
        'patient_note',
      ])
      expect(reviewedWithColleague).toBe(true)
    },
  )

  it('gives only scores from 0 to 10', () => {
    const values = ASSIGNED_PROGRAMS.flatMap((a) => [
      ...(a.scores ?? []).flatMap((s) => [
        s.painBefore,
        s.painAfter,
        s.mobilityAfter,
      ]),
      ...(a.history.kind === 'weekdays' && a.history.stoppedBeforeMakeUp
        ? [
            a.history.stoppedBeforeMakeUp.painBefore,
            a.history.stoppedBeforeMakeUp.painAfter,
          ]
        : []),
    ])
    for (const value of values) {
      if (value !== null) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(10)
      }
    }
  })

  // What the demo is for: the charts' cases, each in the data — an
  // unanswered question (a gap in a line) and a session that made the pain
  // worse (after above before).
  it('includes an unanswered question and a session that made pain worse', () => {
    const all = ASSIGNED_PROGRAMS.flatMap((a) => a.scores ?? [])
    expect(all.some((s) => s.painBefore !== null && s.painAfter === null)).toBe(
      true,
    )
    expect(all.some((s) => s.painBefore === null && s.painAfter !== null)).toBe(
      true,
    )
    expect(
      all.some(
        (s) =>
          s.painBefore !== null &&
          s.painAfter !== null &&
          s.painAfter > s.painBefore,
      ),
    ).toBe(true)
  })

  // Step 2b-iii: only a closed program can be assigned again (the service
  // refuses an active one, and the seed would stop halfway) — and the demo
  // has one of each new thing for the screens: a swap, a cancelled program
  // that is continued.
  it('assigns again only a program it closes', () => {
    for (const assignment of ASSIGNED_PROGRAMS) {
      if (assignment.assignAgain) expect(assignment.close).toBeDefined()
    }
  })

  it('includes a day done early, a swap, and a cancelled program continued by another', () => {
    expect(
      ASSIGNED_PROGRAMS.some(
        (a) =>
          a.history.kind === 'weekdays' &&
          a.history.doneEarlyIndex !== undefined &&
          a.history.swappedWeek !== undefined,
      ),
    ).toBe(true)
    expect(
      ASSIGNED_PROGRAMS.some((a) => a.close === 'cancel' && a.assignAgain),
    ).toBe(true)
  })

  // The point of having several programs: dev data shows both kinds of
  // schedule (decisions §5) for the screens to be tried on.
  it('includes a program of each schedule type', () => {
    const types = new Set(ASSIGNED_PROGRAMS.map((a) => a.schedule.type))
    expect([...types].sort()).toEqual(['times_per_week', 'weekdays'])
  })
})

// The reviewers' guide describes this data; it must name every account
// and clinic, and give the password. (What it SAYS about them is prose —
// this only catches an account added, renamed or removed in one place.)
// The seeded conversations (Phase 5): what the seed and the database
// require of them, checked before anything is written.
describe('the seeded conversations', () => {
  const careTeamOf = (key: AccountKey) => {
    const patient = byKey.get(key)
    return patient?.kind === 'patient' ? currentCareTeam(patient) : []
  }
  // A moment as minutes before the seed's day ends — bigger = older.
  const age = (m: { daysAgo: number; at: string }) => {
    const [hours, minutes] = m.at.split(':').map(Number)
    return m.daysAgo * 24 * 60 - (hours * 60 + minutes)
  }

  it("pairs each patient with a practitioner on the patient's care team, once", () => {
    const pairs = CONVERSATIONS.map((c) => `${c.patient}-${c.practitioner}`)
    expect(new Set(pairs).size).toBe(pairs.length)
    for (const conversation of CONVERSATIONS) {
      expect(byKey.get(conversation.practitioner)?.kind).toBe('practitioner')
      expect(careTeamOf(conversation.patient)).toContain(
        conversation.practitioner,
      )
    }
  })

  // The database's CHECKs (0047) apply to the owner too: a bad message
  // would fail the seed halfway.
  it('writes only messages the database accepts, all in the past, in time order', () => {
    for (const { messages } of CONVERSATIONS) {
      expect(messages.length).toBeGreaterThan(0)
      for (const message of messages) {
        expect(message.body).toMatch(/\S/)
        expect(message.body.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH)
        expect(message.at).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
        expect(message.daysAgo).toBeGreaterThanOrEqual(1)
      }
      const ages = messages.map(age)
      expect([...ages].sort((a, b) => b - a)).toEqual(ages)
    }
  })

  // "Mark as read" reads everything at once: a message read while an
  // EARLIER one from the same person stayed unread can't happen.
  it("has each sender's read messages before their unread ones", () => {
    for (const { messages } of CONVERSATIONS) {
      for (const from of ['patient', 'practitioner'] as const) {
        const reads = messages.filter((m) => m.from === from).map((m) => m.read)
        expect(reads).toEqual([...reads].sort((a, b) => Number(b) - Number(a)))
      }
    }
  })

  it('shows an unread message for a patient and for a practitioner, and an archived conversation', () => {
    const unreadBy = (reader: 'patient' | 'practitioner') =>
      CONVERSATIONS.some((c) =>
        c.messages.some((m) => m.from !== reader && !m.read),
      )
    expect(unreadBy('patient')).toBe(true)
    expect(unreadBy('practitioner')).toBe(true)
    expect(CONVERSATIONS.some((c) => c.archivedBy)).toBe(true)
  })
})

// The seeded medical files (Phase 6): what the seed and the database
// (0049's CHECKs and foreign keys, which hold for the owner too) require of
// them, checked before anything is written.
describe('the seeded medical files', () => {
  const careTeamOf = (key: AccountKey) => {
    const patient = byKey.get(key)
    return patient?.kind === 'patient' ? currentCareTeam(patient) : []
  }
  // A moment as minutes before the seed's day ends — bigger = older.
  const age = (e: { daysAgo: number; at: string }) => {
    const [hours, minutes] = e.at.split(':').map(Number)
    return e.daysAgo * 24 * 60 - (hours * 60 + minutes)
  }

  it("has unique keys, and each author on the patient's care team", () => {
    const keys = MEDICAL_FILES.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of MEDICAL_FILES) {
      expect(byKey.get(entry.patient)?.kind).toBe('patient')
      expect(careTeamOf(entry.patient)).toContain(entry.author)
    }
  })

  it('writes only entries the database accepts, all in the past', () => {
    for (const entry of MEDICAL_FILES) {
      const sections = SOAP_SECTIONS.map((section) => entry[section]).filter(
        (text) => text !== undefined,
      )
      expect(sections.length).toBeGreaterThan(0)
      for (const text of sections) {
        expect(text).toMatch(/\S/)
        expect(text.length).toBeLessThanOrEqual(MEDICAL_FILE_SECTION_MAX_LENGTH)
      }
      expect(entry.at).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
      expect(entry.daysAgo).toBeGreaterThanOrEqual(1)
    }
  })

  // The seed writes in the dataset's order and needs the corrected entry's
  // id: it must come BEFORE, belong to the same patient (the composite
  // foreign key), be older, and be corrected only once (the unique index).
  it('amends only an earlier, older entry of the same patient, once each, with a reason', () => {
    const amended = new Set<string>()
    MEDICAL_FILES.forEach((entry, index) => {
      if (!entry.amends) return
      const earlier = MEDICAL_FILES.slice(0, index)
      const original = earlier.find((e) => e.key === entry.amends?.key)
      expect(original?.patient).toBe(entry.patient)
      expect(age(original!)).toBeGreaterThan(age(entry))
      expect(amended.has(entry.amends.key)).toBe(false)
      amended.add(entry.amends.key)
      expect(entry.amends.reason).toMatch(/\S/)
      expect(entry.amends.reason.length).toBeLessThanOrEqual(
        AMENDMENT_REASON_MAX_LENGTH,
      )
    })
  })

  it('shows every entry type and an amendment, for a patient who can log in', () => {
    expect(new Set(MEDICAL_FILES.map((e) => e.entryType))).toEqual(
      new Set(['initial_assessment', 'progress_note', 'discharge_summary']),
    )
    const amendment = MEDICAL_FILES.find((e) => e.amends)
    const patient = byKey.get(amendment!.patient)
    expect(patient?.kind === 'patient' && patient.invitation).toBe('accepted')
  })
})

// The two-factor demo (decisions §14): the seed turns it on the real way,
// then puts these in place — they must be what the app itself would accept.
describe('the two-factor demo', () => {
  it('is on for exactly one account, which can log in', () => {
    const withMfa = patients.filter((p) => p.twoFactor)
    expect(withMfa.map((p) => p.key)).toEqual(['casey'])
    expect(withMfa[0].invitation).toBe('accepted')
    expect(withMfa[0].deactivated).toBeUndefined()
  })

  // Base32 as authenticator apps read it; 32 symbols = 160 bits, like the
  // keys the app draws (otplib's default).
  it('has a base32 key of 32 symbols', () => {
    expect(DEMO_MFA_SECRET).toMatch(/^[A-Z2-7]{32}$/)
  })

  it('has as many recovery codes as the app makes, each one the app accepts as written', () => {
    expect(DEMO_RECOVERY_CODES).toHaveLength(RECOVERY_CODE_COUNT)
    expect(new Set(DEMO_RECOVERY_CODES).size).toBe(RECOVERY_CODE_COUNT)
    for (const code of DEMO_RECOVERY_CODES) {
      // Already in the stored form: what the hash is made from.
      expect(normaliseRecoveryCode(code)).toBe(code)
    }
  })
})

describe('docs/demo-accounts.md', () => {
  const doc = readFileSync(
    join(__dirname, '..', '..', 'docs', 'demo-accounts.md'),
    'utf8',
  )

  it.each(ACCOUNTS.map((a) => a.email))('lists %s', (email) => {
    expect(doc).toContain(`\`${email}\``)
  })

  it.each(CLINICS.map((c) => c.name))('names the clinic %s', (name) => {
    expect(doc).toContain(name)
  })

  it('gives the demo password', () => {
    expect(doc).toContain(`\`${DEMO_PASSWORD}\``)
  })

  it('gives the two-factor demo key and every recovery code', () => {
    expect(doc).toContain(`\`${DEMO_MFA_SECRET}\``)
    for (const code of DEMO_RECOVERY_CODES) {
      expect(doc).toContain(`\`${code}\``)
    }
  })

  // The other direction: no account in the doc that the seed doesn't make.
  it('lists no account the seed does not create', () => {
    const documented = doc.match(/`[a-z.]+@stride\.test`/g) ?? []
    const seeded = new Set(ACCOUNTS.map((a) => `\`${a.email}\``))
    expect(documented.filter((email) => !seeded.has(email))).toEqual([])
  })
})

// The seeded range of motion (Phase 7): what the seed and the database
// (0076's CHECKs and keys, 0077's triggers — which hold for the owner too)
// require of it, checked before anything is written.
describe('the seeded range of motion', () => {
  const careTeamOf = (key: AccountKey) => {
    const patient = byKey.get(key)
    return patient?.kind === 'patient' ? currentCareTeam(patient) : []
  }

  it("has unique keys, each author on the patient's care team, each note the patient's", () => {
    const keys = ROM_ASSESSMENTS.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const assessment of ROM_ASSESSMENTS) {
      expect(careTeamOf(assessment.patient)).toContain(assessment.author)
      if (assessment.note !== undefined) {
        expect(
          MEDICAL_FILES.find((entry) => entry.key === assessment.note)?.patient,
        ).toBe(assessment.patient)
      }
    }
  })

  it('writes only measurements the database accepts — each once, recorded on or after its day', () => {
    for (const assessment of ROM_ASSESSMENTS) {
      expect(assessment.measurements.length).toBeGreaterThan(0)
      expect(assessment.recordedDaysAgo).toBeGreaterThanOrEqual(1)
      expect(assessment.measuredDaysAgo).toBeGreaterThanOrEqual(
        assessment.recordedDaysAgo,
      )
      expect(assessment.at).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
      const kinds = assessment.measurements.map(
        (m) => `${m.movement}/${m.side ?? '-'}/${m.mode}`,
      )
      expect(new Set(kinds).size).toBe(kinds.length)
      for (const m of assessment.measurements) {
        expect(m.side !== undefined).toBe(SIDED_MOVEMENTS.includes(m.movement))
        expect(Number.isInteger(m.degrees)).toBe(true)
        expect(m.degrees).toBeGreaterThanOrEqual(LOWEST_DEGREES)
        expect(m.degrees).toBeLessThanOrEqual(highestDegrees(m.movement))
        if (m.note !== undefined) {
          expect(m.note).toMatch(/\S/)
          expect(m.note.length).toBeLessThanOrEqual(ROM_NOTE_MAX_LENGTH)
        }
      }
    }
  })

  it('amends only an earlier assessment of the same patient, once each, with a reason', () => {
    const amended = new Set<string>()
    ROM_ASSESSMENTS.forEach((assessment, index) => {
      if (!assessment.amends) return
      const original = ROM_ASSESSMENTS.slice(0, index).find(
        (a) => a.key === assessment.amends?.key,
      )
      expect(original?.patient).toBe(assessment.patient)
      expect(amended.has(assessment.amends.key)).toBe(false)
      amended.add(assessment.amends.key)
      expect(assessment.amends.reason).toMatch(/\S/)
      expect(assessment.amends.reason.length).toBeLessThanOrEqual(
        AMENDMENT_REASON_MAX_LENGTH,
      )
    })
    expect(amended.size).toBe(1)
  })
})

// The demo's sign-in card (decisions §46) lists four accounts by address and
// role, and a "Use" button signs straight in with the shared password. So
// each must be SEEDED, with exactly that one role (a second role would make
// the sign-in ask which — Morgan is left off the card for that reason), with
// a password (the founder, or an accepted invitation), active, and with
// two-factor on exactly when the card says so.
describe('the demo card accounts', () => {
  const roleOf = (account: (typeof ACCOUNTS)[number]) =>
    account.kind === 'founder'
      ? ['admin']
      : account.kind === 'practitioner'
        ? account.alsoAdmin
          ? ['practitioner', 'admin']
          : ['practitioner']
        : ['patient']

  it.each(DEMO_CARD_ACCOUNTS.map((card) => [card.email, card]))(
    '%s is seeded as the card says, ready to sign in',
    (_email, card) => {
      const seeded = ACCOUNTS.find((account) => account.email === card.email)
      expect(seeded).toBeDefined()
      expect(roleOf(seeded!)).toEqual([card.role])
      if (seeded!.kind !== 'founder') {
        expect(seeded!.invitation).toBe('accepted')
      }
      expect(seeded!.kind === 'patient' && seeded!.deactivated).toBeFalsy()
      expect(seeded!.kind === 'patient' && seeded!.twoFactor === true).toBe(
        card.twoFactor,
      )
    },
  )
})