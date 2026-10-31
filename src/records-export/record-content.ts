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

// The records export's WORDS (decisions §20): a patient's record, as loaded,
// turned into a document — headings, fields, paragraphs — that the PDF
// renderer (record-pdf.ts) only has to draw.
//
// Why a separate, PURE step: the renderer's output is a PDF, whose text is
// stored as font glyph numbers and can't be read back in a test without a
// PDF parser. Everything worth testing — what is said, in what order, with
// which dates — is decided HERE, from plain data to plain data, so the tests
// compare strings. The renderer then decides only how things look.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type { MedicalFileEntry } from '../medical-files/medical-files.service'
import type { MedicalFileEntryType } from '../medical-files/medical-file-rules'
import type {
  RomAssessment,
  RomMeasurement,
} from '../range-of-motion/range-of-motion.service'
import {
  ROM_MOVEMENT_DETAILS,
  measurementLabel,
} from '../range-of-motion/movement-catalogue'
import type { WeightUnit } from '../database/schema/weight-unit.schema'
import type { LegalBasis } from '../database/schema/legal-disclosures.schema'
import {
  LEGAL_BASIS_IN_SENTENCE,
  legalBasisText,
  missingPartsText,
  partsText,
  periodText,
  type DisclosurePart,
  type DisclosurePeriod,
} from '../legal-disclosures/legal-disclosure-rules'

// --- THE RECORD, AS LOADED ---------------------------------------------------------------------------------

export interface PersonName {
  firstName: string
  lastName: string
}

// Dates without a time (a birthday, a program's first day, a session's day)
// stay 'YYYY-MM-DD' strings: they name a DAY, the same everywhere, and must
// never pass through a time zone (a Date at midnight UTC is the evening
// before in Montreal).
export interface RecordPatient extends PersonName {
  email: string
  dateOfBirth: string
}

// One exercise of a workout, as prescribed today.
export interface PrescribedExercise {
  name: string
  sets: number | null
  reps: number | null
  durationInSeconds: number | null
  weight: number | null
  weightUnit: WeightUnit | null
  notes: string | null
}

export interface RecordWorkout {
  id: number
  name: string | null
  exercises: PrescribedExercise[]
}

// One exercise of a session: what was asked THAT day (the session keeps its
// own copy) and what the patient did.
export interface SessionExerciseRecord extends PrescribedExercise {
  completed: boolean
  durationActualInSeconds: number | null
  difficultyRating: number | null
  feedback: string | null
}

export type SessionStatus =
  'in_progress' | 'completed' | 'incomplete' | 'skipped'
export type SessionEndReason =
  | 'pain'
  | 'illness'
  | 'no_time'
  | 'other'
  | 'not_finished_in_time'
  | 'program_closed'

export interface RecordSession {
  id: number
  workoutId: number
  localDate: string
  status: SessionStatus
  totalDurationInSeconds: number | null
  painBefore: number | null
  painAfter: number | null
  mobilityAfter: number | null
  sessionFeedback: string | null
  endReason: SessionEndReason | null
  endNote: string | null
  exercises: SessionExerciseRecord[]
}

export type ProgramStatus = 'active' | 'completed' | 'cancelled'

export interface RecordProgram {
  id: number
  title: string
  status: ProgramStatus
  startDate: string
  endDate: string | null
  assignedBy: PersonName
  // In the program's order (A, B, C…).
  workouts: RecordWorkout[]
  // In date order.
  sessions: RecordSession[]
}

// One message of a conversation, as the PATIENT reads it (decisions §25,
// pass 3 — messages leave the app only in a legal disclosure). `body` is
// null for a message its sender deleted: the text stays in the database, but
// both participants see it without — and a copy read as the patient shows
// what the patient sees.
export interface RecordMessage {
  id: number
  fromPatient: boolean
  sentAt: Date
  body: string | null
}

// One conversation: the patient with one practitioner. Messages oldest
// first, as a conversation reads.
export interface RecordConversation {
  id: number
  practitioner: PersonName
  messages: RecordMessage[]
}

// One line of the patient's ACCOUNTING OF DISCLOSURES (HIPAA 164.528): a time
// the clinic gave their record to someone outside it because the law
// required it. Read as the patient, so a disclosure the law lets the clinic
// hold back for a time isn't here until then (migration 0069).
export interface RecordDisclosure {
  id: number
  madeAt: Date
  recipientName: string
  recipientOrganisation: string | null
  legalBasis: LegalBasis
  basisExplanation: string | null
  parts: DisclosurePart[]
  period: DisclosurePeriod
}

export interface RecordData {
  patient: RecordPatient
  // Newest first, as loadMedicalFileEntries answers.
  medicalFile: MedicalFileEntry[]
  // Range-of-motion assessments (Phase 7) — newest first by the day measured,
  // as loadRomAssessments answers. Part of the medical file in a disclosure
  // (record-scope.ts).
  rangeOfMotion: RomAssessment[]
  // Newest first (by first day).
  programs: RecordProgram[]
  // Loaded only for a legal disclosure that includes messages; absent, the
  // document has no messages part at all.
  conversations?: RecordConversation[]
  // Loaded for the patient's own copy (and a review copy, which is exactly
  // that); absent from a disclosure's copy, whose content is only what the
  // order covers. Newest first.
  disclosures?: RecordDisclosure[]
  // The moment the record was read (the transaction's now(), the same
  // instant as the audit entry's created_at).
  madeAt: Date
}

// --- THE DOCUMENT ------------------------------------------------------------------------------------------

// What the renderer draws, in order. Five kinds are enough:
//   - heading:   1 = a part of the record, 2 = a note / a program, 3 = a
//                group inside one, 4 = one session;
//   - fields:    "Label: value" lines (who wrote it, which dates…);
//   - text:      a labelled block of free text (a SOAP section, a note),
//                kept as written, line breaks included;
//   - paragraph: a sentence of ours (muted: a remark, not record content);
//   - list:      short lines (a workout's exercises).
export type RecordBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'fields'; rows: [label: string, value: string][] }
  | { kind: 'text'; label: string; text: string }
  | { kind: 'paragraph'; text: string; muted: boolean }
  | { kind: 'list'; items: string[] }

export interface RecordDocument {
  title: string
  // Repeated in every page's footer, so a loose page still says whose it is.
  footer: string
  // A REVIEW COPY's mark (decisions §25, pass 2), drawn on every page just
  // above the footer, in bold: a page found on a desk says whose copy it is
  // and why it exists. Absent on the patient's own copy.
  stamp?: string
  blocks: RecordBlock[]
}

// What makes a copy a REVIEW copy: the complaint review it was made under
// (complaint-reviews.service.ts). Words only — the service has read the
// names; this file decides what is printed.
export interface ReviewStamp {
  reviewId: number
  // The admin making the copy: "Avery Admin".
  madeBy: string
  reason: string
  caseReference: string | null
  expiresAt: Date
}

// What makes a copy a DISCLOSED copy: the legal disclosure it was made for
// (decisions §25, pass 3 — legal-disclosures.service.ts). The order's details
// as the admin recorded them; the copy's moment is the record's own madeAt
// (one transaction, one now()).
export interface DisclosureStamp {
  disclosureId: number
  // The admin who made it: "Avery Admin".
  madeBy: string
  recipientName: string
  recipientOrganisation: string | null
  legalBasis: LegalBasis
  basisExplanation: string | null
  orderReference: string | null
  // The day the request reached the clinic ('YYYY-MM-DD').
  receivedOn: string
  parts: DisclosurePart[]
  period: DisclosurePeriod
}

// A copy that ISN'T the patient's own, and why — the third argument of
// buildRecordDocument. A tagged union: `kind` says which, and TypeScript
// then knows which fields exist.
export type CopyMark =
  | { kind: 'review'; review: ReviewStamp }
  | { kind: 'disclosure'; disclosure: DisclosureStamp }

// --- WORDS -------------------------------------------------------------------------------------------------

export const DOCUMENT_TITLE = 'Your health record'
export const REVIEW_DOCUMENT_TITLE = 'Health record — review copy'
export const DISCLOSURE_DOCUMENT_TITLE = 'Health record — disclosed copy'

const ENTRY_TYPE_LABELS: Record<MedicalFileEntryType, string> = {
  initial_assessment: 'Initial assessment',
  progress_note: 'Progress note',
  discharge_summary: 'Discharge summary',
}

// The patient's words for each SOAP section (the same as My records,
// frontend medicalFileText.ts), with SOAP's own name after it: this copy may
// be handed to another clinician, who reads the standard names.
const SECTION_LABELS = {
  subjective: 'What you reported (Subjective)',
  objective: 'What was observed (Objective)',
  assessment: 'Assessment',
  plan: 'Plan',
} as const

const SECTIONS = ['subjective', 'objective', 'assessment', 'plan'] as const

const PROGRAM_STATUS_LABELS: Record<ProgramStatus, string> = {
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

// The same words as the progress page (frontend progressText.ts).
const END_REASON_TEXT: Record<SessionEndReason, string> = {
  pain: 'pain',
  illness: 'illness',
  no_time: 'no time',
  other: 'another reason',
  not_finished_in_time: 'left open until a later session started',
  program_closed: 'the program was closed',
}

// The two reasons only the app writes: "Not finished" rather than
// "Stopped" — the patient didn't stop it.
const APP_END_REASONS: ReadonlySet<SessionEndReason> = new Set([
  'not_finished_in_time',
  'program_closed',
])

// --- DATES -------------------------------------------------------------------------------------------------

// en-US with the month written out ("October 9, 2026"): unambiguous on
// both sides of the Atlantic, unlike 10/9/2026.
const LOCALE = 'en-US'

// A DAY ('YYYY-MM-DD'). Read at midnight UTC and written in UTC, so no zone
// can move it to the day before.
export function dayText(day: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`))
}

// A MOMENT, in the patient's zone: "October 9, 2026 at 3:40 PM".
export function momentText(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  }).format(moment)
}

// The DAY of a moment, in the patient's zone: "October 9, 2026".
function momentDayText(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'long',
    timeZone,
  }).format(moment)
}

// --- NUMBERS -----------------------------------------------------------------------------------------------

// "45 s", "2 min", "1 min 30 s" — an exercise's length, to the second.
export function durationText(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest} s`
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

// A session's length, to the minute ("25 min"); under a minute is said so
// rather than rounded to 0.
function sessionLengthText(seconds: number): string {
  if (seconds < 60) return 'less than a minute'
  return `${Math.round(seconds / 60)} min`
}

// What an exercise asks: "3 × 10", "3 × 30 s", "10 reps", "45 s", "3 sets",
// then the weight ("3 × 10 · 20 kg"). null when nothing is set (an exercise
// with no numbers at all — "as the notes say").
export function doseText(exercise: PrescribedExercise): string | null {
  const { sets, reps, durationInSeconds, weight, weightUnit } = exercise
  const each =
    reps !== null
      ? String(reps)
      : durationInSeconds !== null
        ? durationText(durationInSeconds)
        : null
  let dose: string | null
  if (sets !== null && each !== null) dose = `${sets} × ${each}`
  else if (sets !== null) dose = plural(sets, 'set')
  else if (reps !== null) dose = plural(reps, 'rep')
  else if (durationInSeconds !== null) dose = durationText(durationInSeconds)
  else dose = null
  // The database stores a weight with its unit or neither (a CHECK), so
  // weightUnit is set whenever weight is.
  const load = weight !== null ? `${weight} ${weightUnit}` : null
  if (dose !== null && load !== null) return `${dose} · ${load}`
  return dose ?? load
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// A score out of ten, the way the session screens ask it.
function scoreText(score: number): string {
  return `${score} / 10`
}

// --- WORKOUT NAMES -----------------------------------------------------------------------------------------

// "A", or "A · Mobility" — by position, as everywhere in the app (frontend
// workoutLabel.ts).
export function workoutLabel(position: number, name: string | null): string {
  const letter = String.fromCharCode(65 + position)
  return name?.trim() ? `${letter} · ${name.trim()}` : letter
}

// --- THE MEDICAL FILE --------------------------------------------------------------------------------------

// One record kept in versions — a note, a range-of-motion assessment: its
// latest version first, then the versions it replaced, newest to oldest —
// the same grouping as My records (frontend medicalFileRules.ts,
// groupIntoNotes).
export interface Versions<T> {
  latest: T
  earlier: T[]
}
export type NoteVersions = Versions<MedicalFileEntry>

// What grouping needs of a record: its id, what it corrects, what corrects it.
interface Versioned {
  id: number
  amendsId: number | null
  amendedById: number | null
}

// Records in the order of their latest version (`newerFirst`, a sort
// comparator). A record is the LATEST of its chain when nothing amends it
// (amendedById null); its earlier versions are found by following amendsId
// back. The walk stops at a missing link, or at a record already placed — so
// data that broke the rules (a loop) can't hang the export or show a record
// twice.
//
// Nothing is left out: a record reached by no walk (amended by one not in
// the list — impossible under row security, as an amendment always belongs
// to the same patient) is shown on its own rather than dropped from a copy
// that must be complete.
//
// Generic since range of motion (2026-10-31): the medical file's walk,
// unchanged, for any record amended the same way. `T extends Versioned`: any
// type with those three fields — the walk reads nothing else.
export function groupVersions<T extends Versioned>(
  records: T[],
  newerFirst: (a: T, b: T) => number,
): Versions<T>[] {
  const byId = new Map(records.map((record) => [record.id, record]))
  const placed = new Set<number>()
  const groups: Versions<T>[] = []
  for (const record of records) {
    if (record.amendedById !== null) continue
    groups.push({ latest: record, earlier: earlierVersions(record) })
  }
  for (const record of records) {
    if (!placed.has(record.id)) groups.push({ latest: record, earlier: [] })
  }
  return groups.sort((a, b) => newerFirst(a.latest, b.latest))

  function earlierVersions(latest: T): T[] {
    placed.add(latest.id)
    const earlier: T[] = []
    let previous = versionBefore(latest)
    while (previous && !placed.has(previous.id)) {
      placed.add(previous.id)
      earlier.push(previous)
      previous = versionBefore(previous)
    }
    return earlier
  }

  function versionBefore(record: T) {
    return record.amendsId === null ? undefined : byId.get(record.amendsId)
  }
}

// Notes, newest written first (the id breaks a tie of one instant).
export function groupIntoNotes(entries: MedicalFileEntry[]): NoteVersions[] {
  return groupVersions(
    entries,
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
  )
}

function noteBlocks(note: NoteVersions, timeZone: string): RecordBlock[] {
  const { latest, earlier } = note
  const blocks: RecordBlock[] = [
    {
      kind: 'heading',
      level: 2,
      text: `${ENTRY_TYPE_LABELS[latest.entryType]} · ${momentDayText(latest.createdAt, timeZone)}`,
    },
    ...versionBlocks(latest, timeZone),
  ]
  // The latest version HERE was corrected by one that isn't in this copy —
  // which only happens in a disclosed copy, when the correction was written
  // after the period it covers (a patient's own copy holds every version).
  // Said, so nobody reads a superseded note as the current one.
  if (latest.amendedById !== null) {
    blocks.push({
      kind: 'paragraph',
      text: 'This note was corrected later, after the period this copy covers.',
      muted: true,
    })
  }
  // Each earlier version, with when it was replaced — the next newer
  // version's moment (the one before it in the list, or the latest).
  earlier.forEach((version, index) => {
    const replacedBy = index === 0 ? latest : earlier[index - 1]
    blocks.push(
      {
        kind: 'heading',
        level: 3,
        text: `Earlier version, replaced on ${momentDayText(replacedBy.createdAt, timeZone)}`,
      },
      ...versionBlocks(version, timeZone),
    )
  })
  return blocks
}

// One version: who wrote it and when, what it corrects (an amendment), then
// its sections — only the ones written (a null section was never written).
function versionBlocks(
  entry: MedicalFileEntry,
  timeZone: string,
): RecordBlock[] {
  const rows: [string, string][] = [
    ['Written by', `${entry.author.firstName} ${entry.author.lastName}`],
    ['Written on', momentText(entry.createdAt, timeZone)],
  ]
  if (entry.amendsId !== null) {
    rows.push(['Reason for the correction', entry.amendmentReason ?? ''])
  }
  const blocks: RecordBlock[] = [{ kind: 'fields', rows }]
  for (const section of SECTIONS) {
    const text = entry[section]
    if (text !== null) {
      blocks.push({ kind: 'text', label: SECTION_LABELS[section], text })
    }
  }
  return blocks
}

// --- RANGE OF MOTION ---------------------------------------------------------------------------------------

// Assessments, newest MEASURED first (a clinician reads a record by the day
// things happened), then newest recorded, then id — loadRomAssessments'
// order, applied to each chain's latest version.
export function groupIntoAssessments(
  assessments: RomAssessment[],
): Versions<RomAssessment>[] {
  return groupVersions(
    assessments,
    (a, b) =>
      b.measuredOn.localeCompare(a.measuredOn) ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b.id - a.id,
  )
}

// "Knee flexion, right, active: 95° (typical 135°) — pain at end range". A
// value is written as it was measured, sign included ("-5°": 5° short of
// straight). The typical value beside it, every time: a number of degrees
// means little to a reader who doesn't know what the joint usually reaches.
// An ASCII hyphen for the sign: it is in every font the PDF embeds.
export function measurementLine(measurement: RomMeasurement): string {
  const { movement, side, mode, degrees, note } = measurement
  const typical = ROM_MOVEMENT_DETAILS[movement].typicalDegrees
  const line = `${measurementLabel(movement, side, mode)}: ${degrees}° (typical ${typical}°)`
  return note === null ? line : `${line} — ${note}`
}

// One assessment: its latest version, then each version it replaced (the
// notes' layout — noteBlocks). `notes`: the medical file entries in this
// copy, to name a linked note by its type and day.
function assessmentBlocks(
  assessment: Versions<RomAssessment>,
  notes: MedicalFileEntry[],
  timeZone: string,
): RecordBlock[] {
  const { latest, earlier } = assessment
  const blocks: RecordBlock[] = [
    {
      kind: 'heading',
      level: 2,
      text: `Range of motion · ${dayText(latest.measuredOn)}`,
    },
    ...assessmentVersionBlocks(latest, notes, timeZone),
  ]
  // As for a note: corrected after the period a disclosed copy covers.
  if (latest.amendedById !== null) {
    blocks.push({
      kind: 'paragraph',
      text: 'These measurements were corrected later, after the period this copy covers.',
      muted: true,
    })
  }
  earlier.forEach((version, index) => {
    const replacedBy = index === 0 ? latest : earlier[index - 1]
    blocks.push(
      {
        kind: 'heading',
        level: 3,
        text: `Earlier version, replaced on ${momentDayText(replacedBy.createdAt, timeZone)}`,
      },
      ...assessmentVersionBlocks(version, notes, timeZone),
    )
  })
  return blocks
}

function assessmentVersionBlocks(
  version: RomAssessment,
  notes: MedicalFileEntry[],
  timeZone: string,
): RecordBlock[] {
  const rows: [string, string][] = [
    ['Measured by', `${version.author.firstName} ${version.author.lastName}`],
    ['Measured on', dayText(version.measuredOn)],
    ['Recorded on', momentText(version.createdAt, timeZone)],
  ]
  if (version.medicalFileEntryId !== null) {
    rows.push(['Visit note', linkedNoteText(version.medicalFileEntryId)])
  }
  if (version.amendsId !== null) {
    rows.push(['Reason for the correction', version.amendmentReason ?? ''])
  }
  return [
    { kind: 'fields', rows },
    { kind: 'list', items: version.measurements.map(measurementLine) },
  ]

  // "Progress note of March 4, 2031" — the version linked when the
  // assessment was recorded (the reader finds that note by its day; if it was
  // corrected since, its correction is printed with it). A disclosed copy
  // may not hold it (written outside the period): said, not hidden.
  function linkedNoteText(entryId: number): string {
    const note = notes.find((entry) => entry.id === entryId)
    return note === undefined
      ? 'A note not included in this copy'
      : `${ENTRY_TYPE_LABELS[note.entryType]} of ${momentDayText(note.createdAt, timeZone)}`
  }
}

// The part's words, the same in every copy; the empty sentence differs.
const RANGE_OF_MOTION_HEADING = 'Range of motion'
const RANGE_OF_MOTION_INTRO =
  'How far your joints moved when your care team measured them, in degrees. ' +
  'The typical value is a textbook guide, not a target: people differ, and ' +
  'your other side is often the better comparison.'

function rangeOfMotionBlocks(
  record: RecordData,
  emptyText: string,
  timeZone: string,
): RecordBlock[] {
  const blocks: RecordBlock[] = [
    { kind: 'heading', level: 1, text: RANGE_OF_MOTION_HEADING },
    { kind: 'paragraph', text: RANGE_OF_MOTION_INTRO, muted: false },
  ]
  const assessments = groupIntoAssessments(record.rangeOfMotion)
  if (assessments.length === 0) {
    blocks.push({ kind: 'paragraph', text: emptyText, muted: true })
  }
  for (const assessment of assessments) {
    blocks.push(...assessmentBlocks(assessment, record.medicalFile, timeZone))
  }
  return blocks
}

// --- PROGRAMS AND SESSIONS ---------------------------------------------------------------------------------

// What a program's blocks show. The patient's own copy shows everything; a
// disclosed copy shows the parts the order covers — the prescription with
// "programs", the sessions with "sessions" (a program kept only for its
// sessions still gets its heading and dates: they say what the sessions
// were part of).
interface ProgramParts {
  prescription: boolean
  sessions: boolean
  // A disclosed copy's sessions are those of a period: "none in this
  // period", not "none yet".
  inPeriod: boolean
}

const WHOLE_PROGRAM: ProgramParts = {
  prescription: true,
  sessions: true,
  inPeriod: false,
}

function programBlocks(
  program: RecordProgram,
  parts: ProgramParts = WHOLE_PROGRAM,
): RecordBlock[] {
  const dates =
    program.endDate === null
      ? `${dayText(program.startDate)} – no end date`
      : `${dayText(program.startDate)} – ${dayText(program.endDate)}`
  const blocks: RecordBlock[] = [
    { kind: 'heading', level: 2, text: program.title },
    {
      kind: 'fields',
      rows: [
        [
          'Prescribed by',
          `${program.assignedBy.firstName} ${program.assignedBy.lastName}`,
        ],
        ['Dates', dates],
        ['Status', PROGRAM_STATUS_LABELS[program.status]],
      ],
    },
  ]

  // The prescription as it stands now (a session below keeps what was asked
  // on its own day).
  if (parts.prescription) {
    program.workouts.forEach((workout, position) => {
      blocks.push({
        kind: 'heading',
        level: 3,
        text: `Workout ${workoutLabel(position, workout.name)}`,
      })
      blocks.push(
        workout.exercises.length === 0
          ? { kind: 'paragraph', text: 'No exercises.', muted: true }
          : { kind: 'list', items: workout.exercises.map(exerciseLine) },
      )
    })
  }
  if (!parts.sessions) return blocks

  blocks.push({
    kind: 'heading',
    level: 3,
    text:
      program.sessions.length === 0
        ? 'Sessions'
        : `Sessions (${program.sessions.length})`,
  })
  if (program.sessions.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: parts.inPeriod ? 'No sessions in this period.' : 'No sessions yet.',
      muted: true,
    })
  }
  const positions = new Map(
    program.workouts.map((workout, position) => [workout.id, position]),
  )
  for (const session of program.sessions) {
    blocks.push(...sessionBlocks(session, program.workouts, positions))
  }
  return blocks
}

// "Bridges — 3 × 10 · 20 kg. Keep your back flat." — name, dose, notes.
function exerciseLine(exercise: PrescribedExercise): string {
  const dose = doseText(exercise)
  const line = dose === null ? exercise.name : `${exercise.name} — ${dose}`
  return exercise.notes === null ? line : `${line}. ${exercise.notes}`
}

// "Completed", "Stopped (pain)", "Skipped (no time)", "Not finished (the
// program was closed)", "In progress" — the progress page's words.
export function sessionOutcome(session: RecordSession): string {
  switch (session.status) {
    case 'completed':
      return 'Completed'
    case 'in_progress':
      return 'In progress'
    case 'skipped':
      return reasonText('Skipped', session.endReason)
    case 'incomplete':
      return session.endReason !== null &&
        APP_END_REASONS.has(session.endReason)
        ? reasonText('Not finished', session.endReason)
        : reasonText('Stopped', session.endReason)
  }
}

function reasonText(word: string, reason: SessionEndReason | null): string {
  return reason === null ? word : `${word} (${END_REASON_TEXT[reason]})`
}

function sessionBlocks(
  session: RecordSession,
  workouts: RecordWorkout[],
  positions: Map<number, number>,
): RecordBlock[] {
  // The workout as the program names it today. A workout removed since
  // can't be: the database refuses deleting a workout that has sessions.
  const position = positions.get(session.workoutId)
  const workout =
    position === undefined
      ? ''
      : ` · Workout ${workoutLabel(position, workouts[position].name)}`
  const rows: [string, string][] = [['Outcome', sessionOutcome(session)]]
  if (session.endNote !== null) rows.push(['Your note', session.endNote])
  if (session.totalDurationInSeconds !== null) {
    rows.push(['Length', sessionLengthText(session.totalDurationInSeconds)])
  }
  if (session.painBefore !== null) {
    rows.push(['Pain before', scoreText(session.painBefore)])
  }
  if (session.painAfter !== null) {
    rows.push(['Pain after', scoreText(session.painAfter)])
  }
  if (session.mobilityAfter !== null) {
    rows.push(['Mobility after', scoreText(session.mobilityAfter)])
  }
  const blocks: RecordBlock[] = [
    {
      kind: 'heading',
      level: 4,
      text: `${dayText(session.localDate)}${workout}`,
    },
    { kind: 'fields', rows },
  ]
  if (session.sessionFeedback !== null) {
    blocks.push({
      kind: 'text',
      label: 'Your feedback',
      text: session.sessionFeedback,
    })
  }
  // A skipped session has no exercises (never started); the others list
  // theirs, each with what was asked that day and what was done.
  if (session.exercises.length > 0) {
    blocks.push({
      kind: 'list',
      items: session.exercises.map(sessionExerciseLine),
    })
  }
  return blocks
}

// "Done: Bridges — 3 × 10 · difficulty 4 / 10 · “Felt easy”".
function sessionExerciseLine(exercise: SessionExerciseRecord): string {
  const parts = [
    `${exercise.completed ? 'Done' : 'Not done'}: ${exercise.name}`,
  ]
  const dose = doseText(exercise)
  if (dose !== null) parts[0] += ` — ${dose}`
  if (exercise.durationActualInSeconds !== null) {
    parts.push(`took ${durationText(exercise.durationActualInSeconds)}`)
  }
  if (exercise.difficultyRating !== null) {
    parts.push(`difficulty ${scoreText(exercise.difficultyRating)}`)
  }
  if (exercise.feedback !== null) parts.push(`“${exercise.feedback}”`)
  return parts.join(' · ')
}

// --- THE WHOLE DOCUMENT ------------------------------------------------------------------------------------

// `copy`: absent for the patient's own copy. Otherwise:
//   - a REVIEW copy (decisions §25, pass 2). The record itself is EXACTLY the
//     patient's own copy — same blocks, same words, still written to the
//     patient ("your medical file"): the point of a review is to see what the
//     patient's record says, and one generator means the two can never
//     differ. What changes is around it: the title, a first block saying
//     what this copy is and why it was made, and the stamp on every page.
//   - a DISCLOSED copy (pass 3): only the parts and the period the order
//     covers — its own document, below (disclosedDocument).
export function buildRecordDocument(
  record: RecordData,
  timeZone: string,
  copy?: CopyMark,
): RecordDocument {
  if (copy?.kind === 'disclosure') {
    return disclosedDocument(record, timeZone, copy.disclosure)
  }
  const review = copy?.kind === 'review' ? copy.review : undefined
  const { patient } = record
  const name = `${patient.firstName} ${patient.lastName}`
  const madeAt = momentText(record.madeAt, timeZone)

  const blocks: RecordBlock[] = [
    ...(review ? reviewBlocks(review, timeZone) : []),
    {
      kind: 'fields',
      rows: [
        ['Name', name],
        ['Date of birth', dayText(patient.dateOfBirth)],
        ['Email', patient.email],
        ['Copy made on', `${madeAt} (${timeZone} time)`],
      ],
    },
    {
      kind: 'paragraph',
      text:
        'This is a copy of your record as Stride held it when it was made: ' +
        'the notes your care team wrote in your medical file, the range of ' +
        'motion they measured, your exercise programs, and the sessions you ' +
        'did, stopped or skipped. Nothing in a medical file is ever changed ' +
        'or removed — a correction is a new entry, and the version it ' +
        'replaced is shown under it.',
      muted: false,
    },
    {
      kind: 'paragraph',
      text: 'Not included: your messages with your care team.',
      muted: true,
    },
    { kind: 'heading', level: 1, text: 'Medical file' },
  ]

  const notes = groupIntoNotes(record.medicalFile)
  if (notes.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'Your medical file has no entries.',
      muted: true,
    })
  }
  for (const note of notes) blocks.push(...noteBlocks(note, timeZone))

  blocks.push(
    ...rangeOfMotionBlocks(
      record,
      'No range of motion has been recorded.',
      timeZone,
    ),
  )

  blocks.push({
    kind: 'heading',
    level: 1,
    text: 'Exercise programs and sessions',
  })
  if (record.programs.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'You have no exercise programs.',
      muted: true,
    })
  }
  for (const program of record.programs) {
    blocks.push(...programBlocks(program))
  }

  // The accounting of disclosures, when it was read (always, for the patient's
  // own copy and a review copy — the loader's choice).
  if (record.disclosures !== undefined) {
    blocks.push(...accountingBlocks(record.disclosures, timeZone))
  }

  return {
    title: review ? REVIEW_DOCUMENT_TITLE : DOCUMENT_TITLE,
    footer: `Health record of ${name} · copy made on ${momentDayText(record.madeAt, timeZone)}`,
    ...(review ? { stamp: reviewStampText(review) } : {}),
    blocks,
  }
}

// "Review copy — made by Avery Admin for complaint review 12 (case CR-14)" —
// the line on every page. Who and which review, not the reason: a page is
// read by anyone who picks it up, and the reason is on the first page.
export function reviewStampText(review: ReviewStamp): string {
  const caseText =
    review.caseReference === null ? '' : ` (case ${review.caseReference})`
  return `Review copy — made by ${review.madeBy} for complaint review ${review.reviewId}${caseText}`
}

// The first page's account of the copy, ABOVE the patient's details: what it
// is, who made it, why, and until when the review allowed copies.
function reviewBlocks(review: ReviewStamp, timeZone: string): RecordBlock[] {
  return [
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
        ['Made by', review.madeBy],
        ['Complaint review', String(review.reviewId)],
        ...(review.caseReference === null
          ? []
          : [['Case reference', review.caseReference] as [string, string]]),
        ['Reason', review.reason],
        ['Review open until', momentText(review.expiresAt, timeZone)],
      ],
    },
  ]
}

// --- THE ACCOUNTING OF DISCLOSURES -------------------------------------------------------------------------

// The patient's own list of the times their record left the clinic because
// the law required it (HIPAA 164.528; decisions §25, pass 3 — "who, why,
// when, what": recipient, legal basis, date, parts and period). The same
// facts as My records' "Your record was shared" list.
function accountingBlocks(
  disclosures: RecordDisclosure[],
  timeZone: string,
): RecordBlock[] {
  const blocks: RecordBlock[] = [
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
  ]
  if (disclosures.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'Your record has not been disclosed outside the clinic.',
      muted: true,
    })
  }
  for (const disclosure of disclosures) {
    const rows: [string, string][] = [['Given to', disclosure.recipientName]]
    if (disclosure.recipientOrganisation !== null) {
      rows.push(['Organisation', disclosure.recipientOrganisation])
    }
    rows.push(
      [
        'Why',
        legalBasisText(disclosure.legalBasis, disclosure.basisExplanation),
      ],
      ['What', partsText(disclosure.parts)],
      ['Period', periodText(disclosure.period, dayText)],
    )
    blocks.push(
      {
        kind: 'heading',
        level: 2,
        text: `${momentDayText(disclosure.madeAt, timeZone)} · ${recipientText(disclosure)}`,
      },
      { kind: 'fields', rows },
    )
  }
  return blocks
}

// "Jane Roe (Montreal Police)", or the name alone.
function recipientText(recipient: {
  recipientName: string
  recipientOrganisation: string | null
}): string {
  return recipient.recipientOrganisation === null
    ? recipient.recipientName
    : `${recipient.recipientName} (${recipient.recipientOrganisation})`
}

// --- THE DISCLOSED COPY ------------------------------------------------------------------------------------

// A legal disclosure's document (decisions §25, pass 3). The record arrives
// already narrowed to the order's parts and period (scopeRecord,
// record-scope.ts); this decides what is SAID: what this copy is, for whom
// and why (first page), the patient's identity, then each included part —
// and only those — in the patient's own copy's words.
function disclosedDocument(
  record: RecordData,
  timeZone: string,
  disclosure: DisclosureStamp,
): RecordDocument {
  const { patient } = record
  const name = `${patient.firstName} ${patient.lastName}`
  const parts = new Set(disclosure.parts)
  const missing = missingPartsText(disclosure.parts)

  const blocks: RecordBlock[] = [
    ...disclosureBlocks(disclosure, timeZone),
    {
      kind: 'fields',
      // No email: a disclosure carries what identifies the patient (name,
      // date of birth), not how to reach them — the least that serves.
      rows: [
        ['Name', name],
        ['Date of birth', dayText(patient.dateOfBirth)],
        [
          'Copy made on',
          `${momentText(record.madeAt, timeZone)} (${timeZone} time)`,
        ],
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
    ...(missing === null
      ? []
      : [
          {
            kind: 'paragraph',
            text: `Not included: ${missing}.`,
            muted: true,
          } satisfies RecordBlock,
        ]),
  ]

  if (parts.has('medical_file')) {
    blocks.push({ kind: 'heading', level: 1, text: 'Medical file' })
    const notes = groupIntoNotes(record.medicalFile)
    if (notes.length === 0) {
      blocks.push({
        kind: 'paragraph',
        text: 'No medical file entries in this period.',
        muted: true,
      })
    }
    for (const note of notes) blocks.push(...noteBlocks(note, timeZone))
    // Range of motion is part of the medical file (the clinician's objective
    // findings) — disclosed with it, in its own part, by the day measured.
    blocks.push(
      ...rangeOfMotionBlocks(
        record,
        'No range of motion measured in this period.',
        timeZone,
      ),
    )
  }

  const prescription = parts.has('programs')
  const sessions = parts.has('sessions')
  if (prescription || sessions) {
    blocks.push({
      kind: 'heading',
      level: 1,
      text:
        prescription && sessions
          ? 'Exercise programs and sessions'
          : prescription
            ? 'Exercise programs'
            : 'Sessions',
    })
    if (record.programs.length === 0) {
      blocks.push({
        kind: 'paragraph',
        text: prescription
          ? 'No exercise programs in this period.'
          : 'No sessions in this period.',
        muted: true,
      })
    }
    for (const program of record.programs) {
      blocks.push(
        ...programBlocks(program, { prescription, sessions, inPeriod: true }),
      )
    }
  }

  if (parts.has('messages')) {
    blocks.push(...messageBlocks(record.conversations ?? [], patient, timeZone))
  }

  return {
    title: DISCLOSURE_DOCUMENT_TITLE,
    footer: `Health record of ${name} · copy made on ${momentDayText(record.madeAt, timeZone)}`,
    stamp: disclosureStampText(disclosure, record.madeAt, timeZone),
    blocks,
  }
}

// The first page's account of the disclosure, ABOVE the patient's details:
// what this copy is, who receives it, under what, and what it holds.
function disclosureBlocks(
  disclosure: DisclosureStamp,
  timeZone: string,
): RecordBlock[] {
  const rows: [string, string][] = [['Disclosed to', disclosure.recipientName]]
  if (disclosure.recipientOrganisation !== null) {
    rows.push(['Organisation', disclosure.recipientOrganisation])
  }
  rows.push([
    'Legal basis',
    legalBasisText(disclosure.legalBasis, disclosure.basisExplanation),
  ])
  if (disclosure.orderReference !== null) {
    rows.push(['Order reference', disclosure.orderReference])
  }
  rows.push(
    ['Request received on', dayText(disclosure.receivedOn)],
    ['Made by', disclosure.madeBy],
    ['Disclosure', String(disclosure.disclosureId)],
    ['Parts included', partsText(disclosure.parts)],
    [
      'Period',
      // The days are read in the copy's zone (a note written late on the
      // 31st in Montreal is an April 1 note in Paris) — said, so the reader
      // knows which.
      `${periodText(disclosure.period, dayText)} (days in ${timeZone} time)`,
    ],
  )
  return [
    {
      kind: 'paragraph',
      text:
        'Copy disclosed outside the clinic because the law required it — ' +
        "not the patient's own copy. It holds only the parts of the record " +
        'and the period listed here.',
      muted: false,
    },
    { kind: 'fields', rows },
  ]
}

// The longest recipient or reference the one-line stamp prints in full;
// longer ones are cut with "…" (the first page has them whole). The stamp is
// drawn on a single line, never wrapped (record-pdf.ts).
const STAMP_PART_MAX = 60

function shortened(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

// "Disclosed to Montreal Police under a court order (ref. 500-17-123) on
// October 28, 2026 · disclosure 4" — on every page. Who receives it (the
// organisation if there is one — the name is on the first page), under what,
// when, and which disclosure, so a loose page leads back to its record.
export function disclosureStampText(
  disclosure: DisclosureStamp,
  madeAt: Date,
  timeZone: string,
): string {
  const who = shortened(
    disclosure.recipientOrganisation ?? disclosure.recipientName,
    STAMP_PART_MAX,
  )
  const reference =
    disclosure.orderReference === null
      ? ''
      : ` (ref. ${shortened(disclosure.orderReference, STAMP_PART_MAX)})`
  return (
    `Disclosed to ${who} under ${LEGAL_BASIS_IN_SENTENCE[disclosure.legalBasis]}` +
    `${reference} on ${momentDayText(madeAt, timeZone)} · disclosure ${disclosure.disclosureId}`
  )
}

// --- MESSAGES ----------------------------------------------------------------------------------------------

// The conversations of the period, each with one practitioner, its messages
// oldest first — "who · when", then the text as written.
function messageBlocks(
  conversations: RecordConversation[],
  patient: PersonName,
  timeZone: string,
): RecordBlock[] {
  const blocks: RecordBlock[] = [
    { kind: 'heading', level: 1, text: 'Messages' },
  ]
  if (conversations.length === 0) {
    blocks.push({
      kind: 'paragraph',
      text: 'No messages in this period.',
      muted: true,
    })
  }
  const patientName = `${patient.firstName} ${patient.lastName}`
  for (const conversation of conversations) {
    const practitionerName = `${conversation.practitioner.firstName} ${conversation.practitioner.lastName}`
    blocks.push({
      kind: 'heading',
      level: 2,
      text: `With ${practitionerName} (${plural(conversation.messages.length, 'message')})`,
    })
    for (const message of conversation.messages) {
      const label = `${message.fromPatient ? patientName : practitionerName} · ${momentText(message.sentAt, timeZone)}`
      blocks.push(
        message.body === null
          ? {
              kind: 'paragraph',
              text: `${label} — deleted by its sender before it was read; its text isn't shown.`,
              muted: true,
            }
          : { kind: 'text', label, text: message.body },
      )
    }
  }
  return blocks
}
