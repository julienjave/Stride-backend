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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  sessions,
  sessionExercises,
  assignedPrograms,
  assignedProgramExercises,
} from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateSessionDto } from './dto/create-session.dto'
import { UpdateSessionDto, SessionStatus } from './dto/update-session.dto'
import { UpdateSessionExerciseDto } from './dto/update-session-exercise.dto'
import { UserRole } from '../users/dto/create-user.dto'

// --- SERVICE ------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(currentUser: CurrentUser, dto: CreateSessionDto) {
    const program = await this.db.query.assignedPrograms.findFirst({
      where: eq(assignedPrograms.id, dto.assignedProgramId),
    })
    if (!program) {
      throw new NotFoundException(
        `Assigned program ${dto.assignedProgramId} not found`,
      )
    }
    // Self only — no clinic-scoping here at all, unlike practitioner
    // management elsewhere. A patient can only ever start a session for
    // THEIR OWN assigned program.
    if (program.patientId !== currentUser.id) {
      throw new ForbiddenException(
        'You can only create sessions for your own assigned programs',
      )
    }

    const sessionId = await this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          assignedProgramId: dto.assignedProgramId,
          patientId: currentUser.id,
          scheduledDate: dto.scheduledDate
            ? new Date(dto.scheduledDate)
            : new Date(),
          status: 'pending',
        })
        .returning()

      // Pre-populates today's checklist from the program's CURRENT
      // prescribed exercises — each row REFERENCES its
      // assignedProgramExerciseId, it doesn't duplicate sets/reps. The
      // prescription lives on the assigned program; this just tracks
      // actual performance against it.
      const programExerciseRows =
        await tx.query.assignedProgramExercises.findMany({
          where: eq(
            assignedProgramExercises.assignedProgramId,
            dto.assignedProgramId,
          ),
          orderBy: (row, { asc }) => [asc(row.sortOrder)],
        })

      for (const pe of programExerciseRows) {
        await tx.insert(sessionExercises).values({
          sessionId: session.id,
          assignedProgramExerciseId: pe.id,
          completed: false,
          sortOrder: pe.sortOrder,
        })
      }

      return session.id
    })

    return this.findSessionWithExercises(sessionId)
  }

  // --- GET ROUTES ---

  async findAllForCurrentUser(currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) {
      return this.db.query.sessions.findMany()
    }
    if (currentUser.activeRole === UserRole.PATIENT) {
      return this.db.query.sessions.findMany({
        where: eq(sessions.patientId, currentUser.id),
      })
    }
    const managedPatients = await this.usersService.findPatientsForPractitioner(
      currentUser.id,
    )
    const patientIds = managedPatients.map((p) => p.id)
    if (patientIds.length === 0) {
      return []
    }
    return this.db.query.sessions.findMany({
      where: inArray(sessions.patientId, patientIds),
    })
  }

  async findOne(id: number, currentUser: CurrentUser) {
    const session = await this.findSessionOrThrow(id)
    await this.assertCanView(session.patientId, currentUser)
    return this.findSessionWithExercises(id)
  }

  // --- PATCH ROUTES ---

  // Server sets startedAt/completedAt itself, based on the status
  // transition — never trusts a client-supplied timestamp for either,
  // matching the same "timestamps are authoritative, server-set" rule
  // applied to created_at/sent_at everywhere else in this schema.
  async update(id: number, currentUser: CurrentUser, dto: UpdateSessionDto) {
    const session = await this.findSessionOrThrow(id)
    this.assertIsOwner(session, currentUser)

    const updates: Record<string, unknown> = { ...dto }
    if (dto.status === SessionStatus.IN_PROGRESS && !session.startedAt) {
      updates.startedAt = new Date()
    }
    if (dto.status === SessionStatus.COMPLETED) {
      updates.completedAt = new Date()
    }

    const [updated] = await this.db
      .update(sessions)
      .set(updates)
      .where(eq(sessions.id, id))
      .returning()
    return updated
  }

  async updateExercise(
    sessionId: number,
    rowId: number,
    currentUser: CurrentUser,
    dto: UpdateSessionExerciseDto,
  ) {
    const session = await this.findSessionOrThrow(sessionId)
    this.assertIsOwner(session, currentUser)
    await this.findSessionExerciseOrThrow(sessionId, rowId)

    const [updated] = await this.db
      .update(sessionExercises)
      .set(dto)
      .where(eq(sessionExercises.id, rowId))
      .returning()
    return updated
  }

  // === HELPER FUNCTIONS =====================================================

  private async findSessionWithExercises(id: number) {
    const session = await this.findSessionOrThrow(id)
    const exerciseRows = await this.db.query.sessionExercises.findMany({
      where: eq(sessionExercises.sessionId, id),
      orderBy: (row, { asc }) => [asc(row.sortOrder)],
    })
    return { ...session, exercises: exerciseRows }
  }

  private async findSessionOrThrow(id: number) {
    const session = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    })
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`)
    }
    return session
  }

  private async findSessionExerciseOrThrow(sessionId: number, rowId: number) {
    const row = await this.db.query.sessionExercises.findFirst({
      where: and(
        eq(sessionExercises.id, rowId),
        eq(sessionExercises.sessionId, sessionId),
      ),
    })
    if (!row) {
      throw new NotFoundException(`Exercise ${rowId} not found in this session`)
    }
    return row
  }

  private async assertCanView(patientId: number, currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) return
    if (
      currentUser.activeRole === UserRole.PATIENT &&
      patientId === currentUser.id
    )
      return
    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      const managed = await this.usersService.isPatientManagedBy(
        patientId,
        currentUser.id,
      )
      if (managed) return
    }
    throw new ForbiddenException(
      'You do not have permission to view this session',
    )
  }

  // No practitioner/admin branch at all — sessions are patient-only to
  // modify, full stop. Practitioners and admins get read access via
  // assertCanView, never write access via this check.
  private assertIsOwner(
    session: typeof sessions.$inferSelect,
    currentUser: CurrentUser,
  ) {
    if (
      currentUser.activeRole !== UserRole.PATIENT ||
      session.patientId !== currentUser.id
    ) {
      throw new ForbiddenException('You can only modify your own sessions')
    }
  }
}
