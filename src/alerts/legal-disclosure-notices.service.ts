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
  legalDisclosureNoticeReviews,
  legalDisclosures,
  users,
} from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { CareTeamService } from '../care-team/care-team.service'
import { StorageService } from '../storage/storage.service'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import { isLegalDisclosureNoticeFor, joinNoticeCutoff } from './alert-rules'
import type { AlertPatient, PersonName } from './alerts.service'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// An admin disclosed my patient's record outside the clinic (decisions §25,
// pass 3). Who made it, when, to whom — and when the patient will see it, if
// an agency asked the clinic to hold it back (so nobody on the team mentions
// it earlier). NEVER the legal basis, the parts, the order's reference: the
// care team reads legal_disclosures only (0069) — the database keeps the
// rest from them.
export interface LegalDisclosureAlert {
  kind: 'legal_disclosure'
  patient: AlertPatient
  disclosure: {
    id: number
    madeBy: PersonName
    madeAt: Date
    recipientName: string
    recipientOrganisation: string | null
    // The moment the patient may see it (null: no hold).
    withheldUntil: Date | null
  }
}

// POST /alerts/legal-disclosures/:disclosureId/review for a disclosure of my
// patient that isn't a notice for me (I joined after it, I made it, or it's
// past the 14 days) — 409, as for a complaint review.
export const NOT_A_DISCLOSURE_NOTICE_MESSAGE =
  'This disclosure is not in your For review list'

// My CURRENT link to a patient — the condition rls_care_team_member()
// writes (0019), on the database's clock (alerts.service.ts's currentLink).
function currentLink() {
  return and(
    lte(careTeamMembers.startedAt, sql`now()`),
    or(isNull(careTeamMembers.endsAt), gt(careTeamMembers.endsAt, sql`now()`)),
  )
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// The care team's side of a legal disclosure: the notices in "For review"
// (GET /alerts includes them — AlertsService.list), and "Mark as reviewed".
// ComplaintReviewNoticesService's shape exactly, on legal_disclosures: computed
// on every request, only the act of looking stored. The rule is
// isLegalDisclosureNoticeFor (pure, alert-rules.ts); the queries run under
// the practitioner's own row security — which shows a practitioner their
// patients' disclosures (legal_disclosures_select, 0069) and nothing of the
// order.
@Injectable()
export class LegalDisclosureNoticesService {
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
  ): Promise<LegalDisclosureAlert[]> {
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
      // The window here only spares reading every disclosure ever — the
      // RULE decides (it checks the window too).
      const recent = await tx
        .select({
          id: legalDisclosures.id,
          patientId: legalDisclosures.patientId,
          madeBy: legalDisclosures.madeBy,
          madeAt: legalDisclosures.madeAt,
          recipientName: legalDisclosures.recipientName,
          recipientOrganisation: legalDisclosures.recipientOrganisation,
          withheldUntil: legalDisclosures.withheldUntil,
        })
        .from(legalDisclosures)
        .where(
          and(
            inArray(legalDisclosures.patientId, patientIds),
            gte(legalDisclosures.madeAt, cutoff),
          ),
        )
      const reviewed =
        recent.length === 0
          ? []
          : await tx
              .select({
                disclosureId: legalDisclosureNoticeReviews.disclosureId,
              })
              .from(legalDisclosureNoticeReviews)
              .where(
                and(
                  eq(
                    legalDisclosureNoticeReviews.practitionerId,
                    currentUser.id,
                  ),
                  inArray(
                    legalDisclosureNoticeReviews.disclosureId,
                    recent.map((disclosure) => disclosure.id),
                  ),
                ),
              )
      return { mine, recent, reviewed }
    })

    const myStart = new Map(
      read.mine.map((row) => [row.patientId, row.startedAt]),
    )
    const reviewedIds = new Set(read.reviewed.map((row) => row.disclosureId))
    const notices = read.recent.filter(
      (disclosure) =>
        !reviewedIds.has(disclosure.id) &&
        isLegalDisclosureNoticeFor(
          disclosure,
          currentUser.id,
          myStart.get(disclosure.patientId),
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
            notices.flatMap((disclosure) => [
              disclosure.patientId,
              disclosure.madeBy,
            ]),
          ),
        ]),
      )
    const byId = new Map(people.map((person) => [person.id, person]))

    const alerts: LegalDisclosureAlert[] = []
    for (const disclosure of notices) {
      const patient = byId.get(disclosure.patientId)!
      const admin = byId.get(disclosure.madeBy)!
      alerts.push({
        kind: 'legal_disclosure',
        patient: {
          id: patient.id,
          firstName: patient.firstName,
          lastName: patient.lastName,
          avatarUrl: await this.storageService.getPresignedUrlOrNull(
            patient.avatarPath,
            AVATAR_URL_EXPIRY_SECONDS,
          ),
        },
        disclosure: {
          id: disclosure.id,
          madeBy: {
            id: admin.id,
            firstName: admin.firstName,
            lastName: admin.lastName,
          },
          madeAt: disclosure.madeAt,
          recipientName: disclosure.recipientName,
          recipientOrganisation: disclosure.recipientOrganisation,
          withheldUntil: disclosure.withheldUntil,
        },
      })
    }
    return alerts.sort(
      (a, b) =>
        b.disclosure.madeAt.getTime() - a.disclosure.madeAt.getTime() ||
        b.disclosure.id - a.disclosure.id,
    )
  }

  // --- POST /alerts/legal-disclosures/:disclosureId/review ---

  // "Mark as reviewed": takes the notice off THIS practitioner's list.
  // Idempotent (ON CONFLICT DO NOTHING; the second press answers the first
  // review). 404 for a disclosure I can't see (row security shows only my
  // patients' — one answer, so an outsider learns nothing); 409 for one of
  // my patient's that isn't a notice for me.
  async review(
    disclosureId: number,
    currentUser: CurrentUser,
  ): Promise<{ reviewedAt: Date }> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [disclosure] = await tx
        .select({
          id: legalDisclosures.id,
          patientId: legalDisclosures.patientId,
          madeBy: legalDisclosures.madeBy,
          madeAt: legalDisclosures.madeAt,
        })
        .from(legalDisclosures)
        .where(eq(legalDisclosures.id, disclosureId))
      // Row security already hides other patients' disclosures; the
      // care-team check is the TypeScript layer of the same rule (both
      // layers, as for every clinical route) — equivalent BY DESIGN under a
      // mutation, like the complaint review notice's.
      if (
        !disclosure ||
        !(await this.careTeamService.isOnCareTeam(
          currentUser.id,
          disclosure.patientId,
        ))
      ) {
        throw new NotFoundException(`Disclosure ${disclosureId} not found`)
      }
      const [mine] = await tx
        .select({ startedAt: careTeamMembers.startedAt })
        .from(careTeamMembers)
        .where(
          and(
            eq(careTeamMembers.practitionerId, currentUser.id),
            eq(careTeamMembers.patientId, disclosure.patientId),
            currentLink(),
          ),
        )
      // The list's rule, so a review always covers a notice the list showed.
      if (
        !isLegalDisclosureNoticeFor(
          disclosure,
          currentUser.id,
          mine?.startedAt,
          joinNoticeCutoff(new Date()),
        )
      ) {
        throw new ConflictException(NOT_A_DISCLOSURE_NOTICE_MESSAGE)
      }
      const [created] = await tx
        .insert(legalDisclosureNoticeReviews)
        .values({
          disclosureId: disclosure.id,
          practitionerId: currentUser.id,
        })
        .onConflictDoNothing({
          target: [
            legalDisclosureNoticeReviews.disclosureId,
            legalDisclosureNoticeReviews.practitionerId,
          ],
        })
        .returning({
          id: legalDisclosureNoticeReviews.id,
          reviewedAt: legalDisclosureNoticeReviews.reviewedAt,
        })
      if (!created) {
        const [existing] = await tx
          .select({ reviewedAt: legalDisclosureNoticeReviews.reviewedAt })
          .from(legalDisclosureNoticeReviews)
          .where(
            and(
              eq(legalDisclosureNoticeReviews.disclosureId, disclosure.id),
              eq(legalDisclosureNoticeReviews.practitionerId, currentUser.id),
            ),
          )
        return existing
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'LEGAL_DISCLOSURE_NOTICE_REVIEWED',
        targetUserId: disclosure.patientId,
        entityType: 'legal_disclosure_notice_reviews',
        entityId: created.id,
        details: { disclosureId: disclosure.id, madeBy: disclosure.madeBy },
      })
      return { reviewedAt: created.reviewedAt }
    })
  }
}
