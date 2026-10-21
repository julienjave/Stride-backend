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

import { Inject, Injectable } from '@nestjs/common'
import { and, eq, count } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { auditLogs } from '../database/schema'
import { FindAuditLogsQueryDto } from './dto/find-audit-logs-query.dto'
import { withRlsContext } from '../database/rls-context'
import type { CurrentUser } from '../common/decorators/current-user.decorator'

// --- SERVICE -----------------------------------------------------------------------------------------------

// --- INTERFACES ---

export interface AuditEntry {
  performedBy: number
  action: string
  targetUserId?: number
  entityType: string
  entityId?: number
  details?: Record<string, unknown>
}

// ------

@Injectable()
export class AuditService {
  // The ONLY place that ever inserts into audit_logs, across the whole app —
  // enforced by convention here, and backed at the database level by the
  // table's insert-only application permissions (no UPDATE/DELETE issued
  // against it anywhere), matching the schema's original design intent.
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Deliberately NOT run through withRlsContext() — audit_logs' INSERT policy
  // is WITH CHECK (true) (see the "Row-Level Security" writeup), so it needs no
  // session context to succeed, unlike medical_files' write-side policy. Since
  // the audit review (Phase 6) it writes only the sign-in events, which
  // change no data and so have no transaction to join — including calls made
  // before authentication succeeds (e.g. LOGIN_FAILURE, logged against the
  // account the attempt named,
  // by a caller who is specifically NOT authenticated as that account) — a
  // write-side policy modeled on medical_files' (checking the writer's own
  // session against performedBy) would incorrectly reject exactly those calls.
  // Wrapping this in a transaction for RLS context would add overhead for
  // zero security benefit. Leave it a plain insert, AWAITED by its callers:
  // a sign-in is not answered without its entry.
  async log(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values(entry)
  }

  // The same insert, through the CALLER's transaction — for an entry that
  // must commit or roll back with the change it describes (used by routes
  // tagged @AuditedByService()).
  //
  // Why it matters: log() writes on its own connection. Called inside a
  // transaction, it would record a change that a later failure then rolls
  // back; called after the commit (what users.service.ts does today), the
  // change can succeed while its entry fails and is lost. Through `tx`,
  // neither can happen: no change without its entry, no entry without its
  // change. The cost: a failed audit insert now fails the request — which
  // is the point for clinical data (better refused than unrecorded).
  //
  // audit_logs' INSERT policy is WITH CHECK (true), so this works inside any
  // RLS context the caller has set.
  async logInTransaction(tx: DrizzleDb, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLogs).values(entry)
  }

  // --- GET ROUTES ---

  async findAll(currentUser: CurrentUser, query: FindAuditLogsQueryDto) {
    const page = query.page ?? 1
    const limit = query.limit ?? 20
    const offset = (page - 1) * limit

    const conditions = [
      query.action ? eq(auditLogs.action, query.action) : undefined,
      query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
      query.performedBy
        ? eq(auditLogs.performedBy, query.performedBy)
        : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined)
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [rows, [{ total }]] = await withRlsContext(
      this.db,
      currentUser,
      (tx) =>
        Promise.all([
          tx.query.auditLogs.findMany({
            where: whereClause,
            orderBy: (log, { desc: descend }) => [descend(log.createdAt)],
            limit,
            offset,
          }),
          tx.select({ total: count() }).from(auditLogs).where(whereClause),
        ]),
    )

    return {
      data: rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }
}
