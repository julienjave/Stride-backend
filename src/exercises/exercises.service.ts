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

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq, ilike } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { exercises } from '../database/schema'
import { CreateExerciseDto } from './dto/create-exercise.dto'
import { UpdateExerciseDto } from './dto/update-exercise.dto'


// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class ExercisesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(userId: number, dto: CreateExerciseDto) {
    const [exercise] = await this.db
      .insert(exercises)
      .values({
        name: dto.name,
        primaryMuscles: dto.primaryMuscles,
        secondaryMuscles: dto.secondaryMuscles ?? [],
        equipment: dto.equipment ?? [],
        instructions: dto.instructions,
        mediaUrls: [],
        source: 'custom',
        createdBy: userId,
      })
      .returning()
    return exercise
  }

  // --- GET ROUTES ---

  // Open to any authenticated user, regardless of role — there's no clinical
  // sensitivity in a general exercise library the way there is with medical
  // files, and patients need to see the full details of exercises assigned
  // to them, not just practitioners browsing to build a program.
  async findAll(search?: string) {
    return this.db.query.exercises.findMany({
      where: search
        ? and(eq(exercises.isArchived, false), ilike(exercises.name, `%${search}%`))
        : eq(exercises.isArchived, false),
    })
  }

  async findOne(id: number) {
    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, id),
    })
    if (!exercise) {
      throw new NotFoundException(`Exercise ${id} not found`)
    }
    return exercise
  }

  // --- PATCH ROUTES ---

  async update(id: number, userId: number, dto: UpdateExerciseDto) {
    const exercise = await this.findOne(id)
    this.assertOwnership(exercise, userId)
    const [updated] = await this.db
      .update(exercises)
      .set(dto)
      .where(eq(exercises.id, id))
      .returning()
    return updated
  }

  // --- DELETE ROUTES ---

  async archive(id: number, userId: number) {
    const exercise = await this.findOne(id)
    this.assertOwnership(exercise, userId)
    const [archived] = await this.db
      .update(exercises)
      .set({ isArchived: true })
      .where(eq(exercises.id, id))
      .returning()
    return archived
  }


  // === HELPER FUNCTIONS =====================================================

  // Only the practitioner who authored a custom exercise may edit or archive
  // it. Exercises seeded from the external dataset (source: 'api', createdBy:
  // null) can NEVER be edited through this service, by anyone — they're the
  // shared base library every practitioner draws from, not any individual's
  // content. This is exactly the resource-level check RolesGuard can't do —
  // it needs the actual row, which only exists once we've already fetched it.
  private assertOwnership(exercise: typeof exercises.$inferSelect, userId: number) {
    if (exercise.source !== 'custom' || exercise.createdBy !== userId) {
      throw new ForbiddenException('You can only modify custom exercises you created')
    }
  }
}