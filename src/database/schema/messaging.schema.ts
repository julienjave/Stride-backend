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


import { pgTable, serial, bigserial, integer, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { users } from './users.schema'
import { table } from 'console'

export const conversations = pgTable('conversations', {
    id: serial('id').primaryKey(),
    practitionerId: integer('practitioner_id')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    patientId: integer('patient_id')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
}, (table) => ({
    practitionerPatientUnique: unique('conversations_practitioner_patient_unique')
        .on(table.practitionerId, table.patientId),
}))

// bigserial, because messages is one of the tables we expect real growth on.
// { mode: 'number' } tells Drizzle to hand us back a normal JS number rather than
// a JS BigInt — simpler to work with, and fine up to ~9 quadrillion rows, which is
// far beyond what this app will ever need.
export const messages = pgTable('messages', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: integer('conversation_id')
        .notNull()
        .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id')
        .notNull()
        .references(() => users.id, { onDelete: 'restrict' }),
    messageBody: text('message_body').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
})
