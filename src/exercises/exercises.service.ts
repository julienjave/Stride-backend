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
import { and, eq, count, ilike } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { exercises } from '../database/schema'
import { CreateExerciseDto } from './dto/create-exercise.dto'
import { UpdateExerciseDto } from './dto/update-exercise.dto'
import { FindExercisesQueryDto } from './dto/find-exercises-query.dto'
import { StorageService } from '../storage/storage.service'
import { extensionForMimeType } from '../common/config/image-upload.config'
import { UserRole } from '../users/dto/create-user.dto'

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class ExercisesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly storageService: StorageService,
  ) {}

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

  // Appends to the existing mediaUrls array rather than replacing it.
  // Seeded exercises often have multiple genuinely distinct images (e.g. a
  // movement's start and end position) — a full replace would silently
  // delete those too. Removing a specific unwanted image is its own
  // deliberate action (removeImage, below), not an implicit side effect of
  // uploading something new.
  async addImages(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
    files: Express.Multer.File[],
  ) {
    const exercise = await this.findOne(id)
    this.assertCanModify(exercise, currentUser)

    const newKeys: string[] = []
    for (const [index, file] of files.entries()) {
      const objectKey = `exercises/${id}/upload-${Date.now()}-${index}.${extensionForMimeType(file.mimetype)}`
      await this.storageService.upload(objectKey, file.buffer, file.mimetype)
      newKeys.push(objectKey)
    }

    const [updated] = await this.db
      .update(exercises)
      .set({ mediaUrls: [...exercise.mediaUrls, ...newKeys] })
      .where(eq(exercises.id, id))
      .returning()
    return updated
  }

  // --- GET ROUTES ---

  // Open to any authenticated user, regardless of role — there's no clinical
  // sensitivity in a general exercise library the way there is with medical
  // files, and patients need to see the full details of exercises assigned
  // to them, not just practitioners browsing to build a program.
  async findAll(query: FindExercisesQueryDto) {
    const page = query.page ?? 1
    const limit = query.limit ?? 20
    const offset = (page - 1) * limit

    const whereClause = query.search
      ? and(
          eq(exercises.isArchived, false),
          ilike(exercises.name, `%${query.search}%`),
        )
      : eq(exercises.isArchived, false)

    // Run the page of rows and the total count as two separate, PARALLEL
    // queries (Promise.all) rather than sequentially — no reason to wait on
    // one before starting the other, since neither depends on the other's
    // result. The total is what lets a client compute totalPages/know
    // whether there's a next page at all, which the rows alone can't tell it.
    const [rows, [{ total }]] = await Promise.all([
      this.db.query.exercises.findMany({ where: whereClause, limit, offset }),
      this.db.select({ total: count() }).from(exercises).where(whereClause),
    ])

    return {
      data: rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
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

  async update(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
    dto: UpdateExerciseDto,
  ) {
    const exercise = await this.findOne(id)
    this.assertCanModify(exercise, currentUser)
    const [updated] = await this.db
      .update(exercises)
      .set(dto)
      .where(eq(exercises.id, id))
      .returning()
    return updated
  }

  // "Cover image" is deliberately not its own column — it's simply
  // mediaUrls[0], the first image in the array. That means reordering to
  // put a specific image first IS "setting it as the cover," with no
  // separate concept, endpoint, or schema field that could ever drift out
  // of sync with the array itself.
  //
  // Validates newOrder is an exact permutation of the current images — same
  // set of keys, just reordered — so this endpoint can't be used to sneak
  // in keys that were never uploaded, or silently drop ones that were.
  async reorderImages(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
    newOrder: string[],
  ) {
    const exercise = await this.findOne(id)
    this.assertCanModify(exercise, currentUser)

    const currentSet = new Set(exercise.mediaUrls)
    // Same fix as the two reorderExercises methods — a genuine permutation
    // check needs length + no-internal-duplicates + valid-membership
    // together. Here specifically, since mediaUrls gets OVERWRITTEN
    // directly with newOrder (not looped per-row like the two exercise
    // reorder methods), the old, incomplete check could let a client
    // submit an array with a duplicated image key padding it to the right
    // unique count — silently DROPPING a real image from the gallery
    // entirely, replaced by a duplicate of another, rather than just
    // producing a sortOrder gap.
    const isSamePermutation =
      newOrder.length === exercise.mediaUrls.length &&
      new Set(newOrder).size === newOrder.length &&
      newOrder.every((key) => currentSet.has(key))

    if (!isSamePermutation) {
      throw new BadRequestException(
        'The new order must contain exactly the same images as the current gallery, just reordered',
      )
    }

    const [updated] = await this.db
      .update(exercises)
      .set({ mediaUrls: newOrder })
      .where(eq(exercises.id, id))
      .returning()
    return updated
  }

  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: { id: number; activeRole: UserRole }) {
    const exercise = await this.findOne(id)
    this.assertCanModify(exercise, currentUser)
    const [archived] = await this.db
      .update(exercises)
      .set({ isArchived: true })
      .where(eq(exercises.id, id))
      .returning()
    return archived
  }

  // Validates the key actually belongs to THIS exercise before deleting anything
  async removeImage(
    id: number,
    currentUser: { id: number; activeRole: UserRole },
    objectKey: string,
  ) {
    const exercise = await this.findOne(id)
    this.assertCanModify(exercise, currentUser)

    if (!exercise.mediaUrls.includes(objectKey)) {
      throw new NotFoundException('This image does not belong to this exercise')
    }

    await this.storageService.delete(objectKey)

    const [updated] = await this.db
      .update(exercises)
      .set({ mediaUrls: exercise.mediaUrls.filter((url) => url !== objectKey) })
      .where(eq(exercises.id, id))
      .returning()
    return updated
  }

  // === HELPER FUNCTIONS =====================================================

  // A practitioner is restricted to their own custom exercises:
  // an admin can correct anything, including the shared api-sourced library.
  private assertCanModify(
    exercise: typeof exercises.$inferSelect,
    currentUser: { id: number; activeRole: UserRole },
  ) {
    const isAdmin = currentUser.activeRole === UserRole.ADMIN
    const isOwner =
      exercise.source === 'custom' && exercise.createdBy === currentUser.id
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException(
        'You can only modify custom exercises you created, unless you are an administrator',
      )
    }
  }
}
