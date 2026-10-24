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

import { sql, type SQL } from 'drizzle-orm'
import {
  users,
  userRoles,
  userClinics,
  clinics,
  careTeamMembers,
} from '../database/schema'
import { clinicalAccess } from '../care-team/care-team.service'
import { UserRole } from '../users/dto/create-user.dto'

// --- THE RULES ---------------------------------------------------------------------------------------------

// "Needs attention" (decisions §17): the accounts an admin should look at.
// Written ONCE, as SQL conditions on one users row, and used by BOTH readers:
//   - the admin home's numbers (AdminMetricsService: how many, and the first
//     five names);
//   - the users list's filter (GET /users?attention=…: every one of them).
// One definition means the home's "Patients without a care team · 7" and the
// filtered list can never disagree — a copy in each place could drift.
//
// The names double as the API's values (`?attention=`) and the frontend's.
export const ATTENTION_KINDS = [
  'patients-without-care-team',
  'practitioners-without-clinic',
] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

// A type guard: `value is AttentionKind` tells TypeScript that, after a
// `true`, the string is one of the two names — so the controller can pass a
// raw query parameter on without a cast. `includes` is called on the list
// typed as `readonly string[]`: TypeScript's `includes` on a tuple of
// literals only accepts those literals, which is the very thing being tested.
export function isAttentionKind(value: string): value is AttentionKind {
  return (ATTENTION_KINDS as readonly string[]).includes(value)
}

// The users row the conditions are about, as two SQL expressions: the
// metrics statement reads an aliased row (`u.id`), the users list Drizzle's
// own columns (`"users"."id"`). Taking expressions instead of a table keeps
// the rule independent of how each query names its row.
export interface UserRow {
  id: SQL
  isActive: SQL
}

// The condition for one kind. Must run under an ADMIN's row-security
// context: care_team_members is FORCE ROW LEVEL SECURITY and shows nothing
// to a query without one (every patient would then look unattended).
export function needsAttention(kind: AttentionKind, user: UserRow): SQL {
  return kind === 'patients-without-care-team'
    ? patientWithoutCareTeam(user)
    : practitionerWithoutClinic(user)
}

// An ACTIVE patient whom nobody active is treating right now: no care-team
// link passing clinicalAccess() — the rule every clinical permission uses
// (an active period AND a clinic both still share) — to a practitioner
// whose account is active. Deactivating a practitioner doesn't end their
// links, so without `p.is_active` their patients would look looked-after.
//
// clinicalAccess() names care_team_members' columns in full
// ("care_team_members"."patient_id"…), so that table is NOT aliased here.
function patientWithoutCareTeam(user: UserRow): SQL {
  return sql`(${user.isActive}
    AND ${hasRole(user, UserRole.PATIENT)}
    AND NOT EXISTS (
      SELECT 1
      FROM ${careTeamMembers}
      JOIN ${users} p ON p.id = ${careTeamMembers.practitionerId}
      WHERE ${careTeamMembers.patientId} = ${user.id}
        AND p.is_active
        AND ${clinicalAccess()}
    ))`
}

// An ACTIVE practitioner in no ACTIVE clinic (none at all, or only
// deactivated ones — a deactivated clinic keeps its members).
function practitionerWithoutClinic(user: UserRow): SQL {
  return sql`(${user.isActive}
    AND ${hasRole(user, UserRole.PRACTITIONER)}
    AND NOT EXISTS (
      SELECT 1
      FROM ${userClinics} m
      JOIN ${clinics} c ON c.id = m.clinic_id
      WHERE m.user_id = ${user.id} AND c.is_active
    ))`
}

function hasRole(user: UserRow, role: UserRole): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${userRoles} r
    WHERE r.user_id = ${user.id} AND r.role = ${role}
  )`
}
