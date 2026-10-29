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
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  assignedPrograms,
  careTeamJoinReviews,
  careTeamMembers,
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
  isJoinNoticeFor,
  joinNoticeCutoff,
  reviewWindowStart,
  sessionReview,
  type AttendanceFacts,
  type AttendanceReview,
  type SessionAlertReason,
} from './alert-rules'
import {
  ComplaintReviewNoticesService,
  type ComplaintReviewAlert,
} from './complaint-review-notices.service'
import {
  LegalDisclosureNoticesService,
  type LegalDisclosureAlert,
} from './legal-disclosure-notices.service'
import {
  PatientMergeNoticesService,
  type PatientMergeAlert,
} from './patient-merge-notices.service'

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

// A colleague joined one of my patients' care teams (decisions §25, the
// post-Phase-6 tidy-up — pass 1). Who, on whose team, when, and who added
// them: `addedBy` is null when they joined by themselves. `endsAt` as stored:
// in the past, they have left since (still announced — they had access); in
// the future, a planned cover period; null, open-ended. No clinical data —
// who is on a care team is directory-level information (decisions §3).
export interface CareTeamJoinAlert {
  kind: 'care_team_join'
  patient: AlertPatient
  link: {
    id: number
    practitioner: PersonName
    addedBy: PersonName | null
    startedAt: Date
    endsAt: Date | null
  }
}

export interface PersonName {
  id: number
  firstName: string
  lastName: string
}

export type Alert =
  | AttendanceAlert
  | SessionAlert
  | CareTeamJoinAlert
  | ComplaintReviewAlert
  | LegalDisclosureAlert
  | PatientMergeAlert

// The notices about WHO CAN SEE a patient's record (decisions §25): a
// colleague joined the care team, an admin opened a complaint review, an
// admin disclosed the record because the law required it. Shown together,
// newest first, by the instant each happened.
// Since pass 4 of the duplicate-patients item (decisions §27), also: an admin
// merged a second account of the patient into this one — the record changed
// shape, so the team is told the same way.
type AccessNotice =
  | CareTeamJoinAlert
  | ComplaintReviewAlert
  | LegalDisclosureAlert
  | PatientMergeAlert

function noticeMoment(notice: AccessNotice): number {
  switch (notice.kind) {
    case 'care_team_join':
      return notice.link.startedAt.getTime()
    case 'complaint_review':
      return notice.review.openedAt.getTime()
    case 'legal_disclosure':
      return notice.disclosure.madeAt.getTime()
    case 'patient_merge':
      return notice.merge.mergedAt.getTime()
  }
}

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

// POST /alerts/care-team-joins/:linkId/review for a link that IS on one of my
// patients' teams but isn't a notice for me (my own link, one I created, one
// older than mine, or past the 14 days) — 409: the request is valid, the
// link's state is what conflicts with it.
export const NOT_A_JOIN_NOTICE_MESSAGE =
  'This change to the care team is not in your For review list'

// A care-team link is CURRENT at the database's now(): started, and not ended
// (an end in the future is a planned cover, still current) — the condition
// rls_care_team_member() writes (migration 0019), on the same clock.
function currentLink() {
  return and(
    lte(careTeamMembers.startedAt, sql`now()`),
    or(isNull(careTeamMembers.endsAt), gt(careTeamMembers.endsAt, sql`now()`)),
  )
}

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
    private readonly complaintReviewNotices: ComplaintReviewNoticesService,
    private readonly legalDisclosureNotices: LegalDisclosureNoticesService,
    private readonly patientMergeNotices: PatientMergeNoticesService,
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

    // Who else can see my patients' records: colleagues who joined their
    // care teams, admins who opened a complaint review, records disclosed
    // outside the clinic — read on their own (they need no program: a
    // patient with no program yet still has a team).
    // Merged newest first; Array.sort is STABLE (ES2019), so two notices of
    // the same instant keep their own lists' order.
    const notices: AccessNotice[] = [
      ...(await this.joinNotices(currentUser, patientIds)),
      ...(await this.complaintReviewNotices.list(currentUser, patientIds)),
      ...(await this.legalDisclosureNotices.list(currentUser, patientIds)),
      ...(await this.patientMergeNotices.list(currentUser, patientIds)),
    ].sort((a, b) => noticeMoment(b) - noticeMoment(a))

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
    if (read === null) return notices

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
    const clinical = [...attendance, ...toReview]
    // AUDITED (the audit review, step 2): ONE ALERTS_VIEWED per patient the
    // list shows, naming exactly what it showed of them — the programs whose
    // attendance it reports, the sessions (with their pain scores) it asks
    // to review. A patient whose data was read but raised nothing was shown
    // nothing, and gets no entry. Written before the answer. Only the
    // CLINICAL alerts: a join notice shows who is on a care team, which is
    // directory-level, not a read of the patient's clinical data (the care
    // team's own page records no read either).
    await this.auditService.logReads(
      perPatient(clinical, (alert) => alert.patient.id).map(
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
    // The order on the home: what is happening to patients first (attendance,
    // then sessions), then the changes to who can see their records.
    return [...clinical, ...notices]
  }

  // --- Care-team join notices ----------------------------------------------

  // The joins to announce to this practitioner, newest first. The rule is
  // isJoinNoticeFor (pure, alert-rules.ts); the queries only gather what it
  // needs, under the practitioner's row security.
  private async joinNotices(
    currentUser: CurrentUser,
    patientIds: number[],
  ): Promise<CareTeamJoinAlert[]> {
    const now = new Date()
    const cutoff = joinNoticeCutoff(now)
    const read = await withRlsContext(this.db, currentUser, async (tx) => {
      // My CURRENT link to each patient — when I joined (the rule announces
      // only newer members). The exclusion constraint (0019) allows one
      // current link per pair, so one row per patient at most. (Without the
      // "current" condition, an ended earlier link of mine would come back
      // too, and the Map below would keep whichever row came LAST. In the
      // tests Postgres returns them in insertion order — the current one last
      // — so that mutant survives; the condition is what makes the answer
      // independent of row order, which SQL never promises. The review route,
      // which reads ONE row, has a test that kills the same mutant.)
      const mine = await tx
        .select({
          patientId: careTeamMembers.patientId,
          startedAt: careTeamMembers.startedAt,
        })
        .from(careTeamMembers)
        .where(
          and(
            eq(careTeamMembers.practitionerId, currentUser.id),
            inArray(careTeamMembers.patientId, patientIds),
            currentLink(),
          ),
        )
      // The links that started within the window on those patients. The
      // window here only spares reading every link ever — the RULE (which
      // checks the window too) decides; mutation-checked as equivalent.
      const recent = await tx
        .select({
          id: careTeamMembers.id,
          patientId: careTeamMembers.patientId,
          practitionerId: careTeamMembers.practitionerId,
          createdBy: careTeamMembers.createdBy,
          startedAt: careTeamMembers.startedAt,
          endsAt: careTeamMembers.endsAt,
        })
        .from(careTeamMembers)
        .where(
          and(
            inArray(careTeamMembers.patientId, patientIds),
            gte(careTeamMembers.startedAt, cutoff),
          ),
        )
      const reviewed =
        recent.length === 0
          ? []
          : await tx
              .select({ linkId: careTeamJoinReviews.careTeamMemberId })
              .from(careTeamJoinReviews)
              // Mine only — said here AND by the table's SELECT policy (own
              // rows only, migration 0065): either alone is enough, so a
              // mutant removing one survives; removing both was checked to
              // fail the "still on C's list" test.
              .where(
                and(
                  eq(careTeamJoinReviews.practitionerId, currentUser.id),
                  inArray(
                    careTeamJoinReviews.careTeamMemberId,
                    recent.map((link) => link.id),
                  ),
                ),
              )
      return { mine, recent, reviewed }
    })

    const myStart = new Map(
      read.mine.map((row) => [row.patientId, row.startedAt]),
    )
    const reviewedIds = new Set(read.reviewed.map((row) => row.linkId))
    const notices = read.recent.filter(
      (link) =>
        !reviewedIds.has(link.id) &&
        isJoinNoticeFor(
          link,
          currentUser.id,
          myStart.get(link.patientId),
          cutoff,
        ),
    )
    if (notices.length === 0) return []

    // The names (and the patients' photos), in one batched query on the
    // service's own connection — AFTER the access decision, as the care team's
    // list reads its "added by" names (CareTeamService): the admin who added
    // someone is a user row a practitioner's row security may not show, and
    // the name is what the notice is about.
    const people = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarPath: users.avatarPath,
      })
      .from(users)
      .where(
        inArray(users.id, [
          ...new Set(
            notices.flatMap((link) => [
              link.patientId,
              link.practitionerId,
              // isJoinNoticeFor refused every link without a creator.
              link.createdBy!,
            ]),
          ),
        ]),
      )
    const byId = new Map(people.map((person) => [person.id, person]))
    const name = (id: number): PersonName => {
      const { firstName, lastName } = byId.get(id)!
      return { id, firstName, lastName }
    }

    const alerts: CareTeamJoinAlert[] = []
    for (const link of notices) {
      const patient = byId.get(link.patientId)!
      alerts.push({
        kind: 'care_team_join',
        patient: {
          id: patient.id,
          firstName: patient.firstName,
          lastName: patient.lastName,
          avatarUrl: await this.storageService.getPresignedUrlOrNull(
            patient.avatarPath,
            AVATAR_URL_EXPIRY_SECONDS,
          ),
        },
        link: {
          id: link.id,
          practitioner: name(link.practitionerId),
          // Joined by themselves → no "added by".
          addedBy:
            link.createdBy === link.practitionerId
              ? null
              : name(link.createdBy!),
          startedAt: link.startedAt,
          endsAt: link.endsAt,
        },
      })
    }
    return alerts.sort(
      (a, b) =>
        b.link.startedAt.getTime() - a.link.startedAt.getTime() ||
        b.link.id - a.link.id,
    )
  }

  // --- POST /alerts/care-team-joins/:linkId/review ---

  // "Mark as reviewed" for a join notice: takes it off THIS practitioner's
  // list (one row per practitioner and link). Idempotent: a second press
  // writes nothing and answers the first review (ON CONFLICT DO NOTHING on the
  // unique index — a concurrent second insert waits on the index, then does
  // nothing).
  //
  // Refusals: a link the practitioner can't see, or on a patient whose care
  // team they aren't on → 404 (one answer, so an outsider learns nothing);
  // a link of my patient that isn't a notice for me → 409.
  async reviewCareTeamJoin(
    linkId: number,
    currentUser: CurrentUser,
  ): Promise<{ reviewedAt: Date }> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [link] = await tx
        .select({
          id: careTeamMembers.id,
          patientId: careTeamMembers.patientId,
          practitionerId: careTeamMembers.practitionerId,
          createdBy: careTeamMembers.createdBy,
          startedAt: careTeamMembers.startedAt,
        })
        .from(careTeamMembers)
        .where(eq(careTeamMembers.id, linkId))
      if (
        !link ||
        !(await this.careTeamService.isOnCareTeam(
          currentUser.id,
          link.patientId,
        ))
      ) {
        throw new NotFoundException(`Care-team link ${linkId} not found`)
      }
      const [mine] = await tx
        .select({ startedAt: careTeamMembers.startedAt })
        .from(careTeamMembers)
        .where(
          and(
            eq(careTeamMembers.practitionerId, currentUser.id),
            eq(careTeamMembers.patientId, link.patientId),
            currentLink(),
          ),
        )
      // The same rule as the list, so a review always covers a notice the
      // list really showed.
      if (
        !isJoinNoticeFor(
          link,
          currentUser.id,
          mine?.startedAt,
          joinNoticeCutoff(new Date()),
        )
      ) {
        throw new ConflictException(NOT_A_JOIN_NOTICE_MESSAGE)
      }
      // reviewed_at isn't sent: the trigger writes the database's now().
      const [created] = await tx
        .insert(careTeamJoinReviews)
        .values({ careTeamMemberId: link.id, practitionerId: currentUser.id })
        .onConflictDoNothing({
          target: [
            careTeamJoinReviews.careTeamMemberId,
            careTeamJoinReviews.practitionerId,
          ],
        })
        .returning({
          id: careTeamJoinReviews.id,
          reviewedAt: careTeamJoinReviews.reviewedAt,
        })
      if (!created) {
        // Reviewed already: nothing written (the convention), the first
        // review answered.
        const [existing] = await tx
          .select({ reviewedAt: careTeamJoinReviews.reviewedAt })
          .from(careTeamJoinReviews)
          .where(
            and(
              eq(careTeamJoinReviews.careTeamMemberId, link.id),
              eq(careTeamJoinReviews.practitionerId, currentUser.id),
            ),
          )
        return existing
      }
      // ONE complete entry in the same transaction (the audit convention):
      // whose team, which link, who had joined.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'CARE_TEAM_JOIN_REVIEWED',
        targetUserId: link.patientId,
        entityType: 'care_team_join_reviews',
        entityId: created.id,
        details: {
          careTeamLinkId: link.id,
          practitionerId: link.practitionerId,
        },
      })
      return { reviewedAt: created.reviewedAt }
    })
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
