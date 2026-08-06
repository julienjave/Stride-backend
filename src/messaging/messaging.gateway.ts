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

import { Logger, UseFilters } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets'
import { DefaultEventsMap, Server, Socket } from 'socket.io'
import type { IncomingMessage } from 'http'
import type { Session, SessionData } from 'express-session'
import { UsersService } from '../users/users.service'
import { MessagingService } from './messaging.service'
import { getAllowedOrigins } from '../config/allowed-origins'
import { WsHttpExceptionFilter } from './ws-exception.filter'
import { CurrentUser } from '../common/decorators/current-user.decorator'

// --- TYPES ---------------------------------------------------------------------------------------------------
// socket.data is `any` by default — this narrows it to what the
// server.use() middleware below actually stashes on it (the same shape
// @CurrentUser() extracts for HTTP requests, see current-user.decorator.ts).
type AuthenticatedSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  { user: CurrentUser }
>

// Socket.IO types socket.request as a bare IncomingMessage — it has no idea
// SessionIoAdapter runs Express's session middleware directly against it
// (see session-io.adapter.ts), which is what actually attaches `.session`
// at runtime. This describes that real, augmented shape; `session` stays
// optional to match the existing `?.` below (defensive against a socket
// that somehow reaches this middleware before the session middleware ran).
type RequestWithSession = IncomingMessage & {
  session?: Session & Partial<SessionData>
}

// --- GATEWAY ------------------------------------------------------------------------------------------------

@UseFilters(new WsHttpExceptionFilter())
@WebSocketGateway({
  cors: {
    origin: getAllowedOrigins(),
    credentials: true,
  },
})
export class MessagingGateway implements OnGatewayInit {
  @WebSocketServer() server!: Server
  private readonly logger = new Logger(MessagingGateway.name)

  constructor(
    private readonly messagingService: MessagingService,
    private readonly usersService: UsersService,
  ) {}

  // Genuine Socket.IO MIDDLEWARE (server.use), not the handleConnection
  // lifecycle hook this used to be — a real, previously-latent bug this
  // change fixes: handleConnection runs asynchronously WITHOUT blocking the
  // client from sending further events, meaning a client that emits an
  // event (joinConversation, sendMessage) immediately after connecting
  // could reach its handler BEFORE handleConnection's own `await
  // usersService.findOne(...)` had actually finished — socket.data.user
  // would still be undefined, crashing every handler that reads it.
  // Middleware registered via server.use() is different in a way that
  // actually matters here: it must fully resolve, awaits included, before
  // the connection is considered established at all — no event can reach
  // ANY handler until this completes. This is the WebSocket equivalent of
  // Passport's deserializeUser, done manually since Passport's own
  // machinery is Express-specific. socket.request.session exists at all
  // only because of SessionIoAdapter.
  afterInit(server: Server) {
    // Socket.IO's middleware type expects a void-returning callback, but the
    // check below is genuinely async (it awaits a DB lookup) — wrapping the
    // logic in an inner async IIFE keeps the outer function itself
    // synchronous (satisfying that type) while still only calling next()
    // once the awaits inside have resolved, exactly as before.
    server.use((socket: AuthenticatedSocket, next) => {
      void (async () => {
        const sessionData = (socket.request as RequestWithSession).session
          ?.passport?.user
        if (!sessionData) {
          this.logger.warn(`Socket ${socket.id} rejected — no session`)
          return next(new Error('Unauthorized'))
        }

        try {
          const user = await this.usersService.findOne(sessionData.id)
          if (!user.roles.includes(sessionData.activeRole)) {
            return next(new Error('Unauthorized'))
          }
          // Stashed on the socket itself — every subsequent event handler for
          // THIS connection reads it back, the same role @CurrentUser() plays
          // for HTTP requests. Guaranteed set before any handler can possibly
          // run, unlike the old handleConnection-based approach.
          socket.data.user = {
            ...user,
            activeRole: sessionData.activeRole,
          }
          next()
        } catch {
          next(new Error('Unauthorized'))
        }
      })()
    })
  }

  @SubscribeMessage('joinConversation')
  async handleJoin(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { conversationId: number },
  ) {
    const user = socket.data.user
    // Verifies genuine participation — reusing the EXACT SAME rule as every
    // REST endpoint on this resource (MessagingService.assertParticipant) —
    // before ever letting the socket into the room. Without this, any
    // authenticated socket could join ANY conversation's room purely by
    // knowing its id, silently receiving every message broadcast to a
    // clinical conversation they have no legitimate connection to. Throws
    // NotFoundException/ForbiddenException on failure, caught by
    // WsHttpExceptionFilter above rather than a manual try/catch here — the
    // same "let the filter handle it" pattern REST controllers already rely on.
    await this.messagingService.assertUserCanJoinConversation(
      data.conversationId,
      user,
    )
    // Room name is just the conversation's own id — everyone who joins this
    // room receives every message broadcast to it, and no one outside it does.
    await socket.join(`conversation:${data.conversationId}`)
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { conversationId: number; messageBody: string },
  ) {
    const user = socket.data.user
    const message = await this.messagingService.sendMessage(
      data.conversationId,
      user,
      data.messageBody,
    )
    // Broadcast to everyone in the room — including the sender's own other
    // open tabs/devices, so a multi-device session stays in sync too.
    this.server
      .to(`conversation:${data.conversationId}`)
      .emit('newMessage', message)
    return message
  }

  @SubscribeMessage('deleteMessage')
  async handleDeleteMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { conversationId: number; messageId: number },
  ) {
    const user = socket.data.user
    const message = await this.messagingService.deleteMessage(
      data.conversationId,
      data.messageId,
      user,
    )
    // Live tombstone — the other party's open thread updates immediately,
    // same room-broadcast mechanism as a new message.
    this.server
      .to(`conversation:${data.conversationId}`)
      .emit('messageDeleted', message)
    return message
  }
}
