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

// The records export's READS (decisions §20): one patient's whole record,
// as plain data (RecordData, record-content.ts).
//
// Who may read what is NOT decided here. The caller runs these queries in a
// transaction acting AS THE PATIENT (withRlsContext), so row security
// applies the patient's own policies — the same ones My records and the
// session screens go through. The WHERE clauses below only say whose record
// is being copied; if they ever named someone else's, the policies would
// still hand back nothing.
//
// Nine queries, whatever the size of the record (never one per program or
// per session; two of them the range of motion's, since Phase 7): each reads every row of its table for the whole record, and
// the rows are grouped here, in memory. Two more when asked (decisions §25,
// pass 3): the conversations and their messages (a legal disclosure that
// includes them), and the accounting of disclosures (the patient's own copy).

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DrizzleDb } from '../database/drizzle.provider'
import {
  assignedProgramExercises,
  assignedPrograms,
  conversations,
  legalDisclosureDetails,
  legalDisclosures,
  medicalFiles,
  messages,
  patientProfiles,
  programWorkouts,
  romAssessments,
  sessionExercises,
  sessions,
  users,
} from '../database/schema'
import { loadMedicalFileEntries } from '../medical-files/medical-files.service'
import { loadRomAssessments } from '../range-of-motion/range-of-motion.service'
import { partsFromFlags } from '../legal-disclosures/legal-disclosure-rules'
import type {
  PrescribedExercise,
  RecordConversation,
  RecordData,
  RecordDisclosure,
  RecordProgram,
  RecordSession,
  RecordWorkout,
  SessionExerciseRecord,
} from './record-content'

// --- LOADING -----------------------------------------------------------------------------------------------

// What to read besides the file, the programs and the sessions:
//   - messages: ONLY for a legal disclosure that includes them — no other
//     copy ever holds messages (decisions §25), so nothing else reads them;
//   - disclosures: the patient's accounting — for the patient's own copy
//     (and a review copy, which is exactly that), never for a disclosed
//     copy (no order covers the other disclosures).
export interface RecordLoadOptions {
  messages: boolean
  disclosures: boolean
}

const OWN_COPY: RecordLoadOptions = { messages: false, disclosures: true }

export async function loadRecord(
  tx: DrizzleDb,
  patientId: number,
  options: RecordLoadOptions = OWN_COPY,
): Promise<RecordData> {
  // The moment of the copy: now() is the TRANSACTION's start — the same
  // instant the audit entry, written in this transaction, will carry.
  const { rows } = await tx.execute<{ now: string | Date }>(
    sql`SELECT now() AS now`,
  )
  const madeAt = new Date(rows[0].now)

  const [patient] = await tx
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      dateOfBirth: patientProfiles.dateOfBirth,
    })
    .from(users)
    .innerJoin(patientProfiles, eq(patientProfiles.userId, users.id))
    .where(eq(users.id, patientId))
  if (!patient) {
    // Only a patient reaches the export (the role guard), and every patient
    // has a profile row — so this is broken data, not a request to refuse.
    throw new Error(`No patient profile for user ${patientId}`)
  }

  const medicalFile = await loadMedicalFileEntries(
    tx,
    eq(medicalFiles.patientId, patientId),
  )
  // The screens' own query (two of them), as for the file.
  const rangeOfMotion = await loadRomAssessments(
    tx,
    eq(romAssessments.patientId, patientId),
  )
  const programs = await loadPrograms(tx, patientId)

  return {
    patient,
    medicalFile,
    rangeOfMotion,
    programs,
    ...(options.messages
      ? { conversations: await loadConversations(tx, patientId) }
      : {}),
    ...(options.disclosures
      ? { disclosures: await loadDisclosures(tx, patientId) }
      : {}),
    madeAt,
  }
}

// The patient's conversations and every message in them — as the PATIENT
// reads them: the transaction acts as the patient, so the conversations'
// policies (0048: participants only) decide which ones exist, and a message
// is visible when its conversation is (0005). Two queries; the practitioner's
// name comes with the conversation (users are readable by every session).
async function loadConversations(
  tx: DrizzleDb,
  patientId: number,
): Promise<RecordConversation[]> {
  const practitioner = alias(users, 'practitioner')
  const conversationRows = await tx
    .select({
      id: conversations.id,
      practitioner: {
        firstName: practitioner.firstName,
        lastName: practitioner.lastName,
      },
    })
    .from(conversations)
    .innerJoin(practitioner, eq(practitioner.id, conversations.practitionerId))
    .where(eq(conversations.patientId, patientId))
    // A stable order: the conversation started first comes first.
    .orderBy(asc(conversations.createdAt), asc(conversations.id))
  if (conversationRows.length === 0) return []

  const messageRows = await tx
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      messageBody: messages.messageBody,
      sentAt: messages.sentAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(
      inArray(
        messages.conversationId,
        conversationRows.map((conversation) => conversation.id),
      ),
    )
    // Oldest first, as a conversation reads; the id breaks a tie.
    .orderBy(asc(messages.sentAt), asc(messages.id))

  const byConversation = groupBy(messageRows, (row) => row.conversationId)
  return conversationRows.map((conversation) => ({
    ...conversation,
    messages: (byConversation.get(conversation.id) ?? []).map((row) => ({
      id: row.id,
      fromPatient: row.senderId === patientId,
      sentAt: row.sentAt,
      // A deleted message's text stays in the row; the patient reads it
      // without (toPublicMessage, messaging) — and so does the copy.
      body: row.deletedAt === null ? row.messageBody : null,
    })),
  }))
}

// The patient's accounting of disclosures, newest first — as the PATIENT
// reads it: a disclosure still held back (0069's policy) isn't returned, so
// no copy can show it before its time.
async function loadDisclosures(
  tx: DrizzleDb,
  patientId: number,
): Promise<RecordDisclosure[]> {
  const rows = await tx
    .select({
      id: legalDisclosures.id,
      madeAt: legalDisclosures.madeAt,
      recipientName: legalDisclosures.recipientName,
      recipientOrganisation: legalDisclosures.recipientOrganisation,
      legalBasis: legalDisclosureDetails.legalBasis,
      basisExplanation: legalDisclosureDetails.basisExplanation,
      includesMedicalFile: legalDisclosureDetails.includesMedicalFile,
      includesPrograms: legalDisclosureDetails.includesPrograms,
      includesSessions: legalDisclosureDetails.includesSessions,
      includesMessages: legalDisclosureDetails.includesMessages,
      periodFrom: legalDisclosureDetails.periodFrom,
      periodTo: legalDisclosureDetails.periodTo,
    })
    .from(legalDisclosures)
    .innerJoin(
      legalDisclosureDetails,
      eq(legalDisclosureDetails.disclosureId, legalDisclosures.id),
    )
    .where(eq(legalDisclosures.patientId, patientId))
    .orderBy(desc(legalDisclosures.madeAt), desc(legalDisclosures.id))
  return rows.map((row) => ({
    id: row.id,
    madeAt: row.madeAt,
    recipientName: row.recipientName,
    recipientOrganisation: row.recipientOrganisation,
    legalBasis: row.legalBasis,
    basisExplanation: row.basisExplanation,
    parts: partsFromFlags(row),
    period: { from: row.periodFrom, to: row.periodTo },
  }))
}

async function loadPrograms(
  tx: DrizzleDb,
  patientId: number,
): Promise<RecordProgram[]> {
  const programRows = await tx
    .select({
      id: assignedPrograms.id,
      title: assignedPrograms.title,
      status: assignedPrograms.status,
      startDate: assignedPrograms.startDate,
      endDate: assignedPrograms.endDate,
      assignedBy: { firstName: users.firstName, lastName: users.lastName },
    })
    .from(assignedPrograms)
    .innerJoin(users, eq(users.id, assignedPrograms.assignedBy))
    .where(eq(assignedPrograms.patientId, patientId))
    .orderBy(desc(assignedPrograms.startDate), desc(assignedPrograms.id))
  if (programRows.length === 0) return []
  const programIds = programRows.map((program) => program.id)

  const workoutRows = await tx
    .select({
      id: programWorkouts.id,
      assignedProgramId: programWorkouts.assignedProgramId,
      name: programWorkouts.name,
    })
    .from(programWorkouts)
    .where(inArray(programWorkouts.assignedProgramId, programIds))
    .orderBy(asc(programWorkouts.sortOrder), asc(programWorkouts.id))

  // The prescription as it stands: a RETIRED exercise (taken out of a
  // workout that already had sessions with it) is no longer prescribed —
  // the sessions that included it still list it, from their own copy.
  const exerciseRows = await tx
    .select({
      workoutId: assignedProgramExercises.workoutId,
      ...prescriptionColumns(assignedProgramExercises),
    })
    .from(assignedProgramExercises)
    .where(
      and(
        inArray(assignedProgramExercises.assignedProgramId, programIds),
        isNull(assignedProgramExercises.retiredAt),
      ),
    )
    .orderBy(
      asc(assignedProgramExercises.sortOrder),
      asc(assignedProgramExercises.id),
    )

  const sessionRows = await tx
    .select({
      id: sessions.id,
      assignedProgramId: sessions.assignedProgramId,
      workoutId: sessions.workoutId,
      localDate: sessions.localDate,
      status: sessions.status,
      totalDurationInSeconds: sessions.totalDurationInSeconds,
      painBefore: sessions.painBefore,
      painAfter: sessions.painAfter,
      mobilityAfter: sessions.mobilityAfter,
      sessionFeedback: sessions.sessionFeedback,
      endReason: sessions.endReason,
      endNote: sessions.endNote,
    })
    .from(sessions)
    .where(inArray(sessions.assignedProgramId, programIds))
    .orderBy(asc(sessions.localDate), asc(sessions.id))

  const sessionIds = sessionRows.map((session) => session.id)
  const sessionExerciseRows =
    sessionIds.length === 0
      ? []
      : await tx
          .select({
            sessionId: sessionExercises.sessionId,
            ...prescriptionColumns(sessionExercises),
            completed: sessionExercises.completed,
            durationActualInSeconds: sessionExercises.durationActualInSeconds,
            difficultyRating: sessionExercises.difficultyRating,
            feedback: sessionExercises.feedback,
          })
          .from(sessionExercises)
          .where(inArray(sessionExercises.sessionId, sessionIds))
          .orderBy(asc(sessionExercises.sortOrder), asc(sessionExercises.id))

  // --- grouping: child rows under their parent, keeping the order above ---

  const exercisesByWorkout = groupBy(exerciseRows, (row) => row.workoutId)
  const workoutsByProgram = groupBy(workoutRows, (row) => row.assignedProgramId)
  const exercisesBySession = groupBy(
    sessionExerciseRows,
    (row) => row.sessionId,
  )
  const sessionsByProgram = groupBy(sessionRows, (row) => row.assignedProgramId)

  return programRows.map((program) => ({
    ...program,
    workouts: (workoutsByProgram.get(program.id) ?? []).map(
      (workout): RecordWorkout => ({
        id: workout.id,
        name: workout.name,
        exercises: (exercisesByWorkout.get(workout.id) ?? []).map(
          ({ workoutId: _workoutId, ...exercise }) => exercise,
        ),
      }),
    ),
    sessions: (sessionsByProgram.get(program.id) ?? []).map(
      ({ assignedProgramId: _programId, ...session }): RecordSession => ({
        ...session,
        exercises: (exercisesBySession.get(session.id) ?? []).map(
          ({ sessionId: _sessionId, ...exercise }): SessionExerciseRecord =>
            exercise,
        ),
      }),
    ),
  }))
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// The columns of a prescription — the same seven in the program's exercises
// and in a session's copy of them.
function prescriptionColumns(
  table: typeof assignedProgramExercises | typeof sessionExercises,
) {
  return {
    name: table.name,
    sets: table.sets,
    reps: table.reps,
    durationInSeconds: table.durationInSeconds,
    weight: table.weight,
    weightUnit: table.weightUnit,
    notes: table.notes,
  } satisfies Record<keyof PrescribedExercise, unknown>
}

// Rows by a key, each group in the rows' own order. A Map keeps the
// insertion order of its keys and values alike.
function groupBy<Row, Key>(
  rows: Row[],
  keyOf: (row: Row) => Key,
): Map<Key, Row[]> {
  const groups = new Map<Key, Row[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return groups
}
