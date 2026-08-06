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
  bigserial,
  bigint,
  integer,
  varchar,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'
import { users } from './users.schema'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    performedBy: integer('performed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: varchar('action', { length: 100 }).notNull(),
    targetUserId: integer('target_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    // BIGINT because this polymorphically points at whichever table entity_type names —
    // it has to be wide enough for the widest possible ID it might hold (messages,
    // sessions, session_exercises all use bigserial), even though most rows it points
    // at will be from serial (int) tables. Better to always be wide enough than to
    // silently risk overflow for some entity types and not others.
    entityId: bigint('entity_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    details: jsonb('details'),
  },
  (table) => ({
    performedByIdx: index('audit_logs_performed_by_idx').on(table.performedBy),
    entityTypeIdx: index('audit_logs_entity_type_idx').on(table.entityType),
  }),
)
