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
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Delete,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { MessagingService } from './messaging.service'
import { CreateConversationDto } from './dto/create-conversation.dto'
import { SendMessageDto } from './dto/send-message.dto'
import { MessagesPageQueryDto } from './dto/messages-page-query.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Messaging between a patient and their care team (Phase 5). Practitioners
// and patients only: since 2026-10-20 an admin reads no messages and has no
// route here (403 from RolesGuard), and the database agrees (migration
// 0048). Every route that WRITES is @AuditedByService(): the service writes
// one complete entry in the change's own transaction. Reading a conversation
// is NOT recorded (the audit review, step 2, 2026-10-21): only its two
// participants can read it — never someone else — except "mark as read",
// which is a write and records who read what.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PRACTITIONER, UserRole.PATIENT)
@ApiTags('Messaging')
@Controller('conversations')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Start (or get) the conversation with someone on my care team — 201 with
  // its summary either way.
  @Post()
  @AuditedByService()
  create(@CurrentUser() user: CurrentUser, @Body() dto: CreateConversationDto) {
    return this.messagingService.createConversation(user, dto)
  }

  // The REST door for sending, beside the WebSocket's `sendMessage` (which
  // the screens use). Same service method, same events pushed to open
  // browsers — useful for scripts, curl, and a client without a socket.
  @Post(':id/messages')
  @AuditedByService()
  sendMessage(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(id, user, dto.messageBody)
  }

  // --- GET ROUTES ---

  @Get()
  findAll(@CurrentUser() user: CurrentUser) {
    return this.messagingService.findConversationsForUser(user)
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.messagingService.findOne(id, user)
  }

  // One page: `{ messages (oldest first), hasMore }`; `?before=<message id>`
  // for older pages, `?limit=` up to 100 (50 by default).
  @Get(':id/messages')
  getMessages(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Query() query: MessagesPageQueryDto,
  ) {
    return this.messagingService.getMessages(id, user, query)
  }

  // --- PATCH ROUTES ---

  @Patch(':id/read')
  @AuditedByService()
  markAsRead(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.messagingService.markAsRead(id, user)
  }

  @Patch(':id/archive')
  @AuditedByService()
  archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.messagingService.archiveConversation(id, user)
  }

  @Patch(':id/unarchive')
  @AuditedByService()
  unarchive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.messagingService.unarchiveConversation(id, user)
  }

  // --- DELETE ROUTES ---

  // A soft delete of one of my messages: unread AND at most 15 minutes old
  // (MessagingService.deleteMessage).
  @Delete(':id/messages/:messageId')
  @AuditedByService()
  deleteMessage(
    @Param('id', ParseIntPipe) id: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.messagingService.deleteMessage(id, messageId, user)
  }
}
