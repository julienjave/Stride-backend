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
import { sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { withRlsContext } from '../database/rls-context'
import { users, userRoles, clinics, invitations } from '../database/schema'
import { needsAttention, type UserRow } from './attention-rules'
import { UserRole } from '../users/dto/create-user.dto'

// --- TYPES -------------------------------------------------------------------------------------------------

// Who to look at — just enough to name the account and link to its page.
export interface AccountRef {
  id: number
  firstName: string
  lastName: string
}

// A group of accounts that need an admin's attention: how many in all, and
// the first few by name (the home lists them; the total says how many more).
export interface AttentionList {
  total: number
  first: AccountRef[]
}

// The answer of GET /admin/metrics (the admin home, Phase 6 — decisions §17).
export interface AdminMetrics {
  // ACTIVE accounts holding each role. A multi-role account counts once in
  // each of its roles, so the three don't add up to a number of people.
  // Invited accounts that haven't set a password yet are active, so they're
  // counted here too (and in pendingInvitations).
  accounts: {
    admins: number
    practitioners: number
    patients: number
    // Deactivated accounts, whatever their roles — each counted once.
    deactivated: number
  }
  clinics: { active: number; deactivated: number }
  // Invitations that can still be accepted: neither accepted nor revoked,
  // not expired, for an active account — invitationStatus()'s "pending".
  pendingInvitations: number
  needsAttention: {
    // Active patients with nobody treating them: no current care-team link
    // (clinicalAccess(), the rule every clinical permission uses) to a
    // practitioner whose account is still active.
    patientsWithoutCareTeam: AttentionList
    // Active practitioners who belong to no ACTIVE clinic.
    practitionersWithoutClinic: AttentionList
    // Active accounts whose open invitation expired or whose email couldn't
    // be sent (2026-10-25, decisions §19). An unsent PENDING one is also in
    // pendingInvitations: still valid, but the person never got the link.
    invitationsToSendAgain: AttentionList
  }
}

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// How many names each "needs attention" group lists. The home page shows
// them; more than a handful would turn a summary into a second users list.
export const ATTENTION_LIST_LIMIT = 5

// --- SERVICE -----------------------------------------------------------------------------------------------

// The row the statement below returns: one column per number, the two lists
// as JSON arrays (node-postgres parses json columns into JavaScript values).
// A `type`, not an `interface`: execute<T>() requires T to fit
// Record<string, unknown>, and TypeScript only lets a type alias do that
// implicitly — an interface stays open to declaration merging (more keys
// could be added elsewhere), so it never matches an index signature.
type MetricsRow = {
  admins: number
  practitioners: number
  patients: number
  deactivated_accounts: number
  active_clinics: number
  deactivated_clinics: number
  pending_invitations: number
  patients_without_care_team_total: number
  patients_without_care_team_first: AccountRef[]
  practitioners_without_clinic_total: number
  practitioners_without_clinic_first: AccountRef[]
  invitations_to_send_again_total: number
  invitations_to_send_again_first: AccountRef[]
}

@Injectable()
export class AdminMetricsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Every number in ONE SQL statement. Not for speed (the tables are small)
  // but for CONSISTENCY: under Postgres's default isolation (READ COMMITTED)
  // each statement takes its own snapshot of the data, so six separate
  // queries could each see a different moment — an account created between
  // the "patients" count and the "needs attention" count would be in one
  // and not the other. One statement sees one moment, so the numbers on the
  // page always agree with each other.
  //
  // Run AS THE ADMIN (withRlsContext), not with the context-less pool:
  // care_team_members and invitations have FORCE ROW LEVEL SECURITY, and
  // their SELECT policies show rows to an admin (rls_is_admin()) — and to
  // nobody without a context. Without it, every patient would look like
  // they had no care team and there would be no pending invitation. It is
  // also the privacy argument: the route can only count what the admin
  // could already read, row by row, through the other admin routes. Nothing
  // here reads programs, sessions, messages or medical files (admins see
  // none of those since decisions §16) — the person chose "accounts only"
  // (2026-10-24) rather than a function that counts past row security.
  async getMetrics(currentUser: {
    id: number
    activeRole: UserRole
  }): Promise<AdminMetrics> {
    const row = await withRlsContext(this.db, currentUser, async (tx) => {
      const result = await tx.execute<MetricsRow>(metricsQuery())
      return result.rows[0]
    })

    return {
      accounts: {
        admins: row.admins,
        practitioners: row.practitioners,
        patients: row.patients,
        deactivated: row.deactivated_accounts,
      },
      clinics: {
        active: row.active_clinics,
        deactivated: row.deactivated_clinics,
      },
      pendingInvitations: row.pending_invitations,
      needsAttention: {
        patientsWithoutCareTeam: {
          total: row.patients_without_care_team_total,
          first: row.patients_without_care_team_first,
        },
        practitionersWithoutClinic: {
          total: row.practitioners_without_clinic_total,
          first: row.practitioners_without_clinic_first,
        },
        invitationsToSendAgain: {
          total: row.invitations_to_send_again_total,
          first: row.invitations_to_send_again_first,
        },
      },
    }
  }
}

// --- THE STATEMENT -----------------------------------------------------------------------------------------

// Raw SQL rather than Drizzle's builder: the statement is a set of
// independent one-row subqueries joined side by side, plus three named
// subqueries (a WITH clause) each used twice — once to count, once to list.
// That shape is the SQL itself; built from Drizzle calls it would be harder
// to read than to write. Tables are still interpolated as ${table} (so a
// renamed table is a compile error) and every value is a ${...} parameter
// ($1, $2… in the query sent), never pasted into the text.
//
// count(*) is a bigint in Postgres, which node-postgres returns as a STRING
// (a bigint can exceed JavaScript's safe integers). ::int makes each one an
// integer — far beyond any clinic's number of accounts.
//
// Exported for one e2e test: an invitation expiring at the very instant of
// the query, which only a single transaction (one now()) can build.
// The statement's users row, aliased `u`, as the attention rules want it.
const ROW_U: UserRow = { id: sql`u.id`, isActive: sql`u.is_active` }

export function metricsQuery() {
  return sql`
    WITH
      -- The three "needs attention" groups — their rules live in
      -- attention-rules.ts, shared with the users list's filter.
      patients_without_care_team AS (
        SELECT u.id, u.first_name, u.last_name
        FROM ${users} u
        WHERE ${needsAttention('patients-without-care-team', ROW_U)}
      ),
      practitioners_without_clinic AS (
        SELECT u.id, u.first_name, u.last_name
        FROM ${users} u
        WHERE ${needsAttention('practitioners-without-clinic', ROW_U)}
      ),
      invitations_to_send_again AS (
        SELECT u.id, u.first_name, u.last_name
        FROM ${users} u
        WHERE ${needsAttention('invitations-to-send-again', ROW_U)}
      )
    SELECT
      roles.admins,
      roles.practitioners,
      roles.patients,
      deactivated.deactivated_accounts,
      clinic_counts.active_clinics,
      clinic_counts.deactivated_clinics,
      pending.pending_invitations,
      (SELECT count(*)::int FROM patients_without_care_team)
        AS patients_without_care_team_total,
      ${firstByName(sql`patients_without_care_team`)}
        AS patients_without_care_team_first,
      (SELECT count(*)::int FROM practitioners_without_clinic)
        AS practitioners_without_clinic_total,
      ${firstByName(sql`practitioners_without_clinic`)}
        AS practitioners_without_clinic_first,
      (SELECT count(*)::int FROM invitations_to_send_again)
        AS invitations_to_send_again_total,
      ${firstByName(sql`invitations_to_send_again`)}
        AS invitations_to_send_again_first
    FROM
      -- FILTER: one pass over the role rows, three counts. Each aggregate
      -- only counts the rows its WHERE accepts.
      (
        SELECT
          (count(*) FILTER (WHERE r.role = ${UserRole.ADMIN}))::int AS admins,
          (count(*) FILTER (WHERE r.role = ${UserRole.PRACTITIONER}))::int AS practitioners,
          (count(*) FILTER (WHERE r.role = ${UserRole.PATIENT}))::int AS patients
        FROM ${userRoles} r
        JOIN ${users} u ON u.id = r.user_id
        WHERE u.is_active
      ) roles
      CROSS JOIN (
        SELECT count(*)::int AS deactivated_accounts
        FROM ${users}
        WHERE NOT is_active
      ) deactivated
      CROSS JOIN (
        SELECT
          (count(*) FILTER (WHERE is_active))::int AS active_clinics,
          (count(*) FILTER (WHERE NOT is_active))::int AS deactivated_clinics
        FROM ${clinics}
      ) clinic_counts
      CROSS JOIN (
        -- invitationStatus()'s "pending", in SQL: the same > on expires_at
        -- (an invitation expiring at this very instant is expired there).
        SELECT count(*)::int AS pending_invitations
        FROM ${invitations} i
        JOIN ${users} u ON u.id = i.user_id
        WHERE i.accepted_at IS NULL
          AND i.revoked_at IS NULL
          AND i.expires_at > now()
          AND u.is_active
      ) pending
  `
}

// The first ATTENTION_LIST_LIMIT accounts of a named subquery, by last name,
// then first name, then id (two people can share a name — the id makes the
// order the same on every load), as a JSON array of { id, firstName,
// lastName }. LIMIT goes in the inner query: json_agg would otherwise
// aggregate every row before anything could be cut. COALESCE: json_agg of no
// rows is NULL, and the API answers an empty list as [].
//
// The ORDER BY is written twice on purpose. The inner one decides WHICH
// accounts make the cut; the one inside json_agg decides the order of the
// array. Postgres usually keeps a subquery's order through an aggregate,
// but SQL doesn't promise it — so removing the outer one changes nothing in
// any test (a mutation that survives as equivalent), yet it is the only
// guarantee of the order.
function firstByName(source: ReturnType<typeof sql>) {
  return sql`(
    SELECT COALESCE(
      json_agg(
        json_build_object('id', f.id, 'firstName', f.first_name, 'lastName', f.last_name)
        ORDER BY f.last_name, f.first_name, f.id
      ),
      '[]'::json
    )
    FROM (
      SELECT id, first_name, last_name FROM ${source}
      ORDER BY last_name, first_name, id
      LIMIT ${ATTENTION_LIST_LIMIT}
    ) f
  )`
}
