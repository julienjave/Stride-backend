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
import { asc, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { romAssessments, romMeasurements, users } from '../database/schema'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import { withRlsContext } from '../database/rls-context'
import {
  ROM_ASSESSMENTS_AMENDS_SAME_PATIENT_FK,
  ROM_ASSESSMENTS_MEASURED_BY_RECORDING,
  ROM_ASSESSMENTS_NOTE_SAME_PATIENT_FK,
  ROM_ASSESSMENTS_NOT_SELF_AMENDING,
  ROM_ASSESSMENTS_ONE_AMENDMENT,
  ROM_MEASUREMENTS_ONE_VALUE_PER_KIND,
  isCheckViolation,
  isForeignKeyViolation,
  isRowSecurityViolation,
  isUniqueViolation,
} from '../database/pg-errors'
import { CreateRomAssessmentDto } from './dto/create-rom-assessment.dto'
import type { RomMode, RomMovement, RomSide } from './movement-catalogue'
import {
  ALREADY_AMENDED_MESSAGE,
  AMENDS_UNKNOWN_ASSESSMENT_MESSAGE,
  DUPLICATE_MEASUREMENT_MESSAGE,
  FUTURE_DATE_MESSAGE,
  NOTE_UNKNOWN_MESSAGE,
  NOT_ON_CARE_TEAM_READ_MESSAGE,
  NOT_ON_CARE_TEAM_WRITE_MESSAGE,
  OWN_RECORD_ONLY_MESSAGE,
  PATIENT_ID_REQUIRED_MESSAGE,
  assessmentNotFoundMessage,
} from './range-of-motion-rules'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

export interface RomMeasurement {
  id: number
  movement: RomMovement
  side: RomSide | null
  mode: RomMode
  degrees: number
  note: string | null
}

// One assessment as the API answers it — for the practitioner and the
// patient alike (the patient's own record: HIPAA's right of access). The
// medical file entry's shape, with the assessment's own fields:
//   - measuredOn: the clinical day ('YYYY-MM-DD'); createdAt: when it was
//     recorded (the database's clock);
//   - medicalFileEntryId: the note of the same visit, or null — the id of
//     the VERSION linked when this was recorded (a screen follows that
//     note's amendments to its latest version);
//   - amendsId / amendmentReason / amendedById: the correction chain, as in
//     the medical file (amendedById worked out by the query);
//   - measurements: in the catalogue's order (the enum's), then side (left
//     before right), then active before passive — the order a clinician
//     reads them in, whatever order they were typed.
export interface RomAssessment {
  id: number
  patientId: number
  measuredOn: string
  createdAt: Date
  author: { id: number; firstName: string; lastName: string }
  medicalFileEntryId: number | null
  amendsId: number | null
  amendmentReason: string | null
  amendedById: number | null
  measurements: RomMeasurement[]
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// A patient's range-of-motion record (Phase 7, decided with the person
// 2026-10-31). The medical file's design, end to end:
//   - ROW SECURITY decides who reads and writes (0077): the patient reads
//     their own, the care team reads and records; admins neither (the role
//     guard answers 403, the policies hide every row anyway).
//   - APPEND-ONLY: no update and no delete, here or in the database; a
//     correction is an amendment. An assessment's measurements are written
//     in its own transaction and never after.
//   - AUDITED, READS INCLUDED: one entry per request, in its transaction.
@Injectable()
export class RangeOfMotionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES =============================================================

  // --- POST /range-of-motion ---

  // A new assessment, or an amendment. Like the medical file's create, NO
  // pre-check of the care team: the INSERT policy decides, at the moment of
  // writing (an ended link can't slip between a check and the insert). Every
  // refusal is the database's, translated (translateInsertError).
  //
  // ONE transaction for the assessment, its measurements and the audit
  // entry: the measurements' insert policy only accepts values for an
  // assessment written in the same transaction, and the deferred trigger
  // checks at COMMIT that it has at least one. Either all of it is recorded,
  // with its trail, or nothing is.
  async create(
    currentUser: CurrentUser,
    dto: CreateRomAssessmentDto,
  ): Promise<RomAssessment> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      let assessment: typeof romAssessments.$inferSelect
      try {
        // created_at isn't sent: the trigger (0077) writes now().
        ;[assessment] = await tx
          .insert(romAssessments)
          .values({
            patientId: dto.patientId,
            createdBy: currentUser.id,
            measuredOn: dto.measuredOn,
            medicalFileEntryId: dto.medicalFileEntryId ?? null,
            amendsId: dto.amendsId ?? null,
            amendmentReason: dto.amendmentReason ?? null,
          })
          .returning()
        // One INSERT for every value (a multi-row VALUES): one round trip,
        // and the unique index sees them all in one statement.
        await tx.insert(romMeasurements).values(
          dto.measurements.map((measurement) => ({
            assessmentId: assessment.id,
            movement: measurement.movement,
            side: measurement.side ?? null,
            mode: measurement.mode,
            degrees: measurement.degrees,
            note: measurement.note ?? null,
          })),
        )
      } catch (error) {
        throw translateInsertError(error)
      }

      // Points at the row; copies no value (the row IS the record and can't
      // change). How many measurements, so the trail says how big a record
      // was written without holding its clinical content.
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action:
          assessment.amendsId === null
            ? 'ROM_ASSESSMENT_RECORDED'
            : 'ROM_ASSESSMENT_AMENDED',
        targetUserId: assessment.patientId,
        entityType: 'rom_assessments',
        entityId: assessment.id,
        details: {
          measuredOn: assessment.measuredOn,
          createdAt: assessment.createdAt,
          measurementCount: dto.measurements.length,
          ...(assessment.medicalFileEntryId === null
            ? {}
            : { medicalFileEntryId: assessment.medicalFileEntryId }),
          ...(assessment.amendsId === null
            ? {}
            : { amendsId: assessment.amendsId }),
        },
      })

      const [loaded] = await loadRomAssessments(
        tx,
        eq(romAssessments.id, assessment.id),
      )
      return loaded
    })
  }

  // --- GET /range-of-motion ---

  // A patient's whole range-of-motion record. Who asks decides whose (the
  // medical file's rules): a patient their own; a practitioner the patient
  // they name, on their care team — a PRE-check here, so "you may not look"
  // is a 403 and not an empty list (which would say "no measurements").
  async findAll(
    currentUser: CurrentUser,
    patientId?: number,
  ): Promise<RomAssessment[]> {
    const targetPatientId = await this.resolveListTarget(currentUser, patientId)

    return withRlsContext(this.db, currentUser, async (tx) => {
      const assessments = await loadRomAssessments(
        tx,
        eq(romAssessments.patientId, targetPatientId),
      )
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ROM_VIEWED',
        targetUserId: targetPatientId,
        entityType: 'rom_assessments',
        details: { assessmentIds: assessments.map((one) => one.id) },
      })
      return assessments
    })
  }

  // --- GET /range-of-motion/:id ---

  // One assessment. Row security alone decides: one the caller may not see
  // is answered exactly like one that doesn't exist (404).
  async findOne(id: number, currentUser: CurrentUser): Promise<RomAssessment> {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [assessment] = await loadRomAssessments(
        tx,
        eq(romAssessments.id, id),
      )
      if (!assessment) {
        throw new NotFoundException(assessmentNotFoundMessage(id))
      }
      await this.auditService.logInTransaction(tx, {
        performedBy: currentUser.id,
        action: 'ROM_ASSESSMENT_VIEWED',
        targetUserId: assessment.patientId,
        entityType: 'rom_assessments',
        entityId: assessment.id,
      })
      return assessment
    })
  }

  // === HELPERS ============================================================

  private async resolveListTarget(
    currentUser: CurrentUser,
    patientId: number | undefined,
  ): Promise<number> {
    if (currentUser.activeRole === UserRole.PATIENT) {
      if (patientId !== undefined && patientId !== currentUser.id) {
        throw new ForbiddenException(OWN_RECORD_ONLY_MESSAGE)
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
}

// --- LOADING -----------------------------------------------------------------------------------------------

// The assessments matching `where`, in the API's shape. A function, not a
// method, for the same reason as loadMedicalFileEntries: the records export
// reads the record with this same query, so the PDF and the screens can't
// disagree on what an assessment is. TWO queries whatever the count (never
// one per assessment):
//   1. the assessments, with the author's name (three columns of users) and
//      "amended by which one?" (the table joined to ITSELF, under the alias
//      `amendment` — the medical file's idiom);
//   2. every measurement of those assessments, grouped in memory.
// Newest first: by the clinical DAY, then by when it was recorded (two
// assessments of the same day — an amendment and its original — newest
// version first), then by id.
// Both queries run under the caller's row security: whoever may see an
// assessment sees its measurements (their policy reads the assessment's).
export async function loadRomAssessments(
  tx: DrizzleDb,
  where: SQL,
): Promise<RomAssessment[]> {
  const amendment = alias(romAssessments, 'amendment')
  const rows = await tx
    .select({
      assessment: romAssessments,
      author: {
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      },
      amendedById: amendment.id,
    })
    .from(romAssessments)
    .innerJoin(users, eq(users.id, romAssessments.createdBy))
    .leftJoin(amendment, eq(amendment.amendsId, romAssessments.id))
    .where(where)
    .orderBy(
      desc(romAssessments.measuredOn),
      desc(romAssessments.createdAt),
      desc(romAssessments.id),
    )
  if (rows.length === 0) return []

  const measurementRows = await tx
    .select()
    .from(romMeasurements)
    .where(
      inArray(
        romMeasurements.assessmentId,
        rows.map(({ assessment }) => assessment.id),
      ),
    )
    // An enum sorts in its DECLARED order (the catalogue's), not
    // alphabetically — so this is the examination order: the movement, then
    // left before right, then active before passive. (A NULL side never
    // meets a non-NULL one: a movement has a side always or never — the
    // CHECK rom_measurements_side_matches_movement — so where NULLs sort
    // can't matter, and isn't said.)
    .orderBy(
      asc(romMeasurements.movement),
      asc(romMeasurements.side),
      asc(romMeasurements.mode),
      asc(romMeasurements.id),
    )

  const byAssessment = new Map<number, RomMeasurement[]>()
  for (const { assessmentId, ...measurement } of measurementRows) {
    const list = byAssessment.get(assessmentId)
    if (list) list.push(measurement)
    else byAssessment.set(assessmentId, [measurement])
  }

  return rows.map(({ assessment, author, amendedById }) => ({
    id: assessment.id,
    patientId: assessment.patientId,
    measuredOn: assessment.measuredOn,
    createdAt: assessment.createdAt,
    author,
    medicalFileEntryId: assessment.medicalFileEntryId,
    amendsId: assessment.amendsId,
    amendmentReason: assessment.amendmentReason,
    amendedById,
    measurements: byAssessment.get(assessment.id) ?? [],
  }))
}

// --- ERROR TRANSLATION -------------------------------------------------------------------------------------

// The database's refusals of the two INSERTs, as the API's answers.
// Anything else is a real failure and goes on unchanged (a 500): the DTO
// already refused what the side, degrees and note CHECKs would — reaching
// one of those is a bug to see, not a request to answer. Exported for the
// unit test.
export function translateInsertError(error: unknown): unknown {
  // The assessment's INSERT policy (the care team). The measurements'
  // policy can't refuse a request that got this far (same transaction, same
  // author), so this is always the care team.
  if (isRowSecurityViolation(error)) {
    return new ForbiddenException(NOT_ON_CARE_TEAM_WRITE_MESSAGE)
  }
  if (isCheckViolation(error, ROM_ASSESSMENTS_MEASURED_BY_RECORDING)) {
    return new BadRequestException(FUTURE_DATE_MESSAGE)
  }
  if (
    isForeignKeyViolation(error, ROM_ASSESSMENTS_AMENDS_SAME_PATIENT_FK) ||
    isCheckViolation(error, ROM_ASSESSMENTS_NOT_SELF_AMENDING)
  ) {
    return new BadRequestException(AMENDS_UNKNOWN_ASSESSMENT_MESSAGE)
  }
  if (isUniqueViolation(error, ROM_ASSESSMENTS_ONE_AMENDMENT)) {
    return new ConflictException(ALREADY_AMENDED_MESSAGE)
  }
  if (isForeignKeyViolation(error, ROM_ASSESSMENTS_NOTE_SAME_PATIENT_FK)) {
    return new BadRequestException(NOTE_UNKNOWN_MESSAGE)
  }
  if (isUniqueViolation(error, ROM_MEASUREMENTS_ONE_VALUE_PER_KIND)) {
    return new BadRequestException(DUPLICATE_MEASUREMENT_MESSAGE)
  }
  return error
}
