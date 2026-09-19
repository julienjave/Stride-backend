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
} from "@nestjs/common";
import { and, eq, count, ilike, or, sql, inArray } from "drizzle-orm";
import { DRIZZLE, type DrizzleDb } from "../database/drizzle.provider";
import { exercises, users } from "../database/schema";
import { CreateExerciseDto } from "./dto/create-exercise.dto";
import { UpdateExerciseDto } from "./dto/update-exercise.dto";
import { FindExercisesQueryDto } from "./dto/find-exercises-query.dto";
import { StorageService } from "../storage/storage.service";
import { extensionForMimeType } from "../common/config/image-upload.config";
import { UserRole } from "../users/dto/create-user.dto";
import { withRlsContext } from "../database/rls-context";

// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole };

@Injectable()
export class ExercisesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly storageService: StorageService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(currentUser: CurrentUser, dto: CreateExerciseDto) {
    const [exercise] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .insert(exercises)
        .values({
          name: dto.name,
          primaryMuscles: dto.primaryMuscles,
          secondaryMuscles: dto.secondaryMuscles ?? [],
          equipment: dto.equipment ?? [],
          instructions: dto.instructions,
          mediaUrls: [],
          source: "custom",
          createdBy: currentUser.id,
        })
        .returning(),
    );
    return this.withImages(exercise);
  }

  // Appends to the existing mediaUrls array rather than replacing it.
  // Seeded exercises often have multiple genuinely distinct images (e.g. a
  // movement's start and end position) — a full replace would silently
  // delete those too. Removing a specific unwanted image is its own
  // deliberate action (removeImage, below), not an implicit side effect of
  // uploading something new.
  async addImages(
    id: number,
    currentUser: CurrentUser,
    files: Express.Multer.File[],
  ) {
    const exercise = await this.findOne(id);
    this.assertCanModify(exercise, currentUser);

    const newKeys: string[] = [];
    for (const [index, file] of files.entries()) {
      const objectKey = `exercises/${id}/upload-${Date.now()}-${index}.${extensionForMimeType(file.mimetype)}`;
      await this.storageService.upload(objectKey, file.buffer, file.mimetype);
      newKeys.push(objectKey);
    }

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(exercises)
        .set({ mediaUrls: [...exercise.mediaUrls, ...newKeys] })
        .where(eq(exercises.id, id))
        .returning(),
    );
    return this.withImages(updated);
  }

  // --- GET ROUTES ---

  // Open to any authenticated user, regardless of role — there's no clinical
  // sensitivity in a general exercise library the way there is with medical
  // files, and patients need to see the full details of exercises assigned
  // to them, not just practitioners browsing to build a program.
  //
  // currentUserId is optional and only ever READ when query.mine is set —
  // every existing caller that never asks for "mine" continues to work
  // with no second argument at all. In practice the controller always has
  // a real currentUser to pass (SessionAuthGuard guarantees one for every
  // route on this controller), so this is a defensive allowance for
  // callers that don't care about the mine filter, not a real gap.
  async findAll(query: FindExercisesQueryDto, currentUserId?: number) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    // Built as an array of conditions and combined with and(...spread)
    // rather than nested ternaries, now that there are THREE independent,
    // each-optional pieces (archived, search, mine) instead of the
    // original two — nesting ternaries for three independent toggles
    // gets hard to read fast, where an array read top-to-bottom stays
    // clear as more conditions are added later.
    const conditions = [eq(exercises.isArchived, false)];

    if (query.search) {
      const term = `%${query.search}%`;
      // Matches the exercise's name OR either muscle array. Arrays can't
      // use ilike() directly — a text[] column has no single string to
      // pattern-match against — so each muscle condition is a raw SQL
      // EXISTS/unnest: "is there at least one element in this array that
      // ILIKEs the term." unnest() expands the array into one row per
      // element, exactly what EXISTS needs to test each one individually.
      // Deliberately NOT array_to_string(muscles, ' ') ILIKE term — that
      // would risk a false match spanning the boundary between two
      // elements (e.g. ['Quad', 'riceps'] joining into "Quad riceps" and
      // matching a search for "adri"), which per-element EXISTS can't do.
      conditions.push(
        or(
          ilike(exercises.name, term),
          sql`EXISTS (SELECT 1 FROM unnest(${exercises.primaryMuscles}) AS muscle WHERE muscle ILIKE ${term})`,
          sql`EXISTS (SELECT 1 FROM unnest(${exercises.secondaryMuscles}) AS muscle WHERE muscle ILIKE ${term})`,
        )!,
      );
    }

    if (query.mine && currentUserId != null) {
      conditions.push(eq(exercises.createdBy, currentUserId));
    }

    const whereClause = and(...conditions);

    // Run the page of rows and the total count as two separate, PARALLEL
    // queries (Promise.all) rather than sequentially — no reason to wait on
    // one before starting the other, since neither depends on the other's
    // result. The total is what lets a client compute totalPages/know
    // whether there's a next page at all, which the rows alone can't tell it.
    const [rows, [{ total }]] = await Promise.all([
      this.db.query.exercises.findMany({ where: whereClause, limit, offset }),
      this.db.select({ total: count() }).from(exercises).where(whereClause),
    ]);

    // Author names are attached via a SEPARATE batched lookup, not a join
    // on the query above — same "fetch base rows, then batch-fetch related
    // data and merge in JS" shape UsersService/ClinicsService already use
    // for roles/clinic memberships elsewhere in this codebase, rather than
    // introducing Drizzle's relational query API (`with: {...}`), which
    // isn't used anywhere else in this schema. A LEFT JOIN directly on the
    // main query would also need to re-list every exercise column by hand
    // to avoid name collisions with users' own id/etc. columns — this
    // stays simpler and only runs at all when at least one returned
    // exercise actually has a creator to look up.
    const creatorIds = [
      ...new Set(
        rows
          .map((row) => row.createdBy)
          .filter((id): id is number => id != null),
      ),
    ];

    const authorsById = new Map<
      number,
      { firstName: string; lastName: string }
    >();
    if (creatorIds.length > 0) {
      const authors = await this.db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(inArray(users.id, creatorIds));
      for (const author of authors) {
        authorsById.set(author.id, {
          firstName: author.firstName,
          lastName: author.lastName,
        });
      }
    }

    return {
      data: rows.map((row) => ({
        ...row,
        author:
          row.createdBy != null
            ? (authorsById.get(row.createdBy) ?? null)
            : null,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: number) {
    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, id),
    });
    if (!exercise) {
      throw new NotFoundException(`Exercise ${id} not found`);
    }
    return exercise;
  }

  // The controller's GET /:id route calls THIS, not findOne directly —
  // findOne itself stays raw on purpose, since every mutation above
  // (addImages, reorderImages, removeImage) calls it internally to read
  // the CURRENT real object keys before acting on them. reorderImages in
  // particular compares the client's submitted keys directly against
  // exercise.mediaUrls — if findOne returned signed URLs instead of raw
  // keys, that comparison would never match anything, since the client
  // sends back raw keys, never URLs. So the conversion has to happen at
  // a layer ABOVE findOne, applied only to what actually goes back to a
  // client, never to what other methods use for their own internal logic.
  async findOneForDisplay(id: number) {
    return this.withImages(await this.findOne(id));
  }

  // --- PATCH ROUTES ---

  async update(id: number, currentUser: CurrentUser, dto: UpdateExerciseDto) {
    const exercise = await this.findOne(id);
    this.assertCanModify(exercise, currentUser);
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx.update(exercises).set(dto).where(eq(exercises.id, id)).returning(),
    );
    return this.withImages(updated);
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
    currentUser: CurrentUser,
    newOrder: string[],
  ) {
    const exercise = await this.findOne(id);
    this.assertCanModify(exercise, currentUser);

    const currentSet = new Set(exercise.mediaUrls);
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
      newOrder.every((key) => currentSet.has(key));

    if (!isSamePermutation) {
      throw new BadRequestException(
        "The new order must contain exactly the same images as the current gallery, just reordered",
      );
    }

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(exercises)
        .set({ mediaUrls: newOrder })
        .where(eq(exercises.id, id))
        .returning(),
    );
    return this.withImages(updated);
  }

  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: CurrentUser) {
    const exercise = await this.findOne(id);
    this.assertCanModify(exercise, currentUser);
    const [archived] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(exercises)
        .set({ isArchived: true })
        .where(eq(exercises.id, id))
        .returning(),
    );
    return this.withImages(archived);
  }

  // Validates the key actually belongs to THIS exercise before deleting anything
  async removeImage(id: number, currentUser: CurrentUser, objectKey: string) {
    const exercise = await this.findOne(id);
    this.assertCanModify(exercise, currentUser);

    if (!exercise.mediaUrls.includes(objectKey)) {
      throw new NotFoundException(
        "This image does not belong to this exercise",
      );
    }

    await this.storageService.delete(objectKey);

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(exercises)
        .set({
          mediaUrls: exercise.mediaUrls.filter((url) => url !== objectKey),
        })
        .where(eq(exercises.id, id))
        .returning(),
    );
    return this.withImages(updated);
  }

  // === HELPER FUNCTIONS =====================================================

  // A practitioner is restricted to their own custom exercises:
  // an admin can correct anything, including the shared api-sourced library.
  private assertCanModify(
    exercise: typeof exercises.$inferSelect,
    currentUser: CurrentUser,
  ) {
    const isAdmin = currentUser.activeRole === UserRole.ADMIN;
    const isOwner =
      exercise.source === "custom" && exercise.createdBy === currentUser.id;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException(
        "You can only modify custom exercises you created, unless you are an administrator",
      );
    }
  }

  // Replaces the raw mediaUrls: string[] column with images:
  // {objectKey, url}[] on any value handed back to a client — mirrors
  // ClinicsService's withLogoUrl, but pairing rather than replacing,
  // because unlike a clinic's single logoUrl, a client here needs BOTH
  // pieces per image: the url to actually display it, and the objectKey
  // to send back on a later reorder or delete request (those endpoints
  // take objectKey values, not URLs — a client that only ever saw signed
  // URLs would have no way to identify which image is which when asking
  // to remove or reorder one). Renamed from mediaUrls to images, not
  // just changed in place, so any code still expecting the old
  // string[] shape fails to compile instead of silently misbehaving.
  private async withImages(exercise: typeof exercises.$inferSelect) {
    const { mediaUrls, ...rest } = exercise;
    const images = await Promise.all(
      mediaUrls.map(async (objectKey) => ({
        objectKey,
        url: await this.storageService.getPresignedUrl(objectKey),
      })),
    );
    return { ...rest, images };
  }
}