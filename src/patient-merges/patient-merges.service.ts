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

// Merging two accounts of the same patient (decisions §27, pass 3). The
// admin picks the account to keep; everything of the other moves to it, and
// the other is deactivated for good. Traceable, no "Unmerge" (the person's
// choice): two audit entries list everything that moved, and a mistaken
// merge is repaired by hand from them.
//
// The work is split by what each layer is for:
//   - this service: the step-up, the readable refusals (mergeRefusal), the
//     two audit entries, signing the merged account out, the email;
//   - merge_patients() (migration 0072): moving the rows — as the tables'
//     owner, since an admin may not read or change clinical rows — and
//     checking the same conditions again.
// All of it in ONE transaction: the step-up, the merge, the entries and the
// sign-out are committed together or not at all.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { withRlsContext } from '../database/rls-context'
import { patientMerges, userRoles, users } from '../database/schema'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { WRONG_PASSWORD_MESSAGE } from '../common/current-password'
import { endAllSessions } from '../common/other-sessions'
import { errorMessage } from '../common/error-message'
import {
  STEP_UP_COLUMNS,
  StepUpService,
  type StepUpProof,
} from '../mfa/step-up.service'
import type { UserRole } from '../users/dto/create-user.dto'
import {
  mergeAuditDetails,
  mergeRefusal,
  type MergeAccountFacts,
  type MergeRefusal,
  type MergeSummary,
} from './patient-merge-rules'

// --- TYPES -------------------------------------------------------------------------------------------------

type Admin = { id: number; activeRole: UserRole }

// One merge as GET /patient-merges lists it: which account went into which,
// when, by whom. The admin's screens join it with the users list — the
// "Merged" badge, the "Merged into …" banner.
export interface PatientMergeRecord {
  id: number
  mergedId: number
  survivorId: number
  mergedAt: Date
  mergedBy: { id: number; firstName: string; lastName: string }
}

// What the route answers: which merge, which two accounts. Nothing of what
// moved — those ids are clinical (patient_merge_records) and the admin's
// screen has no use for them.
export interface PatientMergeAnswer {
  mergeId: number
  mergedId: number
  survivorId: number
}

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

// A refusal as the exception Nest turns into its status.
function refusalException(refusal: MergeRefusal) {
  switch (refusal.status) {
    case 400:
      return new BadRequestException(refusal.message)
    case 404:
      return new NotFoundException(refusal.message)
    case 409:
      return new ConflictException(refusal.message)
  }
}

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class PatientMergesService {
  private readonly logger = new Logger(PatientMergesService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    private readonly messagingEvents: MessagingEvents,
    private readonly stepUp: StepUpService,
  ) {}

  // GET /patient-merges — every merge, newest first. Admins only (the
  // controller); read under the admin's context, which patient_merges_select
  // lets through. A clinic merges rarely: one list, no paging.
  async list(admin: Admin): Promise<PatientMergeRecord[]> {
    const rows = await withRlsContext(this.db, admin, (tx) =>
      tx
        .select({
          id: patientMerges.id,
          mergedId: patientMerges.mergedId,
          survivorId: patientMerges.survivorId,
          mergedAt: patientMerges.mergedAt,
          adminId: users.id,
          adminFirstName: users.firstName,
          adminLastName: users.lastName,
        })
        .from(patientMerges)
        .innerJoin(users, eq(users.id, patientMerges.mergedBy))
        .orderBy(desc(patientMerges.mergedAt), desc(patientMerges.id)),
    )
    return rows.map((row) => ({
      id: row.id,
      mergedId: row.mergedId,
      survivorId: row.survivorId,
      mergedAt: row.mergedAt,
      mergedBy: {
        id: row.adminId,
        firstName: row.adminFirstName,
        lastName: row.adminLastName,
      },
    }))
  }

  // POST /users/:id/merge — merges `mergedId` INTO `survivorId`.
  async merge(
    admin: Admin,
    mergedId: number,
    survivorId: number,
    proof: StepUpProof,
    sessionId: string,
  ): Promise<PatientMergeAnswer> {
    const attempt = this.stepUp.attempt(admin, sessionId, 'patient_merge')
    const outcome = await withRlsContext(this.db, admin, async (tx) => {
      // The three rows LOCKED — the admin's (their step-up may spend a code)
      // and the two accounts — in ONE statement, in id order: the MFA
      // reset's deadlock argument (mfa.service.ts), with one more row. Two
      // merges of the same pair, in either direction, queue here; the second
      // then reads the first's result ("already merged").
      const rows = await tx
        .select({ id: users.id, isActive: users.isActive, ...STEP_UP_COLUMNS })
        .from(users)
        .where(inArray(users.id, [admin.id, mergedId, survivorId]))
        .orderBy(users.id)
        .for('update')
      const own = rows.find((row) => row.id === admin.id)
      if (!own) throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
      // The step-up FIRST: an admin who can't prove who they are learns
      // nothing about the two accounts (the MFA reset's order).
      const stepUp = await attempt.confirm(tx, own, proof)

      const [roles, merges] = await Promise.all([
        tx
          .select({ userId: userRoles.userId, role: userRoles.role })
          .from(userRoles)
          .where(inArray(userRoles.userId, [mergedId, survivorId])),
        tx
          .select({ mergedId: patientMerges.mergedId })
          .from(patientMerges)
          .where(inArray(patientMerges.mergedId, [mergedId, survivorId])),
      ])
      const facts = (id: number): MergeAccountFacts | undefined => {
        const row = rows.find((candidate) => candidate.id === id)
        return (
          row && {
            roles: roles.filter((r) => r.userId === id).map((r) => r.role),
            isActive: row.isActive,
            alreadyMerged: merges.some((m) => m.mergedId === id),
          }
        )
      }
      const refusal = mergeRefusal(
        mergedId,
        survivorId,
        facts(mergedId),
        facts(survivorId),
      )
      if (refusal) throw refusalException(refusal)

      // The merge itself, as the tables' owner (migration 0072). A plain
      // function call: Drizzle has no builder for it, and `sql` sends the two
      // ids as parameters ($1, $2), never pasted into the text.
      const result = await tx.execute<{ summary: MergeSummary }>(
        sql`SELECT merge_patients(${mergedId}, ${survivorId}) AS summary`,
      )
      const summary = result.rows[0].summary

      // Signed out everywhere, in the same transaction — a deactivated
      // account keeps no session (UsersService.setActive's rule).
      const endedSessionIds = await endAllSessions(tx, mergedId)

      const details = mergeAuditDetails(summary, endedSessionIds.length)
      await this.auditService.logInTransaction(tx, {
        performedBy: admin.id,
        action: 'PATIENT_MERGED',
        targetUserId: survivorId,
        entityType: 'patient_merges',
        entityId: summary.mergeId,
        details: details.account,
      })
      await this.auditService.logInTransaction(tx, {
        performedBy: admin.id,
        action: 'PATIENT_MERGE_RECORDS_MOVED',
        targetUserId: survivorId,
        entityType: 'patient_merge_records',
        entityId: summary.mergeId,
        details: details.records,
      })

      const survivor = rows.find((row) => row.id === survivorId)!
      return {
        summary,
        endedSessionIds,
        stepUp,
        email: survivor.email,
        firstName: survivor.firstName,
      }
    }).catch(attempt.failed)

    // After the commit, never before: a socket closed for a merge that then
    // rolled back would have signed someone out for nothing.
    for (const ended of outcome.endedSessionIds) {
      this.messagingEvents.disconnectSession(ended)
    }
    outcome.stepUp.afterCommit()
    // The patient is told (the person's choice) — at the address they keep.
    // Best effort: the merge is done whatever the mail server says.
    this.emailService
      .sendPatientMergedNotice({
        to: outcome.email,
        firstName: outcome.firstName,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Failed to send the accounts-combined notice to ${outcome.email}: ${errorMessage(error)}`,
        ),
      )

    return {
      mergeId: outcome.summary.mergeId,
      mergedId: outcome.summary.mergedId,
      survivorId: outcome.summary.survivorId,
    }
  }
}
