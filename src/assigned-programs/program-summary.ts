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

import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../database/drizzle.provider'
import {
  programScheduleDays,
  programScheduleRotation,
  programSchedules,
  sessions,
} from '../database/schema'
import type { ScheduleDay } from './schedule/schedule-content'
import { summarizeSchedule } from './schedule/schedule-summary'

// A PROGRAM's schedule summary, read from the database: the reads behind
// the schedule module, in ONE place. Two callers need exactly the same
// summary (moved here 2026-10-16, with late make-ups):
//   - GET /assigned-programs/:id/summary (AssignedProgramsService.summary) —
//     what the screens show;
//   - POST /sessions for a late make-up (SessionsService.create) — which
//     refuses a start the summary doesn't offer.
// If each read the sessions its own way, the button and the refusal could
// disagree; with one function they can't.
//
// The functions take a transaction and never check access: the caller has
// checked who may see the program, and opened the transaction in their RLS
// context (withRlsContext) — the policies on sessions and schedule versions
// then show only what that person may see, which for these callers is all
// of the program's rows.

// --- TYPES -------------------------------------------------------------------------------------------------

// A schedule version as the API returns it and the schedule module reads
// it: the program_schedules row plus its content from the two child tables
// — `days` (weekday → workout, in weekday order) and `rotation` (workout
// ids, position 0 first). Empty arrays when the type has none.
export type ScheduleVersion = typeof programSchedules.$inferSelect & {
  days: ScheduleDay[]
  rotation: number[]
}

// --- READS -------------------------------------------------------------------------------------------------

// The schedule versions of these programs, each with its content: the
// version rows (oldest first within a program), then their days and
// rotation positions — THREE queries whatever the number of programs or
// versions (`IN (…)` lists, grouped in memory), not one per version.
// Always called with a transaction carrying the caller's RLS context: the
// children's policies show only rows of versions the caller may see.
export async function readScheduleVersions(
  tx: DrizzleDb,
  programIds: number[],
): Promise<ScheduleVersion[]> {
  if (programIds.length === 0) return []
  const rows = await tx.query.programSchedules.findMany({
    where: inArray(programSchedules.assignedProgramId, programIds),
    orderBy: (row, { asc }) => [
      asc(row.assignedProgramId),
      asc(row.effectiveFrom),
    ],
  })
  if (rows.length === 0) return []
  const versionIds = rows.map((row) => row.id)
  const [dayRows, rotationRows] = [
    await tx.query.programScheduleDays.findMany({
      where: inArray(programScheduleDays.scheduleId, versionIds),
      orderBy: (row, { asc }) => [asc(row.weekday)],
    }),
    await tx.query.programScheduleRotation.findMany({
      where: inArray(programScheduleRotation.scheduleId, versionIds),
      orderBy: (row, { asc }) => [asc(row.position)],
    }),
  ]
  // Grouped by version; each list keeps the order it was read in.
  const days = new Map<number, ScheduleDay[]>()
  for (const row of dayRows) {
    days.set(row.scheduleId, [
      ...(days.get(row.scheduleId) ?? []),
      { weekday: row.weekday, workoutId: row.workoutId },
    ])
  }
  const rotation = new Map<number, number[]>()
  for (const row of rotationRows) {
    rotation.set(row.scheduleId, [
      ...(rotation.get(row.scheduleId) ?? []),
      row.workoutId,
    ])
  }
  return rows.map((row) => ({
    ...row,
    days: days.get(row.id) ?? [],
    rotation: rotation.get(row.id) ?? [],
  }))
}

// --- THE SUMMARY -------------------------------------------------------------------------------------------

// What summarizeProgram needs of the program row.
export interface SummaryProgram {
  id: number
  startDate: string
  endDate: string | null
  lateMakeUpDays: number | null
}

// The program's summary for `today` (and, optionally, `through`), plus
// `openSession`: the program's session IN PROGRESS — `{ sessionId,
// localDate, workoutId }` — or null. The module never sees it (an open
// session neither counts nor labels anything yet); it rides along so a
// screen can offer "Resume" instead of "Start" without a second request. At
// most one exists (the partial unique index sessions_one_open_per_program);
// its `localDate` may be an earlier day (left open — the next start will
// close it).
export async function summarizeProgram(
  tx: DrizzleDb,
  program: SummaryProgram,
  today: string,
  through?: string,
) {
  const versions = await readScheduleVersions(tx, [program.id])
  // Only what the module needs (id, the patient's day, the workout done,
  // the day it counts for, how it ended), for the sessions that ENDED:
  // completed ones count ("done" means completed — decided 2026-10-09);
  // skipped and stopped ones are labels (step 1b, 2026-10-15). An OPEN
  // session is neither yet — it's read in the same query for `openSession`
  // only, and kept away from the module below. The index on
  // (assigned_program_id, local_date) serves this read.
  const rows = await tx
    .select({
      id: sessions.id,
      localDate: sessions.localDate,
      workoutId: sessions.workoutId,
      // A session for another day — a swap, done early, a late make-up
      // (null for an ordinary session).
      countsFor: sessions.countsFor,
      status: sessions.status,
      endReason: sessions.endReason,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.assignedProgramId, program.id),
        inArray(sessions.status, [
          'completed',
          'skipped',
          'incomplete',
          'in_progress',
        ]),
      ),
    )

  const open = rows.find((row) => row.status === 'in_progress')
  const summary = summarizeSchedule({
    startDate: program.startDate,
    endDate: program.endDate,
    versions,
    sessions: rows
      .filter((row) => row.status === 'completed')
      .map(({ id, localDate, workoutId, countsFor }) => ({
        id,
        localDate,
        workoutId,
        countsFor,
      })),
    attempts: rows.flatMap((row) =>
      row.status === 'skipped' || row.status === 'incomplete'
        ? [
            {
              id: row.id,
              localDate: row.localDate,
              status: row.status,
              // Never null for these two (the CHECK
              // sessions_end_reason_matches_status).
              endReason: row.endReason!,
            },
          ]
        : [],
    ),
    today,
    through,
    lateMakeUpDays: program.lateMakeUpDays,
  })
  return {
    ...summary,
    openSession: open
      ? {
          sessionId: open.id,
          localDate: open.localDate,
          workoutId: open.workoutId,
        }
      : null,
  }
}
