# WebSocket API — `MessagingGateway`

Source of truth: [`src/messaging/messaging.gateway.ts`](../../src/messaging/messaging.gateway.ts),
[`src/messaging/session-io.adapter.ts`](../../src/messaging/session-io.adapter.ts),
[`src/messaging/messaging.service.ts`](../../src/messaging/messaging.service.ts).

This has **zero** Swagger coverage — Swagger only documents HTTP routes.
Everything below was read directly from the gateway and service
implementations.

Transport: [Socket.IO](https://socket.io/) v4, default namespace (`/`), no
custom path configured. CORS is configured separately from the HTTP API but
identically in practice — same `getAllowedOrigins()` allowlist,
`credentials: true`.

## Connection: authenticated via the same session cookie as REST

There is no separate WebSocket login/token flow. `SessionIoAdapter`
(registered in `main.ts` via `app.useWebSocketAdapter(...)`) wraps Socket.IO's
server creation to run the **exact same `express-session` middleware
instance** used for HTTP requests against every socket handshake, before the
connection is accepted. Socket.IO's handshake does not go through Express's
middleware chain by default — this adapter is what makes it do so anyway. The
payoff: `socket.request.session` inside the gateway is the real, shared
session store, not a parallel mechanism invented for sockets.

**Practical implications for the frontend:**

- The user must already have a valid HTTP session (i.e. have already
  completed `POST /auth/login`, and — if MFA is enabled — `POST
  /auth/mfa/verify`) *before* opening the socket connection. There is no way
  to authenticate a socket on its own.
- The client must connect with credentials enabled so the browser attaches
  the `connect.sid` cookie to the handshake — with `socket.io-client`, this
  is `io(url, { withCredentials: true })`. Without this, the handshake
  carries no session and is rejected (see below).

### `handleConnection` — what happens on connect

On every new connection (`messaging.gateway.ts:59`), the gateway:

1. Reads `socket.request.session?.passport?.user` — this is the exact
   `{ id, activeRole }` shape `SessionSerializer.serializeUser` stores for
   HTTP sessions (see [Authentication](./01-authentication.md)). If it's
   missing, the socket is disconnected immediately
   (`socket.disconnect()`) — **no error event is emitted, the socket
   simply closes.** Your client-side `connect_error` / `disconnect` handler
   is the only signal you'll get; there's no message payload explaining
   why.
2. Re-loads the full user via `UsersService.findOne(id)`. If the session's
   stored `activeRole` is no longer among the user's actual roles (a role
   was revoked after the session was established — the same check
   `SessionSerializer` does for HTTP), the socket is disconnected the same
   silent way.
3. On success, stashes `{ ...user, activeRole }` on `socket.data.user` —
   this is what every event handler below reads to know who's connected;
   it plays the same role `@CurrentUser()` plays for HTTP controllers.

**Frontend guidance:** always attach a `disconnect` listener right after
calling `.connect()` and treat an immediate disconnect (no prior successful
event) as "the session isn't valid for sockets" — send the user through the
normal re-authentication path, the same as you'd handle a `401` on REST.

## Client → Server events

### `joinConversation`

```ts
socket.emit('joinConversation', { conversationId: number })
```

Joins the Socket.IO room `conversation:<conversationId>`. Everyone in that
room receives every `newMessage`/`messageDeleted` event broadcast to it.

**Two things worth flagging explicitly, verified directly from
`messaging.gateway.ts:82-90`:**

- **There is no payload validation.** Unlike HTTP routes, WebSocket message
  bodies in this app are **not** run through Nest's global `ValidationPipe`
  — that pipe is wired into the HTTP request pipeline only
  (`app.useGlobalPipes(...)` in `main.ts`), and the gateway does not apply
  any `@UsePipes()` of its own. A malformed payload (missing
  `conversationId`, wrong type) is not rejected with a clean validation
  error — it will either produce a nonsensical room name
  (`conversation:undefined`) or fail in some less-predictable way
  downstream. **The client is entirely responsible for sending well-formed
  payloads here** — there's no server-side safety net to lean on the way
  there is for REST bodies.
- **There is no participant/membership check on join.** The handler calls
  `socket.join(...)` directly with no call into `MessagingService` at all —
  unlike every other operation in this gateway/controller (`sendMessage`,
  `getMessages`, etc.), which all go through
  `MessagingService.assertParticipant` first. As implemented, any
  authenticated socket can join any conversation's room by id and receive
  its live message broadcasts, regardless of whether that user is actually
  one of the two participants. This is a real, verified gap in the current
  implementation, not a design decision described anywhere in the code —
  worth flagging to the backend team rather than relying on client-side
  behavior (e.g. "the UI never lets you type an arbitrary conversation id")
  as the actual security boundary.

### `sendMessage`

```ts
socket.emit('sendMessage', { conversationId: number, messageBody: string })
```

Calls the exact same `MessagingService.sendMessage()` used by the REST
fallback (`POST /conversations/:id/messages`), so behavior is identical
either way *except for what happens next* — see the REST-vs-WebSocket
divergence note below. Authorization here **is** enforced
(`assertParticipant`): the conversation must exist, and the caller must be
one of its two participants (or an admin). On success, the handler:

1. Broadcasts a `newMessage` event to the whole room
   `conversation:<conversationId>` — including the sender's own other open
   tabs/devices, so a multi-device session stays in sync.
2. Returns the created message as a Socket.IO **acknowledgement** — if your
   client passes a callback as the third argument to `.emit()`, it receives
   the same payload directly, without needing to also listen for the
   broadcast.

### `deleteMessage`

```ts
socket.emit('deleteMessage', { conversationId: number, messageId: number })
```

Calls `MessagingService.deleteMessage()` — this is a **soft delete** gated
by two conditions that must **both** hold:

- The caller must be the message's original sender (not just a conversation
  participant).
- The message must be **unread** (`readAt` still null) **and** within a
  **15-minute** window of `sentAt`.

Violating either condition throws a `ForbiddenException` (see error-handling
note below); deleting a message that doesn't exist in that conversation
throws `NotFoundException`. On success, broadcasts `messageDeleted` to the
room and returns the same payload as an ack.

## Server → Client events

### `newMessage`

Emitted to `conversation:<conversationId>` whenever a message is created via
the `sendMessage` WS handler. Payload is the **raw inserted row**:

```json
{
  "id": 501,
  "conversationId": 12,
  "senderId": 7,
  "messageBody": "How's the knee feeling today?",
  "readAt": null,
  "deletedAt": null,
  "sentAt": "2026-08-05T14:22:03.101Z"
}
```

### `messageDeleted`

Emitted to `conversation:<conversationId>` after a successful
`deleteMessage`. Payload is the updated row with the message body replaced
by a tombstone (`MessagingService.toPublicMessage`, `messaging.service.ts:231`)
— the row is never actually removed, so every subsequent read of this
conversation's history shows the same tombstone too:

```json
{
  "id": 501,
  "conversationId": 12,
  "senderId": 7,
  "messageBody": "[message deleted]",
  "readAt": null,
  "deletedAt": "2026-08-05T14:24:11.552Z",
  "sentAt": "2026-08-05T14:22:03.101Z"
}
```

### ⚠️ REST-sent messages do **not** broadcast over the socket

`POST /conversations/:id/messages` (the REST fallback) and the `sendMessage`
WS event both call the identical `MessagingService.sendMessage()`, so the
message is created identically either way — but the `this.server.to(...)
.emit('newMessage', ...)` broadcast line lives **only** inside
`MessagingGateway.handleSendMessage`, not inside `MessagingService` itself.
A message created via the REST endpoint is persisted correctly and will
show up on the next `GET /conversations/:id/messages` poll, but **no
connected client — including the sender's own other tabs — receives a live
`newMessage` event for it.** If your frontend mixes both paths (e.g. REST
for initial send, WS for live updates), be aware the REST path will feel
"silent" until something else triggers a refetch. For a fully live chat
experience, send messages exclusively through the `sendMessage` WS event.

### ⚠️ Errors thrown inside a handler are **not** returned with their real message

None of `messaging.service.ts`'s exceptions (`ForbiddenException`,
`NotFoundException`, etc. — all standard Nest `HttpException`s) are
instances of `WsException`. This project registers no custom WebSocket
exception filter, so Nest's built-in `BaseWsExceptionFilter` handles them —
and that filter only gives special treatment to actual `WsException`
instances. Everything else falls through to `handleUnknownError`, which
emits a **generic, detail-free** `exception` event back to the throwing
client:

```json
{ "status": "error", "message": "Internal server error" }
```

This happens even for an entirely expected, well-formed rejection like
trying to delete someone else's message or a message outside the 15-minute
window — the specific, human-readable reason
(`"You can only delete your own messages"`, etc.) that a REST caller of the
same underlying service method would see in the JSON error body is
**swallowed** on the WebSocket path. (It's also not logged server-side,
since `HttpException` counts as an "expected" `IntrinsicException` in this
Nest version.) **Don't rely on the WS `exception` event's `message` field
for user-facing error text** — if you need the real reason for a rejected
`sendMessage`/`deleteMessage`, either duplicate the relevant validation
client-side before emitting, or fall back to calling the equivalent REST
endpoint, whose JSON error body does carry the specific message (see
[Response Conventions](./03-conventions.md)).

## End-to-end example

```ts
import { io } from 'socket.io-client'

// 1. Regular REST login first — establishes the session cookie.
await fetch('https://api.example.com/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'patient@example.com', password: '...' }),
})

// 2. Connect the socket, reusing that same cookie.
const socket = io('https://api.example.com', { withCredentials: true })

socket.on('connect', () => console.log('connected'))
socket.on('disconnect', (reason) => console.log('disconnected:', reason))
socket.on('exception', (err) => console.warn('ws error (generic):', err))

// 3. Join the conversation's room.
socket.emit('joinConversation', { conversationId: 12 })

// 4. Listen for incoming messages.
socket.on('newMessage', (message) => {
  console.log('new message:', message)
})

// 5. Send a message, and also get it back as an ack.
socket.emit(
  'sendMessage',
  { conversationId: 12, messageBody: 'See you at 3pm' },
  (ack) => console.log('server ack:', ack),
)
```
