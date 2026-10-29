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

import {
  buildRecordDocument,
  dayText,
  disclosureStampText,
  doseText,
  durationText,
  groupIntoNotes,
  momentText,
  sessionOutcome,
  workoutLabel,
  type DisclosureStamp,
  type PrescribedExercise,
  type RecordBlock,
  type RecordData,
  type RecordProgram,
  type RecordSession,
  type SessionExerciseRecord,
} from './record-content'
import type { MedicalFileEntry } from '../medical-files/medical-files.service'

// --- FIXTURES ----------------------------------------------------------------------------------------------

// Far from today (2031), so no test depends on the day it runs.
const PARIS = 'Europe/Paris'
const MONTREAL = 'America/Montreal'

function entry(
  id: number,
  createdAt: string,
  overrides: Partial<MedicalFileEntry> = {},
): MedicalFileEntry {
  return {
    id,
    patientId: 7,
    entryType: 'progress_note',
    subjective: null,
    objective: null,
    assessment: null,
    plan: `Plan ${id}`,
    createdAt: new Date(createdAt),
    author: { id: 3, firstName: 'Alex', lastName: 'Chen' },
    amendsId: null,
    amendmentReason: null,
    amendedById: null,
    ...overrides,
  }
}

function exercise(
  overrides: Partial<PrescribedExercise> = {},
): PrescribedExercise {
  return {
    name: 'Bridges',
    sets: null,
    reps: null,
    durationInSeconds: null,
    weight: null,
    weightUnit: null,
    notes: null,
    ...overrides,
  }
}

function sessionExercise(
  overrides: Partial<SessionExerciseRecord> = {},
): SessionExerciseRecord {
  return {
    ...exercise({ sets: 3, reps: 10 }),
    completed: true,
    durationActualInSeconds: null,
    difficultyRating: null,
    feedback: null,
    ...overrides,
  }
}

function session(overrides: Partial<RecordSession> = {}): RecordSession {
  return {
    id: 1,
    workoutId: 11,
    localDate: '2031-03-10',
    status: 'completed',
    totalDurationInSeconds: null,
    painBefore: null,
    painAfter: null,
    mobilityAfter: null,
    sessionFeedback: null,
    endReason: null,
    endNote: null,
    exercises: [],
    ...overrides,
  }
}

function program(overrides: Partial<RecordProgram> = {}): RecordProgram {
  return {
    id: 1,
    title: 'Knee Rehab',
    status: 'active',
    startDate: '2031-03-03',
    endDate: null,
    assignedBy: { firstName: 'Alex', lastName: 'Chen' },
    workouts: [
      { id: 11, name: 'Mobility', exercises: [] },
      { id: 12, name: null, exercises: [] },
    ],
    sessions: [],
    ...overrides,
  }
}

function record(overrides: Partial<RecordData> = {}): RecordData {
  return {
    patient: {
      firstName: 'Pat',
      lastName: 'Lee',
      email: 'pat@example.com',
      dateOfBirth: '1988-04-12',
    },
    medicalFile: [],
    programs: [],
    // 23:30 UTC: already the 15th in Paris, still the 14th in Montreal.
    madeAt: new Date('2031-03-14T23:30:00Z'),
    ...overrides,
  }
}

// The blocks between two headings' texts (the second excluded) — one part
// of the document, to compare whole.
function partBetween(
  blocks: RecordBlock[],
  from: string,
  to?: string,
): RecordBlock[] {
  const start = blocks.findIndex(
    (block) => block.kind === 'heading' && block.text === from,
  )
  const end =
    to === undefined
      ? blocks.length
      : blocks.findIndex(
          (block) => block.kind === 'heading' && block.text === to,
        )
  expect([start, end].every((index) => index >= 0)).toBe(true)
  return blocks.slice(start, end)
}

// --- DATES AND NUMBERS -------------------------------------------------------------------------------------

describe('dayText', () => {
  // A day is a day everywhere: read and written in UTC, so the Montreal
  // machine running this in the evening can't turn it into the day before.
  it('writes a day as it is, whatever the machine’s zone', () => {
    expect(dayText('2031-01-01')).toBe('January 1, 2031')
    expect(dayText('2031-12-31')).toBe('December 31, 2031')
  })
})

describe('momentText', () => {
  it('writes a moment in the zone it is given', () => {
    const moment = new Date('2031-03-14T23:30:00Z')
    expect(momentText(moment, PARIS)).toBe('March 15, 2031 at 12:30 AM')
    expect(momentText(moment, MONTREAL)).toBe('March 14, 2031 at 7:30 PM')
  })
})

describe('durationText', () => {
  it.each([
    [0, '0 s'],
    [45, '45 s'],
    [60, '1 min'],
    [90, '1 min 30 s'],
    [600, '10 min'],
  ])('writes %i seconds as "%s"', (seconds, text) => {
    expect(durationText(seconds)).toBe(text)
  })
})

describe('doseText', () => {
  it.each<[string, Partial<PrescribedExercise>, string | null]>([
    ['sets of reps', { sets: 3, reps: 10 }, '3 × 10'],
    ['sets of a hold', { sets: 3, durationInSeconds: 30 }, '3 × 30 s'],
    // Reps win over a duration (the app never sets both; if it did, the
    // count is what a set is made of).
    [
      'reps over a duration',
      { sets: 2, reps: 8, durationInSeconds: 30 },
      '2 × 8',
    ],
    ['sets alone', { sets: 3 }, '3 sets'],
    ['one set', { sets: 1 }, '1 set'],
    ['reps alone', { reps: 12 }, '12 reps'],
    ['one rep', { reps: 1 }, '1 rep'],
    ['a duration alone', { durationInSeconds: 90 }, '1 min 30 s'],
    [
      'a weight',
      { sets: 3, reps: 10, weight: 20, weightUnit: 'kg' },
      '3 × 10 · 20 kg',
    ],
    ['a weight alone', { weight: 12.5, weightUnit: 'lbs' }, '12.5 lbs'],
    ['nothing at all', {}, null],
  ])('writes %s', (_label, fields, text) => {
    expect(doseText(exercise(fields))).toBe(text)
  })
})

describe('workoutLabel', () => {
  it('names a workout by its position, with its name if it has one', () => {
    expect(workoutLabel(0, 'Mobility')).toBe('A · Mobility')
    expect(workoutLabel(2, null)).toBe('C')
    // A blank name is no name; one with spaces around is trimmed.
    expect(workoutLabel(1, '   ')).toBe('B')
    expect(workoutLabel(1, ' Strength ')).toBe('B · Strength')
  })
})

// --- THE MEDICAL FILE --------------------------------------------------------------------------------------

describe('groupIntoNotes', () => {
  it('puts each note’s earlier versions under its latest, newest first', () => {
    // Note 1: 1 → amended by 3 → amended by 5. Note 2: 4 alone. As the
    // loader answers them: newest first.
    const v1 = entry(1, '2031-03-01T10:00:00Z', { amendedById: 3 })
    const v3 = entry(3, '2031-03-03T10:00:00Z', { amendsId: 1, amendedById: 5 })
    const v5 = entry(5, '2031-03-05T10:00:00Z', { amendsId: 3 })
    const other = entry(4, '2031-03-04T10:00:00Z')

    expect(groupIntoNotes([v5, other, v3, v1])).toStrictEqual([
      { latest: v5, earlier: [v3, v1] },
      { latest: other, earlier: [] },
    ])
  })

  // Two entries of the same instant: the higher id is the newer, as the
  // loader orders them.
  it('breaks a tie in time by id', () => {
    const a = entry(8, '2031-03-01T10:00:00Z')
    const b = entry(9, '2031-03-01T10:00:00Z')

    expect(groupIntoNotes([a, b]).map((note) => note.latest.id)).toEqual([9, 8])
  })

  // Data that broke the rules mustn't hang the export or lose an entry.
  // Placed after the walks, then sorted into its place by date: newer than
  // the note given before it, it comes first.
  it('shows an entry amended by one it can’t see as a note of its own', () => {
    const latest = entry(6, '2031-03-06T10:00:00Z')
    const orphan = entry(7, '2031-03-08T10:00:00Z', { amendedById: 99 })

    expect(groupIntoNotes([latest, orphan])).toStrictEqual([
      { latest: orphan, earlier: [] },
      { latest, earlier: [] },
    ])
  })

  it('stops at a loop rather than walking it for ever', () => {
    // 1 and 2 amend each other: reached from 3, the walk stops when it
    // comes back to 2 — each entry shown once.
    const one = entry(1, '2031-03-01T10:00:00Z', {
      amendsId: 2,
      amendedById: 2,
    })
    const two = entry(2, '2031-03-02T10:00:00Z', {
      amendsId: 1,
      amendedById: 1,
    })
    const latest = entry(3, '2031-03-03T10:00:00Z', { amendsId: 2 })

    expect(groupIntoNotes([latest, two, one])).toStrictEqual([
      { latest, earlier: [two, one] },
    ])
  })
})

// --- SESSIONS ----------------------------------------------------------------------------------------------

describe('sessionOutcome', () => {
  it.each<[string, Partial<RecordSession>, string]>([
    ['a completed session', { status: 'completed' }, 'Completed'],
    ['an open session', { status: 'in_progress' }, 'In progress'],
    [
      'a skip',
      { status: 'skipped', endReason: 'no_time' },
      'Skipped (no time)',
    ],
    [
      'a stop for pain',
      { status: 'incomplete', endReason: 'pain' },
      'Stopped (pain)',
    ],
    [
      'a stop for another reason',
      { status: 'incomplete', endReason: 'other' },
      'Stopped (another reason)',
    ],
    [
      'a stop for illness',
      { status: 'incomplete', endReason: 'illness' },
      'Stopped (illness)',
    ],
    // The app's own two reasons: the patient didn't stop it.
    [
      'one left open',
      { status: 'incomplete', endReason: 'not_finished_in_time' },
      'Not finished (left open until a later session started)',
    ],
    [
      'one closed with its program',
      { status: 'incomplete', endReason: 'program_closed' },
      'Not finished (the program was closed)',
    ],
    // Old rows from before reasons were required.
    ['a stop without a reason', { status: 'incomplete' }, 'Stopped'],
    ['a skip without a reason', { status: 'skipped' }, 'Skipped'],
  ])('words %s', (_label, fields, text) => {
    expect(sessionOutcome(session(fields))).toBe(text)
  })
})

// --- THE WHOLE DOCUMENT ------------------------------------------------------------------------------------

describe('buildRecordDocument', () => {
  it('starts with who it is about, when it was made, and what it holds', () => {
    const document = buildRecordDocument(record(), PARIS)

    expect(document.title).toBe('Your health record')
    expect(document.footer).toBe(
      'Health record of Pat Lee · copy made on March 15, 2031',
    )
    expect(document.blocks.slice(0, 3)).toStrictEqual([
      {
        kind: 'fields',
        rows: [
          ['Name', 'Pat Lee'],
          ['Date of birth', 'April 12, 1988'],
          ['Email', 'pat@example.com'],
          ['Copy made on', 'March 15, 2031 at 12:30 AM (Europe/Paris time)'],
        ],
      },
      {
        kind: 'paragraph',
        text:
          'This is a copy of your record as Stride held it when it was made: ' +
          'the notes your care team wrote in your medical file, your exercise ' +
          'programs, and the sessions you did, stopped or skipped. Nothing in ' +
          'a medical file is ever changed or removed — a correction is a new ' +
          'entry, and the version it replaced is shown under it.',
        muted: false,
      },
      {
        kind: 'paragraph',
        text: 'Not included: your messages with your care team.',
        muted: true,
      },
    ])
  })

  it('has no stamp on the patient’s own copy', () => {
    expect(buildRecordDocument(record(), PARIS)).not.toHaveProperty('stamp')
  })

  // --- A review copy (decisions §25, pass 2) ---

  const REVIEW = {
    reviewId: 12,
    madeBy: 'Avery Admin',
    reason: 'Knee worse after the March program',
    caseReference: 'CR-14',
    expiresAt: new Date('2031-03-21T23:30:00.000Z'),
  }

  it('makes a review copy: its title, its stamp, and an account of it first', () => {
    const own = buildRecordDocument(record(), PARIS)
    const review = buildRecordDocument(record(), PARIS, {
      kind: 'review',
      review: REVIEW,
    })

    expect(review.title).toBe('Health record — review copy')
    expect(review.stamp).toBe(
      'Review copy — made by Avery Admin for complaint review 12 (case CR-14)',
    )
    expect(review.footer).toBe(own.footer)
    expect(review.blocks.slice(0, 2)).toStrictEqual([
      {
        kind: 'paragraph',
        text:
          "Review copy, made for the clinic's internal review of a complaint — " +
          "not the patient's own copy. The pages that follow are the patient's " +
          'record exactly as their own copy shows it, written to them.',
        muted: false,
      },
      {
        kind: 'fields',
        rows: [
          ['Made by', 'Avery Admin'],
          ['Complaint review', '12'],
          ['Case reference', 'CR-14'],
          ['Reason', 'Knee worse after the March program'],
          // In the zone asked for, like every moment of the copy.
          ['Review open until', 'March 22, 2031 at 12:30 AM'],
        ],
      },
    ])
    // After it, EXACTLY the patient's own document.
    expect(review.blocks.slice(2)).toStrictEqual(own.blocks)
  })

  it('leaves the case reference out when there is none', () => {
    const review = buildRecordDocument(record(), PARIS, {
      kind: 'review',
      review: { ...REVIEW, caseReference: null },
    })
    expect(review.stamp).toBe(
      'Review copy — made by Avery Admin for complaint review 12',
    )
    expect(review.blocks[1]).toStrictEqual({
      kind: 'fields',
      rows: [
        ['Made by', 'Avery Admin'],
        ['Complaint review', '12'],
        ['Reason', 'Knee worse after the March program'],
        ['Review open until', 'March 22, 2031 at 12:30 AM'],
      ],
    })
  })

  it('writes every date of the copy in the patient’s zone', () => {
    const document = buildRecordDocument(record(), MONTREAL)

    expect(document.footer).toBe(
      'Health record of Pat Lee · copy made on March 14, 2031',
    )
    expect(document.blocks[0]).toStrictEqual({
      kind: 'fields',
      rows: [
        ['Name', 'Pat Lee'],
        ['Date of birth', 'April 12, 1988'],
        ['Email', 'pat@example.com'],
        ['Copy made on', 'March 14, 2031 at 7:30 PM (America/Montreal time)'],
      ],
    })
  })

  it('says so when the file and the programs are empty', () => {
    const { blocks } = buildRecordDocument(record(), PARIS)

    expect(blocks.slice(3)).toStrictEqual([
      { kind: 'heading', level: 1, text: 'Medical file' },
      {
        kind: 'paragraph',
        text: 'Your medical file has no entries.',
        muted: true,
      },
      { kind: 'heading', level: 1, text: 'Exercise programs and sessions' },
      {
        kind: 'paragraph',
        text: 'You have no exercise programs.',
        muted: true,
      },
    ])
  })

  it('writes a note, its correction and the version it replaced', () => {
    // Written at 23:15 UTC: the next day in Paris.
    const original = entry(1, '2031-03-01T23:15:00Z', {
      entryType: 'initial_assessment',
      subjective: 'Knee pain.',
      objective: 'Left knee flexion 110°.',
      assessment: null,
      plan: 'Exercises.',
      amendedById: 2,
    })
    const correction = entry(2, '2031-03-04T09:00:00Z', {
      entryType: 'initial_assessment',
      subjective: 'Knee pain.',
      objective: 'Right knee flexion 110°.',
      assessment: 'Patellofemoral pain.',
      plan: null,
      amendsId: 1,
      amendmentReason: 'The wrong knee was recorded.',
      author: { id: 4, firstName: 'Sam', lastName: 'Diaz' },
    })
    const { blocks } = buildRecordDocument(
      record({ medicalFile: [correction, original] }),
      PARIS,
    )

    expect(
      partBetween(blocks, 'Medical file', 'Exercise programs and sessions'),
    ).toStrictEqual([
      { kind: 'heading', level: 1, text: 'Medical file' },
      {
        kind: 'heading',
        level: 2,
        text: 'Initial assessment · March 4, 2031',
      },
      {
        kind: 'fields',
        rows: [
          ['Written by', 'Sam Diaz'],
          ['Written on', 'March 4, 2031 at 10:00 AM'],
          ['Reason for the correction', 'The wrong knee was recorded.'],
        ],
      },
      {
        kind: 'text',
        label: 'What you reported (Subjective)',
        text: 'Knee pain.',
      },
      {
        kind: 'text',
        label: 'What was observed (Objective)',
        text: 'Right knee flexion 110°.',
      },
      { kind: 'text', label: 'Assessment', text: 'Patellofemoral pain.' },
      {
        kind: 'heading',
        level: 3,
        text: 'Earlier version, replaced on March 4, 2031',
      },
      {
        kind: 'fields',
        rows: [
          ['Written by', 'Alex Chen'],
          ['Written on', 'March 2, 2031 at 12:15 AM'],
        ],
      },
      {
        kind: 'text',
        label: 'What you reported (Subjective)',
        text: 'Knee pain.',
      },
      {
        kind: 'text',
        label: 'What was observed (Objective)',
        text: 'Left knee flexion 110°.',
      },
      { kind: 'text', label: 'Plan', text: 'Exercises.' },
    ])
  })

  // With two corrections, each earlier version was replaced by the one
  // just newer than IT — not all by the latest.
  it('dates each earlier version by the version that replaced it', () => {
    const { blocks } = buildRecordDocument(
      record({
        medicalFile: [
          entry(3, '2031-03-09T10:00:00Z', {
            amendsId: 2,
            amendmentReason: 'Again.',
          }),
          entry(2, '2031-03-05T10:00:00Z', {
            amendsId: 1,
            amendmentReason: 'Typo.',
            amendedById: 3,
          }),
          entry(1, '2031-03-01T10:00:00Z', { amendedById: 2 }),
        ],
      }),
      PARIS,
    )

    expect(
      blocks.filter((block) => block.kind === 'heading' && block.level === 3),
    ).toStrictEqual([
      {
        kind: 'heading',
        level: 3,
        text: 'Earlier version, replaced on March 9, 2031',
      },
      {
        kind: 'heading',
        level: 3,
        text: 'Earlier version, replaced on March 5, 2031',
      },
    ])
  })

  it('writes the notes newest first', () => {
    const { blocks } = buildRecordDocument(
      record({
        medicalFile: [
          entry(2, '2031-03-09T10:00:00Z', { entryType: 'discharge_summary' }),
          entry(1, '2031-03-01T10:00:00Z'),
        ],
      }),
      PARIS,
    )

    expect(
      blocks.filter((block) => block.kind === 'heading' && block.level === 2),
    ).toStrictEqual([
      { kind: 'heading', level: 2, text: 'Discharge summary · March 9, 2031' },
      { kind: 'heading', level: 2, text: 'Progress note · March 1, 2031' },
    ])
  })

  it('writes a program: who prescribed it, its dates, its workouts', () => {
    const { blocks } = buildRecordDocument(
      record({
        programs: [
          program({
            status: 'completed',
            endDate: '2031-04-30',
            workouts: [
              {
                id: 11,
                name: 'Mobility',
                exercises: [
                  exercise({ name: 'Heel slides', sets: 3, reps: 10 }),
                  exercise({ name: 'Walk', notes: 'At an easy pace' }),
                ],
              },
              { id: 12, name: null, exercises: [] },
            ],
          }),
        ],
      }),
      PARIS,
    )

    expect(partBetween(blocks, 'Knee Rehab', 'Sessions')).toStrictEqual([
      { kind: 'heading', level: 2, text: 'Knee Rehab' },
      {
        kind: 'fields',
        rows: [
          ['Prescribed by', 'Alex Chen'],
          ['Dates', 'March 3, 2031 – April 30, 2031'],
          ['Status', 'Completed'],
        ],
      },
      { kind: 'heading', level: 3, text: 'Workout A · Mobility' },
      {
        kind: 'list',
        items: ['Heel slides — 3 × 10', 'Walk. At an easy pace'],
      },
      { kind: 'heading', level: 3, text: 'Workout B' },
      { kind: 'paragraph', text: 'No exercises.', muted: true },
    ])
    expect(partBetween(blocks, 'Sessions')).toStrictEqual([
      { kind: 'heading', level: 3, text: 'Sessions' },
      { kind: 'paragraph', text: 'No sessions yet.', muted: true },
    ])
  })

  it('writes an open-ended, cancelled program as such', () => {
    const { blocks } = buildRecordDocument(
      record({ programs: [program({ status: 'cancelled' })] }),
      PARIS,
    )

    expect(blocks).toContainEqual({
      kind: 'fields',
      rows: [
        ['Prescribed by', 'Alex Chen'],
        ['Dates', 'March 3, 2031 – no end date'],
        ['Status', 'Cancelled'],
      ],
    })
  })

  it('writes each session: its day, workout, outcome, scores and exercises', () => {
    const { blocks } = buildRecordDocument(
      record({
        programs: [
          program({
            sessions: [
              session({
                id: 1,
                workoutId: 12,
                localDate: '2031-03-10',
                status: 'incomplete',
                endReason: 'pain',
                endNote: 'Knee hurt',
                totalDurationInSeconds: 1499,
                painBefore: 4,
                painAfter: 7,
                mobilityAfter: 3,
                sessionFeedback: 'Hard day.\nWill rest.',
                exercises: [
                  sessionExercise({
                    name: 'Heel slides',
                    durationActualInSeconds: 95,
                    difficultyRating: 6,
                    feedback: 'Felt a pinch',
                  }),
                  sessionExercise({
                    name: 'Walk',
                    sets: null,
                    reps: null,
                    completed: false,
                  }),
                ],
              }),
              // Nothing but the outcome: no optional row is written.
              session({
                id: 2,
                workoutId: 11,
                localDate: '2031-03-12',
                status: 'skipped',
                endReason: 'illness',
              }),
            ],
          }),
        ],
      }),
      PARIS,
    )

    expect(partBetween(blocks, 'Sessions (2)')).toStrictEqual([
      { kind: 'heading', level: 3, text: 'Sessions (2)' },
      {
        kind: 'heading',
        level: 4,
        text: 'March 10, 2031 · Workout B',
      },
      {
        kind: 'fields',
        rows: [
          ['Outcome', 'Stopped (pain)'],
          ['Your note', 'Knee hurt'],
          ['Length', '25 min'],
          ['Pain before', '4 / 10'],
          ['Pain after', '7 / 10'],
          ['Mobility after', '3 / 10'],
        ],
      },
      { kind: 'text', label: 'Your feedback', text: 'Hard day.\nWill rest.' },
      {
        kind: 'list',
        items: [
          'Done: Heel slides — 3 × 10 · took 1 min 35 s · difficulty 6 / 10 · “Felt a pinch”',
          'Not done: Walk',
        ],
      },
      {
        kind: 'heading',
        level: 4,
        text: 'March 12, 2031 · Workout A · Mobility',
      },
      { kind: 'fields', rows: [['Outcome', 'Skipped (illness)']] },
    ])
  })

  it('says "less than a minute" rather than 0 min', () => {
    const { blocks } = buildRecordDocument(
      record({
        programs: [
          program({ sessions: [session({ totalDurationInSeconds: 59 })] }),
        ],
      }),
      PARIS,
    )

    expect(blocks).toContainEqual({
      kind: 'fields',
      rows: [
        ['Outcome', 'Completed'],
        ['Length', 'less than a minute'],
      ],
    })
  })

  // Can't happen (a workout with sessions can't be deleted), but a copy
  // must still list the session.
  it('writes a session of a workout the program no longer has by its day', () => {
    const { blocks } = buildRecordDocument(
      record({
        programs: [program({ sessions: [session({ workoutId: 99 })] })],
      }),
      PARIS,
    )

    expect(blocks).toContainEqual({
      kind: 'heading',
      level: 4,
      text: 'March 10, 2031',
    })
  })

  it('writes every program, in the order given', () => {
    const { blocks } = buildRecordDocument(
      record({
        programs: [
          program({ id: 2, title: 'Shoulder' }),
          program({ id: 1, title: 'Knee' }),
        ],
      }),
      PARIS,
    )

    expect(
      blocks
        .filter((block) => block.kind === 'heading' && block.level === 2)
        .map((block) => (block.kind === 'heading' ? block.text : '')),
    ).toEqual(['Shoulder', 'Knee'])
  })
})

// --- THE ACCOUNTING OF DISCLOSURES (decisions §25, pass 3) -------------------------------------------------

describe('buildRecordDocument — the accounting of disclosures', () => {
  const disclosed = {
    id: 4,
    // 23:30 UTC: the 22nd in Paris, the 21st in Montreal.
    madeAt: new Date('2031-03-21T23:30:00Z'),
    recipientName: 'Jane Roe',
    recipientOrganisation: 'Montreal Police',
    legalBasis: 'court_order' as const,
    basisExplanation: null,
    parts: ['medical_file' as const, 'messages' as const],
    period: { from: '2031-01-01', to: '2031-02-28' },
  }

  it('lists each disclosure last: who, why, what, which period — in the zone asked', () => {
    const { blocks } = buildRecordDocument(
      record({
        disclosures: [
          disclosed,
          {
            ...disclosed,
            id: 3,
            recipientName: 'Dr. Coroner',
            recipientOrganisation: null,
            legalBasis: 'other',
            basisExplanation: 'A tribunal order',
            parts: ['sessions'],
            period: { from: null, to: null },
          },
        ],
      }),
      MONTREAL,
    )
    const start = blocks.findIndex(
      (block) =>
        block.kind === 'heading' && block.text === 'Disclosures of your record',
    )
    expect(blocks.slice(start)).toStrictEqual([
      { kind: 'heading', level: 1, text: 'Disclosures of your record' },
      {
        kind: 'paragraph',
        text:
          'When the law requires it — a court order, for example — a clinic ' +
          'may have to give a copy of a record to someone outside it without ' +
          'asking the patient first. Each time that happened with your record ' +
          "is listed here. Copies you download yourself aren't.",
        muted: false,
      },
      {
        kind: 'heading',
        level: 2,
        text: 'March 21, 2031 · Jane Roe (Montreal Police)',
      },
      {
        kind: 'fields',
        rows: [
          ['Given to', 'Jane Roe'],
          ['Organisation', 'Montreal Police'],
          ['Why', 'A court order'],
          ['What', 'Medical file and messages'],
          ['Period', 'January 1, 2031 to February 28, 2031'],
        ],
      },
      { kind: 'heading', level: 2, text: 'March 21, 2031 · Dr. Coroner' },
      {
        kind: 'fields',
        rows: [
          ['Given to', 'Dr. Coroner'],
          ['Why', 'Another legal basis: A tribunal order'],
          ['What', 'Sessions'],
          ['Period', 'all dates'],
        ],
      },
    ])
  })

  it('says so when there is none — and prints nothing when it was not read', () => {
    const empty = buildRecordDocument(record({ disclosures: [] }), PARIS)
    expect(empty.blocks.slice(-1)).toStrictEqual([
      {
        kind: 'paragraph',
        text: 'Your record has not been disclosed outside the clinic.',
        muted: true,
      },
    ])
    const notRead = buildRecordDocument(record(), PARIS)
    expect(
      notRead.blocks.some(
        (block) =>
          block.kind === 'heading' &&
          block.text === 'Disclosures of your record',
      ),
    ).toBe(false)
  })
})

// --- THE DISCLOSED COPY (decisions §25, pass 3) ------------------------------------------------------------

describe('buildRecordDocument — a disclosed copy', () => {
  const STAMP: DisclosureStamp = {
    disclosureId: 4,
    madeBy: 'Avery Admin',
    recipientName: 'Jane Roe',
    recipientOrganisation: 'Montreal Police',
    legalBasis: 'subpoena',
    basisExplanation: null,
    orderReference: '500-17-123',
    receivedOn: '2031-03-01',
    parts: ['medical_file', 'messages'],
    period: { from: '2031-03-01', to: '2031-03-31' },
  }
  const disclose = (data: RecordData, stamp: DisclosureStamp = STAMP) =>
    buildRecordDocument(data, PARIS, { kind: 'disclosure', disclosure: stamp })
  const headings = (blocks: RecordBlock[], level: number) =>
    blocks
      .filter((block) => block.kind === 'heading' && block.level === level)
      .map((block) => (block.kind === 'heading' ? block.text : ''))

  it('opens with what the copy is, for whom, under what — then the patient, no email', () => {
    const document = disclose(record())

    expect(document.title).toBe('Health record — disclosed copy')
    // The record's moment in Paris: already the 15th.
    expect(document.stamp).toBe(
      'Disclosed to Montreal Police under a subpoena (ref. 500-17-123) on March 15, 2031 · disclosure 4',
    )
    expect(document.footer).toBe(
      'Health record of Pat Lee · copy made on March 15, 2031',
    )
    expect(document.blocks.slice(0, 5)).toStrictEqual([
      {
        kind: 'paragraph',
        text:
          'Copy disclosed outside the clinic because the law required it — ' +
          "not the patient's own copy. It holds only the parts of the record " +
          'and the period listed here.',
        muted: false,
      },
      {
        kind: 'fields',
        rows: [
          ['Disclosed to', 'Jane Roe'],
          ['Organisation', 'Montreal Police'],
          ['Legal basis', 'A subpoena, with the assurances the law requires'],
          ['Order reference', '500-17-123'],
          ['Request received on', 'March 1, 2031'],
          ['Made by', 'Avery Admin'],
          ['Disclosure', '4'],
          ['Parts included', 'Medical file and messages'],
          [
            'Period',
            'March 1, 2031 to March 31, 2031 (days in Europe/Paris time)',
          ],
        ],
      },
      {
        kind: 'fields',
        rows: [
          ['Name', 'Pat Lee'],
          ['Date of birth', 'April 12, 1988'],
          ['Copy made on', 'March 15, 2031 at 12:30 AM (Europe/Paris time)'],
        ],
      },
      {
        kind: 'paragraph',
        text:
          "What follows is the patient's record as Stride held it when this " +
          'copy was made, limited to the parts and the period above. It uses ' +
          "the words of the patient's own copy, written to them. Nothing in a " +
          'medical file is ever changed or removed — a correction is a new ' +
          'entry, and the version it replaced is shown under it.',
        muted: false,
      },
      {
        kind: 'paragraph',
        text: 'Not included: exercise programs and sessions.',
        muted: true,
      },
    ])
  })

  it('leaves out the rows it has nothing for, and the "Not included" line when all went', () => {
    const document = disclose(record(), {
      ...STAMP,
      recipientOrganisation: null,
      orderReference: null,
      parts: ['medical_file', 'programs', 'sessions', 'messages'],
    })
    const [, order] = document.blocks
    expect(
      order.kind === 'fields' && order.rows.map(([label]) => label),
    ).toEqual([
      'Disclosed to',
      'Legal basis',
      'Request received on',
      'Made by',
      'Disclosure',
      'Parts included',
      'Period',
    ])
    expect(
      document.blocks.some(
        (block) =>
          block.kind === 'paragraph' && block.text.startsWith('Not included'),
      ),
    ).toBe(false)
  })

  it('prints only the parts included, each saying when the period held none', () => {
    const fileAndMessages = disclose(record())
    expect(headings(fileAndMessages.blocks, 1)).toEqual([
      'Medical file',
      'Messages',
    ])
    expect(fileAndMessages.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'No medical file entries in this period.',
      muted: true,
    })
    expect(fileAndMessages.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'No messages in this period.',
      muted: true,
    })

    const programsOnly = disclose(record(), { ...STAMP, parts: ['programs'] })
    expect(headings(programsOnly.blocks, 1)).toEqual(['Exercise programs'])
    expect(programsOnly.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'No exercise programs in this period.',
      muted: true,
    })
    const sessionsOnly = disclose(record(), { ...STAMP, parts: ['sessions'] })
    expect(headings(sessionsOnly.blocks, 1)).toEqual(['Sessions'])
    expect(sessionsOnly.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'No sessions in this period.',
      muted: true,
    })
  })

  it('shows a program’s prescription with "programs", its sessions with "sessions"', () => {
    const data = record({
      programs: [
        program({
          workouts: [
            {
              id: 11,
              name: 'Mobility',
              exercises: [exercise({ sets: 3, reps: 10 })],
            },
          ],
          sessions: [session()],
        }),
      ],
    })
    const both = disclose(data, { ...STAMP, parts: ['programs', 'sessions'] })
    expect(headings(both.blocks, 1)).toEqual(['Exercise programs and sessions'])
    expect(headings(both.blocks, 3)).toEqual([
      'Workout A · Mobility',
      'Sessions (1)',
    ])

    const programs = disclose(data, { ...STAMP, parts: ['programs'] })
    expect(headings(programs.blocks, 3)).toEqual(['Workout A · Mobility'])
    expect(headings(programs.blocks, 4)).toEqual([])

    const sessions = disclose(data, { ...STAMP, parts: ['sessions'] })
    expect(headings(sessions.blocks, 2)).toEqual(['Knee Rehab'])
    expect(headings(sessions.blocks, 3)).toEqual(['Sessions (1)'])
    // The session still names its workout.
    expect(headings(sessions.blocks, 4)).toEqual([
      'March 10, 2031 · Workout A · Mobility',
    ])

    const empty = disclose(record({ programs: [program()] }), {
      ...STAMP,
      parts: ['programs', 'sessions'],
    })
    expect(empty.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'No sessions in this period.',
      muted: true,
    })
  })

  it('writes each conversation: who and when, then the text — a deleted one without', () => {
    const { blocks } = disclose(
      record({
        conversations: [
          {
            id: 1,
            practitioner: { firstName: 'Alex', lastName: 'Chen' },
            messages: [
              {
                id: 1,
                fromPatient: false,
                sentAt: new Date('2031-03-10T09:00:00Z'),
                body: 'Start with the lighter band.',
              },
              {
                id: 2,
                fromPatient: true,
                sentAt: new Date('2031-03-10T10:30:00Z'),
                body: null,
              },
            ],
          },
          {
            id: 2,
            practitioner: { firstName: 'Sam', lastName: 'Okafor' },
            messages: [
              {
                id: 3,
                fromPatient: true,
                sentAt: new Date('2031-03-11T08:00:00Z'),
                body: 'Thank you!',
              },
            ],
          },
        ],
      }),
    )
    const start = blocks.findIndex(
      (block) => block.kind === 'heading' && block.text === 'Messages',
    )
    expect(blocks.slice(start)).toStrictEqual([
      { kind: 'heading', level: 1, text: 'Messages' },
      { kind: 'heading', level: 2, text: 'With Alex Chen (2 messages)' },
      {
        kind: 'text',
        label: 'Alex Chen · March 10, 2031 at 10:00 AM',
        text: 'Start with the lighter band.',
      },
      {
        kind: 'paragraph',
        text: "Pat Lee · March 10, 2031 at 11:30 AM — deleted by its sender before it was read; its text isn't shown.",
        muted: true,
      },
      { kind: 'heading', level: 2, text: 'With Sam Okafor (1 message)' },
      {
        kind: 'text',
        label: 'Pat Lee · March 11, 2031 at 9:00 AM',
        text: 'Thank you!',
      },
    ])
  })

  it('says when a note here was corrected after the period', () => {
    const { blocks } = disclose(
      record({
        medicalFile: [entry(1, '2031-03-05T09:00:00Z', { amendedById: 2 })],
      }),
    )
    expect(blocks).toContainEqual({
      kind: 'paragraph',
      text: 'This note was corrected later, after the period this copy covers.',
      muted: true,
    })
    // Never in the patient's own copy, where the correction is there too.
    const own = buildRecordDocument(
      record({
        medicalFile: [
          entry(2, '2031-03-06T09:00:00Z', {
            amendsId: 1,
            amendmentReason: 'Typo',
          }),
          entry(1, '2031-03-05T09:00:00Z', { amendedById: 2 }),
        ],
      }),
      PARIS,
    )
    expect(
      own.blocks.some(
        (block) =>
          block.kind === 'paragraph' && block.text.includes('corrected later'),
      ),
    ).toBe(false)
  })

  describe('disclosureStampText', () => {
    const madeAt = new Date('2031-03-14T23:30:00Z')

    it('names the organisation, or the person when there is none', () => {
      expect(
        disclosureStampText(
          { ...STAMP, recipientOrganisation: null, orderReference: null },
          madeAt,
          MONTREAL,
        ),
      ).toBe(
        'Disclosed to Jane Roe under a subpoena on March 14, 2031 · disclosure 4',
      )
    })

    it('cuts a long recipient or reference to fit one line', () => {
      const stamp = disclosureStampText(
        {
          ...STAMP,
          recipientOrganisation: 'O'.repeat(61),
          orderReference: `${'R'.repeat(59)} tail`,
        },
        madeAt,
        PARIS,
      )
      expect(stamp).toBe(
        `Disclosed to ${'O'.repeat(59)}… under a subpoena (ref. ${'R'.repeat(59)}…) on March 15, 2031 · disclosure 4`,
      )
      // Exactly 60 characters: kept whole.
      expect(
        disclosureStampText(
          { ...STAMP, recipientOrganisation: 'O'.repeat(60) },
          madeAt,
          PARIS,
        ),
      ).toContain(`to ${'O'.repeat(60)} under`)
    })
  })
})
