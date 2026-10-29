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
  patientMergeNoticeReviews,
  patientMerges,
  users,
} from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { CareTeamService } from '../care-team/care-team.service'
import { StorageService } from '../storage/storage.service'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import { isPatientMergeNoticeFor, joinNoticeCutoff } from './alert-rules'
import type { AlertPatient, PersonName } from './alerts.service'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// An admin merged a second account of my patient into this one (decisions
// §27, pass 4): who, when. The patient is the SURVIVOR — the account the
// care team goes on treating. Nothing about what moved: the practitioner
// sees that in the record itself.
export interface PatientMergeAlert {
  kind: 'patient_merge'
  patient: AlertPatient
  merge: {
    id: number
    mergedBy: PersonName
    mergedAt: Date
  }
}

// POST /alerts/patient-merges/:mergeId/review for a merge of my patient that
// isn't a notice for me (I joined after it, I merged it, it's past the 14
// days) — 409, as for the other notices.
export const NOT_A_MERGE_NOTICE_MESSAGE =
  'This merge is not in your For review list'

// My CURRENT link to a patient — the condition rls_care_team_member()
// writes (0019), on the database's clock.
function currentLink() {
  return and(
    lte(careTeamMembers.startedAt, sql`now()`),
    or(isNull(careTeamMembers.endsAt), gt(careTeamMembers.endsAt, sql`now()`)),
  )
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// The care team's side of a patient merge: the notices in "For review" (GET
// /alerts includes them — AlertsService.list) and "Mark as reviewed".
// LegalDisclosureNoticesService's shape exactly, on patient_merges: computed
// on every request, only the act of looking stored. The rule is
// isPatientMergeNoticeFor (pure, alert-rules.ts).
@Injectable()
export class PatientMergeNoticesService {
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
  ): Promise<PatientMergeAlert[]> {
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
      // The window only spares reading every merge ever — the RULE decides.
      const recent = await tx
        .select({
          id: patientMerges.id,
          survivorId: patientMerges.survivorId,
          mergedBy: patientMerges.mergedBy,
          mergedAt: patientMerges.mergedAt,
        })
        .from(patientMerges)
        .where(
          and(
            inArray(patientMerges.survivorId, patientIds),
            gte(patientMerges.mergedAt, cutoff),
          ),
        )
      const reviewed =
        recent.length === 0
          ? []
          : await tx
              .select({ mergeId: patientMergeNoticeReviews.mergeId })
              .from(patientMergeNoticeReviews)
              .where(
                and(
                  eq(patientMergeNoticeReviews.practitionerId, currentUser.id),
                  inArray(
                    patientMergeNoticeReviews.mergeId,
                    recent.map((merge) => merge.id),
                  ),
                ),
              )
      return { mine, recent, reviewed }
    })

    const myStart = new Map(
      read.mine.map((row) => [row.patientId, row.startedAt]),
    )
    const reviewedIds = new Set(read.reviewed.map((row) => row.mergeId))
    const notices = read.recent.filter(
      (merge) =>
        !reviewedIds.has(merge.id) &&
        isPatientMergeNoticeFor(
          merge,
          currentUser.id,
          myStart.get(merge.survivorId),
          cutoff,
        ),
    )
    if (notices.length === 0) return []

    // Names and photos AFTER the access decision, on the service's own
    // connection (the other notices' reasoning).
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
            notices.flatMap((merge) => [merge.survivorId, merge.mergedBy]),
          ),
        ]),
      )
    const byId = new Map(people.map((person) => [person.id, person]))

    const alerts: PatientMergeAlert[] = []
    for (const merge of notices) {
      const patient = byId.get(merge.survivorId)!
      const admin = byId.get(merge.mergedBy)!
      alerts.push({
        kind: 'patient_merge',
        patient: {
          id: patient.id,
          firstName: patient.firstName,
          lastName: patient.lastName,
          avatarUrl: await this.storageService.getPresignedUrlOrNull(
            patient.avatarPath,
            AVATAR_URL_EXPIRY_SECONDS,
          ),
        },
        merge: {
          id: merge.id,
          mergedBy: {
            id: admin.id,
            firstName: admin.firstName,
            lastName: admin.lastName,
          },
          mergedAt: merge.mergedAt,
        },
      })
    }
    return alerts.sort(
      (a, b) =>
        b.merge.mergedAt.getTime() - a.merge.mergedAt.getTime() ||
        b.merge.id - a.merge.id,
    )
  }

  // --- POST /alerts/patient-merges/:mergeId/review ---

  // "Mark as reviewed": takes the notice off THIS practitioner's list.
  // Idempotent (ON CONFLICT DO NOTHING; a second press answers the first
  // review). 404 for a merge of someone who isn't my patient (one answer,
  // so an outsider learns nothing); 409 for one of my patient's that isn't a
  // notice for me.
  async review(
    mergeId: number,
    currentUser: CurrentUser,
  ): Promise<{ reviewedAt: Date }> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [merge] = await tx
        .select({
          id: patientMerges.id,
          survivorId: patientMerges.survivorId,
          mergedBy: patientMerges.mergedBy,
          mergedAt: patientMerges.mergedAt,
        })
        .from(patientMerges)
        .where(eq(patientMerges.id, mergeId))
      // Practitioners may READ every merge row (0072 — the duplicate check
      // needs them), so here, unlike the disclosures, the care-team check is
      // the ONLY thing standing between a stranger and "their" merge.
      if (
        !merge ||
        !(await this.careTeamService.isOnCareTeam(
          currentUser.id,
          merge.survivorId,
        ))
      ) {
        throw new NotFoundException(`Merge ${mergeId} not found`)
      }
      const [mine] = await tx
        .select({ startedAt: careTeamMembers.startedAt })
        .from(careTeamMembers)
        .where(
          and(
            eq(careTeamMembers.practitionerId, currentUser.id),
            eq(careTeamMembers.patientId, merge.survivorId),
            currentLink(),
          ),
        )
      // The list's rule, so a review always covers a notice the list showed.
      if (
        !isPatientMergeNoticeFor(
          merge,
          currentUser.id,
          mine?.startedAt,
          joinNoticeCutoff(new Date()),
        )
      ) {
        throw new ConflictException(NOT_A_MERGE_NOTICE_MESSAGE)
      }
      const [created] = await tx
        .insert(patientMergeNoticeReviews)
        .values({ mergeId: merge.id, practitionerId: currentUser.id })
        .onConflictDoNothing({
          target: [
            patientMergeNoticeReviews.mergeId,
            patientMergeNoticeReviews.practitionerId,
          ],
        })
        .returning({
          id: patientMergeNoticeReviews.id,
          reviewedAt: patientMergeNoticeReviews.reviewedAt,
        })
      if (!created) {
        const [existing] = await tx
          .select({ reviewedAt: patientMergeNoticeReviews.reviewedAt })
          .from(patientMergeNoticeReviews)
          .where(
            and(
              eq(patientMergeNoticeReviews.mergeId, merge.id),
              eq(patientMergeNoticeReviews.practitionerId, currentUser.id),
            ),
          )
        return existing
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'PATIENT_MERGE_NOTICE_REVIEWED',
        targetUserId: merge.survivorId,
        entityType: 'patient_merge_notice_reviews',
        entityId: created.id,
        details: { mergeId: merge.id, mergedBy: merge.mergedBy },
      })
      return { reviewedAt: created.reviewedAt }
    })
  }
}
