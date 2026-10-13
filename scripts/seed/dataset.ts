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

// THE DEMO DATA — what `npm run seed:dev` creates, as plain data. The seed
// script (scripts/seed-dev.ts) walks these lists in order; the reviewers'
// guide (docs/dev-test-accounts.md) describes them, and dataset.spec.ts
// checks the two still match. Change the data here, then the doc.
//
// Every email ends in @stride.test: `.test` is reserved (RFC 2606) and can
// never receive mail, so even a misconfigured email transport can't write
// to a stranger.

import type { SeedHistory } from './session-history'

// --- TYPES -------------------------------------------------------------------------------------------------

export type ClinicKey = 'riverside' | 'harbour'
export type AccountKey =
  | 'admin'
  | 'morgan'
  | 'alex'
  | 'sam'
  | 'blake'
  | 'pat'
  | 'jo'
  | 'robin'
  | 'newPatient'
  | 'stuckPatient'
  | 'latePatient'
  | 'formerPatient'

// Where the account's invitation ends up — each a state the user page
// shows differently (decisions §3, "Invitations").
export type InvitationOutcome =
  | 'accepted' // password chosen: the account can log in
  | 'pending' // email really sent (to Mailpit): try the accept page
  | 'email-failed' // email "couldn't be sent": the amber warning
  | 'expired' // the 7 days are over: "Send a new invitation"

interface SeedClinic {
  key: ClinicKey
  name: string
  email: string
  phone: string
  addressLine1: string
  addressCity: string
  addressPostalCode: string
  addressCountry: string
}

interface AccountBase {
  key: AccountKey
  email: string
  firstName: string
  lastName: string
  // The first clinic is the one the account is created in; any others are
  // added afterwards by the admin (a clinic membership).
  clinics: ClinicKey[]
  // What a reviewer can see by logging in as this account — shown in the
  // seed's summary and in docs/dev-test-accounts.md.
  shows: string
}

// The founding admin: created through the one-time setup
// (AuthService.registerClinic), with its own password — the only account
// that isn't invited.
export interface FounderAccount extends AccountBase {
  kind: 'founder'
  position: string
}

export interface PractitionerAccount extends AccountBase {
  kind: 'practitioner'
  licenseNumber: string
  specialties: string[]
  invitation: 'accepted'
  // Roles granted on top of practitioner (the multi-role account).
  alsoAdmin?: { position: string }
}

export interface PatientAccount extends AccountBase {
  kind: 'patient'
  dateOfBirth: string
  // Who creates the patient — and so joins their care team (UsersService
  // .create). Must be a practitioner listed EARLIER, with a password.
  createdBy: AccountKey
  // Practitioners who join the care team afterwards ("Join care team").
  // Each must share a clinic with the patient.
  alsoOnCareTeam?: AccountKey[]
  invitation: InvitationOutcome
  // Deactivated by the admin after everything else (a former patient).
  deactivated?: boolean
}

export type SeedAccount = FounderAccount | PractitionerAccount | PatientAccount

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// One password for every account that has one. Published on purpose: this
// is demo data for reviewers, never real accounts.
export const DEMO_PASSWORD = 'password123'

export const CLINICS: SeedClinic[] = [
  {
    key: 'riverside',
    name: 'Riverside Physio',
    email: 'contact@riverside.stride.test',
    phone: '555-0100',
    addressLine1: '12 River Street',
    addressCity: 'Springfield',
    addressPostalCode: '62701',
    addressCountry: 'US',
  },
  {
    key: 'harbour',
    name: 'Harbour Sports Clinic',
    email: 'contact@harbour.stride.test',
    phone: '555-0200',
    addressLine1: '3 Quay Road',
    addressCity: 'Springfield',
    addressPostalCode: '62704',
    addressCountry: 'US',
  },
]

// In creation order: everyone who creates someone is created first.
export const ACCOUNTS: SeedAccount[] = [
  {
    kind: 'founder',
    key: 'admin',
    email: 'admin@stride.test',
    firstName: 'Avery',
    lastName: 'Admin',
    position: 'Clinic Director',
    clinics: ['riverside', 'harbour'],
    shows:
      'The founding admin, in both clinics: clinics, users and their invitations.',
  },
  {
    kind: 'practitioner',
    key: 'morgan',
    email: 'morgan@stride.test',
    firstName: 'Morgan',
    lastName: 'Reyes',
    licenseNumber: 'PT-SEED-001',
    specialties: ['Sports injuries'],
    alsoAdmin: { position: 'Lead Physiotherapist' },
    clinics: ['riverside'],
    invitation: 'accepted',
    shows: 'Practitioner AND admin: the role switcher in the account menu.',
  },
  {
    kind: 'practitioner',
    key: 'alex',
    email: 'alex@stride.test',
    firstName: 'Alex',
    lastName: 'Chen',
    licenseNumber: 'PT-SEED-002',
    specialties: ['Knee rehabilitation', 'Post-surgery'],
    clinics: ['riverside'],
    invitation: 'accepted',
    shows:
      'A practitioner with patients: custom exercises, two templates, and a program assigned to Pat (Programs page: Templates and Assigned tabs).',
  },
  {
    kind: 'practitioner',
    key: 'sam',
    email: 'sam@stride.test',
    firstName: 'Sam',
    lastName: 'Okafor',
    licenseNumber: 'PT-SEED-003',
    specialties: ['Lower back'],
    clinics: ['riverside'],
    invitation: 'accepted',
    shows:
      "Same clinic as Alex, but on the care team of Jo, Robin and Frank only: the directory-vs-clinical split (the directory search finds Pat, but Pat's page is refused).",
  },
  {
    kind: 'practitioner',
    key: 'blake',
    email: 'blake@stride.test',
    firstName: 'Blake',
    lastName: 'Martin',
    licenseNumber: 'PT-SEED-004',
    specialties: ['Shoulder'],
    clinics: ['harbour'],
    invitation: 'accepted',
    shows: 'Harbour only: shares just Robin with Riverside.',
  },
  {
    kind: 'patient',
    key: 'pat',
    email: 'pat@stride.test',
    firstName: 'Pat',
    lastName: 'Lee',
    dateOfBirth: '1988-04-12',
    createdBy: 'alex',
    clinics: ['riverside'],
    invitation: 'accepted',
    shows:
      "Alex's patient, with an assigned program (the patient's own screens come in Phase 4).",
  },
  {
    kind: 'patient',
    key: 'jo',
    email: 'jo@stride.test',
    firstName: 'Jo',
    lastName: 'Novak',
    dateOfBirth: '1975-09-30',
    createdBy: 'alex',
    alsoOnCareTeam: ['sam'],
    clinics: ['riverside'],
    invitation: 'accepted',
    shows: 'A care team of two: Alex and Sam.',
  },
  {
    kind: 'patient',
    key: 'robin',
    email: 'robin@stride.test',
    firstName: 'Robin',
    lastName: 'Silva',
    dateOfBirth: '1992-01-05',
    createdBy: 'sam',
    alsoOnCareTeam: ['blake'],
    clinics: ['riverside', 'harbour'],
    invitation: 'accepted',
    shows: 'In both clinics, with a care team in each: Sam and Blake.',
  },
  {
    kind: 'patient',
    key: 'newPatient',
    email: 'new.patient@stride.test',
    firstName: 'Nina',
    lastName: 'Fresh',
    dateOfBirth: '2000-06-15',
    createdBy: 'alex',
    clinics: ['riverside'],
    invitation: 'pending',
    shows:
      'A pending invitation whose email is in Mailpit (http://localhost:8025): open it and accept.',
  },
  {
    kind: 'patient',
    key: 'stuckPatient',
    email: 'stuck.patient@stride.test',
    firstName: 'Stu',
    lastName: 'Waiting',
    dateOfBirth: '1969-11-02',
    createdBy: 'alex',
    clinics: ['riverside'],
    invitation: 'email-failed',
    shows:
      "An invitation whose email couldn't be sent: the amber warning on the user page.",
  },
  {
    kind: 'patient',
    key: 'latePatient',
    email: 'late.patient@stride.test',
    firstName: 'Lena',
    lastName: 'Late',
    dateOfBirth: '1981-03-23',
    createdBy: 'alex',
    clinics: ['riverside'],
    invitation: 'expired',
    shows: 'An expired invitation: "Send a new invitation".',
  },
  {
    kind: 'patient',
    key: 'formerPatient',
    email: 'former.patient@stride.test',
    firstName: 'Frank',
    lastName: 'Former',
    dateOfBirth: '1958-08-08',
    createdBy: 'sam',
    clinics: ['riverside'],
    invitation: 'accepted',
    deactivated: true,
    shows:
      'A deactivated account: it can no longer log in; an admin can reactivate it.',
  },
]

// --- CONTENT -----------------------------------------------------------------------------------------------

// Alex's own exercises (the shared library comes from `npm run
// seed:exercises`, a separate command — see the seed script).
export const CUSTOM_EXERCISES = [
  {
    name: 'Terminal Knee Extension (band)',
    primaryMuscles: ['quadriceps'],
    equipment: ['bands'],
    instructions: [
      'Loop a resistance band behind your knee, anchored in front of you.',
      'Start with the knee slightly bent.',
      'Straighten the knee fully against the band, hold two seconds, release slowly.',
    ],
  },
  {
    name: 'Heel Slides',
    primaryMuscles: ['hamstrings'],
    secondaryMuscles: ['quadriceps'],
    equipment: ['body only'],
    instructions: [
      'Lie on your back with both legs straight.',
      'Slide the heel towards your buttocks, bending the knee as far as comfortable.',
      'Slide back to straight. Move slowly; stop before pain.',
    ],
  },
]

// An exercise in a template: either one of Alex's (custom) or one from
// the library, by its exact name. Library entries are skipped, with a
// note, when the library hasn't been imported.
export interface TemplateLine {
  exercise: { custom: string } | { library: string }
  sets?: number
  reps?: number
  durationInSeconds?: number
  notes?: string
}

// A workout of a template (decisions §5, "Settled 2026-10-10"): an optional
// name and its exercises, in order. The first one is A, the next B, …
export interface TemplateWorkout {
  name?: string
  lines: TemplateLine[]
}

// One template of each shape: the knee template has TWO named workouts
// (mobility on some days, strength on others); the back template is a
// single, unnamed workout — the shape every template had before workouts.
// Each knee workout starts with one of Alex's own exercises, so neither ends
// up empty when the library isn't imported (assigning refuses a template
// with an empty workout).
export const TEMPLATES: {
  title: string
  description: string
  workouts: TemplateWorkout[]
}[] = [
  {
    title: 'Knee Rehab — Phase 1',
    description:
      'First weeks after a knee injury: range of motion and quadriceps activation.',
    workouts: [
      {
        name: 'Mobility',
        lines: [
          { exercise: { custom: 'Heel Slides' }, sets: 3, reps: 10 },
          { exercise: { library: 'Knee Circles' }, sets: 2, reps: 10 },
        ],
      },
      {
        name: 'Strength',
        lines: [
          {
            exercise: { custom: 'Terminal Knee Extension (band)' },
            sets: 3,
            reps: 12,
          },
          {
            exercise: { library: 'Single Leg Glute Bridge' },
            sets: 3,
            reps: 8,
            notes: 'Keep the pelvis level.',
          },
        ],
      },
    ],
  },
  {
    title: 'Lower Back Mobility',
    description: 'Gentle daily mobility for non-specific lower back pain.',
    workouts: [
      {
        lines: [
          {
            exercise: { library: 'Pelvic Tilt Into Bridge' },
            sets: 2,
            reps: 10,
          },
          { exercise: { library: 'Cat Stretch' }, sets: 2, reps: 8 },
          { exercise: { library: "Child's Pose" }, durationInSeconds: 30 },
          { exercise: { library: 'Plank' }, sets: 3, durationInSeconds: 20 },
        ],
      },
    ],
  },
]

// A program's schedule, in the shape POST /assigned-programs takes
// (NewProgramScheduleDto): workouts named by POSITION in the template (0 =
// A), since the program — and so its workout ids — doesn't exist yet.
// Written as a union of the two kinds so a dataset entry can't mix them
// up: a 'weekdays' schedule MUST list its days and can't have a count, and
// the reverse. (The DTO checks the same at run time; this makes a wrong
// entry fail to compile.) No rotation = every workout in order.
export type SeedSchedule =
  | { type: 'weekdays'; days: { weekday: number; workoutIndex: number }[] }
  | { type: 'times_per_week'; timesPerWeek: number; rotation?: number[] }

// Assigned programs: a copy of a template given to a patient (by a
// practitioner on their care team), with its schedule (decisions §5).
// One of each schedule type, so both can be looked at.
//
// startsDaysAgo: the program's start date, counted back from the day the
// seed runs (0 = that day). Both started in the past, so their summaries
// already have days to judge — and Jo's program weeks don't line up with
// calendar weeks.
//
// history: completed sessions on past days (session-history.ts turns the
// plan into dates for the day the seed runs), so the program pages show
// done, made-up, done-early, swapped and missed days at once. Each session
// does the workout the schedule asks for (seedSessionWorkouts).
//
// close (step 2b-iii): the program is then cancelled or completed, on the
// day the seed runs, through the real service (so its end date follows the
// rules: yesterday). assignAgain: then continued as a new program ("Assign
// again"), starting that day — its workouts and exercises copied from the
// closed one.
export const ASSIGNED_PROGRAMS: {
  patient: AccountKey
  by: AccountKey
  template: string
  title: string
  startsDaysAgo: number
  schedule: SeedSchedule
  history: SeedHistory
  close?: 'cancel' | 'complete'
  assignAgain?: { title: string; schedule: SeedSchedule }
}[] = [
  {
    patient: 'pat',
    by: 'alex',
    template: 'Knee Rehab — Phase 1',
    title: 'Knee Rehab — Pat',
    // Three whole program weeks before the seed's day (a 7-day week always
    // holds three of Mon / Wed / Fri, whatever the weekday): room for one
    // of each kind of day.
    startsDaysAgo: 21,
    // ISO weekdays: Mobility (A) on Mondays and Fridays, Strength (B) on
    // Wednesdays.
    schedule: {
      type: 'weekdays',
      days: [
        { weekday: 1, workoutIndex: 0 },
        { weekday: 3, workoutIndex: 1 },
        { weekday: 5, workoutIndex: 0 },
      ],
    },
    // Every scheduled day done, except: week 1, the 2nd (made up the next
    // day); week 2, the 4th (missed) and the 5th (DONE EARLY, on the free
    // day before it); week 3, two days that SWAP their workouts.
    history: {
      kind: 'weekdays',
      madeUpIndex: 1,
      missedIndex: 3,
      doneEarlyIndex: 4,
      swappedWeek: 2,
    },
  },
  {
    patient: 'jo',
    // Sam, not Alex (whose template it is): Jo has a care team of two, and
    // a program assigned by the colleague shows "Assigned by Sam" to Alex.
    by: 'sam',
    template: 'Lower Back Mobility',
    title: 'Lower Back Mobility — Jo',
    startsDaysAgo: 10,
    // No rotation given: every workout in order — this template has one,
    // so every session is A.
    schedule: { type: 'times_per_week', timesPerWeek: 3 },
    // First program week: 2 of 3 (one missed). Second week (today is its
    // 4th day): 1 so far, in progress.
    history: { kind: 'days-after-start', days: [0, 2, 8] },
  },
  {
    patient: 'robin',
    // Sam (Riverside) — Robin's other practitioner, Blake, is at Harbour.
    by: 'sam',
    template: 'Knee Rehab — Phase 1',
    title: 'Knee Rehab — Robin',
    startsDaysAgo: 21,
    // Twice a week, the suggested rotation: A, B, A, B…
    schedule: { type: 'times_per_week', timesPerWeek: 2 },
    // Two weeks done (A and B each), then nothing: the third week missed.
    history: { kind: 'days-after-start', days: [0, 3, 8, 10] },
    // Cancelled (it has sessions, so it stays, read-only) and continued.
    close: 'cancel',
    assignAgain: {
      title: 'Knee Rehab — Robin, block 2',
      schedule: { type: 'times_per_week', timesPerWeek: 2 },
    },
  },
]