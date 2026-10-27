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

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  assignedPrograms,
  programAlertReviews,
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
import { AuditService } from '../audit/audit.service'
import { perPatient } from '../audit/clinical-reads'
import {
  readScheduleVersions,
  readSummarySessions,
  summaryFromRows,
  type ScheduleVersion,
  type SummaryProgram,
  type SummarySessionRow,
} from '../assigned-programs/program-summary'
import {
  attendanceFacts,
  attendanceKeys,
  isAttendanceReviewed,
  reviewWindowStart,
  sessionReview,
  type AttendanceFacts,
  type AttendanceReview,
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

// What POST /alerts/programs/:id/review answers: the review that now
// covers the program's alert for this practitioner — the facts it saw and
// when.
export interface ProgramAlertReviewAnswer {
  missedSince: string | null
  inactiveSince: string | null
  reviewedAt: Date
}

const NOTHING_TO_REVIEW_MESSAGE =
  'Nothing on this program needs reviewing right now'

// One program's attendance facts for `today`, from ITS OWN schedule
// versions and session rows: the summary (the same code as GET …/summary),
// then the rules. Used by the list (every program at once, rows grouped in
// memory) and by the review route (one program, under its lock) — so the
// alert a practitioner reviews is exactly the one the list showed.
function programAttendance(
  program: SummaryProgram,
  versions: ScheduleVersion[],
  rows: SummarySessionRow[],
  today: string,
): AttendanceFacts | null {
  const summary = summaryFromRows(program, versions, rows, today)
  return attendanceFacts({
    startDate: program.startDate,
    endDate: program.endDate,
    today,
    pauses: summary.pauses,
    days: summary.days,
    weeks: summary.weeks,
    sessionDates: rows.map((row) => row.localDate),
  })
}

// `today` sent by the practitioner's app must be today somewhere (the
// summary's rule): one copy of the check and its message for both routes.
function assertPossibleToday(today: string) {
  if (!isPossibleToday(today)) {
    throw new BadRequestException(
      "today must be today's date in your time zone",
    )
  }
}

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class AlertsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly careTeamService: CareTeamService,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
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
  // HOW MANY QUERIES: a fixed number (ten, plus the care-team lookup),
  // whatever the number of patients or programs — each read asks for every
  // row it needs at once with `IN (…)`, and the rows are grouped in memory.
  // The alternative —
  // the home asking each program's summary and sessions — is one request
  // per program per patient (the "N+1" pattern), slow on a full caseload.
  async list(currentUser: CurrentUser, today: string): Promise<Alert[]> {
    assertPossibleToday(today)
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

      // 8. My LATEST review of each active program's attendance alert
      //    (2026-10-19). DISTINCT ON keeps the first row of each program in
      //    the ORDER BY — the newest — one row per program, in one query.
      //    The index (practitioner, program, reviewed_at) serves it.
      const programReviews =
        activeIds.length === 0
          ? []
          : await tx
              .selectDistinctOn([programAlertReviews.assignedProgramId], {
                assignedProgramId: programAlertReviews.assignedProgramId,
                missedSince: programAlertReviews.missedSince,
                inactiveSince: programAlertReviews.inactiveSince,
                reviewedAt: programAlertReviews.reviewedAt,
              })
              .from(programAlertReviews)
              .where(
                and(
                  eq(programAlertReviews.practitionerId, currentUser.id),
                  inArray(programAlertReviews.assignedProgramId, activeIds),
                ),
              )
              .orderBy(
                programAlertReviews.assignedProgramId,
                desc(programAlertReviews.reviewedAt),
                desc(programAlertReviews.id),
              )

      // 9. The patients' names and photos, and whether their account is
      //    active (attendance below).
      const people = await tx
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          avatarPath: users.avatarPath,
          isActive: users.isActive,
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
        programReviews,
        people,
      }
    })
    if (read === null) return []

    // --- In memory: group, then ask the pure rules ---------------------------

    const patients = new Map<number, AlertPatient>()
    const deactivated = new Set<number>()
    for (const person of read.people) {
      if (!person.isActive) deactivated.add(person.id)
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
    const latestReviews = new Map<number, AttendanceReview>(
      read.programReviews.map(({ assignedProgramId, ...review }) => [
        assignedProgramId,
        review,
      ]),
    )
    // One moment for the whole answer: every reminder is judged against it.
    const now = new Date()

    // Attendance: one summary per ACTIVE program, from its own rows. (A
    // closed program would raise nothing anyway — its end date is past, so
    // it isn't running — but its schedule wasn't even read: the guard says
    // so plainly instead of leaning on that.)
    //
    // Nor for a DEACTIVATED patient (decided 2026-10-27, decisions §22): they
    // can't sign in, so every planned day would read as missed — an alert
    // about an absence nobody can act on. Their programs stay open until
    // someone closes them; their recent SESSIONS (below) are still listed —
    // a session finished before the deactivation can still need a look, and
    // it leaves the list like any other: reviewed, or 14 days old.
    const attendance: AttendanceAlert[] = []
    for (const program of read.programs) {
      if (program.status !== 'active') continue
      if (deactivated.has(program.patientId)) continue
      const facts = programAttendance(
        program,
        read.versions.filter((v) => v.assignedProgramId === program.id),
        read.summaryRows.filter((row) => row.assignedProgramId === program.id),
        today,
      )
      if (facts === null) continue
      // Reviewed by me, and nothing new since (nor 14 days gone): not on
      // MY list. A colleague's review changes nothing here.
      const keys = attendanceKeys(facts, program.startDate)
      if (
        isAttendanceReviewed(keys, latestReviews.get(program.id) ?? null, now)
      ) {
        continue
      }
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
    const alerts = [...attendance, ...toReview]
    // AUDITED (the audit review, step 2): ONE ALERTS_VIEWED per patient the
    // list shows, naming exactly what it showed of them — the programs whose
    // attendance it reports, the sessions (with their pain scores) it asks
    // to review. A patient whose data was read but raised nothing was shown
    // nothing, and gets no entry. Written before the answer.
    await this.auditService.logReads(
      perPatient(alerts, (alert) => alert.patient.id).map(
        ([patientId, shown]) => ({
          performedBy: currentUser.id,
          action: 'ALERTS_VIEWED',
          targetUserId: patientId,
          entityType: 'alerts',
          details: {
            programIds: shown
              .filter((alert) => alert.kind === 'attendance')
              .map((alert) => alert.program.id),
            sessionIds: shown.flatMap((alert) =>
              alert.kind === 'session' ? [alert.session.id] : [],
            ),
          },
        }),
      ),
    )
    return alerts
  }
  // --- POST /alerts/programs/:programId/review ---

  // "Mark as reviewed" for a program's ATTENDANCE alert (decided with the
  // person 2026-10-19, after live testing): it takes the alert off THIS
  // practitioner's list until something new happens, or for 14 days.
  //
  // The client sends only `today`: the FACTS reviewed are computed here,
  // the same way the list computes them — a review always describes what
  // the alert really said, never what a client claims it said.
  //
  // Under the program's row lock (SELECT … FOR UPDATE), so two reviews at
  // once — a double tap, two tabs — are serialized: the second waits, then
  // finds the first's review already covering the alert and writes nothing
  // (the convention: a request that changes nothing writes nothing). Unlike
  // session reviews there is no unique index to lean on — a program gets a
  // new review per situation — so the lock is what makes it idempotent.
  //
  // Refusals: a program the practitioner can't see → 404 (row security,
  // then the care-team check — one answer, so an outsider learns nothing);
  // no attendance alert right now → 409.
  async reviewAttendance(
    programId: number,
    currentUser: CurrentUser,
    today: string,
  ): Promise<ProgramAlertReviewAnswer> {
    assertPossibleToday(today)
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [program] = await tx
        .select({
          id: assignedPrograms.id,
          patientId: assignedPrograms.patientId,
          status: assignedPrograms.status,
          startDate: assignedPrograms.startDate,
          endDate: assignedPrograms.endDate,
          lateMakeUpDays: assignedPrograms.lateMakeUpDays,
        })
        .from(assignedPrograms)
        .where(
          and(
            eq(assignedPrograms.id, programId),
            eq(assignedPrograms.isArchived, false),
          ),
        )
        .for('update')
      // Both layers of the care-team rule, as for every clinical read: row
      // security already hides a program off my care team (`program` is
      // undefined — mutation-checked: removing the TypeScript check below
      // changes no answer), and the check says the rule in TypeScript too.
      if (
        !program ||
        !(await this.careTeamService.isOnCareTeam(
          currentUser.id,
          program.patientId,
        ))
      ) {
        throw new NotFoundException(`Program ${programId} not found`)
      }
      // Only an active program raises an attendance alert — as in the list,
      // which reads schedules for active programs only. (A closed one would
      // raise nothing anyway: it isn't running past its end date. Kept to say
      // the rule plainly, the same way in both places.)
      const facts =
        program.status === 'active'
          ? programAttendance(
              program,
              await readScheduleVersions(tx, [program.id]),
              await readSummarySessions(tx, [program.id]),
              today,
            )
          : null
      if (facts === null) {
        throw new ConflictException(NOTHING_TO_REVIEW_MESSAGE)
      }
      const keys = attendanceKeys(facts, program.startDate)

      const [latest] = await tx
        .select({
          missedSince: programAlertReviews.missedSince,
          inactiveSince: programAlertReviews.inactiveSince,
          reviewedAt: programAlertReviews.reviewedAt,
        })
        .from(programAlertReviews)
        .where(
          and(
            eq(programAlertReviews.practitionerId, currentUser.id),
            eq(programAlertReviews.assignedProgramId, program.id),
          ),
        )
        .orderBy(
          desc(programAlertReviews.reviewedAt),
          desc(programAlertReviews.id),
        )
        .limit(1)
      if (isAttendanceReviewed(keys, latest ?? null, new Date())) return latest

      // reviewed_at isn't sent: the trigger writes the database's now().
      const [created] = await tx
        .insert(programAlertReviews)
        .values({
          assignedProgramId: program.id,
          practitionerId: currentUser.id,
          ...keys,
        })
        .returning({
          id: programAlertReviews.id,
          missedSince: programAlertReviews.missedSince,
          inactiveSince: programAlertReviews.inactiveSince,
          reviewedAt: programAlertReviews.reviewedAt,
        })
      // ONE complete entry in the same transaction (the audit convention):
      // whose program, which facts, on which day of the practitioner's.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'PROGRAM_ALERT_REVIEWED',
        targetUserId: program.patientId,
        entityType: 'program_alert_reviews',
        entityId: created.id,
        details: { programId: program.id, ...keys, today },
      })
      return {
        missedSince: created.missedSince,
        inactiveSince: created.inactiveSince,
        reviewedAt: created.reviewedAt,
      }
    })
  }
}
