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

import { Injectable } from '@nestjs/common'
import type { Server } from 'socket.io'
import { UserRole } from '../users/dto/create-user.dto'
import type { ConversationParticipants, PublicMessage } from './message-rules'

// --- TYPES -------------------------------------------------------------------------------------------------

// Every event the server pushes, with its payload — one list, so the
// gateway's tests and the frontend's listeners read the same names.
//   - newMessage:          a message was sent (by REST or by the socket);
//   - messageDeleted:      a message was deleted — its text is gone (null);
//   - conversationRead:    the reader read these messages at readAt — the
//                          sender's "Seen", the reader's other tabs' badge;
//   - conversationArchived: I archived / unarchived (archivedAt null) — my
//                          other tabs only.
export interface ServerEvents {
  newMessage: PublicMessage
  messageDeleted: PublicMessage
  conversationRead: {
    conversationId: number
    readerId: number
    readAt: Date
    messageIds: number[]
  }
  conversationArchived: { conversationId: number; archivedAt: Date | null }
}

// --- PROVIDER ----------------------------------------------------------------------------------------------

// How the rest of the app reaches connected browsers — without depending on
// the gateway itself.
//
// Why not just inject MessagingGateway into MessagingService? The gateway
// already depends on the service (it calls sendMessage). Two classes that
// need each other are a circular dependency: Nest can untangle one with
// forwardRef(), but the design stays tangled — and the REST controller, the
// auth controller (logout) and the seed would all have to know the gateway.
// Instead, the gateway HANDS its Socket.IO server to this small provider
// when it starts (afterInit → attach); everyone else asks this provider to
// emit. Nothing here knows about HTTP, sockets' handlers or the database.
//
// The payoff: a message sent through REST reaches open browsers exactly
// like one sent through the socket — the service emits after every write,
// whichever door the write came through.
//
// ROOMS, not individual sockets. A Socket.IO room is a named group of
// connections; emitting to a room reaches every connection in it. Each
// connection joins, at its handshake (the gateway's middleware):
//   - `user:<id>:<role>` — every tab and device of this person in this
//     role. Events for a conversation go to its two participants' rooms, so
//     the list, the badge and an open thread all hear about every
//     conversation, without the client joining anything. The ROLE is part
//     of the name: Morgan, practitioner and patient, gets her patients'
//     messages only while signed in as a practitioner.
//   - `session:<sessionId>` — the connections of ONE login session, so
//     logging out or switching role can close exactly those (below).
//
// When no server is attached (a script that builds the app without
// listening — the dev seed), every emit does nothing: there is nobody to
// tell.
@Injectable()
export class MessagingEvents {
  private server: Server | null = null

  attach(server: Server): void {
    this.server = server
  }

  static userRoom(userId: number, role: UserRole): string {
    return `user:${userId}:${role}`
  }

  static sessionRoom(sessionId: string): string {
    return `session:${sessionId}`
  }

  // To both participants of a conversation, each in their own role.
  toParticipants<E extends keyof ServerEvents>(
    conversation: ConversationParticipants,
    event: E,
    payload: ServerEvents[E],
  ): void {
    this.server
      ?.to([
        MessagingEvents.userRoom(
          conversation.practitionerId,
          UserRole.PRACTITIONER,
        ),
        MessagingEvents.userRoom(conversation.patientId, UserRole.PATIENT),
      ])
      .emit(event, payload)
  }

  // To one person's connections in one role (their own other tabs).
  toUser<E extends keyof ServerEvents>(
    userId: number,
    role: UserRole,
    event: E,
    payload: ServerEvents[E],
  ): void {
    this.server?.to(MessagingEvents.userRoom(userId, role)).emit(event, payload)
  }

  // Closes every connection opened with this login session — called when
  // the session ends (logout) or changes role (switch-role).
  //
  // Why it's needed: a socket is authenticated ONCE, at its handshake, from
  // the session cookie — and keeps that identity for as long as it stays
  // open. Without this, a tab that logged out (or switched to another role)
  // would keep a live connection still receiving the old role's messages
  // and still able to send as it. The client reconnects after a role switch
  // and gets a socket for the new role; after a logout the reconnect is
  // refused (no session).
  //
  // One process: rooms live in this server's memory. With several backend
  // instances behind a load balancer, a socket may be held by ANOTHER
  // instance — Socket.IO's Redis adapter shares rooms between instances
  // (deferred-improvements.md, with the rest of "more than one instance").
  disconnectSession(sessionId: string): void {
    this.server?.in(MessagingEvents.sessionRoom(sessionId)).disconnectSockets()
  }
}
