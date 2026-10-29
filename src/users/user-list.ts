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

import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import { userClinics, userRoles, users } from '../database/schema'
import { containsPattern } from '../care-team/care-team.service'
import {
  needsAttention,
  type AttentionKind,
} from '../admin-metrics/attention-rules'
import type { UserRole } from './dto/create-user.dto'
import type { UserListStatus } from './dto/list-users-query.dto'

// --- TYPES -------------------------------------------------------------------------------------------------

// The Users page's filters (GET /admin/users), once validated by the DTO.
export interface UserListFilters {
  search?: string
  role?: UserRole
  clinic?: string // a clinic id, or 'none'
  status?: UserListStatus
  attention?: AttentionKind
}

// --- RULES -------------------------------------------------------------------------------------------------

// One WHERE clause for the page's rows AND its count, so "Page 2 of 5 · 112
// users" always describes the rows shown. Every filter is one condition;
// absent filters add none, and `and()` of nothing is `undefined` (no WHERE).
//
// Each condition is written against the `users` row itself:
//   - role and clinic as EXISTS / NOT EXISTS subqueries, not JOINs — a join
//     on user_roles would return a two-role account twice (and count it
//     twice); EXISTS asks "is there at least one such row?" and keeps one
//     row per account;
//   - the search with ILIKE (case-insensitive LIKE) on "first last" and on
//     the email, the pattern escaped by containsPattern() so a typed % or _
//     is a character, not a wildcard — the directory search's rule. Accents
//     still count ("Lea" doesn't find "Léa"; a deferred idea);
//   - attention through attention-rules.ts — the admin home's own condition,
//     so the group's count there and its list here can't disagree.
export function userListWhere(filters: UserListFilters): SQL | undefined {
  // Through the route the DTO's own default always fills `status` first;
  // `?? 'active'` only makes the type complete (a mutant changing it
  // survives — equivalent there), and keeps the rule right for any other
  // caller.
  const status = filters.status ?? 'active'
  const pattern = filters.search ? containsPattern(filters.search) : undefined
  return and(
    status === 'all' ? undefined : eq(users.isActive, status === 'active'),
    pattern
      ? or(
          ilike(sql`${users.firstName} || ' ' || ${users.lastName}`, pattern),
          ilike(users.email, pattern),
        )
      : undefined,
    filters.role
      ? sql`EXISTS (SELECT 1 FROM ${userRoles} WHERE ${userRoles.userId} = ${users.id} AND ${userRoles.role} = ${filters.role})`
      : undefined,
    filters.clinic === undefined
      ? undefined
      : filters.clinic === 'none'
        ? sql`NOT EXISTS (SELECT 1 FROM ${userClinics} WHERE ${userClinics.userId} = ${users.id})`
        : sql`EXISTS (SELECT 1 FROM ${userClinics} WHERE ${userClinics.userId} = ${users.id} AND ${userClinics.clinicId} = ${Number(filters.clinic)})`,
    filters.attention
      ? needsAttention(filters.attention, {
          id: sql`${users.id}`,
          isActive: sql`${users.isActive}`,
        })
      : undefined,
  )
}
