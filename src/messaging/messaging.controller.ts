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

import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { MessagingService } from './messaging.service'
import { CreateConversationDto } from './dto/create-conversation.dto'
import { SendMessageDto } from './dto/send-message.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'


// --- CONTROLLER --------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@Controller('conversations')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}


  // === ROUTES =============================================================

  // --- POST ROUTES ---

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateConversationDto) {
    return this.messagingService.createConversation(user, dto)
  }

  // A REST fallback for sending a message, alongside the WebSocket path —
  // useful for a client not using sockets, and straightforward to test via
  // curl. Calls the exact same MessagingService.sendMessage() the gateway
  // does.
  @Post(':id/messages')
  sendMessage(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(id, user, dto.messageBody)
  }


  // --- GET ROUTES ---

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.messagingService.findConversationsForUser(user)
  }

  @Get(':id/messages')
  getMessages(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagingService.getMessages(id, user)
  }


  // --- PATCH ROUTES ---

  @Patch(':id/read')
  markAsRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagingService.markAsRead(id, user)
  }
}