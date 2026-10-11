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
} from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import { DRIZZLE, type DrizzleDb } from "../database/drizzle.provider";
import {
  programTemplates,
  templateExercises,
  templateWorkouts,
  exercises,
} from "../database/schema";
import {
  CreateTemplateDto,
  TEMPLATE_TITLE_MAX_LENGTH,
} from "./dto/create-template.dto";
import { UpdateTemplateDto } from "./dto/update-template.dto";
import { AddTemplateExerciseDto } from "./dto/add-template-exercise.dto";
import { UpdateTemplateExerciseDto } from "./dto/update-template-exercise.dto";
import { AddWorkoutDto } from "./dto/add-workout.dto";
import { RenameWorkoutDto } from "./dto/rename-workout.dto";
import { UserRole } from "../users/dto/create-user.dto";
import { withRlsContext } from "../database/rls-context";
import {
  assertCanAddWorkout,
  assertWorkoutRemovable,
  isPermutationOf,
  normalizeWorkoutName,
  orderExercisesByWorkout,
  orderWorkouts,
  resolveWorkoutId,
  workoutLabel,
} from "../common/workout-rules";
import {
  isForeignKeyViolation,
  TEMPLATE_EXERCISES_WORKOUT_FK,
} from "../database/pg-errors";

// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole };

// Prepended to a duplicated template's title — see buildDuplicateTitle.
const DUPLICATE_TITLE_PREFIX = "Copy of ";

@Injectable()
export class ProgramsService {
  // No ExercisesModule import needed here, deliberately — validating that
  // an exerciseId exists is just another query against the shared, global
  // DRIZZLE db, the same "no cross-module dependency for a shared table"
  // reasoning used for Clinics/Users.
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // A new template comes with its first workout (unnamed, "A"), in the same
  // transaction: every template ALWAYS has at least one workout, so an
  // exercise added without saying which workout always has one to go to —
  // the database can't require a row in another table, so the transaction
  // is what makes "both or neither" true (same idea as a program and its
  // first schedule version).
  async create(currentUser: CurrentUser, dto: CreateTemplateDto) {
    return withRlsContext(this.db, currentUser, async (tx) => {
      const [template] = await tx
        .insert(programTemplates)
        .values({
          practitionerId: currentUser.id,
          title: dto.title,
          description: dto.description,
        })
        .returning();
      await tx
        .insert(templateWorkouts)
        .values({ templateId: template.id, sortOrder: 0 });
      return template;
    });
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
    // Which workout: the one asked for (it must be one of THIS template's),
    // or the first. See resolveWorkoutId.
    const workoutId = resolveWorkoutId(
      dto.workoutId,
      await this.findWorkouts(this.db, templateId),
      "template",
    );

    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .insert(templateExercises)
        .values({
          templateId,
          workoutId,
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

  // Reorders the exercises of ONE workout (`workoutId`, or the first one
  // when it's omitted — which is every exercise of a one-workout template,
  // what today's screens send). Exercises of other workouts keep their
  // positions: each workout's list is ordered on its own.
  async reorderExercises(
    templateId: number,
    currentUser: CurrentUser,
    newOrder: number[],
    requestedWorkoutId?: number | null,
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
      const workoutId = resolveWorkoutId(
        requestedWorkoutId,
        await this.findWorkouts(tx, templateId),
        "template",
      );
      const currentRows = await tx.query.templateExercises.findMany({
        where: and(
          eq(templateExercises.templateId, templateId),
          eq(templateExercises.workoutId, workoutId),
        ),
      });
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
      // (The check itself now lives in common/workout-rules.ts —
      // isPermutationOf — shared with workouts and assigned programs.)
      if (
        !isPermutationOf(
          newOrder,
          currentRows.map((r) => r.id),
        )
      ) {
        throw new BadRequestException(
          "The new order must contain exactly the exercises currently in this workout, just reordered",
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

  // Copies a template AND all of its exercise rows into a brand-new
  // template owned by the CURRENT user — deliberately not restricted to
  // the source's owner, since duplicating is the only way a practitioner
  // can build on a colleague's template (templates are readable by
  // everyone, but only editable by their owner). Reading the source
  // needs no permission check for the same reason: program_templates_select
  // and template_exercises_select are both USING (true).
  async duplicate(sourceId: number, currentUser: CurrentUser) {
    const source = await this.findTemplateOrThrow(sourceId);
    // An archived template is "deleted" as far as the app is concerned —
    // still viewable by direct URL, but never something to build new
    // content from. Without this, a bookmark to a deleted template would
    // be a back door to bring its content back into circulation.
    if (source.isArchived) {
      throw new BadRequestException(
        "Archived program templates cannot be duplicated",
      );
    }

    // ONE transaction for both inserts, for two separate reasons:
    //
    // 1. All-or-nothing. If copying the exercise rows failed after the
    //    template row was already committed, the practitioner would be
    //    left with a half-made, empty "Copy of ..." they never asked for.
    //    Inside one transaction, any failure rolls BOTH inserts back.
    //
    // 2. RLS. template_exercises_insert checks, via an EXISTS subquery,
    //    that the parent template belongs to the current user. The new
    //    parent row isn't committed yet when that check runs — but a
    //    transaction always sees its OWN uncommitted writes, so the
    //    subquery finds it. (Separate transactions would also pass this
    //    check, since the first would be committed by then — it's point
    //    1 that really requires sharing one.)
    const newTemplateId = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const [copy] = await tx
          .insert(programTemplates)
          .values({
            practitionerId: currentUser.id,
            title: this.buildDuplicateTitle(source.title),
            description: source.description,
          })
          .returning();

        // The workouts first, in order, remembering which new workout each
        // old one became: the exercises below must point at the COPY's
        // workouts (the composite foreign key would refuse the source's —
        // they belong to another template). One INSERT per workout, not one
        // for all: a multi-row INSERT … RETURNING doesn't promise to return
        // rows in the order they were given, and the mapping relies on
        // order. A template has at most MAX_WORKOUTS, so this stays cheap.
        const newWorkoutIds = new Map<number, number>();
        for (const workout of orderWorkouts(
          await this.findWorkouts(tx, sourceId),
        )) {
          const [copiedWorkout] = await tx
            .insert(templateWorkouts)
            .values({
              templateId: copy.id,
              name: workout.name,
              sortOrder: workout.sortOrder,
            })
            .returning();
          newWorkoutIds.set(workout.id, copiedWorkout.id);
        }

        const sourceRows = await tx.query.templateExercises.findMany({
          where: eq(templateExercises.templateId, sourceId),
          orderBy: (te, { asc: ascend }) => [ascend(te.sortOrder)],
        });

        // Drizzle throws on .values([]) — an INSERT with zero rows isn't
        // valid SQL — so a template with no exercises yet has to skip
        // this step rather than crash. Duplicating an empty template is
        // still a perfectly reasonable thing to do (it copies the title
        // and description).
        if (sourceRows.length > 0) {
          await tx.insert(templateExercises).values(
            // Rest-destructuring copies EVERY column except the two that
            // must change: `id` (the database assigns a fresh one) and
            // `templateId` (re-pointed at the copy). This is deliberately
            // different from addExercise's hand-listed .values({...}):
            // there, the input is a DTO with a different shape than the
            // row, so listing fields is unavoidable. Here, the input IS a
            // row of this exact table — and a hand-written list is
            // exactly the shape that has silently dropped newly-added
            // columns three times in this codebase. With `...copyable`, a
            // column added to template_exercises in the future is copied
            // automatically. (ignoreRestSiblings in eslint.config.mjs is
            // what keeps the unused `id`/`templateId` names lint-clean.)
            sourceRows.map(({ id, templateId, ...copyable }) => ({
              ...copyable,
              templateId: copy.id,
              // Re-pointed like templateId: the copy's own workout. The `!`
              // holds because every source exercise's workout is one of the
              // source's workouts (foreign key), all copied just above.
              workoutId: newWorkoutIds.get(copyable.workoutId)!,
            })),
          );
        }

        return copy.id;
      },
    );

    // Same "always return the full enriched template" convention as
    // every other write on this controller — here it also happens to be
    // exactly what the frontend needs to render the new copy's page
    // immediately, without a second request.
    return this.findOne(newTemplateId);
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

  // The template with its `workouts` (in order: A first) and its
  // `exercises` — ONE flat list, workout by workout, each exercise carrying
  // its workoutId. Flat on purpose: the screens that don't know about
  // workouts yet keep listing every exercise, and those that do group the
  // list by workoutId.
  async findOne(id: number) {
    const template = await this.findTemplateOrThrow(id);
    const workouts = orderWorkouts(await this.findWorkouts(this.db, id));
    const exerciseRows = await this.db.query.templateExercises.findMany({
      where: eq(templateExercises.templateId, id),
    });
    return {
      ...template,
      workouts,
      exercises: await this.withExerciseDetails(
        orderExercisesByWorkout(exerciseRows, workouts),
      ),
    };
  }

  // --- PATCH ROUTES ---

  async update(id: number, currentUser: CurrentUser, dto: UpdateTemplateDto) {
    const template = await this.findTemplateOrThrow(id);
    this.assertCanModify(template, currentUser);
    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(programTemplates)
        .set(dto)
        .where(eq(programTemplates.id, id))
        .returning(),
    );
    // Returns the FULL enriched template, not the bare updated row — the
    // same consistency fix updateExercise needed. The frontend writes
    // this response straight into the template's cache entry; a bare
    // row has no `exercises` array, so the exercise list rendered on the
    // same page as the title would vanish right after renaming it.
    return this.findOne(id);
  }

  async updateExercise(
    templateId: number,
    templateExerciseId: number,
    currentUser: CurrentUser,
    dto: UpdateTemplateExerciseDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    const row = await this.findTemplateExerciseOrThrow(
      templateId,
      templateExerciseId,
    );

    await withRlsContext(this.db, currentUser, async (tx) => {
      const changes = { ...dto };
      // Moving the exercise to another workout: it must be one of this
      // template's (404 otherwise), and — unless the request also says where
      // — it goes to the END of that workout's list, rather than keeping a
      // position that meant something only in its old workout.
      if (dto.workoutId !== undefined && dto.workoutId !== row.workoutId) {
        resolveWorkoutId(
          dto.workoutId,
          await this.findWorkouts(tx, templateId),
          "template",
        );
        if (dto.sortOrder === undefined) {
          changes.sortOrder = await this.nextExercisePosition(
            tx,
            dto.workoutId,
          );
        }
      }
      await tx
        .update(templateExercises)
        .set(changes)
        .where(eq(templateExercises.id, templateExerciseId));
    });
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

  // --- WORKOUTS ---
  //
  // Add, rename, reorder and delete a template's workouts. Each returns the
  // full template, like every other write here. The rules themselves (the
  // limit, when a workout may be deleted, the permutation check) are in
  // common/workout-rules.ts, shared with assigned programs; these methods
  // read and write the rows.
  //
  // Adding and deleting LOCK the template's row first (lockTemplate): both
  // decide from a count — "fewer than 10?", "more than one?" — and two
  // requests counting at the same moment would otherwise both pass. Two
  // deletes racing on a two-workout template could leave it with none.
  // With the lock, the second waits for the first to commit, then counts
  // again.

  async addWorkout(
    templateId: number,
    currentUser: CurrentUser,
    dto: AddWorkoutDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    await withRlsContext(this.db, currentUser, async (tx) => {
      await this.lockTemplate(tx, templateId);
      const workouts = await this.findWorkouts(tx, templateId);
      assertCanAddWorkout(workouts.length);
      await tx.insert(templateWorkouts).values({
        templateId,
        name: normalizeWorkoutName(dto.name),
        // After the last one. (max + 1, not length: positions can have gaps
        // after a delete, and `length` could repeat one that's in use.)
        sortOrder: Math.max(-1, ...workouts.map((w) => w.sortOrder)) + 1,
      });
    });
    return this.findOne(templateId);
  }

  async renameWorkout(
    templateId: number,
    workoutId: number,
    currentUser: CurrentUser,
    dto: RenameWorkoutDto,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    await withRlsContext(this.db, currentUser, async (tx) => {
      resolveWorkoutId(
        workoutId,
        await this.findWorkouts(tx, templateId),
        "template",
      );
      await tx
        .update(templateWorkouts)
        .set({ name: normalizeWorkoutName(dto.name) })
        .where(eq(templateWorkouts.id, workoutId));
    });
    return this.findOne(templateId);
  }

  // The complete new order of the template's workouts: the first id
  // becomes A. Positions are rewritten 0, 1, 2… — which also closes any gap
  // left by a delete.
  async reorderWorkouts(
    templateId: number,
    currentUser: CurrentUser,
    newOrder: number[],
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    await withRlsContext(this.db, currentUser, async (tx) => {
      const workouts = await this.findWorkouts(tx, templateId);
      if (
        !isPermutationOf(
          newOrder,
          workouts.map((w) => w.id),
        )
      ) {
        throw new BadRequestException(
          "The new order must contain exactly the workouts currently in this template, just reordered",
        );
      }
      for (const [index, workoutId] of newOrder.entries()) {
        await tx
          .update(templateWorkouts)
          .set({ sortOrder: index })
          .where(eq(templateWorkouts.id, workoutId));
      }
    });
    return this.findOne(templateId);
  }

  // Only an EMPTY workout, and never the last (assertWorkoutRemovable).
  async removeWorkout(
    templateId: number,
    workoutId: number,
    currentUser: CurrentUser,
  ) {
    const template = await this.findTemplateOrThrow(templateId);
    this.assertCanModify(template, currentUser);
    try {
      await withRlsContext(this.db, currentUser, async (tx) => {
        await this.lockTemplate(tx, templateId);
        const workouts = orderWorkouts(await this.findWorkouts(tx, templateId));
        resolveWorkoutId(workoutId, workouts, "template");
        const [{ exerciseCount }] = await tx
          .select({ exerciseCount: count() })
          .from(templateExercises)
          .where(eq(templateExercises.workoutId, workoutId));
        assertWorkoutRemovable({
          label: workoutLabel(workouts.findIndex((w) => w.id === workoutId)),
          workoutCount: workouts.length,
          exerciseCount,
        });
        await tx
          .delete(templateWorkouts)
          .where(eq(templateWorkouts.id, workoutId));
      });
    } catch (error) {
      // An exercise added to this workout between the count above and the
      // DELETE (adding an exercise doesn't take the template's lock): the
      // database refuses the delete through the exercise's foreign key.
      // Same answer as the count would have given.
      if (isForeignKeyViolation(error, TEMPLATE_EXERCISES_WORKOUT_FK)) {
        throw new ConflictException(
          "This workout still has exercises: move or remove them first",
        );
      }
      throw error;
    }
    return this.findOne(templateId);
  }

  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: CurrentUser) {
    const template = await this.findTemplateOrThrow(id);
    this.assertCanModify(template, currentUser);
    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(programTemplates)
        .set({ isArchived: true })
        .where(eq(programTemplates.id, id))
        .returning(),
    );
    // Same convention as update() above. findOne() doesn't filter on
    // isArchived, so this still finds the row it just archived — and the
    // response now carries isArchived: true alongside the exercises.
    return this.findOne(id);
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

  // "Copy of " + the original title, trimmed so the result never exceeds
  // TEMPLATE_TITLE_MAX_LENGTH. The column itself (varchar 255) would
  // accept a longer one — but the frontend's edit form validates against
  // the DTO's 200, so an over-long generated title would open as
  // "invalid" before the practitioner had typed anything.
  //
  // Array.from(title) splits by Unicode code point, not UTF-16 code
  // unit: a plain .slice() on the string could cut an emoji (two code
  // units) in half, leaving a broken, unpaired half-character at the end.
  private buildDuplicateTitle(title: string) {
    const room = TEMPLATE_TITLE_MAX_LENGTH - DUPLICATE_TITLE_PREFIX.length;
    return DUPLICATE_TITLE_PREFIX + Array.from(title).slice(0, room).join("");
  }

  // A template's workouts, in no particular order (callers that need the
  // display order use orderWorkouts). `executor` is either the plain
  // connection or a transaction — template_workouts is readable by everyone
  // (its SELECT policy is `true`), so both see the same rows; inside a
  // write, the transaction is passed so the read and the write agree.
  private async findWorkouts(executor: DrizzleDb, templateId: number) {
    return executor.query.templateWorkouts.findMany({
      where: eq(templateWorkouts.templateId, templateId),
    });
  }

  // SELECT … FOR UPDATE on the template's row: holds a row lock until the
  // transaction ends, so a second transaction locking the same template
  // WAITS here until the first commits — the workout changes of one
  // template happen one at a time. (The first use of row locking in this
  // codebase: reorderExercises' comment explains why it wasn't needed
  // there — the worst case was a harmless position mix-up. Here the worst
  // case is a template with no workout at all.) Under row-level security,
  // FOR UPDATE also requires the UPDATE policy to allow the row — the
  // template's owner or an admin, the same people allowed to change it.
  private async lockTemplate(tx: DrizzleDb, templateId: number) {
    await tx
      .select({ id: programTemplates.id })
      .from(programTemplates)
      .where(eq(programTemplates.id, templateId))
      .for("update");
  }

  // The position after the last exercise of a workout (0 for an empty one).
  private async nextExercisePosition(tx: DrizzleDb, workoutId: number) {
    const rows = await tx
      .select({ sortOrder: templateExercises.sortOrder })
      .from(templateExercises)
      .where(eq(templateExercises.workoutId, workoutId));
    return Math.max(-1, ...rows.map((r) => r.sortOrder)) + 1;
  }

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