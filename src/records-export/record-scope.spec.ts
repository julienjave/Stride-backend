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

import { scopeRecord } from './record-scope'
import type {
  RecordConversation,
  RecordData,
  RecordProgram,
  RecordSession,
} from './record-content'
import type { MedicalFileEntry } from '../medical-files/medical-files.service'
import type { RomAssessment } from '../range-of-motion/range-of-motion.service'
import type { DisclosurePart } from '../legal-disclosures/legal-disclosure-rules'

// --- FIXTURES ----------------------------------------------------------------------------------------------

// Far from today (2031). 02:00 UTC on April 1 is still March 31 in Montreal,
// and April 1 in Paris — the moment the zone decides.
const MONTREAL = 'America/Montreal'
const PARIS = 'Europe/Paris'
const EDGE = '2031-04-01T02:00:00Z'
const APRIL = { from: '2031-04-01', to: '2031-04-30' }
const ALL: DisclosurePart[] = [
  'medical_file',
  'programs',
  'sessions',
  'messages',
]

function entry(id: number, createdAt: string): MedicalFileEntry {
  return {
    id,
    patientId: 7,
    entryType: 'progress_note',
    subjective: null,
    objective: null,
    assessment: null,
    plan: 'Plan',
    createdAt: new Date(createdAt),
    author: { id: 3, firstName: 'Alex', lastName: 'Chen' },
    amendsId: null,
    amendmentReason: null,
    amendedById: null,
  }
}

// An assessment MEASURED on one day and RECORDED at another moment — the
// two dates the scope must not confuse.
function assessment(
  id: number,
  measuredOn: string,
  createdAt: string,
): RomAssessment {
  return {
    id,
    patientId: 7,
    measuredOn,
    createdAt: new Date(createdAt),
    author: { id: 3, firstName: 'Alex', lastName: 'Chen' },
    medicalFileEntryId: null,
    amendsId: null,
    amendmentReason: null,
    amendedById: null,
    measurements: [],
  }
}

function session(id: number, localDate: string): RecordSession {
  return {
    id,
    workoutId: 11,
    localDate,
    status: 'completed',
    totalDurationInSeconds: null,
    painBefore: null,
    painAfter: null,
    mobilityAfter: null,
    sessionFeedback: null,
    endReason: null,
    endNote: null,
    exercises: [],
  }
}

function program(
  id: number,
  startDate: string,
  endDate: string | null,
  sessions: RecordSession[] = [],
): RecordProgram {
  return {
    id,
    title: `Program ${id}`,
    status: 'active',
    startDate,
    endDate,
    assignedBy: { firstName: 'Alex', lastName: 'Chen' },
    workouts: [{ id: 11, name: 'Mobility', exercises: [] }],
    sessions,
  }
}

function conversation(
  id: number,
  sentAt: [number, string][],
): RecordConversation {
  return {
    id,
    practitioner: { firstName: 'Alex', lastName: 'Chen' },
    messages: sentAt.map(([messageId, moment]) => ({
      id: messageId,
      fromPatient: false,
      sentAt: new Date(moment),
      body: `Message ${messageId}`,
    })),
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
    rangeOfMotion: [],
    programs: [],
    madeAt: new Date('2031-05-14T12:00:00Z'),
    ...overrides,
  }
}

const ids = (rows: { id: number }[]) => rows.map((row) => row.id)

// --- TESTS -------------------------------------------------------------------------------------------------

describe('scopeRecord', () => {
  it('keeps the patient and the moment, and never the accounting', () => {
    const full = record({
      disclosures: [
        {
          id: 1,
          madeAt: new Date('2031-01-01T00:00:00Z'),
          recipientName: 'Someone',
          recipientOrganisation: null,
          legalBasis: 'court_order',
          basisExplanation: null,
          parts: ['messages'],
          period: { from: null, to: null },
        },
      ],
    })
    const scoped = scopeRecord(full, { parts: ALL, period: APRIL }, PARIS)
    expect(scoped.patient).toBe(full.patient)
    expect(scoped.madeAt).toBe(full.madeAt)
    expect('disclosures' in scoped).toBe(false)
  })

  it('keeps the medical file entries written in the period, read in the zone', () => {
    const file = [
      entry(1, '2031-03-31T12:00:00Z'),
      entry(2, EDGE),
      entry(3, '2031-04-30T12:00:00Z'),
      entry(4, '2031-05-01T12:00:00Z'),
    ]
    const scope = { parts: ALL, period: APRIL }
    expect(
      ids(
        scopeRecord(record({ medicalFile: file }), scope, MONTREAL).medicalFile,
      ),
    ).toEqual([3])
    expect(
      ids(scopeRecord(record({ medicalFile: file }), scope, PARIS).medicalFile),
    ).toEqual([2, 3])
  })

  // Part of the medical file, by the day MEASURED — a calendar day, the same
  // in every zone. Each fixture's recorded moment is on the OTHER side of the
  // period's edge, so a scope reading createdAt instead keeps the wrong ones.
  it('keeps the range of motion measured in the period, with the medical file', () => {
    const rom = [
      assessment(1, '2031-03-31', '2031-04-02T12:00:00Z'),
      assessment(2, '2031-04-01', '2031-03-25T12:00:00Z'),
      assessment(3, '2031-04-30', '2031-05-03T12:00:00Z'),
      assessment(4, '2031-05-01', '2031-04-29T12:00:00Z'),
    ]
    const scope = { parts: ALL, period: APRIL }
    for (const zone of [MONTREAL, PARIS]) {
      expect(
        ids(
          scopeRecord(record({ rangeOfMotion: rom }), scope, zone)
            .rangeOfMotion,
        ),
      ).toEqual([2, 3])
    }
    // Without the medical file, none — whatever the period holds.
    expect(
      scopeRecord(
        record({ rangeOfMotion: rom }),
        { parts: ['programs', 'sessions', 'messages'], period: APRIL },
        PARIS,
      ).rangeOfMotion,
    ).toEqual([])
  })

  it('leaves out every part not chosen', () => {
    const full = record({
      medicalFile: [entry(1, '2031-04-10T12:00:00Z')],
      programs: [program(1, '2031-04-01', null, [session(5, '2031-04-10')])],
      conversations: [conversation(1, [[9, '2031-04-10T12:00:00Z']])],
    })
    const scoped = scopeRecord(
      full,
      { parts: ['medical_file'], period: APRIL },
      PARIS,
    )
    expect(ids(scoped.medicalFile)).toEqual([1])
    expect(scoped.programs).toEqual([])
    // Absent, not empty: the document then prints no messages part at all.
    expect('conversations' in scoped).toBe(false)
  })

  it('keeps the messages sent in the period, and only conversations with some', () => {
    const full = record({
      conversations: [
        conversation(1, [
          [1, '2031-03-30T12:00:00Z'],
          [2, EDGE],
          [3, '2031-04-15T12:00:00Z'],
        ]),
        conversation(2, [[4, '2031-05-02T12:00:00Z']]),
      ],
    })
    const scope = { parts: ['messages'] as DisclosurePart[], period: APRIL }
    const montreal = scopeRecord(full, scope, MONTREAL).conversations ?? []
    expect(montreal.map((c) => [c.id, ids(c.messages)])).toEqual([[1, [3]]])
    const paris = scopeRecord(full, scope, PARIS).conversations ?? []
    expect(paris.map((c) => [c.id, ids(c.messages)])).toEqual([[1, [2, 3]]])
  })

  it('answers an empty list of conversations when messages were chosen but none was sent', () => {
    expect(
      scopeRecord(record(), { parts: ['messages'], period: APRIL }, PARIS)
        .conversations,
    ).toEqual([])
  })

  describe('programs and sessions', () => {
    const programs = [
      // Overlaps April, with sessions in and out of it.
      program(1, '2031-03-01', '2031-04-02', [
        session(11, '2031-03-31'),
        session(12, '2031-04-01'),
      ]),
      // Entirely before April, no session in it.
      program(2, '2031-01-01', '2031-03-31', [session(21, '2031-03-15')]),
      // Starts after April.
      program(3, '2031-05-01', null, []),
      // Overlaps April, no session in it.
      program(4, '2031-04-20', null, [session(41, '2031-05-03')]),
    ]
    const scoped = (parts: DisclosurePart[]) =>
      scopeRecord(record({ programs }), { parts, period: APRIL }, PARIS)
        .programs

    it('with "programs": the programs overlapping the period, no sessions', () => {
      expect(scoped(['programs']).map((p) => [p.id, ids(p.sessions)])).toEqual([
        [1, []],
        [4, []],
      ])
    })

    it('with "sessions": the programs with a session in the period, with those', () => {
      expect(scoped(['sessions']).map((p) => [p.id, ids(p.sessions)])).toEqual([
        [1, [12]],
      ])
    })

    it('with both: the overlapping programs, with their sessions of the period', () => {
      expect(
        scoped(['programs', 'sessions']).map((p) => [p.id, ids(p.sessions)]),
      ).toEqual([
        [1, [12]],
        [4, []],
      ])
    })

    it('keeps the workouts (a session names its workout)', () => {
      expect(scoped(['sessions'])[0].workouts).toBe(programs[0].workouts)
    })

    it('with no period: everything', () => {
      expect(
        scopeRecord(
          record({ programs }),
          { parts: ['programs', 'sessions'], period: { from: null, to: null } },
          PARIS,
        ).programs.map((p) => [p.id, ids(p.sessions)]),
      ).toEqual([
        [1, [11, 12]],
        [2, [21]],
        [3, []],
        [4, [41]],
      ])
    })
  })
})
