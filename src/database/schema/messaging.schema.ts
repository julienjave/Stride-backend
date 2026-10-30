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
  bigserial,
  integer,
  text,
  timestamp,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

// The longest message, in characters — ONE constant for the DTO rule
// (IsMessageBody) and the database CHECK below, so the two can't drift.
export const MESSAGE_MAX_LENGTH = 5000

export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    practitionerId: integer('practitioner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    patientId: integer('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    practitionerArchivedAt: timestamp('practitioner_archived_at', {
      withTimezone: true,
    }),
    patientArchivedAt: timestamp('patient_archived_at', { withTimezone: true }),
    // When each side was last EMAILED about this conversation's unread
    // messages (roadmap Phase 6.5, "new-message emails"); NULL = not since
    // they last read it. The sweep emails a side only while this is NULL,
    // and sets it in the same statement that claims the work — so a person
    // gets ONE email per conversation, however many messages pile up, until
    // they read it: reading (PATCH …/read) puts it back to NULL. Only the
    // claim function (SECURITY DEFINER, migration 0075) may SET it; the
    // app's role may only clear it — guard_conversation_update says so.
    practitionerNotifiedAt: timestamp('practitioner_notified_at', {
      withTimezone: true,
    }),
    patientNotifiedAt: timestamp('patient_notified_at', { withTimezone: true }),
    // When the conversation was started (Phase 5). The list sorts by the
    // latest message; a conversation started but still empty needs a moment
    // of its own. Existing rows get the moment the migration runs — their
    // real start wasn't recorded, and the list never shows an empty
    // conversation to the person who didn't start it anyway.
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    practitionerPatientUnique: unique(
      'conversations_practitioner_patient_unique',
    ).on(table.practitionerId, table.patientId),
    practitionerIdIdx: index('conversations_practitioner_id_idx').on(
      table.practitionerId,
    ),
    patientIdIdx: index('conversations_patient_id_idx').on(table.patientId),
  }),
)

// bigserial, because messages is one of the tables we expect real growth on.
// { mode: 'number' } tells Drizzle to hand us back a normal JS number rather than
// a JS BigInt — simpler to work with, and fine up to ~9 quadrillion rows, which is
// far beyond what this app will ever need.
export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    messageBody: text('message_body').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A thread is read a PAGE at a time, newest first, older pages asked
    // for with `?before=<id>` (Phase 5): "WHERE conversation_id = $1 AND
    // id < $2 ORDER BY id DESC LIMIT 50". An index on (conversation_id, id)
    // answers that by walking backwards from one point — however long the
    // conversation, a page costs the same. It replaces the index on
    // conversation_id alone, which this one also serves (its first column).
    conversationIdIdx: index('messages_conversation_id_id_idx').on(
      table.conversationId,
      table.id,
    ),
    // The unread counts (the list, the tab badge, the home card) count the
    // rows nobody has read or deleted, per conversation. A PARTIAL index
    // holds only those rows — usually a handful, whatever the history's
    // size — so counting them never reads the read ones.
    unreadIdx: index('messages_unread_idx')
      .on(table.conversationId)
      .where(sql`${table.readAt} IS NULL AND ${table.deletedAt} IS NULL`),
    // The database's half of IsMessageBody (the DTO rule): at least one
    // character that isn't white space — the same `\S` test, so a message of
    // tabs or new lines is refused by both — and at most MESSAGE_MAX_LENGTH
    // characters (char_length counts characters, as JavaScript's length
    // does for the text people type; an emoji outside the basic plane is 2
    // in JavaScript and 1 here, so the DTO is the stricter of the two).
    bodyNotBlank: check(
      'messages_body_not_blank',
      sql`${table.messageBody} ~ '\\S'`,
    ),
    bodyMaxLength: check(
      'messages_body_max_length',
      sql`char_length(${table.messageBody}) <= ${sql.raw(String(MESSAGE_MAX_LENGTH))}`,
    ),
  }),
)
