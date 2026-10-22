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

import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notInArray,
  type SQL,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { auditLogs, users } from '../database/schema'
import { FindAuditLogsQueryDto } from './dto/find-audit-logs-query.dto'
import { withRlsContext } from '../database/rls-context'
import type { CurrentUser } from '../common/decorators/current-user.decorator'
import {
  AUDIT_ACTIONS,
  actionsOfKind,
  areaOf,
  kindOf,
  type AuditAction,
  type AuditEntityType,
  type AuditKind,
} from './audit-vocabulary'

// --- SERVICE -----------------------------------------------------------------------------------------------

// --- INTERFACES ---

// `action` and `entityType` are the VOCABULARY's names
// (audit-vocabulary.ts), not any string: an action the vocabulary doesn't
// list fails to compile, so the viewer can never meet one it can't label.
export interface AuditEntry {
  performedBy: number
  action: AuditAction
  targetUserId?: number
  entityType: AuditEntityType
  entityId?: number
  details?: Record<string, unknown>
}

// One person, as the viewer names them.
export interface AuditPerson {
  id: number
  firstName: string
  lastName: string
}

// One entry as GET /audit-logs answers it: the stored row, plus what the
// viewer needs to read it without more requests — the names of who acted
// and of whom it is about, the entry's KIND and its AREA (both from
// audit-vocabulary.ts, computed, never stored).
export interface AuditLogView {
  id: number
  action: string
  kind: AuditKind
  entityType: string
  area: string
  entityId: number | null
  details: unknown
  createdAt: Date
  performer: AuditPerson
  target: AuditPerson | null
}

export const RANGE_ORDER_MESSAGE = '`from` must be earlier than `before`'

// The SQL for one kind. `view` and `sign_in` are closed lists; `change` is
// "everything else" — NOT IN both lists — so a stored action the
// vocabulary doesn't know (written before it existed) is a change here AND
// in kindOf(): the label on a row and the filter that finds it agree.
function kindCondition(kind: AuditKind): SQL {
  if (kind === 'change') {
    return notInArray(auditLogs.action, [
      ...actionsOfKind('view'),
      ...actionsOfKind('sign_in'),
    ])
  }
  return inArray(auditLogs.action, actionsOfKind(kind))
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

  // READS of someone else's clinical data (the audit review's step 2,
  // decided with the person 2026-10-21): programs, sessions and pain alerts
  // seen by a practitioner or an admin — ONE entry per patient whose data
  // the answer shows, all written by ONE insert (a single statement: all of
  // them or none), AWAITED by the caller before it answers. A failed insert
  // fails the request: the data is never served without its trace.
  //
  // Why not in the read's transaction, like the medical files' reads? Those
  // run in one transaction; these span several (a program list reads its
  // rows, then its schedules, then its workouts), and the alerts are
  // computed in memory AFTER theirs. A read has nothing to roll back, so
  // what matters is "no answer without the entry" — which awaiting it gives.
  //
  // The patient reading their OWN data is not recorded (the person's
  // choice: "others' reads only") — decided HERE, once, rather than in
  // every caller: an entry whose target is its author is dropped.
  async logReads(entries: AuditEntry[]): Promise<void> {
    const othersReads = entries.filter(
      (entry) => entry.targetUserId !== entry.performedBy,
    )
    if (othersReads.length === 0) return
    await this.db.insert(auditLogs).values(othersReads)
  }

  // --- GET ROUTES ---

  // The audit log, newest first, filtered and paginated (admins only: the
  // controller's @Roles and the audit_logs SELECT policy).
  async findAll(currentUser: CurrentUser, query: FindAuditLogsQueryDto) {
    const page = query.page ?? 1
    const limit = query.limit ?? 20
    const offset = (page - 1) * limit

    // Compared as moments by JavaScript, exactly as Postgres will compare
    // them: both are validated instants with their offsets.
    if (
      query.from !== undefined &&
      query.before !== undefined &&
      Date.parse(query.from) >= Date.parse(query.before)
    ) {
      throw new BadRequestException(RANGE_ORDER_MESSAGE)
    }

    const conditions = [
      query.action ? eq(auditLogs.action, query.action) : undefined,
      query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
      query.performedBy
        ? eq(auditLogs.performedBy, query.performedBy)
        : undefined,
      query.targetUserId
        ? eq(auditLogs.targetUserId, query.targetUserId)
        : undefined,
      query.kind ? kindCondition(query.kind) : undefined,
      // new Date(…): Drizzle sends a timestamptz parameter as a Date.
      query.from ? gte(auditLogs.createdAt, new Date(query.from)) : undefined,
      query.before
        ? lt(auditLogs.createdAt, new Date(query.before))
        : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined)
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    // users joined TWICE — once for who acted, once for whom it's about.
    // alias() gives the second copy its own name, so the two can be told
    // apart in one query (the medical files' amendment join does the same).
    // INNER for the performer (performed_by is NOT NULL), LEFT for the
    // target (many entries are about no one: a library change, a sign-in).
    const targetUser = alias(users, 'target')

    const [rows, [{ total }]] = await withRlsContext(
      this.db,
      currentUser,
      (tx) =>
        Promise.all([
          tx
            .select({
              entry: auditLogs,
              performer: {
                id: users.id,
                firstName: users.firstName,
                lastName: users.lastName,
              },
              target: {
                id: targetUser.id,
                firstName: targetUser.firstName,
                lastName: targetUser.lastName,
              },
            })
            .from(auditLogs)
            .innerJoin(users, eq(users.id, auditLogs.performedBy))
            .leftJoin(targetUser, eq(targetUser.id, auditLogs.targetUserId))
            .where(whereClause)
            // The id breaks ties: one request can write several entries
            // at the same instant (logReads: one per patient, one INSERT,
            // one now()). Without it, rows of equal time could come back
            // in a different order on the next page's query — one entry
            // shown twice, another never.
            .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
            .limit(limit)
            .offset(offset),
          tx.select({ total: count() }).from(auditLogs).where(whereClause),
        ]),
    )

    const data: AuditLogView[] = rows.map(({ entry, performer, target }) => ({
      id: entry.id,
      action: entry.action,
      kind: kindOf(entry.action),
      entityType: entry.entityType,
      area: areaOf(entry.entityType),
      entityId: entry.entityId,
      details: entry.details,
      createdAt: entry.createdAt,
      performer,
      // A LEFT JOIN that found nothing gives null in every column; Drizzle
      // returns the nested object as null itself.
      target,
    }))

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }

  // Every action the app can write, with its kind, by name — the screen's
  // action filter. From the vocabulary: no database, nothing to hide.
  actions(): { action: AuditAction; kind: AuditKind }[] {
    return (Object.keys(AUDIT_ACTIONS) as AuditAction[])
      .sort()
      .map((action) => ({ action, kind: AUDIT_ACTIONS[action] }))
  }
}
