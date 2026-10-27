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

// The messaging rules (Phase 5), as PURE functions — no database, no Nest.
// The service reads rows and writes them; every decision about what those
// rows mean is made here, where a unit test can try every case in
// milliseconds (the shape of session-rules.ts and alert-rules.ts). The
// database holds the same rules as triggers and policies (migration 0048);
// the e2e suites check the two agree.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { UserRole } from '../users/dto/create-user.dto'
import { MESSAGE_MAX_LENGTH } from '../database/schema/messaging.schema'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// A message can be deleted while it is UNREAD and at most this old — both
// conditions together. Narrower than a consumer chat's "delete any time" on
// purpose: clinical communication shouldn't silently disappear once the
// other person has seen it. Migration 0048's trigger holds the same 15
// minutes.
export const DELETE_WINDOW_MS = 15 * 60 * 1000

// A thread is read a page at a time (GET /conversations/:id/messages):
// 50 by default, at most 100 per request.
export const MESSAGE_PAGE_SIZE = 50
export const MESSAGE_PAGE_MAX = 100

// --- MESSAGES ---
// Written once, here, so the service, the WebSocket path, the exception
// filter (for a database refusal) and the tests all say the same words.

export const BLANK_MESSAGE_MESSAGE = "A message can't be blank"
export const MESSAGE_TOO_LONG_MESSAGE = `A message can be at most ${MESSAGE_MAX_LENGTH} characters`
export const START_NOT_ON_CARE_TEAM_MESSAGE =
  'You can only start a conversation with someone you share a care team with'
// Sending into a conversation whose care-team link has ended: the history
// stays readable, writing is refused (decided 2026-10-20). Neutral words —
// the same sentence reaches the patient and the practitioner.
export const READ_ONLY_CONVERSATION_MESSAGE =
  "You're no longer on a care team together, so this conversation is read-only"
// Writing to a deactivated patient — sending, or starting a conversation —
// while still on their care team (decided 2026-10-27, decisions §22). A 409,
// not the 403 above: the writer still has the right (they ARE on the team);
// the patient's state is in the way, and reactivating the account clears it.
// Only a practitioner can ever read it: a deactivated patient can't sign in.
export const DEACTIVATED_PATIENT_MESSAGING_MESSAGE =
  "This patient's account is deactivated, so the conversation is read-only until the account is reactivated"
export const NOT_PARTICIPANT_MESSAGE =
  'You are not a participant in this conversation'
export const NOT_YOUR_MESSAGE_MESSAGE = 'You can only delete your own messages'
export const MESSAGE_ALREADY_READ_MESSAGE =
  'This message has already been read, so it can no longer be deleted'
export const DELETE_WINDOW_PASSED_MESSAGE =
  'This message can no longer be deleted: the 15 minutes have passed'
// The database's refusal (0048's trigger), reached only by a request that
// raced another — it can't tell which condition failed, so it names both.
export const MESSAGE_NOT_DELETABLE_MESSAGE =
  'This message can no longer be deleted: it has been read, or the 15 minutes have passed'
// The other guards' refusals — unreachable through the API (the service
// never asks for those changes), kept readable all the same.
export const MESSAGE_FIXED_MESSAGE = 'A message can no longer change once sent'
export const CONVERSATION_FIXED_MESSAGE =
  'Who a conversation is between can no longer change'

// --- TYPES -------------------------------------------------------------------------------------------------

type Actor = { id: number; activeRole: UserRole }

// Which side of a conversation someone is on. A conversation is always
// between ONE practitioner and ONE patient (the UNIQUE pair of the schema).
export type Side = 'practitioner' | 'patient'

// The parts of a conversation row the rules read.
export interface ConversationParticipants {
  practitionerId: number
  patientId: number
}

// A message row, as the database stores it.
export interface MessageRow {
  id: number
  conversationId: number
  senderId: number
  messageBody: string
  sentAt: Date
  readAt: Date | null
  deletedAt: Date | null
}

// A message as the API serves it: the same fields, except that a deleted
// message's text is NOT sent (`null`) — to anyone, sender included. The row
// keeps it (a soft delete: clinical communication is never destroyed, and
// the audit trail points at it), but the person reading the thread sees
// that a message was deleted, not what it said.
//
// Why `null` and not a placeholder string ("[message deleted]", as before):
// words for people belong to the screens (one language, one place), and a
// placeholder can't be told apart from a real message saying the same
// thing. `deletedAt` says it was deleted; the screen chooses the words.
export interface PublicMessage {
  id: number
  conversationId: number
  senderId: number
  messageBody: string | null
  sentAt: Date
  readAt: Date | null
  deletedAt: Date | null
}

// One conversation, as one viewer sees it — the conversation list's rows
// and GET /conversations/:id. Everything is from THIS viewer's point of
// view: the other person, my unread count, my archive.
export interface ConversationSummary {
  id: number
  otherParticipant: {
    id: number
    firstName: string
    lastName: string
    avatarUrl: string | null
  }
  // The newest message (a deleted one too, without its text) — the list's
  // preview and its sort key. null while nobody has written yet.
  lastMessage: PublicMessage | null
  // Messages from the other person that I haven't read (deleted ones never
  // count: there is nothing left to read).
  unreadCount: number
  // When I archived it (null = in my list). Only MY archive: the other
  // participant's is theirs alone.
  archivedAt: Date | null
  // Whether I can write here now: the two of us are on a care team
  // together, and the patient's account is active. false = a read-only
  // history (decided 2026-10-20; the account since 2026-10-27).
  canSend: boolean
  // WHY it's read-only, for the screen's words — null when canSend is true.
  readOnlyReason: ReadOnlyReason | null
  createdAt: Date
}

// 'care_team_ended': the two are no longer on a care team together.
// 'patient_deactivated': they are, but the patient's account is
// deactivated (decisions §22) — reactivating it would make it writable.
export type ReadOnlyReason = 'care_team_ended' | 'patient_deactivated'

// From the database's two answers about the pair (MessagingService asks
// both in the list's query, with the very functions the write policies use):
// may they write (rls_can_message), and are they on a care team together
// (rls_care_team_member). The care team is checked first: when the link has
// ended, that's the answer even if the account is deactivated too —
// reactivating wouldn't make the conversation writable.
export function readOnlyReason(pair: {
  canSend: boolean
  onCareTeam: boolean
}): ReadOnlyReason | null {
  if (pair.canSend) return null
  return pair.onCareTeam ? 'patient_deactivated' : 'care_team_ended'
}

// --- WHO IS WHO --------------------------------------------------------------------------------------------

// The side `actor` is on, or null when they aren't in this conversation.
// Their ACTIVE role decides, not just their id: Morgan, practitioner and
// patient, signed in as a practitioner, is not the patient of a
// conversation even when the patient id is theirs — the same reading the
// row security policies make (app.current_role).
export function participantSide(
  conversation: ConversationParticipants,
  actor: Actor,
): Side | null {
  if (
    actor.activeRole === UserRole.PRACTITIONER &&
    conversation.practitionerId === actor.id
  ) {
    return 'practitioner'
  }
  if (
    actor.activeRole === UserRole.PATIENT &&
    conversation.patientId === actor.id
  ) {
    return 'patient'
  }
  return null
}

// The other participant's id, seen from `side`.
export function otherParticipantId(
  conversation: ConversationParticipants,
  side: Side,
): number {
  return side === 'practitioner'
    ? conversation.patientId
    : conversation.practitionerId
}

// The column holding MY archive moment — each participant archives only
// their own view.
export function archiveColumn(
  side: Side,
): 'practitionerArchivedAt' | 'patientArchivedAt' {
  return side === 'practitioner'
    ? 'practitionerArchivedAt'
    : 'patientArchivedAt'
}

// --- MESSAGES ----------------------------------------------------------------------------------------------

export function toPublicMessage(message: MessageRow): PublicMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    messageBody: message.deletedAt ? null : message.messageBody,
    sentAt: message.sentAt,
    readAt: message.readAt,
    deletedAt: message.deletedAt,
  }
}

// Why `actorId` may NOT delete `message` at `now`, or null when they may.
// Checked in this order, because the first answer is the most useful one:
// someone else's message (403) — whatever its state, it was never yours to
// delete; then read (409: it was yours, but it has been seen); then the
// window (409). A message ALREADY deleted is the caller's business, not
// this function's: deleting it again changes nothing (an idempotent 200).
//
// "Older than the window" is strictly greater: at exactly 15 minutes it can
// still go — the trigger's `now() - sent_at > interval '15 minutes'`.
export type DeleteRefusal = 'not_sender' | 'read' | 'window_passed'

export function deleteRefusal(
  message: Pick<MessageRow, 'senderId' | 'readAt' | 'sentAt'>,
  actorId: number,
  now: Date,
): DeleteRefusal | null {
  if (message.senderId !== actorId) return 'not_sender'
  if (message.readAt !== null) return 'read'
  if (now.getTime() - message.sentAt.getTime() > DELETE_WINDOW_MS) {
    return 'window_passed'
  }
  return null
}

// --- PAGES -------------------------------------------------------------------------------------------------

// A page of a thread. The query asks for `limit + 1` rows, NEWEST first
// (the index walks backwards from `before`): if the extra row came back,
// there is more history before this page. The page itself is served
// OLDEST first — the order a thread is read in — so a screen appends it as
// it comes.
export function takePage<T>(
  newestFirst: T[],
  limit: number,
): { messages: T[]; hasMore: boolean } {
  const hasMore = newestFirst.length > limit
  return { messages: newestFirst.slice(0, limit).reverse(), hasMore }
}

// --- THE LIST ----------------------------------------------------------------------------------------------

// What the list shows: conversations with at least one message. A
// conversation is created by opening it (the "Message" buttons), before
// anything is written; listing it then would put an empty row in the OTHER
// person's list ("Alex Chen — no messages") for a conversation they never
// joined. Opened directly (GET /conversations/:id), an empty one is served
// all the same.
export function isListed(summary: ConversationSummary): boolean {
  return summary.lastMessage !== null
}

// Newest activity first: the last message's moment, or the conversation's
// own start while it's empty; the id breaks a tie (newer conversations have
// higher ids), so the order never depends on how the database returned the
// rows.
export function compareByActivity(
  a: ConversationSummary,
  b: ConversationSummary,
): number {
  const at = (s: ConversationSummary) =>
    (s.lastMessage?.sentAt ?? s.createdAt).getTime()
  return at(b) - at(a) || b.id - a.id
}
