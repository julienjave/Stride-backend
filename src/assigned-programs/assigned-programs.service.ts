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
  assignedPrograms,
  assignedProgramExercises,
  templateExercises,
  exercises,
  users,
} from "../database/schema";
import { UsersService } from "../users/users.service";
import { CreateAssignedProgramDto } from "./dto/create-assigned-program.dto";
import { UpdateAssignedProgramDto } from "./dto/update-assigned-program.dto";
import { AssignedExerciseInputDto } from "./dto/assigned-exercise-input.dto";
import { UpdateAssignedProgramExerciseDto } from "./dto/update-assigned-program-exercise.dto";
import { UserRole } from "../users/dto/create-user.dto";
import { withRlsContext } from "../database/rls-context";

// --- SERVICE ------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole };

// What resolveSourceExercises produces for create() to insert — the
// exercise's own snapshotted fields (name/muscles/equipment/
// instructions) alongside the per-patient prescription fields
// (sets/reps/weight/etc). Deliberately NOT AssignedExerciseInputDto
// (what a caller sends in) — that type has no name/muscles fields at
// all, since a client never supplies those directly; they're always
// server-derived from the referenced exercise at snapshot time.
interface ResolvedSourceExercise {
  exerciseId: number;
  name: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  instructions: string[];
  sets?: number;
  reps?: number;
  durationInSeconds?: number;
  weight?: number;
  weightUnit?: "kg" | "lbs";
  sortOrder: number;
  notes?: string;
}

@Injectable()
export class AssignedProgramsService {
  // UsersService IS injected here, deliberately, unlike the Clinics/Users
  // relationship — this is a one-directional dependency (AssignedPrograms
  // needs Users' isPatientManagedBy/findPatientsForPractitioner; Users needs
  // nothing back), so there's no circularity risk, and it avoids duplicating
  // that clinic-scoping logic a third time.
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // --- EXERCISE SNAPSHOTTING ------------------------------------------------

  // Batches ONE lookup for however many distinct exercises are being
  // snapshotted at once, rather than fetching one at a time in a loop —
  // same "fetch base rows, then batch-fetch related data" shape used
  // elsewhere in this codebase (ExercisesService.findAll's author
  // attachment, ProgramsService.withExerciseDetails). Also doubles as
  // existence validation: a referenced exercise that doesn't actually
  // exist throws here, rather than silently producing an incomplete
  // snapshot. In practice this can only ever fire for the INLINE
  // exercises array path (a template row's exerciseId is guaranteed
  // valid by its own foreign key, so that path can never hit a missing
  // id) — but the check lives here, once, rather than being duplicated
  // per caller, so both paths get it for free.
  private async fetchExerciseSnapshots(exerciseIds: number[]) {
    const uniqueIds = [...new Set(exerciseIds)];
    const rows =
      uniqueIds.length > 0
        ? await this.db.query.exercises.findMany({
            where: inArray(exercises.id, uniqueIds),
          })
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of uniqueIds) {
      if (!byId.has(id)) {
        throw new NotFoundException(`Exercise ${id} not found`);
      }
    }
    return byId;
  }

  async create(currentUser: CurrentUser, dto: CreateAssignedProgramDto) {
    const managed = await this.usersService.isPatientManagedBy(
      dto.patientId,
      currentUser.id,
    );
    if (!managed) {
      throw new ForbiddenException(
        "You can only assign programs to patients you manage",
      );
    }

    const sourceExercises = await this.resolveSourceExercises(dto);

    const programId = await withRlsContext(this.db, currentUser, async (tx) => {
      const [program] = await tx
        .insert(assignedPrograms)
        .values({
          patientId: dto.patientId,
          assignedBy: currentUser.id,
          basedOnTemplateId: dto.basedOnTemplateId ?? null,
          title: dto.title,
          startDate: dto.startDate,
          endDate: dto.endDate,
        })
        .returning();

      // The actual "copy, not reference" moment. From here on these rows
      // are entirely independent of template_exercises AND of the
      // exercise's own current data — editing or deleting the source
      // template later, or editing/archiving the exercise itself, never
      // touches this patient's already-assigned program.
      for (const ex of sourceExercises) {
        await tx.insert(assignedProgramExercises).values({
          assignedProgramId: program.id,
          exerciseId: ex.exerciseId,
          name: ex.name,
          primaryMuscles: ex.primaryMuscles,
          secondaryMuscles: ex.secondaryMuscles,
          equipment: ex.equipment,
          instructions: ex.instructions,
          sets: ex.sets,
          reps: ex.reps,
          durationInSeconds: ex.durationInSeconds,
          weight: ex.weight,
          weightUnit: ex.weightUnit,
          sortOrder: ex.sortOrder,
          notes: ex.notes,
        });
      }

      return program.id;
    });

    // Deliberately its own, separate RLS-scoped transaction — by the time
    // this runs, the transaction above has committed, so the newly
    // inserted rows are safely visible.
    return this.findProgramWithExercises(programId, currentUser);
  }

  async addExercise(
    assignedProgramId: number,
    currentUser: CurrentUser,
    dto: AssignedExerciseInputDto,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    );
    await this.assertCanManage(program.patientId, currentUser);

    // exercises' SELECT policy is unconditional (USING (true)), so this
    // needs no RLS context — reading it on the normal connection is
    // correct, not a gap.
    const exercise = await this.db.query.exercises.findFirst({
      where: eq(exercises.id, dto.exerciseId),
    });
    if (!exercise) {
      throw new NotFoundException(`Exercise ${dto.exerciseId} not found`);
    }

    const [row] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .insert(assignedProgramExercises)
        .values({
          assignedProgramId,
          exerciseId: dto.exerciseId,
          // Snapshotted from the SAME already-fetched `exercise` above —
          // no extra query needed, since the existence check already
          // has everything this needs in scope. Same "copy, not
          // reference" reasoning as create()'s own snapshot, just for
          // adding to an already-assigned program later rather than at
          // creation time.
          name: exercise.name,
          primaryMuscles: exercise.primaryMuscles,
          secondaryMuscles: exercise.secondaryMuscles,
          equipment: exercise.equipment,
          instructions: exercise.instructions,
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
    return row;
  }

  // --- GET ROUTES ---

  // Role-scoped, not a single "list everything": patient sees their own,
  // practitioner sees programs for patients they manage (their care team,
  // through UsersService's definition), admin sees all.
  //
  // `patientId` (GET /assigned-programs?patientId=, added 2026-10-08 for the
  // practitioner's patient page) narrows the list to ONE patient — every
  // program of theirs, whoever assigned it. It is checked with the same
  // rule as viewing a single program (assertCanView): an admin, the patient
  // themselves, or a practitioner on their care team. Anyone else gets the
  // same 403 as for one of that patient's programs — never an empty list,
  // which would quietly say "this patient has no programs" to someone who
  // isn't allowed to know.
  //
  // Every program comes back with its `assigner` (id and name), so a screen
  // can say "assigned by Sam Okafor" without one request per program.
  async findAllForCurrentUser(currentUser: CurrentUser, patientId?: number) {
    const programs = await this.findProgramRows(currentUser, patientId);
    return this.withAssigners(programs);
  }

  private async findProgramRows(
    currentUser: CurrentUser,
    patientId: number | undefined,
  ) {
    if (patientId !== undefined) {
      await this.assertCanView(patientId, currentUser);
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.assignedPrograms.findMany({
          where: and(
            eq(assignedPrograms.patientId, patientId),
            eq(assignedPrograms.isArchived, false),
          ),
        }),
      );
    }
    if (currentUser.activeRole === UserRole.ADMIN) {
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.assignedPrograms.findMany({
          where: eq(assignedPrograms.isArchived, false),
        }),
      );
    }
    if (currentUser.activeRole === UserRole.PATIENT) {
      return withRlsContext(this.db, currentUser, (tx) =>
        tx.query.assignedPrograms.findMany({
          where: and(
            eq(assignedPrograms.patientId, currentUser.id),
            eq(assignedPrograms.isArchived, false),
          ),
        }),
      );
    }
    const managedPatients = await this.usersService.findPatientsForPractitioner(
      currentUser.id,
    );
    const patientIds = managedPatients.map((p) => p.id);
    if (patientIds.length === 0) {
      return [];
    }
    return withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedPrograms.findMany({
        where: and(
          inArray(assignedPrograms.patientId, patientIds),
          eq(assignedPrograms.isArchived, false),
        ),
      }),
    );
  }

  // Adds `assigner: { id, firstName, lastName }` to each program: ONE query
  // for all the assigners, then a Map lookup per program — not one
  // query per program (the "N+1 queries" problem: 30 programs would be 31
  // round trips). Same batching idea as UsersService.attachProfilesToMany.
  //
  // Read without an RLS context, like every identity read in this app:
  // `users` stays readable without one (migration 0007), and only names
  // are selected — no contact details.
  private async withAssigners<T extends { assignedBy: number }>(programs: T[]) {
    if (programs.length === 0) return [];
    // Duplicates are harmless here: `IN (7, 7, 8)` matches exactly what
    // `IN (7, 8)` does (a mutation check showed de-duplicating changed
    // nothing observable, so it was left out).
    const assignerIds = programs.map((p) => p.assignedBy);
    const assigners = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(inArray(users.id, assignerIds));
    const byId = new Map(assigners.map((a) => [a.id, a]));
    // `?? null` can't happen today (assigned_by is NOT NULL and its foreign
    // key RESTRICTs deleting the user), but a missing name must never turn
    // a whole list into a 500.
    return programs.map((p) => ({ ...p, assigner: byId.get(p.assignedBy) ?? null }));
  }

  async findOne(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser);
    await this.assertCanView(program.patientId, currentUser);
    return this.findProgramWithExercises(id, currentUser);
  }

  // --- PATCH ROUTES ---

  async update(
    id: number,
    currentUser: CurrentUser,
    dto: UpdateAssignedProgramDto,
  ) {
    const program = await this.findProgramOrThrow(id, currentUser);
    await this.assertCanManage(program.patientId, currentUser);
    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(assignedPrograms)
        .set(dto)
        .where(eq(assignedPrograms.id, id))
        .returning(),
    );
    return updated;
  }

  async updateExercise(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
    dto: UpdateAssignedProgramExerciseDto,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    );
    await this.assertCanManage(program.patientId, currentUser);
    await this.findProgramExerciseOrThrow(
      assignedProgramId,
      rowId,
      currentUser,
    );

    const [updated] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(assignedProgramExercises)
        .set(dto)
        .where(eq(assignedProgramExercises.id, rowId))
        .returning(),
    );
    return updated;
  }

  async reorderExercises(
    assignedProgramId: number,
    currentUser: CurrentUser,
    newOrder: number[],
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    );
    await this.assertCanManage(program.patientId, currentUser);

    // Read, permutation-check, and write all happen inside ONE transaction
    // (tx.query instead of this.db.query) — same fix as
    // ProgramsService.reorderExercises, closing the same "separate
    // transaction" TOCTOU gap where a concurrent addExercise/removeExercise
    // could land between the old read and the old write. See that method's
    // comment for the full trace of why this narrows rather than fully
    // closes the race, and why full closure (row locking / SERIALIZABLE +
    // retry) isn't justified given the confirmed failure mode is a harmless
    // sortOrder inconsistency, never a privilege or data-boundary issue —
    // and the response below already reflects genuine post-write state.
    // withRlsContext() supplies this same transaction, scoped to
    // currentUser, rather than a separate set_config step around a plain
    // this.db.transaction(...).
    await withRlsContext(this.db, currentUser, async (tx) => {
      const currentRows = await tx.query.assignedProgramExercises.findMany({
        where: eq(
          assignedProgramExercises.assignedProgramId,
          assignedProgramId,
        ),
      });
      const currentIds = new Set(currentRows.map((r) => r.id));
      // Same fix as ProgramsService.reorderExercises — a genuine permutation
      // check needs length + no-internal-duplicates + valid-membership
      // together, not just a comparison of deduplicated Set sizes. See that
      // method's comment for the full exploit trace.
      const isSamePermutation =
        newOrder.length === currentRows.length &&
        new Set(newOrder).size === newOrder.length &&
        newOrder.every((id) => currentIds.has(id));

      if (!isSamePermutation) {
        throw new BadRequestException(
          "The new order must contain exactly the exercises currently in this program, just reordered",
        );
      }

      for (const [index, rowId] of newOrder.entries()) {
        await tx
          .update(assignedProgramExercises)
          .set({ sortOrder: index })
          .where(eq(assignedProgramExercises.id, rowId));
      }
    });

    return this.findProgramWithExercises(assignedProgramId, currentUser);
  }

  // --- DELETE ROUTES ---

  async archive(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser);
    await this.assertCanManage(program.patientId, currentUser);
    const [archived] = await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .update(assignedPrograms)
        .set({ isArchived: true })
        .where(eq(assignedPrograms.id, id))
        .returning(),
    );
    return archived;
  }

  async removeExercise(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const program = await this.findProgramOrThrow(
      assignedProgramId,
      currentUser,
    );
    await this.assertCanManage(program.patientId, currentUser);
    await this.findProgramExerciseOrThrow(
      assignedProgramId,
      rowId,
      currentUser,
    );

    await withRlsContext(this.db, currentUser, (tx) =>
      tx
        .delete(assignedProgramExercises)
        .where(eq(assignedProgramExercises.id, rowId)),
    );
  }

  // === HELPER FUNCTIONS =================================================================

  private async resolveSourceExercises(
    dto: CreateAssignedProgramDto,
  ): Promise<ResolvedSourceExercise[]> {
    if (dto.basedOnTemplateId) {
      const rows = await this.db.query.templateExercises.findMany({
        where: eq(templateExercises.templateId, dto.basedOnTemplateId),
        orderBy: (te, { asc }) => [asc(te.sortOrder)],
      });
      if (rows.length === 0) {
        throw new NotFoundException(
          `Template ${dto.basedOnTemplateId} not found, or has no exercises to copy`,
        );
      }
      const snapshots = await this.fetchExerciseSnapshots(
        rows.map((row) => row.exerciseId),
      );
      return rows.map((row) => {
        // Guaranteed present — a templateExercises row's exerciseId is
        // enforced valid by its own foreign key (onDelete: "restrict"),
        // so fetchExerciseSnapshots can never actually throw for this
        // branch; the ! reflects that real guarantee, not an assumption.
        const snapshot = snapshots.get(row.exerciseId)!;
        return {
          exerciseId: row.exerciseId,
          name: snapshot.name,
          primaryMuscles: snapshot.primaryMuscles,
          secondaryMuscles: snapshot.secondaryMuscles,
          equipment: snapshot.equipment,
          instructions: snapshot.instructions,
          sets: row.sets ?? undefined,
          reps: row.reps ?? undefined,
          durationInSeconds: row.durationInSeconds ?? undefined,
          weight: row.weight ?? undefined,
          weightUnit: row.weightUnit ?? undefined,
          sortOrder: row.sortOrder,
          notes: row.notes ?? undefined,
        };
      });
    }

    if (!dto.exercises || dto.exercises.length === 0) {
      throw new BadRequestException(
        "Provide either basedOnTemplateId or an inline exercises array",
      );
    }
    // Unlike the template branch, a client-supplied exerciseId here has
    // no foreign key backing it yet — fetchExerciseSnapshots' own
    // existence check is what catches a bad id, a real validation gap
    // this path didn't have before snapshotting made fetching each
    // exercise unavoidable anyway.
    const snapshots = await this.fetchExerciseSnapshots(
      dto.exercises.map((ex) => ex.exerciseId),
    );
    return dto.exercises.map((ex) => {
      const snapshot = snapshots.get(ex.exerciseId)!;
      return {
        exerciseId: ex.exerciseId,
        name: snapshot.name,
        primaryMuscles: snapshot.primaryMuscles,
        secondaryMuscles: snapshot.secondaryMuscles,
        equipment: snapshot.equipment,
        instructions: snapshot.instructions,
        sets: ex.sets,
        reps: ex.reps,
        durationInSeconds: ex.durationInSeconds,
        weight: ex.weight,
        weightUnit: ex.weightUnit,
        sortOrder: ex.sortOrder,
        notes: ex.notes,
      };
    });
  }

  private async findProgramWithExercises(id: number, currentUser: CurrentUser) {
    const program = await this.findProgramOrThrow(id, currentUser);
    const exerciseRows = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedProgramExercises.findMany({
        where: eq(assignedProgramExercises.assignedProgramId, id),
        orderBy: (row, { asc }) => [asc(row.sortOrder)],
      }),
    );
    return { ...program, exercises: exerciseRows };
  }

  private async findProgramOrThrow(id: number, currentUser: CurrentUser) {
    const program = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedPrograms.findFirst({
        where: eq(assignedPrograms.id, id),
      }),
    );
    // Covers both "genuinely does not exist" and "exists, but RLS made it
    // invisible to this session" — assertCanView/assertCanManage never run
    // on a program this query didn't return, so an out-of-scope row reads
    // as 404, not 403. See assertCanView/assertCanManage below for the one
    // deliberate exception (the owning patient IS visible via RLS, so the
    // 403 there is a real app-layer decision, not RLS filtering).
    if (!program) {
      throw new NotFoundException(`Assigned program ${id} not found`);
    }
    return program;
  }

  private async findProgramExerciseOrThrow(
    assignedProgramId: number,
    rowId: number,
    currentUser: CurrentUser,
  ) {
    const row = await withRlsContext(this.db, currentUser, (tx) =>
      tx.query.assignedProgramExercises.findFirst({
        where: and(
          eq(assignedProgramExercises.id, rowId),
          eq(assignedProgramExercises.assignedProgramId, assignedProgramId),
        ),
      }),
    );
    if (!row) {
      throw new NotFoundException(
        `Exercise ${rowId} not found in this assigned program`,
      );
    }
    return row;
  }

  // Viewing allows a third case beyond manage: the patient viewing their
  // own program.
  private async assertCanView(patientId: number, currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) return;
    if (
      currentUser.activeRole === UserRole.PATIENT &&
      patientId === currentUser.id
    )
      return;
    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      const managed = await this.usersService.isPatientManagedBy(
        patientId,
        currentUser.id,
      );
      if (managed) return;
    }
    throw new ForbiddenException(
      "You do not have permission to view this assigned program",
    );
  }

  // Managing (create/update/archive/exercise CRUD) never allows the patient
  // themselves — a patient can see their program, not edit its prescription.
  private async assertCanManage(patientId: number, currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.ADMIN) return;
    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      const managed = await this.usersService.isPatientManagedBy(
        patientId,
        currentUser.id,
      );
      if (managed) return;
    }
    throw new ForbiddenException(
      "You do not have permission to manage this assigned program",
    );
  }
}