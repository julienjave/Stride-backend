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
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { conversations, messages, users } from '../database/schema'
import { withRlsContext } from '../database/rls-context'
import { isRowSecurityViolation } from '../database/pg-errors'
import { UsersService } from '../users/users.service'
import { StorageService } from '../storage/storage.service'
import { AuditService } from '../audit/audit.service'
import { AVATAR_URL_EXPIRY_SECONDS } from '../common/config/avatar.config'
import { UserRole } from '../users/dto/create-user.dto'
import { CreateConversationDto } from './dto/create-conversation.dto'
import { MessagingEvents } from './messaging-events'
import {
  MESSAGE_ALREADY_READ_MESSAGE,
  DELETE_WINDOW_PASSED_MESSAGE,
  MESSAGE_PAGE_SIZE,
  NOT_PARTICIPANT_MESSAGE,
  NOT_YOUR_MESSAGE_MESSAGE,
  READ_ONLY_CONVERSATION_MESSAGE,
  START_NOT_ON_CARE_TEAM_MESSAGE,
  archiveColumn,
  compareByActivity,
  deleteRefusal,
  isListed,
  participantSide,
  takePage,
  toPublicMessage,
  type ConversationSummary,
  type PublicMessage,
  type Side,
} from './message-rules'

// --- TYPES -------------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

// A conversation row, as the service reads it.
interface ConversationRow {
  id: number
  practitionerId: number
  patientId: number
  practitionerArchivedAt: Date | null
  patientArchivedAt: Date | null
  createdAt: Date
}

// What PATCH /conversations/:id/read answers — and the conversationRead
// event carries: which messages became read, and when. Reading a thread
// with nothing new answers `readAt: null, messageIds: []` (and writes
// nothing).
export interface ReadReceipt {
  conversationId: number
  readAt: Date | null
  messageIds: number[]
}

export const STAFF_AND_PATIENTS_ONLY_MESSAGE =
  'Only practitioners and patients can use messaging'

// --- SERVICE -----------------------------------------------------------------------------------------------

// Messaging between a patient and the practitioners on their care team
// (Phase 5). The shape every write follows — the conventions of Phases 3–4:
//   1. one transaction under the caller's row security context
//      (withRlsContext): the database's policies apply to every query;
//   2. the service's own checks first, each with a specific answer (404,
//      403, 409) — the database's policies and triggers (migration 0048)
//      hold the same rules underneath, for any query under the app's role;
//   3. ONE complete audit entry in the same transaction
//      (AuditService.logInTransaction — the routes are @AuditedByService());
//      a request that changes nothing writes nothing;
//   4. AFTER the commit, the change is pushed to open browsers
//      (MessagingEvents) — never before: an event for a write that then
//      rolled back would show people a message that doesn't exist.
// Both doors — the REST controller and the WebSocket gateway — call these
// same methods, so they can't behave differently.
@Injectable()
export class MessagingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly storageService: StorageService,
    private readonly auditService: AuditService,
    private readonly events: MessagingEvents,
  ) {}

  // === ROUTES =============================================================

  // --- POST /conversations ---

  // "Start or get": the conversation between me and `dto.userId` — created
  // if it doesn't exist yet, the existing one otherwise. Both answer 201 with
  // the conversation's summary, so a "Message" button can simply open
  // whatever comes back.
  //
  // Starting one needs a CURRENT care-team link between the two (the service
  // asks the care team; conversations_insert asks the database). An
  // existing conversation whose link has ended is NOT reopened here — it is
  // reachable from the list, read-only.
  async createConversation(
    currentUser: CurrentUser,
    dto: CreateConversationDto,
  ): Promise<ConversationSummary> {
    const side = sideOf(currentUser)
    const practitionerId = side === 'practitioner' ? currentUser.id : dto.userId
    const patientId = side === 'patient' ? currentUser.id : dto.userId

    const onCareTeam = await this.usersService.isPatientManagedBy(
      patientId,
      practitionerId,
    )
    if (!onCareTeam) {
      throw new ForbiddenException(START_NOT_ON_CARE_TEAM_MESSAGE)
    }

    return withRlsContext(this.db, currentUser, async (tx) => {
      // ON CONFLICT DO NOTHING on the pair's UNIQUE constraint: two
      // "Message" taps at once (two tabs, a double click) can't create two
      // conversations, and neither gets an error — the second insert inserts
      // nothing, atomically. (Before, a "look, then insert" let both look,
      // both find nothing, and the second insert fail with a 500.)
      const [created] = await tx
        .insert(conversations)
        .values({ practitionerId, patientId })
        .onConflictDoNothing({
          target: [conversations.practitionerId, conversations.patientId],
        })
        .returning({ id: conversations.id })

      let id: number
      if (created) {
        id = created.id
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'CONVERSATION_STARTED',
          targetUserId: patientId,
          entityType: 'conversations',
          entityId: id,
          details: { practitionerId, patientId },
        })
      } else {
        const [existing] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.practitionerId, practitionerId),
              eq(conversations.patientId, patientId),
            ),
          )
        id = existing.id
      }
      const [summary] = await this.summarize(tx, currentUser, [id])
      return summary
    })
  }

  // --- POST /conversations/:id/messages, and the `sendMessage` event ---

  // Sends a message, and pushes it to both participants' open connections.
  // Only while the two are on a care team together: a conversation whose
  // link has ended answers 403 READ_ONLY_CONVERSATION_MESSAGE.
  //
  // WHO decides that: the database, at the moment of writing
  // (messages_insert, migration 0048) — and nothing before it. A check here
  // first ("if (!canSend) refuse") would read the care team, then write a
  // moment later: a link ended in between would slip through the check and
  // be caught by the policy anyway. Two layers giving the same answer can't
  // be told apart by any test (a mutation removing the check survived), and
  // the policy is the one that's atomic — so it is the only one. The same
  // pattern as a UNIQUE constraint deciding a duplicate (isUniqueViolation
  // → 409) instead of a "look, then insert".
  //
  // A new message brings the conversation back from BOTH participants'
  // archives (decided 2026-10-20): archiving clears a conversation until
  // something new happens, so nothing clinical sits unseen in an archive.
  async sendMessage(
    conversationId: number,
    currentUser: CurrentUser,
    messageBody: string,
  ): Promise<PublicMessage> {
    const { message, conversation } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const conversation = await this.loadConversation(
          tx,
          conversationId,
          currentUser,
        )
        requireSide(conversation, currentUser)

        // sent_at isn't sent: the trigger writes the database's now().
        let row: typeof messages.$inferSelect
        try {
          ;[row] = await tx
            .insert(messages)
            .values({ conversationId, senderId: currentUser.id, messageBody })
            .returning()
        } catch (error) {
          // The policy's refusal. Everything else it checks is settled
          // already — the sender is the caller (set just above), and
          // requireSide proved they're a participant — so the one reason
          // left is the care-team link: none between the two right now.
          if (isRowSecurityViolation(error)) {
            throw new ForbiddenException(READ_ONLY_CONVERSATION_MESSAGE)
          }
          throw error
        }

        const unarchivedFor: Side[] = []
        if (conversation.practitionerArchivedAt)
          unarchivedFor.push('practitioner')
        if (conversation.patientArchivedAt) unarchivedFor.push('patient')
        if (unarchivedFor.length > 0) {
          await tx
            .update(conversations)
            .set({ practitionerArchivedAt: null, patientArchivedAt: null })
            .where(eq(conversations.id, conversationId))
        }

        // The entry points at the message; it doesn't copy the text. The
        // row IS the record — its text can never change (0048's guard) and
        // the row is never removed (a delete is soft) — so a copy would
        // only be a second place holding clinical content.
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'MESSAGE_SENT',
          targetUserId: conversation.patientId,
          entityType: 'messages',
          entityId: row.id,
          details: {
            conversationId,
            sentAt: row.sentAt,
            ...(unarchivedFor.length > 0 ? { unarchivedFor } : {}),
          },
        })
        return { message: toPublicMessage(row), conversation }
      },
    )
    this.events.toParticipants(conversation, 'newMessage', message)
    return message
  }

  // --- GET /conversations ---

  // My conversation list: every conversation I'm in that has at least one
  // message (isListed), archived ones INCLUDED with their `archivedAt` — the
  // screen puts them behind "Show N archived" (one request; the pattern of
  // ShowHiddenToggle) — newest activity first.
  async findConversationsForUser(
    currentUser: CurrentUser,
  ): Promise<ConversationSummary[]> {
    sideOf(currentUser)
    const all = await withRlsContext(this.db, currentUser, (tx) =>
      this.summarize(tx, currentUser),
    )
    return all.filter(isListed).sort(compareByActivity)
  }

  // --- GET /conversations/:id ---

  // One conversation's summary — the thread's header (who, can I write).
  // Served even while empty: it's what a "Message" button opens.
  async findOne(
    id: number,
    currentUser: CurrentUser,
  ): Promise<ConversationSummary> {
    sideOf(currentUser)
    const [summary] = await withRlsContext(this.db, currentUser, (tx) =>
      this.summarize(tx, currentUser, [id]),
    )
    if (!summary) {
      throw new NotFoundException(`Conversation ${id} not found`)
    }
    return summary
  }

  // --- GET /conversations/:id/messages?before=&limit= ---

  // One page of the thread, oldest first, and whether older messages exist
  // (`hasMore` — the screen's "load earlier" as you scroll up). Deleted
  // messages come with their text removed, for everyone (toPublicMessage —
  // before Phase 5 only the delete's own answer hid it, and the history
  // served it again to the recipient).
  async getMessages(
    conversationId: number,
    currentUser: CurrentUser,
    page: { before?: number; limit?: number } = {},
  ): Promise<{ messages: PublicMessage[]; hasMore: boolean }> {
    const limit = page.limit ?? MESSAGE_PAGE_SIZE
    return withRlsContext(this.db, currentUser, async (tx) => {
      const conversation = await this.loadConversation(
        tx,
        conversationId,
        currentUser,
      )
      requireSide(conversation, currentUser)
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            page.before === undefined
              ? undefined
              : lt(messages.id, page.before),
          ),
        )
        // By id, not sent_at: ids are unique and grow with every insert, so
        // the order is total and stable, and `before` can point at one exact
        // row. (Two messages written in one transaction share a sent_at.)
        .orderBy(desc(messages.id))
        .limit(limit + 1)
      return takePage(rows.map(toPublicMessage), limit)
    })
  }

  // --- PATCH /conversations/:id/read ---

  // Marks the other person's unread messages as read, at the database's
  // now(); pushes a conversationRead to both participants (the sender's
  // "Seen", my other tabs' badge). Deleted messages are left alone — there
  // is nothing to read, and "read" can't be set on them (0048).
  //
  // IDEMPOTENT: nothing unread = nothing written, no entry, no event.
  //
  // Audited: who read which messages, when. Reading someone's clinical
  // messages is the kind of access HIPAA's audit controls ask to be
  // traceable — and here the read is already a write (read_at), so the
  // entry costs nothing extra.
  async markAsRead(
    conversationId: number,
    currentUser: CurrentUser,
  ): Promise<ReadReceipt> {
    const { receipt, conversation } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const conversation = await this.loadConversation(
          tx,
          conversationId,
          currentUser,
        )
        requireSide(conversation, currentUser)
        const read = await tx
          .update(messages)
          .set({ readAt: sql`now()` })
          .where(
            and(
              eq(messages.conversationId, conversationId),
              ne(messages.senderId, currentUser.id),
              isNull(messages.readAt),
              isNull(messages.deletedAt),
            ),
          )
          .returning({ id: messages.id, readAt: messages.readAt })
        if (read.length === 0) {
          const nothing: ReadReceipt = {
            conversationId,
            readAt: null,
            messageIds: [],
          }
          return { receipt: nothing, conversation }
        }
        const messageIds = read.map((m) => m.id).sort((a, b) => a - b)
        // Every row of one UPDATE got the same now() (the transaction's).
        const readAt = read[0].readAt
        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'CONVERSATION_READ',
          targetUserId: conversation.patientId,
          entityType: 'conversations',
          entityId: conversationId,
          details: { messageIds, readAt },
        })
        return { receipt: { conversationId, readAt, messageIds }, conversation }
      },
    )
    if (receipt.readAt !== null) {
      this.events.toParticipants(conversation, 'conversationRead', {
        conversationId,
        readerId: currentUser.id,
        readAt: receipt.readAt,
        messageIds: receipt.messageIds,
      })
    }
    return receipt
  }

  // --- PATCH /conversations/:id/archive and /unarchive ---

  // Each participant archives only their OWN view (their column). Allowed on
  // a read-only conversation too: tidying your own list isn't writing to the
  // other person. Idempotent — archiving an archived conversation keeps its
  // first moment and writes nothing. Answers the summary, so the screen
  // moves the row at once; my other tabs hear conversationArchived.
  async archiveConversation(
    id: number,
    currentUser: CurrentUser,
  ): Promise<ConversationSummary> {
    return this.setArchived(id, currentUser, true)
  }

  async unarchiveConversation(
    id: number,
    currentUser: CurrentUser,
  ): Promise<ConversationSummary> {
    return this.setArchived(id, currentUser, false)
  }

  // --- DELETE /conversations/:id/messages/:messageId, and `deleteMessage` ---

  // Deletes one of MY messages — while it is unread and at most 15 minutes
  // old (deleteRefusal says which rule refuses: 403 someone else's message,
  // 409 already read, 409 too old). A SOFT delete: deleted_at is set, the
  // text stays in the row (and the audit entry points at it), and every
  // reader — me included — gets it without its text from now on.
  // Deleting an already deleted message of mine is a no-op: the same
  // answer, nothing written.
  //
  // The delete-vs-read race: the recipient may read the message while this
  // runs. The UPDATE repeats the "still unread" condition in its WHERE; if
  // a read committed in between — or is committing, in which case the
  // UPDATE waits for its row lock — the row no longer matches, nothing is
  // deleted, and the answer is the "already read" 409. (0048's trigger
  // refuses it too, for any other query.)
  async deleteMessage(
    conversationId: number,
    messageId: number,
    currentUser: CurrentUser,
  ): Promise<PublicMessage> {
    const { message, conversation, changed } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const conversation = await this.loadConversation(
          tx,
          conversationId,
          currentUser,
        )
        requireSide(conversation, currentUser)
        // `now` is the database's: the transaction's now(), the same one the
        // UPDATE below writes and the trigger compares with — one clock for
        // the 15 minutes.
        const [found] = await tx
          .select({ row: messages, now: sql<Date>`now()`.mapWith(asDate) })
          .from(messages)
          .where(
            and(
              eq(messages.id, messageId),
              eq(messages.conversationId, conversationId),
            ),
          )
        if (!found) {
          throw new NotFoundException(
            `Message ${messageId} not found in this conversation`,
          )
        }
        const { row, now } = found
        if (row.deletedAt && row.senderId === currentUser.id) {
          return { message: toPublicMessage(row), conversation, changed: false }
        }
        const refusal = deleteRefusal(row, currentUser.id, now)
        if (refusal === 'not_sender') {
          throw new ForbiddenException(NOT_YOUR_MESSAGE_MESSAGE)
        }
        if (refusal === 'read') {
          throw new ConflictException(MESSAGE_ALREADY_READ_MESSAGE)
        }
        if (refusal === 'window_passed') {
          throw new ConflictException(DELETE_WINDOW_PASSED_MESSAGE)
        }

        const [deleted] = await tx
          .update(messages)
          .set({ deletedAt: sql`now()` })
          .where(
            and(
              eq(messages.id, messageId),
              isNull(messages.readAt),
              isNull(messages.deletedAt),
            ),
          )
          .returning()
        if (!deleted) {
          // Read (or deleted from another tab) since the SELECT above: the
          // row changed under us. The window and the sender can't have —
          // `now` is fixed for the transaction and a sender never changes —
          // and a delete from my other tab leaves deletedAt set, which is
          // "already read"'s only rival; re-reading tells them apart.
          const [current] = await tx
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
          if (current.deletedAt) {
            return {
              message: toPublicMessage(current),
              conversation,
              changed: false,
            }
          }
          throw new ConflictException(MESSAGE_ALREADY_READ_MESSAGE)
        }

        await this.auditService.logInTransaction(tx, {
          performedBy: currentUser.id,
          action: 'MESSAGE_DELETED',
          targetUserId: conversation.patientId,
          entityType: 'messages',
          entityId: messageId,
          details: {
            conversationId,
            sentAt: deleted.sentAt,
            deletedAt: deleted.deletedAt,
          },
        })
        return {
          message: toPublicMessage(deleted),
          conversation,
          changed: true,
        }
      },
    )
    if (changed) {
      this.events.toParticipants(conversation, 'messageDeleted', message)
    }
    return message
  }

  // === HELPERS ============================================================

  private async setArchived(
    id: number,
    currentUser: CurrentUser,
    archived: boolean,
  ): Promise<ConversationSummary> {
    const { summary, change } = await withRlsContext(
      this.db,
      currentUser,
      async (tx) => {
        const conversation = await this.loadConversation(tx, id, currentUser)
        const side = requireSide(conversation, currentUser)
        const column = archiveColumn(side)
        let change: { archivedAt: Date | null } | null = null
        if (archived !== (conversation[column] !== null)) {
          const [updated] = await tx
            .update(conversations)
            .set(
              column === 'practitionerArchivedAt'
                ? { practitionerArchivedAt: archived ? sql`now()` : null }
                : { patientArchivedAt: archived ? sql`now()` : null },
            )
            .where(eq(conversations.id, id))
            .returning({
              archivedAt:
                side === 'practitioner'
                  ? conversations.practitionerArchivedAt
                  : conversations.patientArchivedAt,
            })
          change = { archivedAt: updated.archivedAt }
          await this.auditService.logInTransaction(tx, {
            performedBy: currentUser.id,
            action: archived
              ? 'CONVERSATION_ARCHIVED'
              : 'CONVERSATION_UNARCHIVED',
            targetUserId: conversation.patientId,
            entityType: 'conversations',
            entityId: id,
            details: { side, archivedAt: updated.archivedAt },
          })
        }
        const [summary] = await this.summarize(tx, currentUser, [id])
        return { summary, change }
      },
    )
    if (change) {
      this.events.toUser(
        currentUser.id,
        currentUser.activeRole,
        'conversationArchived',
        { conversationId: id, archivedAt: change.archivedAt },
      )
    }
    return summary
  }

  // The conversation, or a 404. Row security decides what
  // "exists" means: a conversation I'm not in is invisible
  // (conversations_select), so it reads as "not found" — the same answer
  // as one that doesn't exist, which says nothing about other people's
  // conversations.
  private async loadConversation(
    tx: DrizzleDb,
    id: number,
    currentUser: CurrentUser,
  ): Promise<ConversationRow> {
    sideOf(currentUser)
    const [row] = await tx
      .select(conversationColumns)
      .from(conversations)
      .where(eq(conversations.id, id))
    if (!row) {
      throw new NotFoundException(`Conversation ${id} not found`)
    }
    return row
  }

  // The summaries of my conversations — all of them, or the given ids — in
  // THREE queries, whatever their number (no query per conversation):
  //   1. the conversations I'm in, joined to the OTHER person's name and
  //      photo, with canSend;
  //   2. each one's latest message — DISTINCT ON (conversation_id) keeps
  //      the first row of each conversation in the ORDER BY, the newest;
  //   3. my unread count per conversation — the partial index
  //      messages_unread_idx holds exactly the rows it counts.
  private async summarize(
    tx: DrizzleDb,
    currentUser: CurrentUser,
    ids?: number[],
  ): Promise<ConversationSummary[]> {
    const side = sideOf(currentUser)
    const mine =
      side === 'practitioner'
        ? conversations.practitionerId
        : conversations.patientId
    const theirs =
      side === 'practitioner'
        ? conversations.patientId
        : conversations.practitionerId

    const rows = await tx
      .select({
        ...conversationColumns,
        canSend: canSendColumn,
        other: {
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          avatarPath: users.avatarPath,
        },
      })
      .from(conversations)
      .innerJoin(users, eq(users.id, theirs))
      .where(
        and(
          // My conversations on my ACTIVE side (Morgan, signed in as a
          // practitioner, doesn't list the ones where she is the patient).
          // Row security says the same already (conversations_select reads
          // app.current_role), so this is the policy's rule restated — a
          // mutation removing it survives, on purpose: the query states its
          // own meaning instead of leaning on the policy for it, and a plain
          // equality lets the planner use the per-side index
          // (conversations_practitioner_id_idx / _patient_id_idx).
          eq(mine, currentUser.id),
          ids === undefined ? undefined : inArray(conversations.id, ids),
        ),
      )
    if (rows.length === 0) return []
    const conversationIds = rows.map((row) => row.id)

    const latest = await tx
      .selectDistinctOn([messages.conversationId])
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds))
      .orderBy(messages.conversationId, desc(messages.id))
    const latestByConversation = new Map(
      latest.map((message) => [message.conversationId, message]),
    )

    const unread = await tx
      .select({ conversationId: messages.conversationId, unread: count() })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, conversationIds),
          ne(messages.senderId, currentUser.id),
          isNull(messages.readAt),
          isNull(messages.deletedAt),
        ),
      )
      .groupBy(messages.conversationId)
    const unreadByConversation = new Map(
      unread.map((row) => [row.conversationId, row.unread]),
    )

    return Promise.all(
      rows.map(async (row) => {
        const last = latestByConversation.get(row.id)
        return {
          id: row.id,
          otherParticipant: {
            id: row.other.id,
            firstName: row.other.firstName,
            lastName: row.other.lastName,
            avatarUrl: await this.storageService.getPresignedUrlOrNull(
              row.other.avatarPath,
              AVATAR_URL_EXPIRY_SECONDS,
            ),
          },
          lastMessage: last ? toPublicMessage(last) : null,
          unreadCount: unreadByConversation.get(row.id) ?? 0,
          archivedAt: row[archiveColumn(side)],
          canSend: row.canSend,
          createdAt: row.createdAt,
        }
      }),
    )
  }
}

// --- QUERY PIECES ------------------------------------------------------------------------------------------

const conversationColumns = {
  id: conversations.id,
  practitionerId: conversations.practitionerId,
  patientId: conversations.patientId,
  practitionerArchivedAt: conversations.practitionerArchivedAt,
  patientArchivedAt: conversations.patientArchivedAt,
  createdAt: conversations.createdAt,
}

// "May these two write to each other now?" — computed BY THE DATABASE, with
// the very function messages_insert uses (rls_care_team_member, 0019): the
// list's canSend and the write's permission can't disagree, because they
// are one definition. It runs under the caller's row security, which lets
// each participant read the care-team link between them.
const canSendColumn = sql<boolean>`rls_care_team_member(${conversations.practitionerId}, ${conversations.patientId})`

// node-postgres returns a timestamptz column as a Date — but a computed
// expression like now() comes back through drizzle's sql`` as whatever the
// driver gives for its type; mapWith makes it a Date either way.
function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

// --- GUARDS --------------------------------------------------------------------------------------------------

// The caller's messaging side, from their ACTIVE role — or a 403 for an
// admin. The controller's @Roles refuses admins first; this keeps the
// service safe for any other caller (the gateway, a script). Admins have no
// messaging at all since Phase 5 (decided 2026-10-20) — the database agrees
// (0048: conversations_select without its admin branch).
function sideOf(currentUser: CurrentUser): Side {
  if (currentUser.activeRole === UserRole.PRACTITIONER) return 'practitioner'
  if (currentUser.activeRole === UserRole.PATIENT) return 'patient'
  throw new ForbiddenException(STAFF_AND_PATIENTS_ONLY_MESSAGE)
}

// The caller's side IN this conversation. Row security normally answers
// first — a conversation I'm not in is a 404 — so this 403 is the service's
// own copy of the rule (defence in depth), reached only if a policy were
// ever widened.
function requireSide(
  conversation: ConversationRow,
  currentUser: CurrentUser,
): Side {
  const side = participantSide(conversation, currentUser)
  if (side === null) {
    throw new ForbiddenException(NOT_PARTICIPANT_MESSAGE)
  }
  return side
}
