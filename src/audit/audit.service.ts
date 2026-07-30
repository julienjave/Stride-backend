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


// --- SERVICE -----------------------------------------------------------------------------------------------

// --- INTERFACES ---

interface AuditEntry {
  performedBy: number
  action: string
  targetUserId?: number
  entityType: string
  entityId?: number
  details?: Record<string, unknown>
}

interface AuditFilters {
  action?: string
  entityType?: string
  performedBy?: number
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

  async log(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values(entry)
  }


  // --- GET ROUTES ---

  async findAll(query: FindAuditLogsQueryDto) {
    const page = query.page ?? 1
    const limit = query.limit ?? 20
    const offset = (page - 1) * limit
 
    const conditions = [
      query.action ? eq(auditLogs.action, query.action) : undefined,
      query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
      query.performedBy ? eq(auditLogs.performedBy, query.performedBy) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined)
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined
 
    const [rows, [{ total }]] = await Promise.all([
      this.db.query.auditLogs.findMany({
        where: whereClause,
        orderBy: (log, { desc: descend }) => [descend(log.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(auditLogs).where(whereClause),
    ])
 
    return {
      data: rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }
}