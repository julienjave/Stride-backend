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
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE, type DrizzleDb } from "../database/drizzle.provider";
import {
  programTemplates,
  templateExercises,
  exercises,
} from "../database/schema";
import { CreateTemplateDto } from "./dto/create-template.dto";
import { UpdateTemplateDto } from "./dto/update-template.dto";
import { AddTemplateExerciseDto } from "./dto/add-template-exercise.dto";
import { UpdateTemplateExerciseDto } from "./dto/update-template-exercise.dto";
import { UserRole } from "../users/dto/create-user.dto";
import { withRlsContext } from "../database/rls-context";

// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole };

@Injectable()
export class ProgramsService {
  // No ExercisesModule import needed here, deliberately — validating that
  // an exerciseId exists is just another query against the shared, global
  // DRIZZLE db, the same "no cross-module dependency for a shared table"
  // reasoning used for Clinics/Users.
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async create(currentUser: CurrentUser, dto: CreateTemplateDto) {
    const [template] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .insert(programTemplates)
        .values({
          practitionerId: currentUser.id,
          title: dto.title,
          description: dto.description,
        })
        .returning(),
    );
    return template;
  }

  async addExercise(
    templateId: number,
    currentUser: CurrentUser,
    dto: AddTemplateExerciseDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);

    // exercises' SELECT policy is USING (true) — unconditional, no
    // session setting involved — so this existence check stays on the
    // plain connection, same as findTemplateOrThrow below.
    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, dto.exerciseId),
    });
    if (!exercise) {
      throw new NotFoundException(`Exercise ${dto.exerciseId} not found`);
    }

    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .insert(templateExercises)
        .values({
          templateId,
          exerciseId: dto.exerciseId,
          sets: dto.sets,
          reps: dto.reps,
          durationInSeconds: dto.durationInSeconds,
          weight: dto.weight,
          weightUnit: dto.weightUnit,
          sortOrder: dto.sortOrder,
          notes: dto.notes,
        })
        .returning(),
    );
    // Returns the FULL enriched template, not just the one inserted row
    // — matches reorderExercises' own existing convention (see its
    // final line), and gives the frontend everything it needs to
    // re-render the whole card list after adding one, not just the new
    // card in isolation.
    return this.findOne(templateId);
  }

  async reorderExercises(
    templateId: number,
    currentUser: CurrentUser,
    newOrder: number[],
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);

    // Read, permutation-check, and write all happen inside ONE transaction
    // (tx.query instead of this.db.query) — this used to read currentRows
    // via a separate, already-committed round trip and only open the write
    // transaction afterwards, leaving a window where a concurrent
    // addExercise/removeExercise could land: the update loop would then
    // silently no-op on a since-deleted id, or leave a since-added row's
    // sortOrder untouched. Folding the read into the same transaction as
    // the write closes that specific "separate transaction" gap.
    //
    // This narrows the race rather than closing it outright: Postgres's
    // default READ COMMITTED isolation still lets each statement inside a
    // transaction see newly-committed data, so a concurrent write between
    // this SELECT and the UPDATE loop below is still theoretically
    // possible. Fully closing that would need row locking (SELECT ... FOR
    // UPDATE — not used anywhere else in this codebase) or SERIALIZABLE
    // isolation with retry-on-conflict logic, neither justified here: the
    // actual failure mode, even in the worst case, is a harmless sortOrder
    // inconsistency (a stale row keeping its old value, or two rows
    // sharing one), never a privilege or data-boundary violation — and the
    // response below already reflects genuine post-write state (re-read
    // from the DB, not echoed back from the request), so a caller can
    // never be misled about what actually happened.
    // withRlsContext() supplies this same transaction, scoped to
    // currentUser, rather than a separate set_config step around a plain
    // this.db.transaction(...) — same swap as
    // AssignedProgramsService.reorderExercises.
    await withRlsContext(this.db, currentUser, async (tx) => {
      const currentRows = await tx.query.templateExercises.findMany({
        where: eq(templateExercises.templateId, templateId),
      });
      const currentIds = new Set(currentRows.map((r) => r.id));
      // A genuine permutation check needs THREE conditions together — the
      // previous version only compared deduplicated Set sizes, which a
      // client could satisfy by submitting a newOrder array containing a
      // DUPLICATE id (padding it to the right unique count) while silently
      // OMITTING a real exercise entirely. That array would pass the old
      // check, then get looped over directly below using its RAW length —
      // the duplicated id's later occurrence would silently overwrite its
      // own earlier sortOrder update, leaving a genuine gap in the final
      // sequence (e.g. sortOrder 1,2,3 with 0 never actually applied to any
      // row) while the omitted exercise's real sortOrder went untouched.
      const isSamePermutation =
        newOrder.length === currentRows.length &&
        new Set(newOrder).size === newOrder.length &&
        newOrder.every((id) => currentIds.has(id));

      if (!isSamePermutation) {
        throw new BadRequestException(
          "The new order must contain exactly the exercises currently in this template, just reordered",
        );
      }

      for (const [index, templateExerciseId] of newOrder.entries()) {
        await tx
          .update(templateExercises)
          .set({ sortOrder: index })
          .where(eq(templateExercises.id, templateExerciseId));
      }
    });

    return this.findOne(templateId);
  }

  // --- GET ROUTES ---

  // Visible to any authenticated user, same as exercises — a preset library
  // is more useful shared across the practice than hidden per-practitioner,
  // while remaining editable only by its owner (or an admin), matching
  // exactly how the exercise library itself works.
  async findAll() {
    return this.db.query.programTemplates.findMany({
      where: eq(programTemplates.isArchived, false),
    });
  }

  async findOne(id: number) {
    const template = await this.findTemplateOrThrow(id);
    const exerciseRows = await this.db.query.templateExercises.findMany({
      where: eq(templateExercises.templateId, id),
      orderBy: (te, { asc: ascend }) => [ascend(te.sortOrder)],
    });
    return {
      ...template,
      exercises: await this.withExerciseDetails(exerciseRows),
    };
  }

  // --- PATCH ROUTES ---

  async update(id: number, currentUser: CurrentUser, dto: UpdateTemplateDto) {
    const template = await this.findTemplateOrThrow(id);
    this.assertCanModify(template, currentUser);
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(programTemplates)
        .set(dto)
        .where(eq(programTemplates.id, id))
        .returning(),
    );
    return updated;
  }

  async updateExercise(
    templateId: number,
    templateExerciseId: number,
    currentUser: CurrentUser,
    dto: UpdateTemplateExerciseDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    await this.findTemplateExerciseOrThrow(templateId, templateExerciseId);

    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(templateExercises)
        .set(dto)
        .where(eq(templateExercises.id, templateExerciseId))
        .returning(),
    );
    // Returns the FULL enriched template, not just the bare updated row
    // — matches addExercise/removeExercise/reorderExercises' own
    // convention (see addExercise's comment for the original reasoning).
    // This one was missed when that consistency was established
    // elsewhere on this controller, since nothing on the frontend called
    // this specific endpoint yet — the gap only became visible once the
    // View/Edit screen actually needed the exercise's name/muscles/
    // photos back in the response after a save.
    return this.findOne(templateId);
  }

  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: CurrentUser) {
    const template = await this.findTemplateOrThrow(id);
    this.assertCanModify(template, currentUser);
    const [archived] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(programTemplates)
        .set({ isArchived: true })
        .where(eq(programTemplates.id, id))
        .returning(),
    );
    return archived;
  }

  async removeExercise(
    templateId: number,
    templateExerciseId: number,
    currentUser: CurrentUser,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    await this.findTemplateExerciseOrThrow(templateId, templateExerciseId);

    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .delete(templateExercises)
        .where(eq(templateExercises.id, templateExerciseId)),
    );
    // Same reasoning as addExercise's own change — the frontend needs
    // the post-removal state to re-render the list, not just a bare
    // success signal.
    return this.findOne(templateId);
  }

  // === HELPER FUNCTIONS =================================================================

  private async findTemplateOrThrow(id: number) {
    const template = await this.db.query.programTemplates.findFirst({
      where: eq(programTemplates.id, id),
    });
    if (!template) {
      throw new NotFoundException(`Program template ${id} not found`);
    }
    return template;
  }

  // Confirms a template_exercises row genuinely belongs to the template in
  // the URL — the same IDOR-shaped check as removeImage validating an
  // object key actually belongs to the exercise being modified. Without
  // this, a valid row id from a DIFFERENT template (which its owner has
  // every right to modify on ITS OWN template) could be edited through
  // this template's URL instead.
  private async findTemplateExerciseOrThrow(
    templateId: number,
    templateExerciseId: number,
  ) {
    const row = await this.db.query.templateExercises.findFirst({
      where: and(
        eq(templateExercises.id, templateExerciseId),
        eq(templateExercises.templateId, templateId),
      ),
    });
    if (!row) {
      throw new NotFoundException(
        `Exercise ${templateExerciseId} not found in this template`,
      );
    }
    return row;
  }

  private assertCanModify(
    template: typeof programTemplates.$inferSelect,
    currentUser: CurrentUser,
  ) {
    const isAdmin = currentUser.activeRole === UserRole.ADMIN;
    const isOwner = template.practitionerId === currentUser.id;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException(
        "You can only modify program templates you created, unless you are an administrator",
      );
    }
  }

  // Enriches each templateExercises row with the exercise it actually
  // references — name and primaryMuscles, the same information
  // ExerciseCard already needs to render a card, so a template's own
  // exercise cards can look consistent with the Library's. A batched,
  // SEPARATE lookup rather than a join on the main query — same
  // reasoning as ExercisesService.findAll's own author-attachment: fetch
  // base rows, then batch-fetch related data and merge in JS, rather
  // than introducing Drizzle's relational query API, which isn't used
  // anywhere else in this schema.
  //
  // Deliberately does NOT filter the exercise lookup by isArchived — an
  // exercise referenced by an existing template can be archived LATER
  // (archiving only flips a flag; the foreign key's onDelete: "restrict"
  // prevents a real delete, not an archive), and the template should
  // still show what it actually contains rather than silently dropping
  // a row because the underlying exercise was archived since it was
  // added.
  private async withExerciseDetails(
    rows: (typeof templateExercises.$inferSelect)[],
  ) {
    const exerciseIds = [...new Set(rows.map((row) => row.exerciseId))];
    const exerciseRows =
      exerciseIds.length > 0
        ? await this.db.query.exercises.findMany({
            where: inArray(exercises.id, exerciseIds),
          })
        : [];
    const exercisesById = new Map(
      exerciseRows.map((exercise) => [
        exercise.id,
        {
          id: exercise.id,
          name: exercise.name,
          primaryMuscles: exercise.primaryMuscles,
        },
      ]),
    );
    return rows.map((row) => ({
      ...row,
      exercise: exercisesById.get(row.exerciseId) ?? null,
    }));
  }
}