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

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { conversations, messages } from '../database/schema'
import { UsersService } from '../users/users.service'
import { CreateConversationDto } from './dto/create-conversation.dto'


// --- SERVICE -----------------------------------------------------------------------------------------------

type CurrentUser = { id: number; activeRole: string }

@Injectable()
export class MessagingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}


  // === ROUTES =============================================================

  // --- POST ROUTES ---

  async createConversation(currentUser: CurrentUser, dto: CreateConversationDto) {
    let practitionerId: number
    let patientId: number

    if (currentUser.activeRole === 'practitioner') {
      practitionerId = currentUser.id
      patientId = dto.userId
    } else if (currentUser.activeRole === 'patient') {
      practitionerId = dto.userId
      patientId = currentUser.id
    } else {
      throw new ForbiddenException('Only practitioners and patients can start conversations')
    }

    // Reuses the same clinic-scoped relationship check as everywhere else —
    // messaging is only ever allowed between people with a genuine clinical
    // relationship, not any two accounts in the system.
    const managed = await this.usersService.isPatientManagedBy(patientId, practitionerId)
    if (!managed) {
      throw new ForbiddenException('You can only message someone you have a clinical relationship with')
    }

    // Idempotent "start or get" — the UNIQUE(practitionerId, patientId)
    // constraint means a second attempt should return the existing
    // conversation, not error.
    const existing = await this.db.query.conversations.findFirst({
      where: and(eq(conversations.practitionerId, practitionerId), eq(conversations.patientId, patientId)),
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
  async sendMessage(conversationId: number, currentUser: CurrentUser, messageBody: string) {
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
    if (currentUser.activeRole === 'practitioner') {
      return this.db.query.conversations.findMany({
        where: eq(conversations.practitionerId, currentUser.id),
      })
    }
    if (currentUser.activeRole === 'patient') {
      return this.db.query.conversations.findMany({
        where: eq(conversations.patientId, currentUser.id),
      })
    }
    return this.db.query.conversations.findMany(); // admin: full oversight
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


  // === HELPER FUNCTIONS =====================================================

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
      (currentUser.activeRole === 'practitioner' && conversation.practitionerId === currentUser.id) ||
      (currentUser.activeRole === 'patient' && conversation.patientId === currentUser.id)
    if (!isParticipant && currentUser.activeRole !== 'admin') {
      throw new ForbiddenException('You are not a participant in this conversation')
    }
  }
}