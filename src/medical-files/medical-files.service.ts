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
import { desc, eq, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { medicalFiles, users } from '../database/schema'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { CreateMedicalFileDto } from './dto/create-medical-file.dto'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import {
  MEDICAL_FILES_AMENDS_SAME_PATIENT_FK,
  MEDICAL_FILES_HAS_CONTENT,
  MEDICAL_FILES_NOT_SELF_AMENDING,
  MEDICAL_FILES_ONE_AMENDMENT_PER_ENTRY,
  isCheckViolation,
  isForeignKeyViolation,
  isRowSecurityViolation,
  isUniqueViolation,
} from '../database/pg-errors'
import {
  ALREADY_AMENDED_MESSAGE,
  AMENDS_UNKNOWN_ENTRY_MESSAGE,
  NOT_ON_CARE_TEAM_READ_MESSAGE,
  NOT_ON_CARE_TEAM_WRITE_MESSAGE,
  NO_SECTION_MESSAGE,
  OWN_FILE_ONLY_MESSAGE,
  PATIENT_ID_REQUIRED_MESSAGE,
  entryNotFoundMessage,
  type MedicalFileEntryType,
} from './medical-file-rules'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// One entry as the API answers it — for the practitioner and the patient
// alike (a patient may read their whole file: HIPAA's right of access).
//   - author: who wrote it, by name — the screens show "Alex Chen" and the
//     patient knows their care team anyway. Only these three fields of the
//     users row: the identity tables are readable by every role (login reads
//     them before anyone is signed in), so the SELECT below is the rule.
//   - amendsId / amendmentReason: set on an amendment — what it corrects,
//     and why.
//   - amendedById: set on an entry that HAS been amended — the id of the
//     entry that corrects it, so a screen can say "Amended" and link to the
//     newer version. Worked out by the query (the amendment points back
//     here), never stored twice.
export interface MedicalFileEntry {
  id: number
  patientId: number
  entryType: MedicalFileEntryType
  subjective: string | null
  objective: string | null
  assessment: string | null
  plan: string | null
  createdAt: Date
  author: { id: number; firstName: string; lastName: string }
  amendsId: number | null
  amendmentReason: string | null
  amendedById: number | null
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// A patient's medical file (Phase 6, brought to the Phase 3–5 standards
// 2026-10-20):
//   - ROW SECURITY decides who reads and writes (migrations 0019 / 0050): the
//     patient reads their own file, the practitioners on their care team read
//     and add entries. Admins don't (decided 2026-10-20 — the role guard
//     answers them 403, and the policy hides every row from them anyway).
//   - APPEND-ONLY: no update and no delete, here or in the database. A
//     correction is an amendment — a new entry pointing at the old one.
//   - AUDITED, READS INCLUDED: every request writes ONE entry, in the SAME
//     transaction as what it describes. For a write, that means no change
//     without its record (the entry commits or rolls back with it). For a
//     read, that the data is never served without the trace of who saw it:
//     if the audit insert fails, the request fails. HIPAA's concern with a
//     health record is who VIEWED it as much as who changed it — the patient
//     viewing their own file is logged too.
@Injectable()
export class MedicalFilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES =============================================================

  // --- POST /medical-files ---

  // A new entry, or an amendment of an earlier one. There is NO pre-check of
  // the care team here: the INSERT policy decides it, at the moment of
  // writing, and its refusal (42501) becomes the 403. A check before the
  // insert would give the same answer — no test could tell the two apart —
  // and only the policy is atomic: a care-team link ended between a check
  // and the insert would slip through the check, never through the policy
  // (the reasoning that removed messaging's pre-check, decisions §7).
  //
  // The other refusals are the database's too, each translated:
  //   - no section at all → the CHECK medical_files_has_content → 400;
  //   - amendsId names no entry of this patient → the composite foreign key
  //     (or, for the new row's own id, the not-self CHECK) → 400;
  //   - the entry was amended already → the unique index → 409. Two
  //     amendments of the same entry at the same moment: the second INSERT
  //     waits for the first to commit, then meets the index.
  async create(
    currentUser: CurrentUser,
    dto: CreateMedicalFileDto,
  ): Promise<MedicalFileEntry> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      let row: typeof medicalFiles.$inferSelect
      try {
        // created_at isn't sent: the trigger (0050) writes the database's
        // now(). `?? null` turns an absent section into NULL explicitly.
        ;[row] = await tx
          .insert(medicalFiles)
          .values({
            patientId: dto.patientId,
            createdBy: currentUser.id,
            entryType: dto.entryType,
            subjective: dto.subjective ?? null,
            objective: dto.objective ?? null,
            assessment: dto.assessment ?? null,
            plan: dto.plan ?? null,
            amendsId: dto.amendsId ?? null,
            amendmentReason: dto.amendmentReason ?? null,
          })
          .returning()
      } catch (error) {
        throw translateInsertError(error)
      }

      // The audit entry points at the row; it doesn't copy the text. The
      // row IS the record, and it can never change or disappear (0050) — a
      // copy would only be a second place holding clinical content.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action:
          row.amendsId === null
            ? 'MEDICAL_FILE_ENTRY_CREATED'
            : 'MEDICAL_FILE_ENTRY_AMENDED',
        targetUserId: row.patientId,
        entityType: 'medical_files',
        entityId: row.id,
        details: {
          entryType: row.entryType,
          createdAt: row.createdAt,
          ...(row.amendsId === null ? {} : { amendsId: row.amendsId }),
        },
      })

      const [entry] = await this.loadEntries(tx, eq(medicalFiles.id, row.id))
      return entry
    })
  }

  // --- GET /medical-files ---

  // A patient's whole file, newest first. Who asks decides whose:
  //   - a patient: their own (a patientId naming someone else → 403);
  //   - a practitioner: the patientId they name (required), and only on the
  //     patient's care team.
  // The practitioner's care-team check stays a PRE-check, unlike create's:
  // here the policy alone would answer an empty list — "this patient has no
  // entries" — when the truth is "you may not look". The 403 says what is
  // true, and a test CAN tell it from the policy (403 vs 200 []). The policy
  // still filters the rows, whatever the check said.
  async findAll(
    currentUser: CurrentUser,
    patientId?: number,
  ): Promise<MedicalFileEntry[]> {
    const targetPatientId = await this.resolveListTarget(currentUser, patientId)

    return withRlsContext(this.db, currentUser, async (tx) => {
      const entries = await this.loadEntries(
        tx,
        eq(medicalFiles.patientId, targetPatientId),
      )
      // Which entries were shown, by id: "who saw what" is answerable later
      // even after more entries are added.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MEDICAL_FILE_VIEWED',
        targetUserId: targetPatientId,
        entityType: 'medical_files',
        details: { entryIds: entries.map((entry) => entry.id) },
      })
      return entries
    })
  }

  // --- GET /medical-files/:id ---

  // One entry. Row security alone decides: an entry the caller may not see
  // is answered exactly like one that doesn't exist (404) — whether a
  // patient HAS an entry with this id is itself clinical information.
  async findOne(
    id: number,
    currentUser: CurrentUser,
  ): Promise<MedicalFileEntry> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [entry] = await this.loadEntries(tx, eq(medicalFiles.id, id))
      if (!entry) {
        throw new NotFoundException(entryNotFoundMessage(id))
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'MEDICAL_FILE_ENTRY_VIEWED',
        targetUserId: entry.patientId,
        entityType: 'medical_files',
        entityId: entry.id,
      })
      return entry
    })
  }

  // === HELPERS ============================================================

  // Whose file a list request is for — or why it's refused. Runs on the
  // normal connection (no row security needed: it reads the care team).
  private async resolveListTarget(
    currentUser: CurrentUser,
    patientId: number | undefined,
  ): Promise<number> {
    if (currentUser.activeRole === UserRole.PATIENT) {
      if (patientId !== undefined && patientId !== currentUser.id) {
        throw new ForbiddenException(OWN_FILE_ONLY_MESSAGE)
      }
      return currentUser.id
    }
    if (patientId === undefined) {
      throw new BadRequestException(PATIENT_ID_REQUIRED_MESSAGE)
    }
    if (
      !(await this.usersService.isPatientManagedBy(patientId, currentUser.id))
    ) {
      throw new ForbiddenException(NOT_ON_CARE_TEAM_READ_MESSAGE)
    }
    return patientId
  }

  // The entries matching `where`, in the API's shape, newest first (the id
  // breaks a tie between two entries of the same instant). One query
  // whatever the count:
  //   - JOIN users for the author's name (three columns, see the type);
  //   - LEFT JOIN the table on ITSELF for "is this entry amended, and by
  //     which one?". `alias()` gives the second copy its own name
  //     (`amendment`) — without it, the two copies of medical_files in one
  //     query couldn't be told apart. LEFT: most entries have no amendment
  //     (the columns come back NULL). The unique index guarantees at most
  //     one match, so no row is ever doubled.
  // Under the caller's row security, both copies are filtered: an amendment
  // is always of the same patient (the foreign key), so whoever sees an
  // entry sees its amendment.
  private async loadEntries(
    tx: DrizzleDb,
    where: SQL,
  ): Promise<MedicalFileEntry[]> {
    const amendment = alias(medicalFiles, 'amendment')
    const rows = await tx
      .select({
        entry: medicalFiles,
        author: {
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
        },
        amendedById: amendment.id,
      })
      .from(medicalFiles)
      .innerJoin(users, eq(users.id, medicalFiles.createdBy))
      .leftJoin(amendment, eq(amendment.amendsId, medicalFiles.id))
      .where(where)
      .orderBy(desc(medicalFiles.createdAt), desc(medicalFiles.id))

    return rows.map(({ entry, author, amendedById }) => ({
      id: entry.id,
      patientId: entry.patientId,
      entryType: entry.entryType,
      subjective: entry.subjective,
      objective: entry.objective,
      assessment: entry.assessment,
      plan: entry.plan,
      createdAt: entry.createdAt,
      author,
      amendsId: entry.amendsId,
      amendmentReason: entry.amendmentReason,
      amendedById,
    }))
  }
}

// --- ERROR TRANSLATION -------------------------------------------------------------------------------------

// The database's refusals of an INSERT, as the API's answers. Anything else
// is a real failure and goes on unchanged (a 500 through the filter).
// Exported for the unit test.
export function translateInsertError(error: unknown): unknown {
  // The INSERT policy. The role guard let only practitioners through and
  // created_by is the caller (set above), so the one reason left is the
  // care team.
  if (isRowSecurityViolation(error)) {
    return new ForbiddenException(NOT_ON_CARE_TEAM_WRITE_MESSAGE)
  }
  if (isCheckViolation(error, MEDICAL_FILES_HAS_CONTENT)) {
    return new BadRequestException(NO_SECTION_MESSAGE)
  }
  if (
    isForeignKeyViolation(error, MEDICAL_FILES_AMENDS_SAME_PATIENT_FK) ||
    isCheckViolation(error, MEDICAL_FILES_NOT_SELF_AMENDING)
  ) {
    return new BadRequestException(AMENDS_UNKNOWN_ENTRY_MESSAGE)
  }
  if (isUniqueViolation(error, MEDICAL_FILES_ONE_AMENDMENT_PER_ENTRY)) {
    return new ConflictException(ALREADY_AMENDED_MESSAGE)
  }
  return error
}
