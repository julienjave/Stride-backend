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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { conversations, messages } from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateConversationDto } from './dto/create-conversation.dto'
import { UserRole } from '../users/dto/create-user.dto'

// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: UserRole }

@Injectable()
export class MessagingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async createConversation(
    currentUser: CurrentUser,
    dto: CreateConversationDto,
  ) {
    let practitionerId: number
    let patientId: number

    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      practitionerId = currentUser.id
      patientId = dto.userId
    } else if (currentUser.activeRole === UserRole.PATIENT) {
      practitionerId = dto.userId
      patientId = currentUser.id
    } else {
      throw new ForbiddenException(
        'Only practitioners and patients can start conversations',
      )
    }

    // Reuses the same clinic-scoped relationship check as everywhere else —
    // messaging is only ever allowed between people with a genuine clinical
    // relationship, not any two accounts in the system.
    const managed = await this.usersService.isPatientManagedBy(
      patientId,
      practitionerId,
    )
    if (!managed) {
      throw new ForbiddenException(
        'You can only message someone you have a clinical relationship with',
      )
    }

    // Idempotent "start or get" — the UNIQUE(practitionerId, patientId)
    // constraint means a second attempt should return the existing
    // conversation, not error.
    const existing = await this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.practitionerId, practitionerId),
        eq(conversations.patientId, patientId),
      ),
    })
    if (existing) {
      return existing
    }

    const [conversation] = await this.db
      .insert(conversations)
      .values({ practitionerId, patientId })
      .returning()
    return conversation
  }

  // The one place a message is ever actually created — called identically
  // by MessagingController's REST route and MessagingGateway's WebSocket
  // handler, so there's no risk of the two diverging in behavior.
  async sendMessage(
    conversationId: number,
    currentUser: CurrentUser,
    messageBody: string,
  ) {
    const conversation = await this.findConversationOrThrow(conversationId)
    this.assertParticipant(conversation, currentUser)

    const [message] = await this.db
      .insert(messages)
      .values({ conversationId, senderId: currentUser.id, messageBody })
      .returning()
    return message
  }

  // --- GET ROUTES ---

  async findConversationsForUser(currentUser: CurrentUser) {
    if (currentUser.activeRole === UserRole.PRACTITIONER) {
      return this.db.query.conversations.findMany({
        where: eq(conversations.practitionerId, currentUser.id),
      })
    }
    if (currentUser.activeRole === UserRole.PATIENT) {
      return this.db.query.conversations.findMany({
        where: eq(conversations.patientId, currentUser.id),
      })
    }
    return this.db.query.conversations.findMany() // admin: full oversight
  }

  async getMessages(conversationId: number, currentUser: CurrentUser) {
    const conversation = await this.findConversationOrThrow(conversationId)
    this.assertParticipant(conversation, currentUser)
    return this.db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: (m, { asc }) => [asc(m.sentAt)],
    })
  }

  // --- PATCH ROUTES ---

  async markAsRead(conversationId: number, currentUser: CurrentUser) {
    const conversation = await this.findConversationOrThrow(conversationId)
    this.assertParticipant(conversation, currentUser)

    // Marks every unread message NOT sent by the current user — reading your
    // own sent messages isn't a meaningful concept.
    await this.db
      .update(messages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          ne(messages.senderId, currentUser.id),
          isNull(messages.readAt),
        ),
      )
  }

  // Two explicit actions rather than one ambiguous "toggle" endpoint — each
  // only ever touches the CALLING user's own column, never the other
  // participant's. Admins don't get an archive action at all: this is a
  // personal inbox-management concern for the two actual participants, not
  // something oversight touches.
  async archiveConversation(id: number, currentUser: CurrentUser) {
    const conversation = await this.findConversationOrThrow(id)
    this.assertParticipant(conversation, currentUser)
    if (currentUser.activeRole === UserRole.ADMIN) {
      throw new ForbiddenException(
        'Archiving a conversation is a participant-only action',
      )
    }

    const column =
      currentUser.activeRole === UserRole.PRACTITIONER
        ? { practitionerArchivedAt: new Date() }
        : { patientArchivedAt: new Date() }

    const [updated] = await this.db
      .update(conversations)
      .set(column)
      .where(eq(conversations.id, id))
      .returning()
    return updated
  }

  async unarchiveConversation(id: number, currentUser: CurrentUser) {
    const conversation = await this.findConversationOrThrow(id)
    this.assertParticipant(conversation, currentUser)
    if (currentUser.activeRole === UserRole.ADMIN) {
      throw new ForbiddenException(
        'Unarchiving a conversation is a participant-only action',
      )
    }

    const column =
      currentUser.activeRole === UserRole.PRACTITIONER
        ? { practitionerArchivedAt: null }
        : { patientArchivedAt: null }

    const [updated] = await this.db
      .update(conversations)
      .set(column)
      .where(eq(conversations.id, id))
      .returning()
    return updated
  }

  // --- DELETE ROUTES ---

  // 15 minutes: a message can be deleted only within this window AND only
  // if the recipient hasn't read it yet (checked in deleteMessage below) —
  // both conditions together, not either alone. This is narrower than a
  // typical consumer chat app's "delete anytime" on purpose: this schema's
  // whole design treats clinical communication as something that shouldn't
  // silently disappear once the other party has actually seen it.
  private readonly DELETE_WINDOW_MS = 15 * 60 * 1000

  async deleteMessage(
    conversationId: number,
    messageId: number,
    currentUser: CurrentUser,
  ) {
    const conversation = await this.findConversationOrThrow(conversationId)
    this.assertParticipant(conversation, currentUser)

    const message = await this.db.query.messages.findFirst({
      where: and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
      ),
    })
    if (!message) {
      throw new NotFoundException(
        `Message ${messageId} not found in this conversation`,
      )
    }
    if (message.senderId !== currentUser.id) {
      throw new ForbiddenException('You can only delete your own messages')
    }
    if (message.readAt) {
      throw new ForbiddenException(
        'This message has already been read and can no longer be deleted',
      )
    }
    if (Date.now() - message.sentAt.getTime() > this.DELETE_WINDOW_MS) {
      throw new ForbiddenException(
        'This message can no longer be deleted — the 15 minute window has passed',
      )
    }

    const [updated] = await this.db
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(eq(messages.id, messageId))
      .returning()
    return this.toPublicMessage(updated)
  }

  // === HELPER FUNCTIONS =====================================================

  // Soft delete only, matching messages.deletedAt in the schema — the row
  // is never actually removed. What changes is the SERVED representation:
  // once deleted, the real messageBody is replaced with a tombstone for
  // EVERYONE reading it, sender included, rather than the message quietly
  // vanishing from the thread with no trace.
  private toPublicMessage(message: typeof messages.$inferSelect) {
    if (message.deletedAt) {
      return { ...message, messageBody: '[message deleted]' }
    }
    return message
  }

  // The ONE piece of this service's authorization logic that needs to be
  // reachable from OUTSIDE it — MessagingGateway.handleJoin() needs to
  // verify a socket is actually allowed into a conversation's room before
  // letting it join, using the EXACT SAME rule as every REST method above
  // (findConversationOrThrow + assertParticipant), not a separate,
  // independently-maintained copy of the same check that could quietly
  // drift from it over time. Deliberately public and narrow.
  async assertUserCanJoinConversation(
    conversationId: number,
    currentUser: CurrentUser,
  ): Promise<void> {
    const conversation = await this.findConversationOrThrow(conversationId)
    this.assertParticipant(conversation, currentUser)
  }

  private async findConversationOrThrow(id: number) {
    const conversation = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    })
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`)
    }
    return conversation
  }

  private assertParticipant(
    conversation: typeof conversations.$inferSelect,
    currentUser: CurrentUser,
  ) {
    const isParticipant =
      (currentUser.activeRole === UserRole.PRACTITIONER &&
        conversation.practitionerId === currentUser.id) ||
      (currentUser.activeRole === UserRole.PATIENT &&
        conversation.patientId === currentUser.id)
    if (!isParticipant && currentUser.activeRole !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'You are not a participant in this conversation',
      )
    }
  }
}
