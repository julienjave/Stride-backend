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
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  complaintReviewReasons,
  complaintReviews,
  userRoles,
  users,
} from '../database/schema'
import { applyUserContext, withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import {
  RecordsExportService,
  type RecordExport,
} from '../records-export/records-export.service'
import type { OpenComplaintReviewDto } from './dto/open-complaint-review.dto'

// --- TYPES -------------------------------------------------------------------------------------------------

// Derived from the row and the database's clock, never stored (as a link's
// status is — records-export-link-status.ts):
//   ended   — an admin closed it before its time;
//   expired — its 7 days are over;
//   open    — copies can be made with it.
export type ComplaintReviewStatus = 'open' | 'ended' | 'expired'

export interface PersonRef {
  id: number
  firstName: string
  lastName: string
}

// One review as the API returns it — to an admin, reason included.
export interface ComplaintReviewSummary {
  id: number
  status: ComplaintReviewStatus
  reason: string
  caseReference: string | null
  openedBy: PersonRef
  openedAt: Date
  expiresAt: Date
  endedAt: Date | null
  endedBy: PersonRef | null
}

// The signed-in admin.
interface Actor {
  id: number
  activeRole: UserRole
}

// A review as read inside a transaction, with the DATABASE's now() — the
// clock the guard trigger judges expiry by, so the service and the database
// never disagree about whether a review is still open.
interface FoundReview {
  id: number
  patientId: number
  openedBy: number
  openedAt: Date
  expiresAt: Date
  endedAt: Date | null
  endedBy: number | null
  reason: string
  caseReference: string | null
  now: Date
}

// --- MESSAGES ----------------------------------------------------------------------------------------------

export const ONLY_THE_OPENER_MESSAGE =
  'Only the admin who opened this review can make copies with it. Open a review of your own, with its reason.'

type OverStatus = Exclude<ComplaintReviewStatus, 'open'>

// A copy asked of a review that is over (410)…
const OVER_MESSAGES: Record<OverStatus, string> = {
  ended:
    'This review has ended. Open a new one, with its reason, to make another copy.',
  expired:
    'This review has expired. Open a new one, with its reason, to make another copy.',
}

// … and an ending asked of one (409).
const ALREADY_OVER_MESSAGES: Record<OverStatus, string> = {
  ended: 'This review has already ended.',
  expired: 'This review has already expired.',
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// Pure: the status at `now`. The ending wins over the expiry (a review ended
// on day 3 is "ended", even once day 7 has passed) — what happened to it,
// rather than what would have.
export function complaintReviewStatus(
  review: { endedAt: Date | null; expiresAt: Date },
  now: Date,
): ComplaintReviewStatus {
  if (review.endedAt !== null) return 'ended'
  if (review.expiresAt <= now) return 'expired'
  return 'open'
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// THE COMPLAINT REVIEW (decisions §25, pass 2 — why it exists, and why it is
// shaped this way, is in complaint-reviews.schema.ts). In short: an admin
// opens a time-boxed, reasoned access to ONE patient's record; while it is
// open, that admin downloads the records export's PDF, stamped "Review copy";
// every step leaves its audit entry; the care team is told (AlertsModule's
// ComplaintReviewNoticesService).
//
// The rule this file is careful about: an admin never gains READ ACCESS to
// clinical tables. A copy is made by switching the transaction to the
// PATIENT's own row security (applyUserContext) — the emailed link's path —
// and calling the same generator the patient's own download uses.
@Injectable()
export class ComplaintReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly recordsExportService: RecordsExportService,
    private readonly auditService: AuditService,
  ) {}

  // --- GET /users/:id/complaint-reviews ---

  // Every review of this patient's record, newest first: the open ones and
  // the history behind them, with their reasons.
  async list(
    patientId: number,
    actor: Actor,
  ): Promise<ComplaintReviewSummary[]> {
    await this.assertPatient(patientId)
    return this.findSummaries(actor, { patientId })
  }

  // --- POST /users/:id/complaint-reviews ---

  // Opens a review. ONE transaction: the review, its reason, the audit entry
  // — all or nothing (a review without its reason, or without its trace,
  // can't exist). opened_at and expires_at are NOT sent: the guard trigger
  // writes them from the database's clock (7 days, exactly).
  //
  // Several reviews of one patient may be open at once (two complaints, two
  // admins): each is its own case, with its own reason and its own copies.
  async open(
    patientId: number,
    dto: OpenComplaintReviewDto,
    actor: Actor,
  ): Promise<ComplaintReviewSummary> {
    await this.assertPatient(patientId)
    const caseReference = dto.caseReference ?? null

    const reviewId = await withRlsContext(this.db, actor, async (tx) => {
      const [review] = await tx
        .insert(complaintReviews)
        // expires_at is required by the column; the trigger overwrites it.
        // now() is sent only to satisfy NOT NULL — the value that counts is
        // the trigger's.
        .values({ patientId, openedBy: actor.id, expiresAt: sql`now()` })
        .returning({
          id: complaintReviews.id,
          expiresAt: complaintReviews.expiresAt,
        })
      await tx.insert(complaintReviewReasons).values({
        reviewId: review.id,
        reason: dto.reason,
        caseReference,
      })
      // ONE complete entry: the reason is in it — the audit log is read by
      // admins only, who see the reason on the patient's page anyway; and
      // the trail must say WHY a record was opened even if a page changes.
      await this.auditService.logInTransaction(tx, {
        performedBy: actor.id,
        action: 'COMPLAINT_REVIEW_OPENED',
        targetUserId: patientId,
        entityType: 'complaint_reviews',
        entityId: review.id,
        details: {
          reason: dto.reason,
          ...(caseReference === null ? {} : { caseReference }),
          expiresAt: review.expiresAt,
        },
      })
      return review.id
    })

    const [summary] = await this.findSummaries(actor, { reviewId })
    return summary
  }

  // --- POST /users/:id/complaint-reviews/:reviewId/end ---

  // Ends a review before its time. ANY admin may (less access is always
  // allowed — a colleague closing a review left open is a good thing); the
  // ending is signed with who did it. 409 when it is already over: the
  // request is valid, the review's state is what conflicts with it.
  async end(
    patientId: number,
    reviewId: number,
    actor: Actor,
  ): Promise<ComplaintReviewSummary> {
    await withRlsContext(this.db, actor, async (tx) => {
      const review = await this.findReview(tx, patientId, reviewId)
      const status = complaintReviewStatus(review, review.now)
      if (status !== 'open') {
        throw new ConflictException(ALREADY_OVER_MESSAGES[status])
      }
      // ended_at is the trigger's (the database's now()); ended_by is
      // checked by it against the session user.
      await tx
        .update(complaintReviews)
        .set({ endedBy: actor.id })
        .where(eq(complaintReviews.id, review.id))
      await this.auditService.logInTransaction(tx, {
        performedBy: actor.id,
        action: 'COMPLAINT_REVIEW_ENDED',
        targetUserId: patientId,
        entityType: 'complaint_reviews',
        entityId: review.id,
        details: { openedBy: review.openedBy, expiresAt: review.expiresAt },
      })
    })
    const [summary] = await this.findSummaries(actor, { reviewId })
    return summary
  }

  // --- GET /users/:id/complaint-reviews/:reviewId/copy ---

  // A review copy: the records export's PDF, stamped. ONE transaction, at
  // REPEATABLE READ (the export's "one moment" — records-export.service.ts):
  //   1. as the ADMIN: the review is read and checked — this admin's, open
  //      by the database's clock;
  //   2. then as the PATIENT (applyUserContext): the record is read through
  //      the patient's own policies, exactly as their own download reads it;
  //   3. the PDF is drawn and RECORDS_EXPORTED written (via complaint_review,
  //      performed by the admin, with the ids of what went in) — before a
  //      byte leaves. A failed drawing leaves no entry and hands out nothing.
  //
  // Any number of copies, each recorded (the person's choice): the record
  // may change during the review, and each copy's entry says what it held.
  //
  // Refusals, in this order: not this patient's review → 404; another
  // admin's → 403 (they can see it exists — the list shows it — so a 404
  // would be a lie; what they lack is the grant); over → 410 (the grant is
  // gone, as for a used emailed link).
  async copy(
    patientId: number,
    reviewId: number,
    timeZone: string,
    actor: Actor,
  ): Promise<RecordExport> {
    return withRlsContext(
      this.db,
      actor,
      async (tx) => {
        const review = await this.findReview(tx, patientId, reviewId)
        if (review.openedBy !== actor.id) {
          throw new ForbiddenException(ONLY_THE_OPENER_MESSAGE)
        }
        const status = complaintReviewStatus(review, review.now)
        if (status !== 'open') {
          throw new GoneException(OVER_MESSAGES[status])
        }
        // The admin's name for the stamp — users is readable by every
        // session (0007), so read it before the switch, as the admin.
        const [admin] = await tx
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, actor.id))

        // From here the transaction acts AS THE PATIENT: no admin branch on
        // any clinical table is used, or needed (decisions §16 holds).
        await applyUserContext(tx, {
          id: patientId,
          activeRole: UserRole.PATIENT,
        })
        return this.recordsExportService.exportInTransaction(
          tx,
          patientId,
          timeZone,
          {
            via: 'complaint_review',
            adminId: actor.id,
            stamp: {
              reviewId: review.id,
              madeBy: `${admin.firstName} ${admin.lastName}`,
              reason: review.reason,
              caseReference: review.caseReference,
              expiresAt: review.expiresAt,
            },
          },
        )
      },
      { isolationLevel: 'repeatable read' },
    )
  }

  // === PRIVATE ============================================================

  // The review `reviewId` OF THIS PATIENT, with its reason and the
  // database's now() — or 404 (another patient's review id is "not found"
  // here: the URL names the patient, and the two must agree).
  private async findReview(
    tx: DrizzleDb,
    patientId: number,
    reviewId: number,
  ): Promise<FoundReview> {
    const [review] = await tx
      .select({
        id: complaintReviews.id,
        patientId: complaintReviews.patientId,
        openedBy: complaintReviews.openedBy,
        openedAt: complaintReviews.openedAt,
        expiresAt: complaintReviews.expiresAt,
        endedAt: complaintReviews.endedAt,
        endedBy: complaintReviews.endedBy,
        reason: complaintReviewReasons.reason,
        caseReference: complaintReviewReasons.caseReference,
        // mapWith: read back through a timestamp column's conversion, so it
        // arrives as a Date like the others.
        now: sql`now()`.mapWith(complaintReviews.openedAt),
      })
      .from(complaintReviews)
      .innerJoin(
        complaintReviewReasons,
        eq(complaintReviewReasons.reviewId, complaintReviews.id),
      )
      .where(
        and(
          eq(complaintReviews.id, reviewId),
          eq(complaintReviews.patientId, patientId),
        ),
      )
    if (!review) {
      throw new NotFoundException(`Complaint review ${reviewId} not found`)
    }
    return review
  }

  // 404 when there is no such account, 400 when it isn't a patient's — the
  // emailed link's checks (users and user_roles are readable without a
  // session context: 0007, 0009).
  private async assertPatient(patientId: number): Promise<void> {
    const [account] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, patientId))
    if (!account) throw new NotFoundException(`User ${patientId} not found`)
    const [role] = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, patientId),
          eq(userRoles.role, UserRole.PATIENT),
        ),
      )
    if (!role) {
      throw new BadRequestException(
        'Only a patient has a health record to review',
      )
    }
  }

  // One patient's reviews, or one review, as the admin sees them: reason
  // included (the reasons' admin-only policy), names read in one batched
  // query.
  private async findSummaries(
    actor: Actor,
    filter: { patientId: number } | { reviewId: number },
  ): Promise<ComplaintReviewSummary[]> {
    const rows = await withRlsContext(this.db, actor, (tx) =>
      tx
        .select({
          review: complaintReviews,
          reason: complaintReviewReasons.reason,
          caseReference: complaintReviewReasons.caseReference,
          now: sql`now()`.mapWith(complaintReviews.openedAt),
        })
        .from(complaintReviews)
        .innerJoin(
          complaintReviewReasons,
          eq(complaintReviewReasons.reviewId, complaintReviews.id),
        )
        .where(
          'patientId' in filter
            ? eq(complaintReviews.patientId, filter.patientId)
            : eq(complaintReviews.id, filter.reviewId),
        )
        // Newest first. Two reviews opened in the same instant are possible
        // (two admins), so the id breaks the tie: a stable order.
        .orderBy(desc(complaintReviews.openedAt), desc(complaintReviews.id)),
    )
    if (rows.length === 0) return []

    const ids = [
      ...new Set(
        rows.flatMap(({ review }) =>
          review.endedBy === null
            ? [review.openedBy]
            : [review.openedBy, review.endedBy],
        ),
      ),
    ]
    const people = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(inArray(users.id, ids))
    const byId = new Map(people.map((person) => [person.id, person]))

    return rows.map(({ review, reason, caseReference, now }) => ({
      id: review.id,
      status: complaintReviewStatus(review, now),
      reason,
      caseReference,
      openedBy: byId.get(review.openedBy)!,
      openedAt: review.openedAt,
      expiresAt: review.expiresAt,
      endedAt: review.endedAt,
      endedBy: review.endedBy === null ? null : byId.get(review.endedBy)!,
    }))
  }
}
