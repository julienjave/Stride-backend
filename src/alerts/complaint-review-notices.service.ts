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
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  careTeamMembers,
  complaintReviewNoticeReviews,
  complaintReviews,
  users,
} from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { CareTeamService } from '../care-team/care-team.service'
import { StorageService } from '../storage/storage.service'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import { isComplaintReviewNoticeFor, joinNoticeCutoff } from './alert-rules'
import type { AlertPatient, PersonName } from './alerts.service'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// An admin opened a complaint review of my patient's record (decisions §25,
// pass 2). Who, when, until, and whether it was ended early — NEVER the
// reason or the case reference (the person's choice; the database's too:
// they live in complaint_review_reasons, admins only).
export interface ComplaintReviewAlert {
  kind: 'complaint_review'
  patient: AlertPatient
  review: {
    id: number
    openedBy: PersonName
    openedAt: Date
    expiresAt: Date
    // Ended before its time (null: it ran, or is running, its course).
    endedAt: Date | null
  }
}

// POST /alerts/complaint-reviews/:reviewId/review for a review of my patient
// that isn't a notice for me (I joined after it opened, I opened it, or it's
// past the 14 days) — 409, as for a join.
export const NOT_A_REVIEW_NOTICE_MESSAGE =
  'This complaint review is not in your For review list'

// My CURRENT link to a patient — the condition rls_care_team_member()
// writes (0019), on the database's clock (alerts.service.ts's currentLink).
function currentLink() {
  return and(
    lte(careTeamMembers.startedAt, sql`now()`),
    or(isNull(careTeamMembers.endsAt), gt(careTeamMembers.endsAt, sql`now()`)),
  )
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// The care team's side of a complaint review: the notices in "For review"
// (GET /alerts includes them — AlertsService.list), and "Mark as reviewed".
// Computed from complaint_reviews on every request, like every alert; only
// the act of looking is stored. The rule is isComplaintReviewNoticeFor
// (pure, alert-rules.ts); the queries gather what it needs, under the
// practitioner's own row security — which shows a practitioner the reviews
// of their patients (complaint_reviews_select, 0067) and nothing of why.
@Injectable()
export class ComplaintReviewNoticesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly careTeamService: CareTeamService,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
  ) {}

  // The notices for this practitioner on these patients (theirs — the caller
  // found them), newest first.
  async list(
    currentUser: CurrentUser,
    patientIds: number[],
  ): Promise<ComplaintReviewAlert[]> {
    const cutoff = joinNoticeCutoff(new Date())
    const read = await withRlsContext(this.db, currentUser, async (tx) => {
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
      // The window here only spares reading every review ever — the RULE
      // decides (it checks the window too).
      const recent = await tx
        .select({
          id: complaintReviews.id,
          patientId: complaintReviews.patientId,
          openedBy: complaintReviews.openedBy,
          openedAt: complaintReviews.openedAt,
          expiresAt: complaintReviews.expiresAt,
          endedAt: complaintReviews.endedAt,
        })
        .from(complaintReviews)
        .where(
          and(
            inArray(complaintReviews.patientId, patientIds),
            gte(complaintReviews.openedAt, cutoff),
          ),
        )
      const reviewed =
        recent.length === 0
          ? []
          : await tx
              .select({
                reviewId: complaintReviewNoticeReviews.complaintReviewId,
              })
              .from(complaintReviewNoticeReviews)
              .where(
                and(
                  eq(
                    complaintReviewNoticeReviews.practitionerId,
                    currentUser.id,
                  ),
                  inArray(
                    complaintReviewNoticeReviews.complaintReviewId,
                    recent.map((review) => review.id),
                  ),
                ),
              )
      return { mine, recent, reviewed }
    })

    const myStart = new Map(
      read.mine.map((row) => [row.patientId, row.startedAt]),
    )
    const reviewedIds = new Set(read.reviewed.map((row) => row.reviewId))
    const notices = read.recent.filter(
      (review) =>
        !reviewedIds.has(review.id) &&
        isComplaintReviewNoticeFor(
          review,
          currentUser.id,
          myStart.get(review.patientId),
          cutoff,
        ),
    )
    if (notices.length === 0) return []

    // Names and photos AFTER the access decision, on the service's own
    // connection — the admin's user row may be one a practitioner's row
    // security doesn't show (the join notices' reasoning).
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
            notices.flatMap((review) => [review.patientId, review.openedBy]),
          ),
        ]),
      )
    const byId = new Map(people.map((person) => [person.id, person]))

    const alerts: ComplaintReviewAlert[] = []
    for (const review of notices) {
      const patient = byId.get(review.patientId)!
      const admin = byId.get(review.openedBy)!
      alerts.push({
        kind: 'complaint_review',
        patient: {
          id: patient.id,
          firstName: patient.firstName,
          lastName: patient.lastName,
          avatarUrl: await this.storageService.getPresignedUrlOrNull(
            patient.avatarPath,
            AVATAR_URL_EXPIRY_SECONDS,
          ),
        },
        review: {
          id: review.id,
          openedBy: {
            id: admin.id,
            firstName: admin.firstName,
            lastName: admin.lastName,
          },
          openedAt: review.openedAt,
          expiresAt: review.expiresAt,
          endedAt: review.endedAt,
        },
      })
    }
    return alerts.sort(
      (a, b) =>
        b.review.openedAt.getTime() - a.review.openedAt.getTime() ||
        b.review.id - a.review.id,
    )
  }

  // --- POST /alerts/complaint-reviews/:reviewId/review ---

  // "Mark as reviewed": takes the notice off THIS practitioner's list.
  // Idempotent (ON CONFLICT DO NOTHING; the second press answers the first
  // review). 404 for a review I can't see (row security shows only my
  // patients' reviews — one answer, so an outsider learns nothing); 409 for
  // one of my patient's that isn't a notice for me.
  async review(
    reviewId: number,
    currentUser: CurrentUser,
  ): Promise<{ reviewedAt: Date }> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [review] = await tx
        .select({
          id: complaintReviews.id,
          patientId: complaintReviews.patientId,
          openedBy: complaintReviews.openedBy,
          openedAt: complaintReviews.openedAt,
        })
        .from(complaintReviews)
        .where(eq(complaintReviews.id, reviewId))
      // Row security already hides other patients' reviews; the care-team
      // check is the TypeScript layer of the same rule (both layers, as for
      // every clinical route). So a mutant removing it survives — the other
      // layer still answers 404 (mutation-checked, 2026-10-28): equivalent
      // BY DESIGN, like the join review's (alerts.service.ts).
      if (
        !review ||
        !(await this.careTeamService.isOnCareTeam(
          currentUser.id,
          review.patientId,
        ))
      ) {
        throw new NotFoundException(`Complaint review ${reviewId} not found`)
      }
      const [mine] = await tx
        .select({ startedAt: careTeamMembers.startedAt })
        .from(careTeamMembers)
        .where(
          and(
            eq(careTeamMembers.practitionerId, currentUser.id),
            eq(careTeamMembers.patientId, review.patientId),
            currentLink(),
          ),
        )
      // The list's rule, so a review always covers a notice the list showed.
      if (
        !isComplaintReviewNoticeFor(
          review,
          currentUser.id,
          mine?.startedAt,
          joinNoticeCutoff(new Date()),
        )
      ) {
        throw new ConflictException(NOT_A_REVIEW_NOTICE_MESSAGE)
      }
      const [created] = await tx
        .insert(complaintReviewNoticeReviews)
        .values({
          complaintReviewId: review.id,
          practitionerId: currentUser.id,
        })
        .onConflictDoNothing({
          target: [
            complaintReviewNoticeReviews.complaintReviewId,
            complaintReviewNoticeReviews.practitionerId,
          ],
        })
        .returning({
          id: complaintReviewNoticeReviews.id,
          reviewedAt: complaintReviewNoticeReviews.reviewedAt,
        })
      if (!created) {
        const [existing] = await tx
          .select({ reviewedAt: complaintReviewNoticeReviews.reviewedAt })
          .from(complaintReviewNoticeReviews)
          .where(
            and(
              eq(complaintReviewNoticeReviews.complaintReviewId, review.id),
              eq(complaintReviewNoticeReviews.practitionerId, currentUser.id),
            ),
          )
        return existing
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'COMPLAINT_REVIEW_NOTICE_REVIEWED',
        targetUserId: review.patientId,
        entityType: 'complaint_review_notice_reviews',
        entityId: created.id,
        details: { complaintReviewId: review.id, openedBy: review.openedBy },
      })
      return { reviewedAt: created.reviewedAt }
    })
  }
}
