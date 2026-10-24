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
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, asc, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  careTeamMembers,
  clinics,
  patientProfiles,
  practitionerProfiles,
  userClinics,
  userRoles,
  users,
} from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import {
  CARE_TEAM_NO_OVERLAP,
  isExclusionViolation,
} from '../database/pg-errors'
import { AuditService } from '../audit/audit.service'
import { StorageService } from '../storage/storage.service'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { UserRole } from '../users/dto/create-user.dto'
import { AddCareTeamMemberDto } from './dto/add-care-team-member.dto'

// --- TYPES -------------------------------------------------------------------------------------------------

// Who is acting — the two fields every RLS context and permission check
// needs (the same shape withRlsContext() takes).
export interface Actor {
  id: number
  activeRole: UserRole
}

// A person referenced by a care-team entry ("added by", "ended by").
export interface PersonRef {
  id: number
  firstName: string
  lastName: string
}

// The practitioner of a care-team link: their DIRECTORY fields — who they
// are and what they do (the patient's Team page shows them, decided
// 2026-10-18). Never their own contact details (email, phone, address) nor
// their license number: those are read from `users` / the profile by
// other endpoints, for other people. A patient reaches their practitioner
// through the clinic (its contact details are public, GET /clinics/:id)
// and, later, through messaging.
export interface CareTeamPractitioner extends PersonRef {
  avatarUrl: string | null
  specialties: string[]
  bio: string | null
}

// One care-team link as the API returns it. Directory-level information
// only about the practitioner: being told who is on a patient's team is not
// clinical data.
export interface CareTeamEntry {
  id: number
  patientId: number
  practitioner: CareTeamPractitioner
  // The clinics this practitioner and the patient BOTH belong to now — where
  // they see each other. Empty once they share none (a link ended by
  // leaving the clinic, in the history).
  sharedClinics: { id: number; name: string }[]
  startedAt: Date
  endsAt: Date | null
  // Computed with the SAME rule as access (period AND shared clinic), so
  // "active" on screen always means "has clinical access right now".
  isActive: boolean
  reason: string | null
  createdBy: PersonRef | null
  endedBy: PersonRef | null
}

// The same entry as the PATIENT reads it: without `reason`. The reason is
// typed by staff for staff ("Holiday cover", or anything else a colleague
// should know), in a dialog that never said the patient would read it — so
// it stays in the audit trail and on the staff screens (decided
// 2026-10-18). Who added the practitioner, and when, stays visible: that is
// the accountability the patient is promised (decisions §3).
export type PatientCareTeamEntry = Omit<CareTeamEntry, 'reason'>

// One patient in the clinic directory: enough to recognise someone and
// decide to join their care team — nothing clinical, no contact details
// (design decisions §3, "two levels of access").
// A practitioner who could be added to a patient's care team ("Add a
// colleague", decided 2026-10-09): directory fields for STAFF — enough to
// choose the right person (name, photo, specialties, where they work with
// this patient) and nothing else (no email, phone, license number).
export interface CareTeamCandidate {
  id: number
  firstName: string
  lastName: string
  avatarUrl: string | null
  specialties: string[]
  // The clinics where this practitioner works AND the patient attends —
  // the reason they can be added at all (clinical access needs one).
  sharedClinics: { id: number; name: string }[]
  // Already on the team (an active period): adding them again would be
  // refused (the no-overlap constraint → 409), so the screen disables them.
  onCareTeam: boolean
}

export interface DirectoryPatient {
  id: number
  firstName: string
  lastName: string
  avatarUrl: string | null
  dateOfBirth: string | null
  // Only the clinics this patient shares with the practitioner searching.
  sharedClinics: { id: number; name: string }[]
  onMyCareTeam: boolean
}

// A link ended as a side effect (a clinic membership removed). Returned so
// the caller can write one audit entry per link once its transaction has
// committed.
export interface EndedLink {
  id: number
  patientId: number
  practitionerId: number
  // The period the link granted access — for the audit entry of its end.
  startedAt: Date
  endsAt: Date | null
}

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The reason stored on the link created automatically when a practitioner
// creates a patient (UsersService.create()).
export const CREATED_PATIENT_REASON = 'Created the patient'

// The directory is a search, not an export: a practitioner types a name
// and picks from the matches. A cap keeps a vague search ("a") cheap.
export const DIRECTORY_RESULT_LIMIT = 50

// --- THE RULE, IN SQL --------------------------------------------------------------------------------------
//
// The care-team rule (design decisions §3), written ONCE here for every
// TypeScript query, as small reusable SQL fragments. Its SQL twin is
// rls_care_team_member() in migration 0019; test/care-team.e2e-spec.ts runs
// the same scenarios through both and requires identical answers, so the
// two copies can't drift apart unnoticed.
//
// Why raw `sql` fragments rather than Drizzle's and()/or() builders: the
// shared-clinic check joins user_clinics to ITSELF (one row for each
// person), which needs two aliases of the same table inside an EXISTS
// subquery — much clearer written as the SQL it is. Values are still passed
// as ${...} placeholders, which Drizzle turns into query parameters ($1, $2…),
// never pasted into the SQL text — so this is not an injection risk.

// The link's period covers "now": it has started, and has no end date or
// ends in the future (a planned cover period is active until it ends).
function activePeriod(): SQL {
  return sql`(${careTeamMembers.startedAt} <= now() AND (${careTeamMembers.endsAt} IS NULL OR ${careTeamMembers.endsAt} > now()))`
}

// Two users belong to at least one common clinic. `a` and `b` can be
// columns (inside a query on care_team_members) or plain values.
function sharedClinic(a: SQL | number, b: SQL | number): SQL {
  return sql`EXISTS (SELECT 1 FROM ${userClinics} uc_a JOIN ${userClinics} uc_b ON uc_a.clinic_id = uc_b.clinic_id WHERE uc_a.user_id = ${a} AND uc_b.user_id = ${b})`
}

// The full rule for CLINICAL access, applied to the care_team_members row
// being read: an active period AND a clinic both people still share.
// Exported for the admin home's metrics (AdminMetricsService, 2026-10-24):
// "which patients have nobody treating them?" must use exactly this rule,
// not a third copy of it.
export function clinicalAccess(): SQL {
  return sql`(${activePeriod()} AND ${sharedClinic(
    sql`${careTeamMembers.practitionerId}`,
    sql`${careTeamMembers.patientId}`,
  )})`
}

// Turns a user's search text into a LIKE pattern that matches it anywhere.
// % and _ are wildcards in LIKE, so a user typing them must get them
// literally (escaped with a backslash, Postgres's default escape character).
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`
}

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class CareTeamService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
  ) {}

  // === THE TWO ACCESS LEVELS ==============================================

  // CLINICAL access: is this practitioner on this patient's care team right
  // now? The one question behind UsersService.isPatientManagedBy(), and so
  // behind every clinical endpoint (profile, programs, sessions, medical
  // files, messaging).
  //
  // Why the query runs "as" the practitioner being checked:
  // care_team_members has FORCE ROW LEVEL SECURITY, and a query with no
  // session context sees NO rows at all — every answer would be "no". Its
  // SELECT policy lets a practitioner see their own links, so asking from
  // the practitioner's own point of view is exactly right: "can THIS person
  // see a link of theirs to this patient?"
  async isOnCareTeam(practitionerId: number, patientId: number) {
    const rows = await withRlsContext(
      this.db,
      asPractitioner(practitionerId),
      (tx) =>
        tx
          .select({ id: careTeamMembers.id })
          .from(careTeamMembers)
          .where(
            and(
              eq(careTeamMembers.practitionerId, practitionerId),
              eq(careTeamMembers.patientId, patientId),
              clinicalAccess(),
            ),
          )
          .limit(1),
    )
    return rows.length > 0
  }

  // DIRECTORY access: do these two people share at least one clinic? Enough
  // to find a patient, see who is on their care team, and join it — never
  // enough to read clinical data. (This is the old "manages" rule, under an
  // honest name.) user_clinics is readable without a session context (its
  // SELECT policy is open, like users'), so no RLS context is needed.
  async sharesClinic(userA: number, userB: number) {
    const result = await this.db.execute<{ shared: boolean }>(
      sql`SELECT ${sharedClinic(userA, userB)} AS shared`,
    )
    return result.rows[0]?.shared === true
  }

  // The ids of every patient this practitioner has clinical access to —
  // "my patients". UsersService.findPatientsForPractitioner() builds the
  // full list from these (so GET /users, and the assigned-programs and
  // sessions lists, all mean "my care team").
  async findPatientIdsForPractitioner(practitionerId: number) {
    const rows = await withRlsContext(
      this.db,
      asPractitioner(practitionerId),
      (tx) =>
        tx
          .selectDistinct({ patientId: careTeamMembers.patientId })
          .from(careTeamMembers)
          .where(
            and(
              eq(careTeamMembers.practitionerId, practitionerId),
              clinicalAccess(),
            ),
          ),
    )
    return rows.map((row) => row.patientId)
  }

  // === ROUTES =============================================================

  // --- GET /users/:id/care-team ---

  // Who may see a patient's care team: an admin, the patient themselves, or
  // a practitioner who shares a clinic with them (directory level — seeing
  // who treats a patient tells a colleague whom to ask, and whether to
  // join). Ended links are included only with includeEnded; the patient may
  // ask for them too (they see their own history, marked as ended).
  async listForPatient(
    patientId: number,
    actor: Actor,
    includeEnded: boolean,
  ): Promise<CareTeamEntry[] | PatientCareTeamEntry[]> {
    await this.assertActivePatient(patientId)
    await this.assertCanSeeCareTeam(patientId, actor)
    const entries = await this.findEntries(actor, {
      patientId,
      activeOnly: !includeEnded,
    })
    // assertCanSeeCareTeam() let a patient through only for their OWN team,
    // so "acting as a patient" here means "the patient reading their team".
    // The key is REMOVED, not set to null: null already means "no reason
    // was given", and the patient's answer must not pretend to say that.
    if (actor.activeRole === UserRole.PATIENT) {
      return entries.map(({ reason: _staffOnly, ...entry }) => entry)
    }
    return entries
  }

  // --- POST /users/:id/care-team ---

  // Adds a practitioner to a patient's care team: "Join" (no practitionerId
  // — the caller themselves) or "add a colleague". Deliberately NO approval
  // step (decisions §3, "break-glass"): a rule that can block treatment is
  // worse than one resting on accountability. The accountability is the
  // audit entry below, and the patient seeing it on their Team page.
  async addMember(
    patientId: number,
    dto: AddCareTeamMemberDto,
    actor: Actor,
  ): Promise<CareTeamEntry> {
    const isAdmin = actor.activeRole === UserRole.ADMIN
    const practitionerId = dto.practitionerId ?? (isAdmin ? null : actor.id)
    if (practitionerId === null) {
      throw new BadRequestException(
        'practitionerId is required when an admin adds someone to a care team',
      )
    }
    if (practitionerId === patientId) {
      throw new BadRequestException(
        'A patient cannot be on their own care team',
      )
    }

    await this.assertActivePatient(patientId)
    await this.assertActivePractitioner(practitionerId)

    // The caller must be in the patient's clinic (admins aside, as
    // everywhere else in this app)…
    if (!isAdmin && !(await this.sharesClinic(actor.id, patientId))) {
      throw new ForbiddenException(
        'You can only join the care team of a patient in one of your clinics',
      )
    }
    // …and so must the practitioner being added — even when that is the
    // caller (then this repeats the check above; harmless and simpler than
    // a special case).
    if (!(await this.sharesClinic(practitionerId, patientId))) {
      throw new BadRequestException(
        "This practitioner does not work at any of this patient's clinics",
      )
    }

    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('endsAt must be in the future')
    }

    let link: typeof careTeamMembers.$inferSelect
    try {
      link = await withRlsContext(this.db, actor, async (tx) => {
        const [inserted] = await tx
          .insert(careTeamMembers)
          .values({
            patientId,
            practitionerId,
            endsAt,
            createdBy: actor.id,
            reason: dto.reason ?? null,
          })
          .returning()
        // The accountability this route rests on (no approval step — see
        // above): ONE entry, in the link's own transaction, so a link can't
        // exist without it. JOINED when the caller adds themselves, ADDED
        // when they add a colleague.
        await this.auditService.logInTransaction(tx, {
          performedBy: actor.id,
          action:
            practitionerId === actor.id
              ? 'CARE_TEAM_JOINED'
              : 'CARE_TEAM_MEMBER_ADDED',
          targetUserId: patientId,
          entityType: 'care_team_members',
          entityId: inserted.id,
          details: {
            practitionerId,
            startedAt: inserted.startedAt,
            endsAt: inserted.endsAt,
            reason: inserted.reason,
          },
        })
        return inserted
      })
    } catch (error) {
      // The exclusion constraint's verdict, not a check-before-insert: two
      // simultaneous "Join" clicks can't both succeed (see pg-errors.ts).
      if (isExclusionViolation(error, CARE_TEAM_NO_OVERLAP)) {
        throw new ConflictException(
          'This practitioner is already on the care team for this period',
        )
      }
      throw error
    }

    return this.findEntryOrThrow(link.id, actor)
  }

  // --- POST /users/:id/care-team/:practitionerId/end ---

  // Ends a practitioner's CURRENT link to a patient (sets ends_at to now —
  // nothing is deleted). Allowed for the practitioner themselves or an
  // admin. A patient removing someone from their team is a possible later
  // feature (deferred-improvements.md).
  async endMembership(
    patientId: number,
    practitionerId: number,
    actor: Actor,
  ): Promise<CareTeamEntry> {
    const isAdmin = actor.activeRole === UserRole.ADMIN
    if (!isAdmin && actor.id !== practitionerId) {
      throw new ForbiddenException(
        'You can only end your own care-team membership',
      )
    }

    // The "is it still active?" condition is part of the UPDATE itself, not
    // a separate read first: if two requests end the same link at once, the
    // second updates nothing and gets a 404, instead of overwriting the
    // first one's ends_at/ended_by.
    const ended = await withRlsContext(this.db, actor, async (tx) => {
      const [row] = await tx
        .update(careTeamMembers)
        .set({ endsAt: sql`now()`, endedBy: actor.id })
        .where(
          and(
            eq(careTeamMembers.patientId, patientId),
            eq(careTeamMembers.practitionerId, practitionerId),
            activePeriod(),
          ),
        )
        .returning()
      // Thrown INSIDE the transaction: nothing was updated, and the entry
      // below is never reached — a refused request writes no entry.
      if (!row) {
        throw new NotFoundException(
          'This practitioner has no active care-team membership for this patient',
        )
      }
      // The period the link covered, start and end — "who could read this
      // patient's file, and when" — answerable from the entry alone.
      await this.auditService.logInTransaction(tx, {
        performedBy: actor.id,
        action: 'CARE_TEAM_ENDED',
        targetUserId: patientId,
        entityType: 'care_team_members',
        entityId: row.id,
        details: {
          practitionerId,
          startedAt: row.startedAt,
          endsAt: row.endsAt,
        },
      })
      return row
    })

    return this.findEntryOrThrow(ended.id, actor)
  }

  // --- GET /directory/patients ---

  // The clinic directory (directory level): active patients who share at
  // least one clinic with this practitioner, optionally filtered by name.
  // Returns identification data only — name, photo, date of birth (to tell
  // two people with the same name apart), the shared clinics, and whether
  // the caller is already on their care team.
  async searchDirectory(
    practitionerId: number,
    search?: string,
  ): Promise<DirectoryPatient[]> {
    const myClinics = await this.db
      .select({ clinicId: userClinics.clinicId })
      .from(userClinics)
      .where(eq(userClinics.userId, practitionerId))
    const myClinicIds = myClinics.map((row) => row.clinicId)
    if (myClinicIds.length === 0) {
      return []
    }

    const term = search?.trim()
    const rows = await this.db
      .selectDistinct({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarPath: users.avatarPath,
        dateOfBirth: patientProfiles.dateOfBirth,
      })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(userClinics, eq(userClinics.userId, users.id))
      .leftJoin(patientProfiles, eq(patientProfiles.userId, users.id))
      .where(
        and(
          eq(userRoles.role, UserRole.PATIENT),
          eq(users.isActive, true),
          inArray(userClinics.clinicId, myClinicIds),
          // "Marie", "Martin" and "Marie Martin" all find Marie Martin:
          // the search runs against "first last" as one string.
          term
            ? ilike(
                sql`${users.firstName} || ' ' || ${users.lastName}`,
                containsPattern(term),
              )
            : undefined,
        ),
      )
      .orderBy(asc(users.lastName), asc(users.firstName))
      .limit(DIRECTORY_RESULT_LIMIT)

    if (rows.length === 0) {
      return []
    }
    const patientIds = rows.map((row) => row.id)

    // Two batched queries for the whole page of results (not one per
    // patient): the shared clinics, and which patients are already mine.
    const clinicRows = await this.db
      .select({
        userId: userClinics.userId,
        id: clinics.id,
        name: clinics.name,
      })
      .from(userClinics)
      .innerJoin(clinics, eq(clinics.id, userClinics.clinicId))
      .where(
        and(
          inArray(userClinics.userId, patientIds),
          inArray(userClinics.clinicId, myClinicIds),
        ),
      )
    const mine = new Set(
      await this.findPatientIdsForPractitioner(practitionerId),
    )

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        avatarUrl: await this.avatarUrl(row.avatarPath),
        dateOfBirth: row.dateOfBirth,
        sharedClinics: clinicRows
          .filter((clinic) => clinic.userId === row.id)
          .map(({ id, name }) => ({ id, name })),
        onMyCareTeam: mine.has(row.id),
      })),
    )
  }

  // --- GET /users/:id/care-team/candidates ---

  // Who could join this patient's care team: every active practitioner who
  // works at one of THE PATIENT's clinics — not the caller's (Sam, at
  // Riverside, may add Blake, at Harbour, to Robin, who attends both: the
  // backend's addMember() checks the ADDED practitioner against the
  // patient). Ordered by name. No search and no limit: a clinic has a
  // handful of practitioners, so the screen filters as you type.
  //
  // Who may ask: an admin, or a practitioner sharing a clinic with the
  // patient — exactly who may add someone (addMember). A patient choosing
  // their own team is not a feature, so a patient gets a 403.
  async listCandidates(
    patientId: number,
    actor: Actor,
  ): Promise<CareTeamCandidate[]> {
    await this.assertActivePatient(patientId)
    const isAdmin = actor.activeRole === UserRole.ADMIN
    const isClinicColleague =
      actor.activeRole === UserRole.PRACTITIONER &&
      (await this.sharesClinic(actor.id, patientId))
    if (!isAdmin && !isClinicColleague) {
      throw new ForbiddenException(
        "You can't add anyone to this patient's care team",
      )
    }

    const patientClinics = await this.db
      .select({ clinicId: userClinics.clinicId })
      .from(userClinics)
      .where(eq(userClinics.userId, patientId))
    const patientClinicIds = patientClinics.map((row) => row.clinicId)
    if (patientClinicIds.length === 0) {
      return []
    }

    // One row per practitioner (selectDistinct: someone working at two of
    // the patient's clinics would otherwise appear twice). The LEFT JOIN on
    // the profile brings the specialties; a practitioner always has one, but
    // a LEFT JOIN means a missing profile can't hide a person.
    const rows = await this.db
      .selectDistinct({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarPath: users.avatarPath,
        specialties: practitionerProfiles.specialties,
      })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(userClinics, eq(userClinics.userId, users.id))
      .leftJoin(practitionerProfiles, eq(practitionerProfiles.userId, users.id))
      .where(
        and(
          eq(userRoles.role, UserRole.PRACTITIONER),
          eq(users.isActive, true),
          inArray(userClinics.clinicId, patientClinicIds),
        ),
      )
      .orderBy(asc(users.lastName), asc(users.firstName))

    if (rows.length === 0) {
      return []
    }
    const practitionerIds = rows.map((row) => row.id)

    // Batched for the whole list, as in searchDirectory(): the clinics each
    // practitioner shares with the patient, and who is on the team now.
    const sharedClinics = await this.sharedClinicsByPractitioner(
      patientId,
      practitionerIds,
    )
    // Read under the caller's RLS context: the care_team_members SELECT
    // policy lets an admin and any clinic-sharing practitioner see a
    // patient's links (directory level — who treats a patient isn't
    // clinical data).
    const onTeamRows = await withRlsContext(this.db, actor, (tx) =>
      tx
        .select({ practitionerId: careTeamMembers.practitionerId })
        .from(careTeamMembers)
        .where(and(eq(careTeamMembers.patientId, patientId), activePeriod())),
    )
    const onTeam = new Set(onTeamRows.map((row) => row.practitionerId))

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        avatarUrl: await this.avatarUrl(row.avatarPath),
        specialties: row.specialties ?? [],
        sharedClinics: sharedClinics.get(row.id) ?? [],
        onCareTeam: onTeam.has(row.id),
      })),
    )
  }

  // === USED BY OTHER SERVICES, INSIDE THEIR TRANSACTIONS ==================

  // UsersService.create(): a practitioner who creates a patient joins their
  // care team at once — otherwise they couldn't open the patient they just
  // created. Runs in create()'s own transaction (`tx`), so the patient, their
  // clinic membership and this link all exist, or none of them do. No entry
  // of its own: the caller's USER_CREATED entry names this link
  // (careTeamLinkId) — one request, one entry.
  async linkCreator(tx: DrizzleDb, patientId: number, practitionerId: number) {
    const [link] = await tx
      .insert(careTeamMembers)
      .values({
        patientId,
        practitionerId,
        createdBy: practitionerId,
        reason: CREATED_PATIENT_REASON,
      })
      .returning()
    return link
  }

  // ClinicsService.removeMember(): once someone leaves a clinic, every
  // active link of theirs that no longer has a clinic in common is ENDED
  // (not deleted), in the same transaction as the membership removal.
  //
  // Access would stop anyway — the rule also requires a shared clinic — but
  // ending the links keeps the history truthful ("treated until the day
  // they left"), instead of showing links that look active but grant
  // nothing. Links with ANOTHER clinic still in common are left alone.
  async endLinksWithoutSharedClinic(
    tx: DrizzleDb,
    userId: number,
    performedBy: number,
  ): Promise<EndedLink[]> {
    return tx
      .update(careTeamMembers)
      .set({ endsAt: sql`now()`, endedBy: performedBy })
      .where(
        and(
          sql`(${careTeamMembers.patientId} = ${userId} OR ${careTeamMembers.practitionerId} = ${userId})`,
          activePeriod(),
          sql`NOT ${sharedClinic(
            sql`${careTeamMembers.practitionerId}`,
            sql`${careTeamMembers.patientId}`,
          )}`,
        ),
      )
      .returning({
        id: careTeamMembers.id,
        patientId: careTeamMembers.patientId,
        practitionerId: careTeamMembers.practitionerId,
        startedAt: careTeamMembers.startedAt,
        endsAt: careTeamMembers.endsAt,
      })
  }

  // === HELPER FUNCTIONS ===================================================

  // 404 unless `patientId` is an active user holding the patient role —
  // care teams only exist for patients.
  private async assertActivePatient(patientId: number) {
    if (!(await this.hasActiveRole(patientId, UserRole.PATIENT))) {
      throw new NotFoundException(`Patient ${patientId} not found`)
    }
  }

  // 400 unless `practitionerId` is an active practitioner. A 400 rather
  // than a 404: the URL (the patient) exists; it's the request body that
  // names someone who can't be added.
  private async assertActivePractitioner(practitionerId: number) {
    if (!(await this.hasActiveRole(practitionerId, UserRole.PRACTITIONER))) {
      throw new BadRequestException(
        `User ${practitionerId} is not an active practitioner`,
      )
    }
  }

  private async hasActiveRole(userId: number, role: UserRole) {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(
        and(
          eq(users.id, userId),
          eq(users.isActive, true),
          eq(userRoles.role, role),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  private async assertCanSeeCareTeam(patientId: number, actor: Actor) {
    if (actor.activeRole === UserRole.ADMIN) return
    if (actor.activeRole === UserRole.PATIENT && actor.id === patientId) return
    if (
      actor.activeRole === UserRole.PRACTITIONER &&
      (await this.sharesClinic(actor.id, patientId))
    ) {
      return
    }
    throw new ForbiddenException("You can't view this patient's care team")
  }

  private async findEntryOrThrow(linkId: number, actor: Actor) {
    const [entry] = await this.findEntries(actor, { linkId })
    if (!entry) {
      // Unreachable in practice (the caller has just written this row);
      // a clear error beats returning undefined as if it were an entry.
      throw new NotFoundException(`Care-team link ${linkId} not found`)
    }
    return entry
  }

  // The one query that builds CareTeamEntry objects, used by the list, and
  // to return the row just added or ended in the same shape.
  //
  // Runs with the actor's RLS context: the table's policies are the second
  // line of defence behind assertCanSeeCareTeam() above.
  private async findEntries(
    actor: Actor,
    filter: { patientId: number; activeOnly: boolean } | { linkId: number },
  ): Promise<CareTeamEntry[]> {
    const where =
      'linkId' in filter
        ? eq(careTeamMembers.id, filter.linkId)
        : and(
            eq(careTeamMembers.patientId, filter.patientId),
            filter.activeOnly ? clinicalAccess() : undefined,
          )

    const rows = await withRlsContext(this.db, actor, (tx) =>
      tx
        .select({
          link: careTeamMembers,
          isActive: sql<boolean>`${clinicalAccess()}`,
          practitioner: {
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            avatarPath: users.avatarPath,
          },
          // Named fields only, never the whole profile row: it also holds
          // the license number, which this answer must not carry.
          profile: {
            specialties: practitionerProfiles.specialties,
            bio: practitionerProfiles.bio,
          },
        })
        .from(careTeamMembers)
        .innerJoin(users, eq(users.id, careTeamMembers.practitionerId))
        // LEFT JOIN, as in listCandidates(): a practitioner always has a
        // profile, but a missing one must not make a team member vanish.
        .leftJoin(
          practitionerProfiles,
          eq(practitionerProfiles.userId, careTeamMembers.practitionerId),
        )
        .where(where)
        // Active members first, then the most recent periods first.
        .orderBy(
          desc(sql`${clinicalAccess()}`),
          desc(careTeamMembers.startedAt),
        ),
    )
    if (rows.length === 0) {
      return []
    }

    // The people named in "added by" / "ended by", in one batched query.
    const personIds = [
      ...new Set(
        rows
          .flatMap(({ link }) => [link.createdBy, link.endedBy])
          .filter((id): id is number => id !== null),
      ),
    ]
    const people =
      personIds.length === 0
        ? []
        : await this.db
            .select({
              id: users.id,
              firstName: users.firstName,
              lastName: users.lastName,
            })
            .from(users)
            .where(inArray(users.id, personIds))
    const personById = new Map(people.map((person) => [person.id, person]))
    const person = (id: number | null) =>
      id === null ? null : (personById.get(id) ?? null)

    // Where each practitioner and the patient meet, in one batched query.
    // Both filters name ONE patient (a list is one patient's team; a link
    // has one patient), so the first row's patient is everyone's.
    const sharedClinics = await this.sharedClinicsByPractitioner(
      rows[0].link.patientId,
      [...new Set(rows.map(({ practitioner }) => practitioner.id))],
    )

    return Promise.all(
      rows.map(async ({ link, isActive, practitioner, profile }) => ({
        id: link.id,
        patientId: link.patientId,
        practitioner: {
          id: practitioner.id,
          firstName: practitioner.firstName,
          lastName: practitioner.lastName,
          avatarUrl: await this.avatarUrl(practitioner.avatarPath),
          // A LEFT JOIN with no match gives null for each field.
          specialties: profile?.specialties ?? [],
          bio: profile?.bio ?? null,
        },
        sharedClinics: sharedClinics.get(practitioner.id) ?? [],
        startedAt: link.startedAt,
        endsAt: link.endsAt,
        isActive,
        reason: link.reason,
        createdBy: person(link.createdBy),
        endedBy: person(link.endedBy),
      })),
    )
  }

  // For each of `practitionerIds`, the clinics they share with the patient,
  // ordered by name — one query for the whole list, whatever its length
  // (one query per person would be the "N + 1" pattern). The patient's
  // clinics are a subquery, so the comparison happens inside Postgres; it
  // reads user_clinics a second time, hence the alias, as in sharedClinic().
  // Clinics are read without an RLS context: their SELECT policy is open,
  // like user_clinics' (identity data — migrations 0008 and 0011).
  private async sharedClinicsByPractitioner(
    patientId: number,
    practitionerIds: number[],
  ): Promise<Map<number, { id: number; name: string }[]>> {
    const rows = await this.db
      .select({
        userId: userClinics.userId,
        id: clinics.id,
        name: clinics.name,
      })
      .from(userClinics)
      .innerJoin(clinics, eq(clinics.id, userClinics.clinicId))
      .where(
        and(
          inArray(userClinics.userId, practitionerIds),
          sql`${userClinics.clinicId} IN (SELECT pc.clinic_id FROM ${userClinics} pc WHERE pc.user_id = ${patientId})`,
        ),
      )
      .orderBy(asc(clinics.name))

    const byPractitioner = new Map<number, { id: number; name: string }[]>()
    for (const { userId, id, name } of rows) {
      byPractitioner.set(userId, [
        ...(byPractitioner.get(userId) ?? []),
        { id, name },
      ])
    }
    return byPractitioner
  }

  private avatarUrl(avatarPath: string | null) {
    return this.storageService.getPresignedUrlOrNull(
      avatarPath,
      AVATAR_URL_EXPIRY_SECONDS,
    )
  }
}

// The RLS context for evaluating a check from a practitioner's own point of
// view (see isOnCareTeam()).
function asPractitioner(practitionerId: number): Actor {
  return { id: practitionerId, activeRole: UserRole.PRACTITIONER }
}
