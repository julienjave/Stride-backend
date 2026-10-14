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

import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  date,
  pgEnum,
  index,
  real,
  check,
  unique,
  foreignKey,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { exercises } from './exercises.schema'
// Defined in its own file (see the comment there): users.schema.ts needs
// it too, and importing it from HERE would make the two files import each
// other.
import { weightUnitEnum } from './weight-unit.schema'

// `on_hold` was removed in step 2b-ii (migration 0028): a pause is a schedule
// version ("paused from D" — program-schedules.schema.ts), because a status
// can't say since when, and the schedule module needs exactly that.
export const programStatusEnum = pgEnum('program_status', [
  'active',
  'completed',
  'cancelled',
])

export const programTemplates = pgTable(
  'program_templates',
  {
    id: serial('id').primaryKey(),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    isArchived: boolean('is_archived').notNull().default(false),
  },
  (table) => ({
    // A title must hold something visible — the database's half of the DTOs'
    // IsTitle() rule (common/validators/title.ts), as the workouts' names
    // have *_name_not_blank. btrim() removes spaces at both ends; a title
    // made only of spaces becomes '', of length 0. (btrim's default is the
    // space character only: a title of tabs alone would pass HERE — the
    // DTOs, whose \S covers every whitespace, refuse it first. Same choice
    // as the workouts' CHECKs.) Added by migration 0035, which renamed the
    // existing blank titles first ("Untitled template").
    titleNotBlank: check(
      'program_templates_title_not_blank',
      sql`length(btrim(${table.title})) > 0`,
    ),
  }),
)

// A WORKOUT is one set of exercises done together in a session — "upper
// body", "lower body" (decisions §5, "Settled 2026-10-10", point 1). A
// template has one or more; every exercise belongs to exactly one. A
// one-workout template behaves exactly as templates did before workouts
// existed. The screens label workouts by their ORDER (A, B, C — see
// workoutLabel in common/workout-rules.ts) plus this optional name ("A ·
// Upper body"), so the label is never stored: reordering would make a
// stored letter wrong.
//
// Not expressible in Drizzle, so added by the custom migration
// 0027_workouts_rls: the row-level security policies (the same people as
// the template's exercises).
export const templateWorkouts = pgTable(
  'template_workouts',
  {
    id: serial('id').primaryKey(),
    // 'cascade', like template_exercises: a workout is part of its template.
    // (Templates are archived, never deleted, by the app.)
    templateId: integer('template_id')
      .notNull()
      .references(() => programTemplates.id, { onDelete: 'cascade' }),
    // Optional: "A" alone is a valid workout. NULL rather than '' for "no
    // name" — one spelling for "absent" (the service trims, and turns an
    // empty name into NULL; the CHECK below is the guarantee behind it).
    name: varchar('name', { length: 100 }),
    // The workout's position: A is the lowest. Gaps are fine (deleting B
    // leaves A=0, C=2, which read as A, B) — only the ORDER means anything.
    sortOrder: integer('sort_order').notNull(),
  },
  (table) => ({
    templateIdIdx: index('template_workouts_template_id_idx').on(
      table.templateId,
    ),
    nameNotBlank: check(
      'template_workouts_name_not_blank',
      sql`${table.name} IS NULL OR length(btrim(${table.name})) > 0`,
    ),
    // (id, template_id) is unique anyway — id alone already is — but a
    // foreign key can only point at columns that a unique constraint
    // covers EXACTLY. This one exists so template_exercises can reference
    // the PAIR: see templateExercises' workout foreign key below.
    idTemplateUnique: unique('template_workouts_id_template_id_unique').on(
      table.id,
      table.templateId,
    ),
  }),
)

export const templateExercises = pgTable(
  'template_exercises',
  {
    id: serial('id').primaryKey(),
    templateId: integer('template_id')
      .notNull()
      .references(() => programTemplates.id, { onDelete: 'cascade' }),
    // Which workout of the template this exercise belongs to. See the
    // composite foreign key below for why the database, not only the
    // service, guarantees it's a workout of the SAME template.
    workoutId: integer('workout_id').notNull(),
    exerciseId: integer('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'restrict' }),
    // sets / reps / durationInSeconds are deliberately all nullable — a timed hold has
    // a duration but no reps; a rep-based exercise has reps but no duration.
    sets: integer('sets'),
    reps: integer('reps'),
    durationInSeconds: integer('duration_in_seconds'),
    // real (a 4-byte float), not numeric/decimal — weight here is a
    // simple, human-entered value (62.5, say), never used in
    // accumulating arithmetic the way money would be, so real's
    // negligible floating-point imprecision doesn't matter in practice,
    // and it maps directly to a JS number rather than numeric's string
    // representation (which would otherwise need parsing at every
    // boundary just to avoid Postgres's own precision-preserving
    // string return). Nullable and independent of weightUnit at the
    // COLUMN level — the DTOs enforce "both or neither together" (see
    // hasStartedWeight), not the schema itself.
    weight: real('weight'),
    weightUnit: weightUnitEnum('weight_unit'),
    sortOrder: integer('sort_order').notNull(),
    notes: text('notes'),
  },
  (table) => ({
    templateIdIdx: index('template_exercises_template_id_idx').on(
      table.templateId,
    ),
    // A COMPOSITE foreign key: (workout_id, template_id) must be a
    // (id, template_id) pair of template_workouts. A plain foreign key on
    // workout_id alone would only say "some workout exists" — an exercise of
    // template 1 could then point at a workout of template 2, and nothing
    // would notice. Pairing it with template_id makes "a workout of THIS
    // template" a rule of the database itself.
    //
    // No onDelete: the default, NO ACTION. The app only deletes EMPTY
    // workouts, so a delete that still has exercises is a bug and must fail.
    // NO ACTION rather than RESTRICT for one case: deleting a whole template
    // (only the seed's --reset does) cascades to BOTH its workouts and its
    // exercises in one statement — RESTRICT checks immediately, mid-cascade,
    // and would fail; NO ACTION checks at the end of the statement, when
    // the exercises are gone too.
    workoutFk: foreignKey({
      name: 'template_exercises_workout_fk',
      columns: [table.workoutId, table.templateId],
      foreignColumns: [templateWorkouts.id, templateWorkouts.templateId],
    }),
  }),
)

export const assignedPrograms = pgTable(
  'assigned_programs',
  {
    id: serial('id').primaryKey(),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedBy: integer('assigned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    basedOnTemplateId: integer('based_on_template_id').references(
      () => programTemplates.id,
      { onDelete: 'set null' },
    ),
    // "Assign again" (step 2b-iii): the cancelled or completed program this
    // one continues — its tailored workouts and exercises were copied from
    // there. A program pointing at another row of its OWN table, hence the
    // `AnyPgColumn` annotation: TypeScript can't infer the type of a
    // variable from an expression that refers to that same variable, so the
    // callback's return type is spelled out. NO ACTION: a program others
    // continue can't be deleted on its own (the app never deletes programs
    // — it archives them — so this guards against direct queries); it is
    // checked at the END of the statement, so deleting a program together
    // with its continuation (the seed's reset deletes every program in one
    // statement) works. Same choice as step 2b-i's workout keys. (A mutation
    // check showed RESTRICT behaves the same HERE — no cascade ever deletes
    // programs; the two differ when rows go mid-cascade, as 2b-i's did.)
    basedOnProgramId: integer('based_on_program_id').references(
      (): AnyPgColumn => assignedPrograms.id,
      { onDelete: 'no action' },
    ),
    title: varchar('title', { length: 255 }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    // active → completed | cancelled, and those two are FINAL (decisions §5,
    // "Settled 2026-10-11"): changed only by POST …/complete and …/cancel.
    status: programStatusEnum('status').notNull().default('active'),
    isArchived: boolean('is_archived').notNull().default(false),
    // May the patient swap two days' workouts within a program week
    // (sessions.counts_for)? On by default; the practitioner can turn it off.
    // It governs NEW swaps only — swaps already recorded keep counting.
    allowSwaps: boolean('allow_swaps').notNull().default(true),
  },
  (table) => ({
    // findAllForCurrentUser() filters on this directly (patient) or via
    // inArray (practitioner's managed patients) — the single most-queried
    // column in this table.
    patientIdIdx: index('assigned_programs_patient_id_idx').on(table.patientId),
    // Dates are the source of truth for a program's length (decisions §5,
    // point 1): the number of sessions is DERIVED from them and the
    // schedule. An end before the start would make that derivation
    // meaningless (a negative number of weeks), so the database refuses it.
    // >= rather than >: a one-day program is legitimate. NULL = open-ended.
    endsAfterStart: check(
      'assigned_programs_ends_after_start',
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
    // A program can't continue itself.
    notBasedOnItself: check(
      'assigned_programs_not_based_on_itself',
      sql`${table.basedOnProgramId} IS NULL OR ${table.basedOnProgramId} <> ${table.id}`,
    ),
    // A title must hold something visible — see program_templates' CHECK
    // above (migration 0035; existing blank titles became "Untitled
    // program").
    titleNotBlank: check(
      'assigned_programs_title_not_blank',
      sql`length(btrim(${table.title})) > 0`,
    ),
  }),
)

// An assigned program's workouts: COPIED from the template's when the
// program is assigned (copy, not reference — the same rule as its
// exercises), then tailored per patient. Same shape and rules as
// template_workouts above. A program assigned from an inline exercise list
// gets one workout.
//
// Sessions record which workout they did (sessions.workout_id), so a
// workout that has sessions can't be deleted — its foreign key refuses, and
// the service says why first.
export const programWorkouts = pgTable(
  'program_workouts',
  {
    id: serial('id').primaryKey(),
    assignedProgramId: integer('assigned_program_id')
      .notNull()
      .references(() => assignedPrograms.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }),
    sortOrder: integer('sort_order').notNull(),
  },
  (table) => ({
    assignedProgramIdIdx: index('program_workouts_assigned_program_id_idx').on(
      table.assignedProgramId,
    ),
    nameNotBlank: check(
      'program_workouts_name_not_blank',
      sql`${table.name} IS NULL OR length(btrim(${table.name})) > 0`,
    ),
    // The target of the composite foreign keys from
    // assigned_program_exercises and sessions — see templateWorkouts.
    idProgramUnique: unique(
      'program_workouts_id_assigned_program_id_unique',
    ).on(table.id, table.assignedProgramId),
  }),
)

// A COPY of template_exercises, not a reference to it — same shape,
// independent rows. Originally this only meant the PRESCRIPTION fields
// (sets/reps/weight/duration/notes); exerciseId itself, and therefore
// the exercise's own name/muscles/equipment/instructions, stayed a live
// reference. That turned out to be a real gap: if a shared exercise's
// instructions changed after a program was already assigned, a patient
// could silently see something different from what was actually
// prescribed — a live reference is fine for a template still being
// iterated on, but not for a program a real patient is actively
// following. name/primaryMuscles/secondaryMuscles/equipment/
// instructions below are that same "copy, not reference" treatment
// extended to the exercise's own descriptive fields, snapshotted at the
// moment an exercise is added (whether via copying a template or adding
// one directly) and independently editable afterward per patient — same
// as sets/reps always have been. Deliberately NOT extended to
// mediaUrls/photos yet — see deferred-improvements.md for why that's a
// materially bigger, deferred piece of work (no copy-object capability
// in StorageService today, plus an ongoing per-assignment storage cost
// the text fields don't have).
export const assignedProgramExercises = pgTable(
  'assigned_program_exercises',
  {
    id: serial('id').primaryKey(),
    assignedProgramId: integer('assigned_program_id')
      .notNull()
      .references(() => assignedPrograms.id, { onDelete: 'cascade' }),
    // A workout of THIS program — composite foreign key below, same reasoning
    // as template_exercises'.
    workoutId: integer('workout_id').notNull(),
    exerciseId: integer('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'restrict' }),
    // Snapshotted from the exercise at add-time — see this table's own
    // comment above. Same column shapes as exercises' own
    // name/primaryMuscles/secondaryMuscles/equipment/instructions
    // (exercises.schema.ts), since this is literally the same kind of
    // data, just copied rather than referenced from here on.
    name: varchar('name', { length: 255 }).notNull(),
    primaryMuscles: text('primary_muscles').array().notNull().default([]),
    secondaryMuscles: text('secondary_muscles').array().notNull().default([]),
    equipment: text('equipment').array().notNull().default([]),
    instructions: text('instructions').array().notNull(),
    sets: integer('sets'),
    reps: integer('reps'),
    durationInSeconds: integer('duration_in_seconds'),
    // Same reasoning as templateExercises' own weight/weightUnit
    // columns — see that table's comment. This is genuinely the MORE
    // important of the two tables for weight specifically, since a
    // patient's actual prescribed weight (as opposed to a template's
    // default) is exactly the per-patient value that motivated adding
    // this field at all.
    weight: real('weight'),
    weightUnit: weightUnitEnum('weight_unit'),
    sortOrder: integer('sort_order').notNull(),
    notes: text('notes'),
    // RETIRED (step 3b-0, decided 2026-10-13): taken out of the program, but
    // kept, because a session recorded it — session_exercises points at this
    // row (ON DELETE RESTRICT), and that history must keep saying what was
    // done. A retired exercise is left out of new sessions' checklists and
    // of "Assign again", and can no longer change (migration 0033's trigger).
    // An exercise no session used is really DELETED instead: there is no
    // history to keep. Both columns or neither (the CHECK below), like
    // care_team_members' ends_at / ended_by.
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredBy: integer('retired_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => ({
    assignedProgramIdIdx: index(
      'assigned_program_exercises_assigned_program_id_idx',
    ).on(table.assignedProgramId),
    retiredTogether: check(
      'assigned_program_exercises_retired_together',
      sql`(${table.retiredAt} IS NULL) = (${table.retiredBy} IS NULL)`,
    ),
    // Same as template_exercises_workout_fk: the workout must belong to the
    // same program; NO ACTION for the same cascade reason.
    workoutFk: foreignKey({
      name: 'assigned_program_exercises_workout_fk',
      columns: [table.workoutId, table.assignedProgramId],
      foreignColumns: [programWorkouts.id, programWorkouts.assignedProgramId],
    }),
  }),
)
