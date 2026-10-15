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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type { sessions, sessionExercises } from '../database/schema'

type SessionRow = typeof sessions.$inferSelect
type SessionExerciseRow = typeof sessionExercises.$inferSelect

// --- AUDIT ENTRIES -----------------------------------------------------------------------------------------
//
// Every write to a session follows the audit convention (decided with the
// person 2026-10-15): the route is tagged @AuditedByService(), and the
// service writes ONE complete entry inside the change's own transaction —
// no change without its entry, no entry without its change. Exercise ticks
// included (about 50 entries a patient a week: nothing for Postgres, and
// the viewer can group them), so even a session abandoned halfway leaves a
// record of what was done. Entity 'sessions', target = the patient.
//
// Shared by SessionsService and AssignedProgramsService (closing a program
// closes its open sessions — step 1b), so a session's entries read the same
// whoever writes them. Plain copies, field by field (like exerciseForAudit
// in the programs service), so an entry never depends on what the row type
// happens to carry.

// What a session IS and how it ended — the part every entry about it shares.
export function sessionForAudit(session: SessionRow) {
  return {
    assignedProgramId: session.assignedProgramId,
    workoutId: session.workoutId,
    localDate: session.localDate,
    countsFor: session.countsFor,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
    endNote: session.endNote,
    painBefore: session.painBefore,
    painAfter: session.painAfter,
    mobilityAfter: session.mobilityAfter,
    totalDurationInSeconds: session.totalDurationInSeconds,
    sessionFeedback: session.sessionFeedback,
  }
}

// What the patient DID with each exercise — the results, by checklist row
// (the prescription is in the SESSION_STARTED entry, and fixed: 0033).
export function resultsForAudit(rows: SessionExerciseRow[]) {
  return rows.map((row) => ({
    exerciseRowId: row.id,
    name: row.name,
    completed: row.completed,
    durationActualInSeconds: row.durationActualInSeconds,
    difficultyRating: row.difficultyRating,
    feedback: row.feedback,
  }))
}
