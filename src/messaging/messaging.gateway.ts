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

import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common'
import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets'
import { DefaultEventsMap, Server, Socket } from 'socket.io'
import type { IncomingMessage } from 'http'
import type { Session, SessionData } from 'express-session'
import { UsersService } from '../users/users.service'
import { UserRole } from '../users/dto/create-user.dto'
import { MessagingService } from './messaging.service'
import { MessagingEvents } from './messaging-events'
import { getAllowedOrigins } from '../config/allowed-origins'
import { WsHttpExceptionFilter, type WsAnswer } from './ws-exception.filter'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import {
  DeleteMessageEventDto,
  SendMessageEventDto,
} from './dto/send-message.dto'
import type { PublicMessage } from './message-rules'

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
// (and `.sessionID`, the session's id) at runtime. This describes that real,
// augmented shape; `session` stays optional (defensive against a socket that
// somehow reaches this middleware before the session middleware ran).
type RequestWithSession = IncomingMessage & {
  session?: Session & Partial<SessionData>
  sessionID?: string
}

// --- GATEWAY ------------------------------------------------------------------------------------------------

// The live half of messaging (Phase 5). What it does, and what it no longer
// does:
//   - AUTHENTICATES each connection once, from the session cookie (the
//     middleware below) — practitioners and patients only;
//   - PUTS each connection in its rooms (MessagingEvents): this person in
//     this role, and this login session. Every conversation's events reach
//     its participants through the first; logout / switch-role close the
//     connections through the second. There is no "joinConversation" any
//     more: per-conversation rooms made a screen join each thread it showed,
//     and still left the list and the unread badge deaf to every other
//     conversation. One room per person hears them all, and needs no
//     authorization check of its own — it's derived from the session.
//   - RECEIVES two events, sendMessage and deleteMessage, and hands them to
//     MessagingService — the same methods the REST routes call. The service
//     emits the resulting events itself (after its commit), so a message
//     sent through REST is pushed exactly like one sent here.
//   - ANSWERS each event through its acknowledgement: { ok: true, data } or
//     { ok: false, status, message } (WsHttpExceptionFilter).
//
// VALIDATION: the app's global ValidationPipe (main.ts) applies to HTTP
// routes only — gateways get their own, here, with the same options. Before
// Phase 5 the socket took its payloads as they came.
@UseFilters(new WsHttpExceptionFilter())
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
@WebSocketGateway({
  cors: {
    origin: getAllowedOrigins(),
    credentials: true,
  },
})
export class MessagingGateway implements OnGatewayInit {
  private readonly logger = new Logger(MessagingGateway.name)

  constructor(
    private readonly messagingService: MessagingService,
    private readonly usersService: UsersService,
    private readonly events: MessagingEvents,
  ) {}

  // Genuine Socket.IO MIDDLEWARE (server.use): it must fully resolve —
  // awaits included — before the connection counts as established, so no
  // event can reach a handler before socket.data.user is set. (A former
  // handleConnection hook ran WITHOUT blocking events: one emitted right
  // after connecting could arrive before the user was loaded.) This is the
  // WebSocket equivalent of Passport's deserializeUser, done by hand since
  // Passport's machinery is Express-specific. socket.request.session exists
  // only because of SessionIoAdapter.
  afterInit(server: Server) {
    // The rest of the app emits through MessagingEvents; it needs THIS
    // server to do so (messaging-events.ts explains the arrangement).
    this.events.attach(server)

    // Socket.IO's middleware type expects a void-returning callback, but the
    // check is genuinely async (a database read) — an inner async function
    // keeps the outer one synchronous while still calling next() only once
    // the awaits have resolved.
    server.use((socket: AuthenticatedSocket, next) => {
      void (async () => {
        const request = socket.request as RequestWithSession
        const sessionData = request.session?.passport?.user
        if (!sessionData || !request.sessionID) {
          this.logger.warn(`Socket ${socket.id} rejected — no session`)
          return next(new Error('Unauthorized'))
        }
        // Messaging is for practitioners and patients (decided 2026-10-20:
        // admins read no messages) — an admin's connection is refused at
        // the door rather than accepted and left with nothing to hear.
        if (
          sessionData.activeRole !== UserRole.PRACTITIONER &&
          sessionData.activeRole !== UserRole.PATIENT
        ) {
          return next(new Error('Forbidden'))
        }

        try {
          // findSelf: the same shape as req.user (SessionSerializer), so
          // socket.data.user matches the CurrentUser type it is read as.
          const user = await this.usersService.findSelf(sessionData.id)
          if (!user.roles.includes(sessionData.activeRole)) {
            return next(new Error('Unauthorized'))
          }
          // Stashed on the socket — every handler of THIS connection reads
          // it back, the role @CurrentUser() plays for HTTP requests.
          socket.data.user = {
            ...user,
            activeRole: sessionData.activeRole,
          }
          // The connection's two rooms (see the class comment). Joining in
          // the middleware means the rooms are set before the client's
          // 'connect' fires: no event for this person can be missed between
          // connecting and joining.
          await socket.join([
            MessagingEvents.userRoom(user.id, sessionData.activeRole),
            MessagingEvents.sessionRoom(request.sessionID),
          ])
          next()
        } catch {
          next(new Error('Unauthorized'))
        }
      })()
    })
  }

  // `sendMessage` { conversationId, messageBody } → ack { ok, data: the
  // message }. Everyone in the conversation (the sender's other tabs too)
  // receives `newMessage` from the service; the sender's own screen can use
  // the ack to replace its "sending…" bubble.
  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: SendMessageEventDto,
  ): Promise<WsAnswer<PublicMessage>> {
    const message = await this.messagingService.sendMessage(
      data.conversationId,
      socket.data.user,
      data.messageBody,
    )
    return { ok: true, data: message }
  }

  // `deleteMessage` { conversationId, messageId } → ack { ok, data: the
  // message, without its text }; both participants receive
  // `messageDeleted`.
  @SubscribeMessage('deleteMessage')
  async handleDeleteMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: DeleteMessageEventDto,
  ): Promise<WsAnswer<PublicMessage>> {
    const message = await this.messagingService.deleteMessage(
      data.conversationId,
      data.messageId,
      socket.data.user,
    )
    return { ok: true, data: message }
  }
}
