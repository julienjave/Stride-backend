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

import { Logger } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { UsersService } from '../users/users.service'
import { MessagingService } from './messaging.service'
import { getAllowedOrigins } from '../config/allowed-origins'


// --- GATEWAY ------------------------------------------------------------------------------------------------

@WebSocketGateway({
  cors: {
    origin: getAllowedOrigins(),
    credentials: true,
  },
})
export class MessagingGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server
  private readonly logger = new Logger(MessagingGateway.name)

  constructor(
    private readonly messagingService: MessagingService,
    private readonly usersService: UsersService,
  ) {}

  // Runs once, when a socket first connects — this is the WebSocket
  // equivalent of Passport's deserializeUser, done manually here rather than
  // through Passport itself (Passport's own machinery is Express-specific;
  // reusing it for sockets would need wrapping passport.initialize() and
  // passport.session() too, real added complexity for one connection event).
  // socket.request.session exists at all only because of SessionIoAdapter.
  async handleConnection(socket: Socket) {
    const sessionData = (socket.request as any).session?.passport?.user
    if (!sessionData) {
      this.logger.warn(`Socket ${socket.id} rejected — no session`)
      socket.disconnect()
      return
    }

    try {
      const user = await this.usersService.findOne(sessionData.id)
      if (!user.roles.includes(sessionData.activeRole)) {
        socket.disconnect()
        return
      }
      // Stashed on the socket itself — every subsequent event handler for
      // THIS connection reads it back, the same role @CurrentUser() plays
      // for HTTP requests.
      (socket.data as any).user = { ...user, activeRole: sessionData.activeRole }
    } catch {
      socket.disconnect()
    }
  }

  @SubscribeMessage('joinConversation')
  async handleJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { conversationId: number },
  ) {
    // Room name is just the conversation's own id — everyone who joins this
    // room receives every message broadcast to it, and no one outside it does.
    await socket.join(`conversation:${data.conversationId}`)
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { conversationId: number; messageBody: string },
  ) {
    const user = (socket.data as any).user
    const message = await this.messagingService.sendMessage(data.conversationId, user, data.messageBody)
    // Broadcast to everyone in the room — including the sender's own other
    // open tabs/devices, so a multi-device session stays in sync too.
    this.server.to(`conversation:${data.conversationId}`).emit('newMessage', message)
    return message
  }

  @SubscribeMessage('deleteMessage')
  async handleDeleteMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { conversationId: number; messageId: number },
  ) {
    const user = (socket.data as any).user;
    const message = await this.messagingService.deleteMessage(
      data.conversationId,
      data.messageId,
      user,
    )
    // Live tombstone — the other party's open thread updates immediately,
    // same room-broadcast mechanism as a new message.
    this.server.to(`conversation:${data.conversationId}`).emit('messageDeleted', message)
    return message
  }
}