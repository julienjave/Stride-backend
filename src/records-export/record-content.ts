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
import type { WeightUnit } from '../database/schema/weight-unit.schema'

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

export interface RecordData {
  patient: RecordPatient
  // Newest first, as loadMedicalFileEntries answers.
  medicalFile: MedicalFileEntry[]
  // Newest first (by first day).
  programs: RecordProgram[]
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
  blocks: RecordBlock[]
}

// --- WORDS -------------------------------------------------------------------------------------------------

export const DOCUMENT_TITLE = 'Your health record'

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

// One note: its latest version first, then the versions it replaced, newest
// to oldest — the same grouping as My records (frontend
// medicalFileRules.ts, groupIntoNotes).
export interface NoteVersions {
  latest: MedicalFileEntry
  earlier: MedicalFileEntry[]
}

// Notes in the order of their latest version (newest first). An entry is
// the LATEST of its note when nothing amends it (amendedById null); its
// earlier versions are found by following amendsId back. The walk stops at
// a missing link, or at an entry already placed — so data that broke the
// rules (a loop) can't hang the export or show an entry twice.
//
// Nothing is left out: an entry reached by no walk (amended by an entry not
// in the list — impossible under row security, as an amendment always
// belongs to the same patient) is shown as a note of its own rather than
// dropped from a copy that must be complete.
export function groupIntoNotes(entries: MedicalFileEntry[]): NoteVersions[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const placed = new Set<number>()
  const notes: NoteVersions[] = []
  for (const entry of entries) {
    if (entry.amendedById !== null) continue
    notes.push({ latest: entry, earlier: earlierVersions(entry) })
  }
  for (const entry of entries) {
    if (!placed.has(entry.id)) notes.push({ latest: entry, earlier: [] })
  }
  return notes.sort(
    (a, b) =>
      b.latest.createdAt.getTime() - a.latest.createdAt.getTime() ||
      b.latest.id - a.latest.id,
  )

  function earlierVersions(latest: MedicalFileEntry): MedicalFileEntry[] {
    placed.add(latest.id)
    const earlier: MedicalFileEntry[] = []
    let previous = versionBefore(latest)
    while (previous && !placed.has(previous.id)) {
      placed.add(previous.id)
      earlier.push(previous)
      previous = versionBefore(previous)
    }
    return earlier
  }

  function versionBefore(entry: MedicalFileEntry) {
    return entry.amendsId === null ? undefined : byId.get(entry.amendsId)
  }
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

// --- PROGRAMS AND SESSIONS ---------------------------------------------------------------------------------

function programBlocks(program: RecordProgram): RecordBlock[] {
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

  blocks.push({
    kind: 'heading',
    level: 3,
    text:
      program.sessions.length === 0
        ? 'Sessions'
        : `Sessions (${program.sessions.length})`,
  })
  if (program.sessions.length === 0) {
    blocks.push({ kind: 'paragraph', text: 'No sessions yet.', muted: true })
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

export function buildRecordDocument(
  record: RecordData,
  timeZone: string,
): RecordDocument {
  const { patient } = record
  const name = `${patient.firstName} ${patient.lastName}`
  const madeAt = momentText(record.madeAt, timeZone)

  const blocks: RecordBlock[] = [
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

  return {
    title: DOCUMENT_TITLE,
    footer: `Health record of ${name} · copy made on ${momentDayText(record.madeAt, timeZone)}`,
    blocks,
  }
}
