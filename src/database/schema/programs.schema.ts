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


import { pgTable, serial, integer, varchar, text, boolean, date, pgEnum, index } from 'drizzle-orm/pg-core'
import { users } from './users.schema'
import { exercises } from './exercises.schema'
 

export const programStatusEnum = pgEnum('program_status', ['active', 'completed', 'on_hold', 'cancelled'])

export const programTemplates = pgTable('program_templates', {
    id: serial('id').primaryKey(),
    practitionerId: integer('practitioner_id')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    isArchived: boolean('is_archived').notNull().default(false),
})

export const templateExercises = pgTable('template_exercises', {
    id: serial('id').primaryKey(),
    templateId: integer('template_id')
        .notNull()
        .references(() => programTemplates.id, { onDelete: 'cascade' }),
    exerciseId: integer('exercise_id')
        .notNull()
        .references(() => exercises.id, { onDelete: 'restrict' }),
    // sets / reps / durationInSeconds are deliberately all nullable — a timed hold has
    // a duration but no reps; a rep-based exercise has reps but no duration.
    sets: integer('sets'),
    reps: integer('reps'),
    durationInSeconds: integer('duration_in_seconds'),
    sortOrder: integer('sort_order').notNull(),
    notes: text('notes'),
}, (table) => ({
  templateIdIdx: index('template_exercises_template_id_idx').on(table.templateId),
}))

export const assignedPrograms = pgTable('assigned_programs', {
    id: serial('id').primaryKey(),
    patientId: integer('patient_id')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    assignedBy: integer('assigned_by')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    basedOnTemplateId: integer('based_on_template_id')
        .references(() => programTemplates.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 255 }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    status: programStatusEnum('status').notNull().default('active'),
    isArchived: boolean('is_archived').notNull().default(false),
}, (table) => ({
  // findAllForCurrentUser() filters on this directly (patient) or via
  // inArray (practitioner's managed patients) — the single most-queried
  // column in this table.
  patientIdIdx: index('assigned_programs_patient_id_idx').on(table.patientId),
}))

// A COPY of template_exercises, not a reference to it — same shape, independent rows.
export const assignedProgramExercises = pgTable('assigned_program_exercises', {
    id: serial('id').primaryKey(),
    assignedProgramId: integer('assigned_program_id')
        .notNull()
        .references(() => assignedPrograms.id, { onDelete: 'cascade' }),
    exerciseId: integer('exercise_id')
        .notNull()
        .references(() => exercises.id, { onDelete: 'restrict' }),
    sets: integer('sets'),
    reps: integer('reps'),
    durationInSeconds: integer('duration_in_seconds'),
    sortOrder: integer('sort_order').notNull(),
    notes: text('notes'),
}, (table) => ({
  assignedProgramIdIdx: index('assigned_program_exercises_assigned_program_id_idx').on(table.assignedProgramId),
}))
