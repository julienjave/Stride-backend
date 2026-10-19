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

import { ConflictException, Inject, Injectable } from '@nestjs/common'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { sessionReviews } from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import { SessionsService } from './sessions.service'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// The message for a session still open — the service's half of the rule
// (migration 0044's trigger is the database's).
export const REVIEW_IN_PROGRESS_MESSAGE =
  "This session is still in progress, so it can't be reviewed yet"

// --- SERVICE -----------------------------------------------------------------------------------------------

// "Mark as reviewed" — the practitioner home's To-do (decided 2026-10-19).
// Its own service, beside SessionsService rather than inside it: the
// sessions service is the PATIENT's state machine (start, tick, finish), and
// a review never changes the session — it is a separate record ABOUT it.
@Injectable()
export class SessionReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly sessionsService: SessionsService,
    private readonly auditService: AuditService,
  ) {}

  // --- POST /sessions/:id/review ---

  // Records that THIS practitioner has looked at the session, and answers
  // the session as GET /sessions/:id does (its reviews included) — so the
  // page shows "Reviewed by you" without a second request.
  //
  // IDEMPOTENT: marking a session you already reviewed changes nothing —
  // the same answer, no second row, no second audit entry (the convention:
  // a request that changes nothing writes nothing). A double tap, or two
  // tabs, can't record two reviews: the unique index
  // session_reviews_one_per_practitioner decides, and ON CONFLICT DO NOTHING
  // turns its refusal into "nothing inserted" — atomically, where a "read,
  // then insert if absent" would leave a window for two inserts.
  async review(id: number, currentUser: CurrentUser) {
    // Exists, and the caller may see it: 404 when row security hides it (a
    // practitioner off the care team), 403 when they see it but may not
    // (findOne's assertCanView) — the same answers as reading it.
    const session = await this.sessionsService.findOne(id, currentUser)
    if (session.status === 'in_progress') {
      throw new ConflictException(REVIEW_IN_PROGRESS_MESSAGE)
    }

    await withRlsContext(this.db, currentUser, async (tx) => {
      // reviewed_at isn't sent: the trigger writes the database's now().
      const [created] = await tx
        .insert(sessionReviews)
        .values({ sessionId: id, practitionerId: currentUser.id })
        .onConflictDoNothing({
          target: [sessionReviews.sessionId, sessionReviews.practitionerId],
        })
        .returning({
          id: sessionReviews.id,
          reviewedAt: sessionReviews.reviewedAt,
        })
      if (!created) return
      // ONE complete entry in the same transaction (the audit convention):
      // who reviewed which session of which patient, and when.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'SESSION_REVIEWED',
        targetUserId: session.patientId,
        entityType: 'session_reviews',
        entityId: created.id,
        details: { sessionId: id, reviewedAt: created.reviewedAt },
      })
    })
    return this.sessionsService.findOne(id, currentUser)
  }
}
