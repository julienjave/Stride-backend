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


import { pgTable, serial, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

export const medicalFiles = pgTable('medical_files', {
    id: serial('id').primaryKey(),
    patientId: integer('patient_id')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    createdBy: integer('created_by')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Unlike the array .default([]), a raw sql`` template is used here — Drizzle's plain
    // .default({}) would try to insert a JS object, not tell Postgres "empty jsonb object".
    // sql`` drops a literal fragment of real SQL straight into the generated migration.
    clinicalData: jsonb('clinical_data').notNull().default(sql`'{}'::jsonb`),
}, (table) => ({
  // Every findAll()/findOne() call filters on this — the exact column
  // ACCESS_MEDICAL_FILE(_LIST) auditing runs against constantly.
  patientIdIdx: index('medical_files_patient_id_idx').on(table.patientId),
}))
