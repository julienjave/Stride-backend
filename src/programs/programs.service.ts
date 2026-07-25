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

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { programTemplates, templateExercises, exercises } from '../database/schema'
import { CreateTemplateDto } from './dto/create-template.dto'
import { UpdateTemplateDto } from './dto/update-template.dto'
import { AddTemplateExerciseDto } from './dto/add-template-exercise.dto'
import { UpdateTemplateExerciseDto } from './dto/update-template-exercise.dto'


// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class ProgramsService {
  // No ExercisesModule import needed here, deliberately — validating that
  // an exerciseId exists is just another query against the shared, global
  // DRIZZLE db, the same "no cross-module dependency for a shared table"
  // reasoning used for Clinics/Users.
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}


  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(practitionerId: number, dto: CreateTemplateDto) {
    const [template] = await this.db
      .insert(programTemplates)
      .values({ practitionerId, title: dto.title, description: dto.description })
      .returning()
    return template
  }

  async addExercise(
    templateId: number,
    currentUser: { id: number; activeRole: string },
    dto: AddTemplateExerciseDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId)
    this.assertCanModify(template, currentUser)

    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, dto.exerciseId),
    })
    if (!exercise) {
      throw new NotFoundException(`Exercise ${dto.exerciseId} not found`)
    }

    const [row] = await this.db
      .insert(templateExercises)
      .values({
        templateId,
        exerciseId: dto.exerciseId,
        sets: dto.sets,
        reps: dto.reps,
        durationInSeconds: dto.durationInSeconds,
        sortOrder: dto.sortOrder,
        notes: dto.notes,
      })
      .returning()
    return row
  }

  async reorderExercises(
    templateId: number,
    currentUser: { id: number; activeRole: string },
    newOrder: number[],
  ) {
    const template = await this.findTemplateOrThrow(templateId)
    this.assertCanModify(template, currentUser)

    const currentRows = await this.db.query.templateExercises.findMany({
      where: eq(templateExercises.templateId, templateId),
    })
    const currentIds = new Set(currentRows.map((r) => r.id))
    const newIds = new Set(newOrder)
    const isSamePermutation =
      currentIds.size === newIds.size && [...currentIds].every((rowId) => newIds.has(rowId))

    if (!isSamePermutation) {
      throw new BadRequestException(
        'The new order must contain exactly the exercises currently in this template, just reordered',
      )
    }

    // A transaction — a reorder is meant to be all-or-nothing. If one row's
    // update failed partway through a plain loop, the template would be
    // left with an inconsistent, partially-reordered sortOrder sequence.
    await this.db.transaction(async (tx) => {
      for (const [index, templateExerciseId] of newOrder.entries()) {
        await tx
          .update(templateExercises)
          .set({ sortOrder: index })
          .where(eq(templateExercises.id, templateExerciseId))
      }
    })

    return this.findOne(templateId)
  }


  // --- GET ROUTES ---

  // Visible to any authenticated user, same as exercises — a preset library
  // is more useful shared across the practice than hidden per-practitioner,
  // while remaining editable only by its owner (or an admin), matching
  // exactly how the exercise library itself works.
  async findAll() {
    return this.db.query.programTemplates.findMany({
      where: eq(programTemplates.isArchived, false),
    })
  }

  async findOne(id: number) {
    const template = await this.findTemplateOrThrow(id);
    const exerciseRows = await this.db.query.templateExercises.findMany({
      where: eq(templateExercises.templateId, id),
      orderBy: (te, { asc: ascend }) => [ascend(te.sortOrder)],
    })
    return { ...template, exercises: exerciseRows }
  }


  // --- PATCH ROUTES ---

  async update(id: number, currentUser: { id: number; activeRole: string }, dto: UpdateTemplateDto) {
    const template = await this.findTemplateOrThrow(id)
    this.assertCanModify(template, currentUser)
    const [updated] = await this.db
      .update(programTemplates)
      .set(dto)
      .where(eq(programTemplates.id, id))
      .returning()
    return updated
  }

  async updateExercise(
    templateId: number,
    templateExerciseId: number,
    currentUser: { id: number; activeRole: string },
    dto: UpdateTemplateExerciseDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId)
    this.assertCanModify(template, currentUser)
    await this.findTemplateExerciseOrThrow(templateId, templateExerciseId)

    const [updated] = await this.db
      .update(templateExercises)
      .set(dto)
      .where(eq(templateExercises.id, templateExerciseId))
      .returning()
    return updated
  }


  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: { id: number; activeRole: string }) {
    const template = await this.findTemplateOrThrow(id)
    this.assertCanModify(template, currentUser)
    const [archived] = await this.db
      .update(programTemplates)
      .set({ isArchived: true })
      .where(eq(programTemplates.id, id))
      .returning()
    return archived
  }

  async removeExercise(
    templateId: number,
    templateExerciseId: number,
    currentUser: { id: number; activeRole: string },
  ) {
    const template = await this.findTemplateOrThrow(templateId)
    this.assertCanModify(template, currentUser);
    await this.findTemplateExerciseOrThrow(templateId, templateExerciseId)

    await this.db.delete(templateExercises).where(eq(templateExercises.id, templateExerciseId))
  }


  // === HELPER FUNCTIONS =================================================================

  private async findTemplateOrThrow(id: number) {
    const template = await this.db.query.programTemplates.findFirst({
      where: eq(programTemplates.id, id),
    })
    if (!template) {
      throw new NotFoundException(`Program template ${id} not found`)
    }
    return template
  }

  // Confirms a template_exercises row genuinely belongs to the template in
  // the URL — the same IDOR-shaped check as removeImage validating an
  // object key actually belongs to the exercise being modified. Without
  // this, a valid row id from a DIFFERENT template (which its owner has
  // every right to modify on ITS OWN template) could be edited through
  // this template's URL instead.
  private async findTemplateExerciseOrThrow(templateId: number, templateExerciseId: number) {
    const row = await this.db.query.templateExercises.findFirst({
      where: and(
        eq(templateExercises.id, templateExerciseId),
        eq(templateExercises.templateId, templateId),
      ),
    })
    if (!row) {
      throw new NotFoundException(`Exercise ${templateExerciseId} not found in this template`)
    }
    return row
  }

  private assertCanModify(
    template: typeof programTemplates.$inferSelect,
    currentUser: { id: number; activeRole: string },
  ) {
    const isAdmin = currentUser.activeRole === 'admin'
    const isOwner = template.practitionerId === currentUser.id
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException(
        'You can only modify program templates you created, unless you are an administrator',
      )
    }
  }
}