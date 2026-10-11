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
import { seedSessionDays, seedSessionWorkouts } from './session-history'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCOUNTS,
  ASSIGNED_PROGRAMS,
  CLINICS,
  CUSTOM_EXERCISES,
  DEMO_PASSWORD,
  TEMPLATES,
  type AccountKey,
  type PatientAccount,
} from './dataset'

// The rules the seed script RELIES ON, checked here so a bad edit to the
// data fails in a second — not halfway through a seed, against a
// half-filled database.

const byKey = new Map(ACCOUNTS.map((account) => [account.key, account]))
const patients = ACCOUNTS.filter(
  (a): a is PatientAccount => a.kind === 'patient',
)
const positionOf = (key: AccountKey) => ACCOUNTS.findIndex((a) => a.key === key)

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
      const careTeam = [patient?.createdBy, ...(patient?.alsoOnCareTeam ?? [])]
      expect(careTeam).toContain(assignment.by)
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

  // Step 2b-iii: only a closed program can be assigned again (the service
  // refuses an active one, and the seed would stop halfway) — and the demo
  // has one of each new thing for the screens: a swap, a cancelled program
  // that is continued.
  it('assigns again only a program it closes', () => {
    for (const assignment of ASSIGNED_PROGRAMS) {
      if (assignment.assignAgain) expect(assignment.close).toBeDefined()
    }
  })

  it('includes a swap, and a cancelled program continued by another', () => {
    expect(
      ASSIGNED_PROGRAMS.some(
        (a) =>
          a.history.kind === 'weekdays' && a.history.swappedIndex !== undefined,
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
describe('docs/dev-test-accounts.md', () => {
  const doc = readFileSync(
    join(__dirname, '..', '..', 'docs', 'dev-test-accounts.md'),
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

  // The other direction: no account in the doc that the seed doesn't make.
  it('lists no account the seed does not create', () => {
    const documented = doc.match(/`[a-z.]+@stride\.test`/g) ?? []
    const seeded = new Set(ACCOUNTS.map((a) => `\`${a.email}\``))
    expect(documented.filter((email) => !seeded.has(email))).toEqual([])
  })
})