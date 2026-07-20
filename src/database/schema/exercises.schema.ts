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


import { pgTable, serial, varchar, text, integer, boolean, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'
import { table } from 'console'


export const exerciseSourceEnum = pgEnum('exercise_source', ['api', 'custom'])

export const exercises = pgTable('exercises', {
    id: serial('id').primaryKey(),
    externalId: varchar('external_id', { length: 255 }),
    name: varchar('name', { length: 255 }).notNull(),
    primaryMuscles: text('primary_muscles').array().notNull().default([]),
    secondaryMuscles: text('secondary_muscles').array().notNull().default([]),
    equipment: text('equipment').array().notNull().default([]),
    instructions: text('instructions').notNull(),
    mediaUrls: text('media_urls').array().notNull().default([]),
    source: exerciseSourceEnum('source').notNull(),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isArchived: boolean('is_archived').notNull().default(false),
}, (table) => ({
    // A PARTIAL unique index: the .where() means the constraint only applies to rows
    // where it's true. Custom exercises (external_id = null) never collide with each
    // other or block one another — only two rows both claiming the same real
    // external_id would be rejected.
    externalIdUnique: uniqueIndex('exercises_external_id_unique')
        .on(table.externalId)
        .where(sql`${table.externalId} IS NOT NULL`),
}))
