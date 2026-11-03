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
// guide (docs/demo-accounts.md) describes them, and dataset.spec.ts
// checks the two still match. Change the data here, then the doc.
//
// Every email ends in @stride.test: `.test` is reserved (RFC 2606) and can
// never receive mail, so even a misconfigured email transport can't write
// to a stranger.

import type { SeedHistory, SeedScores } from './session-history'
import type {
  RomMode,
  RomMovement,
  RomSide,
} from '../../src/range-of-motion/movement-catalogue'

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
  | 'casey'
  | 'newPatient'
  | 'stuckPatient'
  | 'latePatient'
  | 'formerPatient'
  | 'taylor'
  | 'dana'

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
  // seed's summary and in docs/demo-accounts.md.
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
  // What the patient's Team page shows under the name (decided 2026-10-18).
  // Optional, like the real profile field: Blake is left without one — he
  // is on Robin's care team, so the page's no-bio case shows straight away.
  bio?: string
  invitation: 'accepted'
  // Roles granted on top of practitioner (the multi-role account).
  alsoAdmin?: { position: string }
  // Removed from every clinic by the admin once created (decisions §17): an
  // active practitioner in NO clinic — one of the admin home's "needs
  // attention" groups. Must create nobody and be on nobody's care team
  // (a removal ends the links left without a shared clinic).
  removedFromClinics?: boolean
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
  // Practitioners who LEAVE the care team afterwards ("End", as
  // themselves — decisions §17): their link ends, and stays in the care
  // team's history. Leaving them all makes a patient nobody treats: the
  // admin home's other "needs attention" group.
  leftCareTeam?: AccountKey[]
  invitation: InvitationOutcome
  // Deactivated by the admin after everything else (a former patient).
  deactivated?: boolean
  // Two-factor sign-in turned on, with the published demo key and recovery
  // codes below (decisions §14) — so a reviewer can try the sign-in step.
  twoFactor?: boolean
}

export type SeedAccount = FounderAccount | PractitionerAccount | PatientAccount

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The published demo data — the shared password, the two-factor key and
// recovery codes — lives in src/demo/demo-accounts.ts since 2026-11-02 (the
// running app's demo card publishes them too: decisions §46). Re-exported
// here so the seed and its spec keep importing them from the dataset.
export {
  DEMO_MFA_SECRET,
  DEMO_PASSWORD,
  DEMO_RECOVERY_CODES,
} from '../../src/demo/demo-accounts'

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
    bio: 'Sports injuries of every kind, from sprained ankles to torn ligaments. Before Riverside I worked with a regional swimming team.',
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
    bio: 'Physiotherapist for twelve years, most of them helping people back on their feet after knee surgery. I build programs around what you want to get back to — stairs, running, your garden.',
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
    bio: 'I work with people living with back pain, from a first episode to pain that has lasted years. Expect gentle, regular movement and honest explanations of what is going on.',
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
    kind: 'practitioner',
    key: 'taylor',
    email: 'taylor@stride.test',
    firstName: 'Taylor',
    lastName: 'Kim',
    licenseNumber: 'PT-SEED-005',
    specialties: ['Hand therapy'],
    bio: 'Hand and wrist rehabilitation, after fractures, surgery or long hours at a keyboard.',
    clinics: ['harbour'],
    removedFromClinics: true,
    invitation: 'accepted',
    shows:
      'Removed from Harbour by the admin, so in no clinic: on the admin home\'s "Needs attention".',
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
    key: 'casey',
    email: 'casey@stride.test',
    firstName: 'Casey',
    lastName: 'Moreau',
    dateOfBirth: '1984-11-02',
    createdBy: 'alex',
    clinics: ['riverside'],
    invitation: 'accepted',
    twoFactor: true,
    shows:
      'Two-factor sign-in on: logging in asks for a code (the demo key, or a recovery code).',
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
  {
    kind: 'patient',
    key: 'dana',
    email: 'dana@stride.test',
    firstName: 'Dana',
    lastName: 'Ortiz',
    dateOfBirth: '1979-07-19',
    createdBy: 'sam',
    leftCareTeam: ['sam'],
    clinics: ['riverside'],
    invitation: 'accepted',
    shows:
      'Sam left Dana\'s care team, so nobody treats her: on the admin home\'s "Needs attention" (her Team page shows Sam as a past member).',
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

// What a patient rated and wrote during one seeded session (the To-do,
// 2026-10-19). `difficulty` and `notes` follow the session's CHECKLIST, in
// its order (null = not rated, no note) — by position rather than by name,
// because which workout a session did depends on the weekday the seed runs
// (Pat's swap). A checklist shorter than the list (the library not
// imported) simply ignores the extra entries.
export interface SeedFeedback {
  session: number
  difficulty: (number | null)[]
  notes?: (string | null)[]
  sessionFeedback?: string
}

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
// scores (the progress page, 2026-10-18): each completed session's pain
// before / after and mobility after, in day order — one entry per session
// of `history` (seedSessionScores refuses any other count), `null` where
// the patient didn't answer. Written so each chart has something to say:
// pain easing over the weeks, each session relieving it a little, mobility
// rising — and the cases the charts must draw honestly: a question left
// unanswered (a gap), sessions that made pain WORSE (Robin's: the reason
// before / after are never averaged, decisions §6).
//
// feedback and reviews (the practitioner's To-do, 2026-10-19): what the
// patient rated and wrote during chosen sessions, and which practitioner has
// already marked a session reviewed — so the To-do has one case of each
// kind to show (decisions §3). `session` is a position in the program's
// seeded sessions, as for `scores`.
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
  scores?: SeedScores[]
  feedback?: SeedFeedback[]
  reviews?: { session: number; by: AccountKey }[]
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
    // Every scheduled day done, except: week 1, the 2nd (a session STOPPED
    // for pain that day, then made up the next day); week 2, the 4th
    // (SKIPPED for illness — missed) and the 5th (DONE EARLY, on the free day
    // before it); week 3, two days that SWAP their workouts.
    history: {
      kind: 'weekdays',
      madeUpIndex: 1,
      missedIndex: 3,
      doneEarlyIndex: 4,
      swappedWeek: 2,
      skippedMissed: 'illness',
      stoppedBeforeMakeUp: { reason: 'pain', painBefore: 5, painAfter: 7 },
    },
    // Its 8 sessions (the 9 scheduled days but the missed one): pain easing
    // from 6 to 3 before, and lower after each session; the session done
    // early answered the check-in only (no pain after, no mobility: gaps).
    scores: [
      { painBefore: 6, painAfter: 5, mobilityAfter: 4 },
      { painBefore: 5, painAfter: 4, mobilityAfter: 4 },
      { painBefore: 6, painAfter: 4, mobilityAfter: 5 },
      { painBefore: 5, painAfter: null, mobilityAfter: null },
      { painBefore: 5, painAfter: 3, mobilityAfter: 5 },
      { painBefore: 4, painAfter: 3, mobilityAfter: 6 },
      { painBefore: 4, painAfter: 2, mobilityAfter: 6 },
      { painBefore: 3, painAfter: 2, mobilityAfter: 7 },
    ],
    // The To-do: the LAST session (always within the last 14 days) rated its
    // second exercise 9 of 10, with a question — a session for Alex to
    // review ("hard exercise", "the patient wrote something").
    feedback: [
      {
        session: 7,
        difficulty: [4, 9],
        notes: [
          null,
          'Sharp pain at the end of the movement. Should I stop earlier?',
        ],
      },
    ],
  },
  {
    patient: 'jo',
    // Sam, not Alex (whose template it is): Jo has a care team of two, and
    // a program assigned by the colleague shows "Assigned by Sam" to Alex.
    by: 'sam',
    template: 'Lower Back Mobility',
    title: 'Lower Back Mobility — Jo',
    startsDaysAgo: 17,
    // No rotation given: every workout in order — this template has one,
    // so every session is A.
    schedule: { type: 'times_per_week', timesPerWeek: 3 },
    // First program week: 2 of 3 (missed). Second week: 1 of 3 (missed) —
    // two weeks in a row below target, an attendance alert on Alex's and
    // Sam's To-do (changed 2026-10-19; it was 10 days and one missed week).
    // Third week (today is its 4th day): 1 so far, in progress.
    history: { kind: 'days-after-start', days: [0, 2, 8, 15] },
    // The second session skipped the check-in (no pain before: a gap).
    scores: [
      { painBefore: 7, painAfter: 6, mobilityAfter: 3 },
      { painBefore: null, painAfter: 6, mobilityAfter: 4 },
      { painBefore: 6, painAfter: 5, mobilityAfter: 4 },
      { painBefore: 6, painAfter: 5, mobilityAfter: 5 },
    ],
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
    // Every session made the pain WORSE — the before / after gap the charts
    // exist to show (an average of the two would hide it). The last one,
    // 11 days before the seed's day, from 3 to 7 (changed 2026-10-19; it was
    // 4 → 6): high pain after AND a rise of 4 — a session to review.
    scores: [
      { painBefore: 3, painAfter: 5, mobilityAfter: 5 },
      { painBefore: 4, painAfter: 5, mobilityAfter: 5 },
      { painBefore: 3, painAfter: 4, mobilityAfter: 4 },
      { painBefore: 3, painAfter: 7, mobilityAfter: 3 },
    ],
    // … which SAM has already reviewed, and Blake hasn't: a review is one
    // practitioner's (decided 2026-10-19), so the session is on Blake's
    // To-do only — and its page shows Blake "Reviewed by Sam Okafor".
    reviews: [{ session: 3, by: 'sam' }],
    // Cancelled (it has sessions, so it stays, read-only) and continued.
    close: 'cancel',
    assignAgain: {
      title: 'Knee Rehab — Robin, block 2',
      schedule: { type: 'times_per_week', timesPerWeek: 2 },
    },
  },
]

// --- MESSAGES (Phase 5) ------------------------------------------------------------------------------------

// One message of a seeded conversation. Written as the database OWNER with
// a past moment (the API stamps every message with now(), and a demo
// conversation needs a history), like the session history above.
export interface SeedMessage {
  from: 'patient' | 'practitioner'
  // When: this many days before the seed's day, at this UTC time. Never the
  // seed's own day (0): the seed may run at 06:00 UTC, and a message "at
  // 21:00 today" would be in the future.
  daysAgo: number
  at: string
  body: string
  // Read by the other person, 30 minutes after it was sent — or not yet
  // (an unread count and a "Seen" missing, on the screens).
  read: boolean
}

export interface SeedConversation {
  patient: AccountKey
  // On the patient's care team: starting a conversation needs it (the
  // service refuses otherwise — and so does the database).
  practitioner: AccountKey
  // Archived by one side, after its messages (decided 2026-10-20: a NEW
  // message would bring it back).
  archivedBy?: 'patient' | 'practitioner'
  messages: SeedMessage[]
}

export const CONVERSATIONS: SeedConversation[] = [
  {
    // Pat and Alex: an exchange over the last days, Alex's last two
    // messages still unread — Pat's Messages tab shows a badge of 2.
    patient: 'pat',
    practitioner: 'alex',
    messages: [
      {
        from: 'practitioner',
        daysAgo: 4,
        at: '09:15',
        body: "Hi Pat, I've added a strength workout on Wednesdays. Start with the lighter band.",
        read: true,
      },
      {
        from: 'patient',
        daysAgo: 4,
        at: '18:40',
        body: 'Thanks! Should I still ice the knee after each session?',
        read: true,
      },
      {
        from: 'practitioner',
        daysAgo: 3,
        at: '08:05',
        body: 'Yes, 10 to 15 minutes if it feels warm.',
        read: true,
      },
      {
        from: 'patient',
        daysAgo: 1,
        at: '19:20',
        body: 'The last exercise gave me a sharp pain at the end of the movement. I left a note on the session.',
        read: true,
      },
      {
        from: 'practitioner',
        daysAgo: 1,
        at: '21:00',
        body: 'I saw it, thank you. Stop a little before that point for now, and we will look at it together on Friday.',
        read: false,
      },
      {
        from: 'practitioner',
        daysAgo: 1,
        at: '21:02',
        body: 'And skip the band for that one until then.',
        read: false,
      },
    ],
  },
  {
    // Jo and Sam: Jo's question waits for Sam — Sam's practitioner home
    // shows "1 unread".
    patient: 'jo',
    practitioner: 'sam',
    messages: [
      {
        from: 'practitioner',
        daysAgo: 6,
        at: '10:00',
        body: 'Hi Jo, how are the mobility exercises going?',
        read: true,
      },
      {
        from: 'patient',
        daysAgo: 2,
        at: '20:10',
        body: 'Sorry, I missed a few sessions, work has been busy. Could we make the program shorter for a couple of weeks?',
        read: false,
      },
    ],
  },
  {
    // Robin and Blake: an old, finished exchange that Robin archived —
    // "Show 1 archived conversation" on Robin's list.
    patient: 'robin',
    practitioner: 'blake',
    archivedBy: 'patient',
    messages: [
      {
        from: 'practitioner',
        daysAgo: 9,
        at: '11:30',
        body: 'Hi Robin, your next appointment at Harbour is confirmed for Thursday at 10.',
        read: true,
      },
      {
        from: 'patient',
        daysAgo: 9,
        at: '12:05',
        body: 'Great, thank you!',
        read: true,
      },
    ],
  },
]

// --- MEDICAL FILES (Phase 6) -------------------------------------------------------------------------------

// One entry of a patient's medical file — a SOAP note (decided 2026-10-20).
// Written as the database OWNER with a past moment: the app stamps an entry
// with now() (0050's trigger, which exempts the owner), and a demo file
// needs a history. The CHECKs of 0049 hold for the owner too — the dataset
// spec tries every entry against the same rules first.
export interface SeedMedicalEntry {
  // A name for this entry, so an amendment can say which one it corrects.
  key: string
  patient: AccountKey
  // On the patient's care team (the API would refuse anyone else).
  author: AccountKey
  // When: this many days before the seed's day, at this UTC time — never
  // the seed's own day (the same reason as the messages).
  daysAgo: number
  at: string
  entryType: 'initial_assessment' | 'progress_note' | 'discharge_summary'
  subjective?: string
  objective?: string
  assessment?: string
  plan?: string
  // An amendment: the key of the EARLIER entry of the same patient it
  // corrects (each entry corrected at most once), and why.
  amends?: { key: string; reason: string }
}

export const MEDICAL_FILES: SeedMedicalEntry[] = [
  {
    // Pat's first visit, the day the knee program started (21 days ago).
    key: 'pat-initial',
    patient: 'pat',
    author: 'alex',
    daysAgo: 21,
    at: '09:00',
    entryType: 'initial_assessment',
    subjective:
      'Right knee pain for 3 months, worse on stairs and after sitting. Pain 6/10 at worst. Goal: return to weekend hiking.',
    objective:
      'Right knee flexion 110°, extension full. Mild effusion. Pain on resisted knee extension. Single-leg squat: knee drifts inward.',
    assessment:
      'Patellofemoral pain, right knee, with reduced quadriceps and hip strength.',
    plan: 'Home program: Knee Rehab — Phase 1 (mobility and strength, 3 days a week). Ice after sessions if warm. Review in 10 days.',
  },
  {
    // A follow-up with a mistake in it: the LEFT knee recorded…
    key: 'pat-review',
    patient: 'pat',
    author: 'alex',
    daysAgo: 11,
    at: '09:30',
    entryType: 'progress_note',
    subjective:
      'Stairs easier. Pain 4/10 at worst. Missed one session (illness).',
    objective: 'Left knee flexion 120°, no effusion.',
    assessment: 'Progressing as expected.',
    plan: 'Continue the program; add the strength workout on Wednesdays.',
  },
  {
    // …corrected the same morning by an AMENDMENT: a complete new version,
    // pointing at the old one — which stays, marked as amended.
    key: 'pat-review-corrected',
    patient: 'pat',
    author: 'alex',
    daysAgo: 11,
    at: '11:15',
    entryType: 'progress_note',
    subjective:
      'Stairs easier. Pain 4/10 at worst. Missed one session (illness).',
    objective: 'Right knee flexion 120°, no effusion.',
    assessment: 'Progressing as expected.',
    plan: 'Continue the program; add the strength workout on Wednesdays.',
    amends: {
      key: 'pat-review',
      reason: 'The wrong knee was recorded: the right knee was measured.',
    },
  },
  {
    // A short note with only two sections — the others are optional.
    key: 'pat-pain-note',
    patient: 'pat',
    author: 'alex',
    daysAgo: 1,
    at: '21:10',
    entryType: 'progress_note',
    subjective:
      'Sharp pain at the end of the movement in the last session (noted on the session, 9/10 difficulty).',
    plan: "Stop short of the painful range and skip the band until Friday's visit; reassess then.",
  },
  {
    // Jo, assessed by Sam when the back program started (17 days ago).
    key: 'jo-initial',
    patient: 'jo',
    author: 'sam',
    daysAgo: 17,
    at: '14:00',
    entryType: 'initial_assessment',
    subjective:
      'Low back stiffness in the mornings for 6 weeks, desk job. No leg symptoms.',
    objective:
      'Lumbar flexion limited to mid-shin, painless. Neurological screen normal.',
    assessment: 'Non-specific low back pain, mechanical.',
    plan: 'Lower Back Mobility, 3 times a week. Walk daily. Review in 3 weeks.',
  },
  {
    // Robin: two clinics, two authors — and a first block that ended.
    key: 'robin-initial',
    patient: 'robin',
    author: 'sam',
    daysAgo: 21,
    at: '10:30',
    entryType: 'initial_assessment',
    subjective: 'Left knee pain after a fall while running, 4 weeks ago.',
    objective: 'Left knee flexion 100°. Ligament tests negative.',
    assessment: 'Knee sprain, recovering.',
    plan: 'Knee Rehab twice a week.',
  },
  {
    key: 'robin-discharge',
    patient: 'robin',
    author: 'sam',
    daysAgo: 1,
    at: '16:00',
    entryType: 'discharge_summary',
    assessment:
      'First block stopped: pain rose after every session (3 to 7 at the last). Not progressing on this program.',
    plan: 'Block cancelled; a lighter second block assigned. Blake to review at Harbour.',
  },
  {
    key: 'robin-harbour',
    patient: 'robin',
    author: 'blake',
    daysAgo: 1,
    at: '17:30',
    entryType: 'progress_note',
    subjective: 'Pain 5/10 after sessions, mostly when going downhill.',
    plan: 'Review the second block after its first week.',
  },
]

// --- RANGE OF MOTION (Phase 7) -----------------------------------------------------------------------------

// One measurement of a seeded assessment — the API's shape.
export interface SeedRomMeasurement {
  movement: RomMovement
  side?: RomSide
  mode: RomMode
  degrees: number
  note?: string
}

// One range-of-motion assessment. Written as the database OWNER with a past
// moment, like the medical file (0077's clock trigger exempts the owner) —
// and, like every writer, with its measurements in ONE transaction: the
// "at least one measurement" check (0077) runs at commit for the owner too.
export interface SeedRomAssessment {
  key: string
  patient: AccountKey
  // On the patient's care team (the API would refuse anyone else).
  author: AccountKey
  // The clinical day: this many days before the seed's day…
  measuredDaysAgo: number
  // …and when it was typed in: this many days ago, at this UTC time — the
  // same day or LATER (the CHECK rom_assessments_measured_by_recording).
  recordedDaysAgo: number
  at: string
  // The medical file entry of the same visit (a MEDICAL_FILES key).
  note?: string
  // An amendment: the key of the EARLIER assessment it corrects, and why.
  amends?: { key: string; reason: string }
  measurements: SeedRomMeasurement[]
}

// Pat's right knee, as the notes tell it (MEDICAL_FILES): 110° of flexion at
// the first visit, 120° at the review — the left knee, measured too, is the
// comparison. Three visits make a trend a chart can show; the review's
// assessment has a typing mistake corrected the same morning (an
// amendment); the latest was taken at Friday's visit and typed in the next
// day, with no note (the link is optional). Jo's back shows the movements
// measured without a side.
export const ROM_ASSESSMENTS: SeedRomAssessment[] = [
  {
    key: 'pat-rom-initial',
    patient: 'pat',
    author: 'alex',
    measuredDaysAgo: 21,
    recordedDaysAgo: 21,
    at: '09:20',
    note: 'pat-initial',
    measurements: [
      { movement: 'knee_flexion', side: 'right', mode: 'active', degrees: 110 },
      {
        movement: 'knee_flexion',
        side: 'right',
        mode: 'passive',
        degrees: 118,
        note: 'pain at end range',
      },
      { movement: 'knee_extension', side: 'right', mode: 'active', degrees: 0 },
      { movement: 'knee_flexion', side: 'left', mode: 'active', degrees: 138 },
      { movement: 'knee_extension', side: 'left', mode: 'active', degrees: 0 },
    ],
  },
  {
    // 102° typed for 120°…
    key: 'pat-rom-review',
    patient: 'pat',
    author: 'alex',
    measuredDaysAgo: 11,
    recordedDaysAgo: 11,
    at: '09:40',
    note: 'pat-review-corrected',
    measurements: [
      { movement: 'knee_flexion', side: 'right', mode: 'active', degrees: 102 },
      {
        movement: 'knee_flexion',
        side: 'right',
        mode: 'passive',
        degrees: 126,
      },
      { movement: 'knee_flexion', side: 'left', mode: 'active', degrees: 138 },
    ],
  },
  {
    // …corrected by an amendment: a complete new version.
    key: 'pat-rom-review-corrected',
    patient: 'pat',
    author: 'alex',
    measuredDaysAgo: 11,
    recordedDaysAgo: 11,
    at: '11:20',
    note: 'pat-review-corrected',
    amends: {
      key: 'pat-rom-review',
      reason: 'Right knee flexion was typed as 102°; it measured 120°.',
    },
    measurements: [
      { movement: 'knee_flexion', side: 'right', mode: 'active', degrees: 120 },
      {
        movement: 'knee_flexion',
        side: 'right',
        mode: 'passive',
        degrees: 126,
      },
      { movement: 'knee_flexion', side: 'left', mode: 'active', degrees: 138 },
    ],
  },
  {
    key: 'pat-rom-friday',
    patient: 'pat',
    author: 'alex',
    measuredDaysAgo: 4,
    recordedDaysAgo: 3,
    at: '08:15',
    measurements: [
      { movement: 'knee_flexion', side: 'right', mode: 'active', degrees: 126 },
      {
        movement: 'knee_flexion',
        side: 'right',
        mode: 'passive',
        degrees: 131,
      },
      { movement: 'knee_extension', side: 'right', mode: 'active', degrees: 0 },
      { movement: 'knee_flexion', side: 'left', mode: 'active', degrees: 139 },
    ],
  },
  {
    key: 'jo-rom-initial',
    patient: 'jo',
    author: 'sam',
    measuredDaysAgo: 17,
    recordedDaysAgo: 17,
    at: '14:20',
    note: 'jo-initial',
    measurements: [
      {
        movement: 'thoracolumbar_flexion',
        mode: 'active',
        degrees: 50,
        note: 'fingertips to mid-shin',
      },
      { movement: 'thoracolumbar_extension', mode: 'active', degrees: 15 },
      {
        movement: 'thoracolumbar_lateral_flexion',
        side: 'left',
        mode: 'active',
        degrees: 25,
      },
      {
        movement: 'thoracolumbar_lateral_flexion',
        side: 'right',
        mode: 'active',
        degrees: 30,
      },
    ],
  },
]