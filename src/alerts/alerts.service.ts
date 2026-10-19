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

import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { and, eq, gte, inArray, ne } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  assignedPrograms,
  sessionExercises,
  sessionReviews,
  sessions,
  users,
} from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { isPossibleToday } from '../common/calendar-date'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { CareTeamService } from '../care-team/care-team.service'
import { StorageService } from '../storage/storage.service'
import { UserRole } from '../users/dto/create-user.dto'
import {
  readScheduleVersions,
  readSummarySessions,
  summaryFromRows,
} from '../assigned-programs/program-summary'
import {
  attendanceFacts,
  reviewWindowStart,
  sessionReview,
  type AttendanceFacts,
  type SessionAlertReason,
} from './alert-rules'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// Who the alert is about — enough for the row (name, photo), nothing more.
export interface AlertPatient {
  id: number
  firstName: string
  lastName: string
  avatarUrl: string | null
}

export interface AlertProgram {
  id: number
  title: string
}

// "This program's patient has stopped coming" — one per program, gone by
// itself once the patient acts.
export interface AttendanceAlert extends AttendanceFacts {
  kind: 'attendance'
  patient: AlertPatient
  program: AlertProgram
}

// "This session needs a look" — one per session, until THIS practitioner
// marks it reviewed (or it leaves the 14-day window).
export interface SessionAlert {
  kind: 'session'
  patient: AlertPatient
  program: AlertProgram
  // What the row shows of the session: its day, how it ended, and the two
  // pain scores (shown as "pain 5 → 7"). Never the patient's words — the
  // session page has them (minimum necessary).
  session: {
    id: number
    localDate: string
    status: 'completed' | 'incomplete' | 'skipped'
    endReason: string | null
    painBefore: number | null
    painAfter: number | null
  }
  reasons: SessionAlertReason[]
  hardExercises: { name: string; rating: number }[]
}

export type Alert = AttendanceAlert | SessionAlert

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class AlertsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly careTeamService: CareTeamService,
    private readonly storageService: StorageService,
  ) {}

  // --- GET /alerts ---

  // The practitioner's To-do (decided 2026-10-19): attendance alerts for
  // their patients' running programs, then the sessions of the last 14 days
  // they haven't reviewed. COMPUTED on every request, never stored: stored
  // alerts would need a job to keep them true, and a job has no user to
  // sign its audit entries (the "system actor" question, still open). Here
  // the answer is always today's data.
  //
  // WHOSE patients — HIPAA's care-team rule, at BOTH layers, as for every
  // clinical read:
  //   1. TypeScript: only the patients whose care team this practitioner is
  //      on (findPatientIdsForPractitioner — an active link AND a shared
  //      clinic). Someone on no care team gets an empty list, not a 403:
  //      "you have nothing to do" is the true answer, and says nothing about
  //      anyone else.
  //   2. SQL: every read below runs in the practitioner's RLS context
  //      (withRlsContext), so the policies on programs, sessions, checklists
  //      and reviews filter the same rows again. A bug in step 1 would show
  //      no extra patient.
  //
  // HOW MANY QUERIES: a fixed number (nine, plus the care-team lookup),
  // whatever the number of patients or programs — each read asks for every
  // row it needs at once with `IN (…)`, and the rows are grouped in memory.
  // The alternative —
  // the home asking each program's summary and sessions — is one request
  // per program per patient (the "N+1" pattern), slow on a full caseload.
  async list(currentUser: CurrentUser, today: string): Promise<Alert[]> {
    if (!isPossibleToday(today)) {
      throw new BadRequestException(
        "today must be today's date in your time zone",
      )
    }
    const patientIds = await this.careTeamService.findPatientIdsForPractitioner(
      currentUser.id,
    )
    // A shortcut, not a rule: with no patient every read below would find
    // nothing anyway (an empty `IN ()` matches no row) — this only spares
    // the transaction. (Mutation-checked: removing it changes no answer.)
    if (patientIds.length === 0) return []

    const read = await withRlsContext(this.db, currentUser, async (tx) => {
      // 1. The patients' programs — every status (a session of a program
      //    closed last week can still need a look), never a deleted one.
      const programs = await tx
        .select({
          id: assignedPrograms.id,
          patientId: assignedPrograms.patientId,
          title: assignedPrograms.title,
          status: assignedPrograms.status,
          startDate: assignedPrograms.startDate,
          endDate: assignedPrograms.endDate,
          lateMakeUpDays: assignedPrograms.lateMakeUpDays,
        })
        .from(assignedPrograms)
        .where(
          and(
            inArray(assignedPrograms.patientId, patientIds),
            eq(assignedPrograms.isArchived, false),
          ),
        )
      if (programs.length === 0) return null
      const programIds = programs.map((program) => program.id)
      const activeIds = programs
        .filter((program) => program.status === 'active')
        .map((program) => program.id)

      // 2–4. What the ACTIVE programs' summaries need: their schedule
      //      versions (three queries, in readScheduleVersions) and all
      //      their sessions (one) — the very reads GET …/summary makes, so
      //      "missed" here means what the program page shows.
      const versions = await readScheduleVersions(tx, activeIds)
      const summaryRows = await readSummarySessions(tx, activeIds)

      // 5. The sessions that may need a review: FINISHED, of any program,
      //    from the window's first day on. (`gte` only: a patient far east
      //    of the practitioner can already be on tomorrow.) Leaving the open
      //    one out is ALSO the rule's job (sessionReview never lists a
      //    session in progress) — no test can tell the two apart; here it
      //    reads less, and lets the status below be typed without it.
      const recent = await tx
        .select({
          id: sessions.id,
          assignedProgramId: sessions.assignedProgramId,
          localDate: sessions.localDate,
          status: sessions.status,
          endReason: sessions.endReason,
          painBefore: sessions.painBefore,
          painAfter: sessions.painAfter,
          sessionFeedback: sessions.sessionFeedback,
          endNote: sessions.endNote,
        })
        .from(sessions)
        .where(
          and(
            inArray(sessions.assignedProgramId, programIds),
            gte(sessions.localDate, reviewWindowStart(today)),
            ne(sessions.status, 'in_progress'),
          ),
        )
      const recentIds = recent.map((session) => session.id)

      // 6. Their checklists (what was rated, what was written) …
      const checklist =
        recentIds.length === 0
          ? []
          : await tx
              .select({
                sessionId: sessionExercises.sessionId,
                name: sessionExercises.name,
                difficultyRating: sessionExercises.difficultyRating,
                feedback: sessionExercises.feedback,
                sortOrder: sessionExercises.sortOrder,
              })
              .from(sessionExercises)
              .where(inArray(sessionExercises.sessionId, recentIds))
              .orderBy(sessionExercises.sessionId, sessionExercises.sortOrder)

      // 7. … and which of them THIS practitioner has already reviewed
      //    (the unique index on (session_id, practitioner_id) serves it).
      const reviewed =
        recentIds.length === 0
          ? []
          : await tx
              .select({ sessionId: sessionReviews.sessionId })
              .from(sessionReviews)
              .where(
                and(
                  inArray(sessionReviews.sessionId, recentIds),
                  eq(sessionReviews.practitionerId, currentUser.id),
                ),
              )

      // 8. The patients' names and photos.
      const people = await tx
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          avatarPath: users.avatarPath,
        })
        .from(users)
        .where(inArray(users.id, patientIds))

      return {
        programs,
        versions,
        summaryRows,
        recent,
        checklist,
        reviewed,
        people,
      }
    })
    if (read === null) return []

    // --- In memory: group, then ask the pure rules ---------------------------

    const patients = new Map<number, AlertPatient>()
    for (const person of read.people) {
      patients.set(person.id, {
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        avatarUrl: await this.storageService.getPresignedUrlOrNull(
          person.avatarPath,
          AVATAR_URL_EXPIRY_SECONDS,
        ),
      })
    }
    const programsById = new Map(read.programs.map((p) => [p.id, p]))
    const reviewedIds = new Set(read.reviewed.map((row) => row.sessionId))

    // Attendance: one summary per ACTIVE program, from its own rows. (A
    // closed program would raise nothing anyway — its end date is past, so
    // it isn't running — but its schedule wasn't even read: the guard says
    // so plainly instead of leaning on that.)
    const attendance: AttendanceAlert[] = []
    for (const program of read.programs) {
      if (program.status !== 'active') continue
      const rows = read.summaryRows.filter(
        (row) => row.assignedProgramId === program.id,
      )
      const summary = summaryFromRows(
        program,
        read.versions.filter((v) => v.assignedProgramId === program.id),
        rows,
        today,
      )
      const facts = attendanceFacts({
        startDate: program.startDate,
        endDate: program.endDate,
        today,
        pauses: summary.pauses,
        days: summary.days,
        weeks: summary.weeks,
        sessionDates: rows.map((row) => row.localDate),
      })
      if (facts === null) continue
      attendance.push({
        kind: 'attendance',
        patient: patients.get(program.patientId)!,
        program: { id: program.id, title: program.title },
        ...facts,
      })
    }

    // Sessions to review: the recent ones this practitioner hasn't
    // reviewed, for which the rules find a reason.
    const toReview: SessionAlert[] = []
    for (const session of read.recent) {
      if (reviewedIds.has(session.id)) continue
      const review = sessionReview({
        ...session,
        exercises: read.checklist.filter((row) => row.sessionId === session.id),
      })
      if (review === null) continue
      const program = programsById.get(session.assignedProgramId)!
      toReview.push({
        kind: 'session',
        patient: patients.get(program.patientId)!,
        program: { id: program.id, title: program.title },
        session: {
          id: session.id,
          localDate: session.localDate,
          // Never in_progress: the read above excludes it.
          status: session.status as SessionAlert['session']['status'],
          endReason: session.endReason,
          painBefore: session.painBefore,
          painAfter: session.painAfter,
        },
        ...review,
      })
    }

    // The order the list is shown in: attendance first (an ongoing
    // situation), by patient then program; then sessions, newest first —
    // by the patient's day, then by creation within a day.
    attendance.sort(
      (a, b) =>
        a.patient.lastName.localeCompare(b.patient.lastName) ||
        a.patient.firstName.localeCompare(b.patient.firstName) ||
        a.program.title.localeCompare(b.program.title) ||
        a.program.id - b.program.id,
    )
    toReview.sort(
      (a, b) =>
        b.session.localDate.localeCompare(a.session.localDate) ||
        b.session.id - a.session.id,
    )
    return [...attendance, ...toReview]
  }
}
