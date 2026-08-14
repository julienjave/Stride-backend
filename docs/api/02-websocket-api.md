# WebSocket API — `MessagingGateway`

Verified against commit `a3531f1c2a66c113e2fbcdd74365797e9670b949`. Source of
truth: [`src/messaging/messaging.gateway.ts`](../../src/messaging/messaging.gateway.ts),
[`src/messaging/ws-exception.filter.ts`](../../src/messaging/ws-exception.filter.ts),
[`src/messaging/session-io.adapter.ts`](../../src/messaging/session-io.adapter.ts),
[`src/messaging/messaging.service.ts`](../../src/messaging/messaging.service.ts),
and [`test/messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts)
(the only test file that drives a real socket connection end-to-end — every
concrete payload and status below is cross-checked against its assertions).

This has **zero** Swagger coverage — Swagger only documents HTTP routes.
Everything below was read directly from the gateway and service source.

Transport: [Socket.IO](https://socket.io/) v4 (`socket.io@^4.8.3`,
`@nestjs/platform-socket.io@^11`), default namespace (`/`), no custom path
configured. CORS for the gateway is configured separately from the HTTP API
(`@WebSocketGateway({ cors: { origin: getAllowedOrigins(), credentials: true } })`)
but reads the exact same `FRONTEND_URLS`-derived allowlist as the REST API.

## Connection: authenticated via the same session cookie as REST, via real Socket.IO middleware

There is no separate WebSocket login or token exchange. Socket.IO's handshake
does **not** go through Express's normal middleware chain by default — two
pieces of this app work together to make it do so anyway:

1. **`SessionIoAdapter`** (registered in `main.ts` via
   `app.useWebSocketAdapter(new SessionIoAdapter(app, sessionMiddleware))`)
   wraps Socket.IO's own server creation to run the *same*
   `express-session` middleware instance used for HTTP requests against
   every socket handshake, before Socket.IO does anything else with it. This
   is what makes `socket.request.session` available at all inside the
   gateway — the real, shared session store, not a parallel mechanism
   invented for sockets.
2. **`MessagingGateway.afterInit`** registers genuine **Socket.IO
   middleware** via `server.use(...)` — *not* the `handleConnection`
   lifecycle hook. This distinction matters and is worth being precise
   about: `server.use()` middleware must fully resolve — including the
   `await usersService.findOne(...)` call inside it — before Socket.IO
   considers the connection established at all, and *no event from that
   client can reach any handler until it does*. (`handleConnection`, by
   contrast, does not block delivery of the client's own subsequent events;
   an earlier version of this gateway used `handleConnection` for this same
   check and had a real race condition as a result — a client emitting an
   event immediately after `'connect'` could reach a handler before the
   async user lookup had resolved, crashing on an unset `socket.data.user`.
   [`test/messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts)
   has a dedicated regression test for this — "handles a joinConversation
   event emitted immediately on connect, with no delay".)

The middleware itself, on every handshake:

1. Reads `socket.request.session?.passport?.user` — the exact
   `{ id, activeRole }` shape `SessionSerializer.serializeUser` stores for
   HTTP sessions (see [Authentication](./01-authentication.md)). If absent,
   the handshake is rejected by calling `next(new Error('Unauthorized'))`.
2. Otherwise, re-loads the full user via `UsersService.findOne(id)`. If the
   session's stored `activeRole` is no longer among the user's actual roles
   (a role was revoked since this session was established — the same check
   `SessionSerializer` performs for HTTP), the handshake is rejected the
   same way.
3. On success, stashes `{ ...user, activeRole }` on `socket.data.user` —
   every event handler below reads this to know who's connected; it plays
   the same role `@CurrentUser()` plays for HTTP controllers.

**What the client actually sees on rejection:** calling `next(new Error(...))`
inside Socket.IO server middleware makes the handshake itself fail — the
client's `'connect'` event never fires at all; only `'connect_error'` does,
and the socket never reports as connected
(`socket.connected` stays `false`). This is exactly what
[`test/messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts)
asserts ("rejects a socket connection with no session cookie" — listens for
`'connect'` vs `'connect_error'` and asserts only the latter fires). There is
no structured error payload describing *why* the handshake was rejected
(invalid session vs. revoked role) — treat any `connect_error` as "this
session isn't valid for a socket connection; the user needs to be
re-authenticated over REST first."

**Practical implications for the frontend:**

- The user must already hold a valid, fully-authenticated HTTP session
  (`POST /auth/login` completed — and `POST /auth/mfa/verify` too, if MFA is
  enabled) *before* opening the socket connection. There is no way to
  authenticate a socket independently.
- Connect with credentials enabled so the handshake request carries the
  `connect.sid` cookie. With `socket.io-client`, `extraHeaders: { Cookie:
  '...' }` (as the e2e tests do, since they don't run in a browser) or,
  in an actual browser, `io(url, { withCredentials: true })` is what makes
  the browser attach the cookie automatically.

## Client → Server events

### `joinConversation`

```ts
socket.emit('joinConversation', { conversationId: number })
```

Handled by `MessagingGateway.handleJoin`. Joins the Socket.IO room
`conversation:<conversationId>` — everyone in that room receives every
`newMessage`/`messageDeleted` event broadcast to it.

**This performs a real authorization check**, via
`MessagingService.assertUserCanJoinConversation`, which is deliberately the
exact same check (`findConversationOrThrow` + `assertParticipant`) that
every REST endpoint on this resource uses: the conversation must exist and
be visible to this session, and the caller must be one of its two
participants (practitioner or patient) — or an admin, who is allowed to
join/view any conversation but, as covered in
[Roles & Authorization](./04-authorization.md), cannot send into one.
Failing either check throws `NotFoundException`/`ForbiddenException`,
caught by `WsHttpExceptionFilter` (see below) rather than a manual
`try`/`catch` in the handler — the same "let the filter handle it" pattern
REST controllers rely on.

**Row-Level Security changes which of those two exceptions a genuinely
unrelated caller actually gets.** `conversations` carries a `SELECT` policy
mirroring `assertParticipant`'s own rule, so `findConversationOrThrow`'s
query simply returns nothing for a socket with no real relationship to the
conversation — `assertParticipant` never runs at all, because there's no
row left to check it against.
[`test/messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts)
exercises this directly: a genuinely authenticated socket with no
relationship to the target conversation gets a `404` `exception` event with
message `` `Conversation <id> not found` `` — not a `403`, and not a silent
join. An admin, by contrast, *is* visible to `conversations`' RLS policy
(admins see every conversation by design), so an admin's join always
succeeds at this particular check — the explicit
send/markAsRead/archive blocks documented in
[Roles & Authorization](./04-authorization.md) are what actually stop an
admin from participating, not this one.

**Payload validation:** `data` is typed as a plain TypeScript interface
(`{ conversationId: number }`), not a `class`-based DTO the way REST body
payloads are. The global `ValidationPipe` registered in `main.ts` does apply
across NestJS's request-handling pipeline generically, but `ValidationPipe`
only actually validates a parameter when its reflected type is a real class
with `class-validator` decorators — a plain object-literal type has no such
metadata, so it passes through untouched. In practice this means a
malformed or missing `conversationId` isn't rejected with a clean validation
error the way a malformed REST body would be; it flows straight into the
service layer, where a non-existent/undefined id will surface as a
`NotFoundException` from `findConversationOrThrow` (translated to a `404`
`exception` event by the filter) rather than a `400`. Send well-formed
payloads — there's no dedicated schema-validation safety net on this
transport the way there is for REST bodies.

### `sendMessage`

```ts
socket.emit('sendMessage', { conversationId: number, messageBody: string })
```

Handled by `MessagingGateway.handleSendMessage`, which calls the exact same
`MessagingService.sendMessage()` used by the REST fallback
(`POST /conversations/:id/messages`) — persistence behavior is identical
either way (see the REST-vs-WebSocket divergence note below for what is
*not* identical). Authorization: the conversation must exist and the caller
must be a genuine participant (`assertParticipant`); additionally, **an
admin is explicitly blocked from sending** — `ForbiddenException`,
`"Sending a message is a participant-only action"` — even though an admin
passes the participant check for read purposes elsewhere in this module. On
success:

1. Broadcasts a `newMessage` event to the whole room
   `conversation:<conversationId>` — including the sender's own other open
   tabs/devices, so a multi-device session stays in sync.
2. Returns the created message row as a Socket.IO **acknowledgement** — if
   your client passes a callback as the third argument to `.emit()`, it
   receives the same payload directly, without needing to separately listen
   for the broadcast.

### `deleteMessage`

```ts
socket.emit('deleteMessage', { conversationId: number, messageId: number })
```

Handled by `MessagingGateway.handleDeleteMessage`, calling
`MessagingService.deleteMessage()` — a **soft delete** gated by conditions
that must **all** hold:

- The caller must be a genuine conversation participant (`assertParticipant`).
- The caller must be the message's original sender — not just a
  participant. `ForbiddenException`, `"You can only delete your own
  messages"`.
- The message must be **unread** (`readAt` still `null`). `ForbiddenException`,
  `"This message has already been read and can no longer be deleted"`.
- The message must be within **15 minutes** of `sentAt`.
  `ForbiddenException`, `"This message can no longer be deleted — the 15
  minute window has passed"`.
- The message must actually belong to the given `conversationId`
  (`NotFoundException` otherwise).

On success, broadcasts `messageDeleted` to the room and returns the same
tombstoned payload as an acknowledgement (see `messageDeleted` below for the
exact shape).

## Server → Client events

### `newMessage`

Emitted to `conversation:<conversationId>` whenever a message is created via
the `sendMessage` WS handler. Payload is the raw inserted `messages` row:

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
`deleteMessage`. Payload is the updated row with `messageBody` replaced by a
tombstone (`MessagingService.toPublicMessage`) — the row is never physically
removed, so every later read of this conversation's history (REST or
WebSocket) shows the same tombstone:

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

### `exception` — thrown errors, translated to real status codes and messages

`@UseFilters(new WsHttpExceptionFilter())` is applied at the gateway class
level (`messaging.gateway.ts`), so it runs for every handler in this file.
This matters: `MessagingService` throws ordinary Nest `HttpException`
subclasses (`NotFoundException`, `ForbiddenException`) — the *same* classes
used throughout the REST API — not `WsException`. Nest's default WebSocket
exception handling (`BaseWsExceptionFilter`) only gives special treatment to
actual `WsException` instances; anything else collapses into a generic
"Internal server error" with no useful detail. `WsHttpExceptionFilter`
exists specifically to prevent that: it catches any `HttpException`, pulls
out its real `status` and `message`, wraps them in a `WsException`, and
*then* hands off to `BaseWsExceptionFilter`'s own handling — so the caller
gets the real reason, not a generic failure.

Concretely, a rejected handler emits an `exception` event on the throwing
client's own socket, shaped:

```json
{ "status": 404, "message": ["Conversation 12 not found"] }
```

This exact shape and value is what
[`test/messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts)
asserts for an unrelated practitioner's rejected `joinConversation` — see
the Row-Level Security note above for why this is a `404`, not the `403`
an unrelated participant might otherwise expect. The same translation
applies to every thrown `HttpException` from any handler in this gateway —
a rejected `sendMessage`/`deleteMessage` (wrong 15-minute window, not the
sender, not a participant, an admin blocked from sending, etc.) surfaces
its real, specific message and status the same way a REST caller of the
identical underlying service method would see in the JSON error body.
Listen for `'exception'` on the socket to catch these.

## REST-sent messages do **not** broadcast over the socket

`POST /conversations/:id/messages` (the REST fallback) and the `sendMessage`
WS event both call the identical `MessagingService.sendMessage()`, so the
message is created identically either way — but the
`this.server.to(...).emit('newMessage', ...)` broadcast line lives *only*
inside `MessagingGateway.handleSendMessage`, not inside `MessagingService`
itself. A message sent via the REST endpoint is persisted correctly and
appears on the next `GET /conversations/:id/messages` poll, but **no
connected socket — including the sender's own other tabs — receives a live
`newMessage` event for it.** If a frontend mixes both paths, the REST path
will feel "silent" until something else triggers a refetch. For a genuinely
live chat experience, send messages exclusively through the `sendMessage` WS
event.

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

// 2. Connect the socket, reusing that same cookie via the browser's cookie jar.
const socket = io('https://api.example.com', { withCredentials: true })

socket.on('connect', () => console.log('connected'))
socket.on('connect_error', (err) => console.warn('handshake rejected:', err.message))
socket.on('exception', (err) => console.warn('server rejected an event:', err.status, err.message))

// 3. Join the conversation's room — server verifies real participation first.
socket.emit('joinConversation', { conversationId: 12 })

// 4. Listen for incoming messages.
socket.on('newMessage', (message) => {
  console.log('new message:', message)
})

// 5. Send a message, and also get it back as an acknowledgement.
socket.emit(
  'sendMessage',
  { conversationId: 12, messageBody: 'See you at 3pm' },
  (ack) => console.log('server ack:', ack),
)
```
