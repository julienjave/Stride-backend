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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { medicalFiles } from '../database/schema'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { CreateMedicalFileDto } from './dto/create-medical-file.dto'

// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: string }

@Injectable()
export class MedicalFilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Practitioner-only at the controller level (authoring clinical content —
  // same reasoning as exercises/templates/assigned-programs creation).
  // Clinic-scoped here too: a practitioner may only add an entry for a
  // patient they actually manage.
  async create(currentUser: CurrentUser, dto: CreateMedicalFileDto) {
    const managed = await this.usersService.isPatientManagedBy(
      dto.patientId,
      currentUser.id,
    )
    if (!managed) {
      throw new ForbiddenException(
        'You can only create medical file entries for patients you manage',
      )
    }

    const [entry] = await this.db
      .insert(medicalFiles)
      .values({
        patientId: dto.patientId,
        createdBy: currentUser.id,
        clinicalData: dto.clinicalData,
      })
      .returning()

    await this.auditService.log({
      performedBy: currentUser.id,
      action: 'CREATE_MEDICAL_FILE',
      targetUserId: dto.patientId,
      entityType: 'medical_files',
      entityId: entry.id,
    })

    return entry
  }

  // --- GET ROUTES ---

  async findAll(currentUser: CurrentUser, patientId?: number) {
    let targetPatientId: number

    if (currentUser.activeRole === 'patient') {
      targetPatientId = currentUser.id
    } else {
      if (!patientId) {
        throw new BadRequestException('patientId is required')
      }
      if (currentUser.activeRole === 'practitioner') {
        const managed = await this.usersService.isPatientManagedBy(
          patientId,
          currentUser.id,
        )
        if (!managed) {
          throw new ForbiddenException(
            "You do not have permission to view this patient's medical file",
          )
        }
      }
      targetPatientId = patientId
    }

    const entries = await this.db.query.medicalFiles.findMany({
      where: eq(medicalFiles.patientId, targetPatientId),
      orderBy: (mf, { desc }) => [desc(mf.createdAt)],
    })

    // The first real use of targetUserId — logged for EVERY viewer,
    // including the patient viewing their own record. HIPAA's actual
    // concern with clinical records is as much about who VIEWED them as
    // who changed them, unlike every other resource in this app, where
    // only mutations get audited.
    await this.auditService.log({
      performedBy: currentUser.id,
      action: 'ACCESS_MEDICAL_FILE_LIST',
      targetUserId: targetPatientId,
      entityType: 'medical_files',
    })

    return entries
  }

  async findOne(id: number, currentUser: CurrentUser) {
    const entry = await this.db.query.medicalFiles.findFirst({
      where: eq(medicalFiles.id, id),
    })
    if (!entry) {
      throw new NotFoundException(`Medical file entry ${id} not found`)
    }

    const isSelf =
      currentUser.activeRole === 'patient' && entry.patientId === currentUser.id
    const isAdmin = currentUser.activeRole === 'admin'
    const isManaging =
      currentUser.activeRole === 'practitioner' &&
      (await this.usersService.isPatientManagedBy(
        entry.patientId,
        currentUser.id,
      ))

    if (!isSelf && !isAdmin && !isManaging) {
      throw new ForbiddenException(
        'You do not have permission to view this medical file entry',
      )
    }

    await this.auditService.log({
      performedBy: currentUser.id,
      action: 'ACCESS_MEDICAL_FILE',
      targetUserId: entry.patientId,
      entityType: 'medical_files',
      entityId: entry.id,
    })

    return entry
  }

  // Deliberately no update() or archive() method — see MedicalFilesModule
  // writeup for the reasoning: clinical entries are append-only. A
  // correction belongs as a new entry, not an edit to an existing one.
}
