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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.schema";
import { exercises } from "./exercises.schema";
// Defined in its own file (see the comment there): users.schema.ts needs
// it too, and importing it from HERE would make the two files import each
// other.
import { weightUnitEnum } from "./weight-unit.schema";

export const programStatusEnum = pgEnum("program_status", [
  "active",
  "completed",
  "on_hold",
  "cancelled",
]);

export const programTemplates = pgTable("program_templates", {
  id: serial("id").primaryKey(),
  practitionerId: integer("practitioner_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  isArchived: boolean("is_archived").notNull().default(false),
});

export const templateExercises = pgTable(
  "template_exercises",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => programTemplates.id, { onDelete: "cascade" }),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "restrict" }),
    // sets / reps / durationInSeconds are deliberately all nullable — a timed hold has
    // a duration but no reps; a rep-based exercise has reps but no duration.
    sets: integer("sets"),
    reps: integer("reps"),
    durationInSeconds: integer("duration_in_seconds"),
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
    weight: real("weight"),
    weightUnit: weightUnitEnum("weight_unit"),
    sortOrder: integer("sort_order").notNull(),
    notes: text("notes"),
  },
  (table) => ({
    templateIdIdx: index("template_exercises_template_id_idx").on(
      table.templateId,
    ),
  }),
);

export const assignedPrograms = pgTable(
  "assigned_programs",
  {
    id: serial("id").primaryKey(),
    patientId: integer("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedBy: integer("assigned_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    basedOnTemplateId: integer("based_on_template_id").references(
      () => programTemplates.id,
      { onDelete: "set null" },
    ),
    title: varchar("title", { length: 255 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    status: programStatusEnum("status").notNull().default("active"),
    isArchived: boolean("is_archived").notNull().default(false),
  },
  (table) => ({
    // findAllForCurrentUser() filters on this directly (patient) or via
    // inArray (practitioner's managed patients) — the single most-queried
    // column in this table.
    patientIdIdx: index("assigned_programs_patient_id_idx").on(table.patientId),
    // Dates are the source of truth for a program's length (decisions §5,
    // point 1): the number of sessions is DERIVED from them and the
    // schedule. An end before the start would make that derivation
    // meaningless (a negative number of weeks), so the database refuses it.
    // >= rather than >: a one-day program is legitimate. NULL = open-ended.
    endsAfterStart: check(
      "assigned_programs_ends_after_start",
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
  }),
);

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
  "assigned_program_exercises",
  {
    id: serial("id").primaryKey(),
    assignedProgramId: integer("assigned_program_id")
      .notNull()
      .references(() => assignedPrograms.id, { onDelete: "cascade" }),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "restrict" }),
    // Snapshotted from the exercise at add-time — see this table's own
    // comment above. Same column shapes as exercises' own
    // name/primaryMuscles/secondaryMuscles/equipment/instructions
    // (exercises.schema.ts), since this is literally the same kind of
    // data, just copied rather than referenced from here on.
    name: varchar("name", { length: 255 }).notNull(),
    primaryMuscles: text("primary_muscles").array().notNull().default([]),
    secondaryMuscles: text("secondary_muscles").array().notNull().default([]),
    equipment: text("equipment").array().notNull().default([]),
    instructions: text("instructions").array().notNull(),
    sets: integer("sets"),
    reps: integer("reps"),
    durationInSeconds: integer("duration_in_seconds"),
    // Same reasoning as templateExercises' own weight/weightUnit
    // columns — see that table's comment. This is genuinely the MORE
    // important of the two tables for weight specifically, since a
    // patient's actual prescribed weight (as opposed to a template's
    // default) is exactly the per-patient value that motivated adding
    // this field at all.
    weight: real("weight"),
    weightUnit: weightUnitEnum("weight_unit"),
    sortOrder: integer("sort_order").notNull(),
    notes: text("notes"),
  },
  (table) => ({
    assignedProgramIdIdx: index(
      "assigned_program_exercises_assigned_program_id_idx",
    ).on(table.assignedProgramId),
  }),
);