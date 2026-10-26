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
// Seven queries, whatever the size of the record (never one per program or
// per session): each reads every row of its table for the whole record, and
// the rows are grouped here, in memory.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../database/drizzle.provider'
import {
  assignedProgramExercises,
  assignedPrograms,
  medicalFiles,
  patientProfiles,
  programWorkouts,
  sessionExercises,
  sessions,
  users,
} from '../database/schema'
import { loadMedicalFileEntries } from '../medical-files/medical-files.service'
import type {
  PrescribedExercise,
  RecordData,
  RecordProgram,
  RecordSession,
  RecordWorkout,
  SessionExerciseRecord,
} from './record-content'

// --- LOADING -----------------------------------------------------------------------------------------------

export async function loadRecord(
  tx: DrizzleDb,
  patientId: number,
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
  const programs = await loadPrograms(tx, patientId)

  return { patient, medicalFile, programs, madeAt }
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
