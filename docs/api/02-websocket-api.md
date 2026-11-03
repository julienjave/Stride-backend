# WebSocket API — `MessagingGateway`

Source of truth:
[`src/messaging/messaging.gateway.ts`](../../src/messaging/messaging.gateway.ts),
[`src/messaging/messaging-events.ts`](../../src/messaging/messaging-events.ts),
[`src/messaging/ws-exception.filter.ts`](../../src/messaging/ws-exception.filter.ts),
[`src/messaging/session-io.adapter.ts`](../../src/messaging/session-io.adapter.ts),
[`src/messaging/messaging.service.ts`](../../src/messaging/messaging.service.ts).
Every behaviour below has a test in
[`test/messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts),
which drives real Socket.IO connections against a running app.

Swagger documents HTTP routes only, so none of this appears at `/api-docs`.

**Transport:** [Socket.IO](https://socket.io/) 4 (`socket.io@^4.8.3`,
`@nestjs/platform-socket.io@^11`), on the API's own address. It uses the
default namespace (`/`) and path (`/socket.io`). The gateway's CORS uses the
same allow-list as the REST API (`FRONTEND_URLS`), with credentials.

## What the socket is for

The socket is the **live** half of messaging. Every action also exists as a
REST route (`/conversations…`), and REST is the way to load things: the
conversation list, a thread's history, marking as read, archiving. The
socket adds two things:

1. **The server pushes events** to everyone concerned the moment something
   happens: a new message, a deletion, a "seen", an archive. That holds
   **whichever door the change came through.** The service emits the event
   itself, after its transaction commits, so a message sent with
   `POST /conversations/:id/messages` is pushed exactly like one sent over
   the socket.
2. **Two actions can be sent over it**, `sendMessage` and `deleteMessage`.
   They call the same service methods as the REST routes, with the same
   rules, the same audit entries and the same answers.

## Connecting

There is no separate WebSocket login: the socket is authenticated by the
**same session cookie** as REST. Sign in over REST first (and complete the
two-factor step, if the account has one), then connect with credentials so
the handshake carries the cookie:

```ts
const socket = io('https://api.stridecare.app', { withCredentials: true })
```

Two pieces make the cookie work for a socket:

- **`SessionIoAdapter`** runs the app's own `express-session` middleware
  on every Socket.IO handshake. Socket.IO doesn't go through Express's
  middleware by default, so without this the handshake would have no
  session at all.
- **A Socket.IO middleware** (`server.use(...)` in the gateway's
  `afterInit`) checks that session. Being middleware, not a
  `handleConnection` hook, matters: Socket.IO waits for it to finish before
  the connection counts as open. So no event from the client can reach a
  handler before the user is known. (An earlier version used
  `handleConnection` and had exactly that race. The test "handles an event
  emitted immediately on connect" guards against it coming back.)

The middleware, on every handshake:

1. **No signed-in session**: refused, `Unauthorized`.
2. **The session's active role is `admin`**: refused, `Forbidden`.
   Messaging is between a practitioner and a patient; admins read no
   messages (decided 2026-10-20). The REST routes say the same, since all
   are `practitioner, patient` in the [endpoint index](./06-endpoints.md).
3. **The account no longer has that role** (removed since sign-in):
   refused, `Unauthorized`.
4. Otherwise the user is loaded (the same shape as `@CurrentUser()` over
   REST), and the connection joins its **two rooms**:
   - `user:<id>:<role>`: every tab and device of this person in this
     role. Every event for a conversation is sent to its two participants'
     rooms, so the conversation list, the unread badge and an open thread
     all hear about every conversation. The client joins nothing itself, so
     there is nothing to authorize per conversation. The role is part of
     the name: someone who is both a practitioner and a patient hears their
     patients' messages only while signed in as a practitioner.
   - `session:<sessionId>`: the connections of one sign-in session, so the
     server can close exactly those (below).

   Joining happens *inside* the middleware, before the client's `connect`
   fires, so no event can be missed between connecting and joining.

A refused handshake never fires `connect`, only `connect_error`, with the
reason as its message (`err.message` is `'Unauthorized'` or `'Forbidden'`).
Treat it as "this session can't open a socket": sign in again over REST.

**The server closes the socket when the session ends or changes.** A
socket is authenticated once, at its handshake, so the server disconnects
a session's sockets when:

- that session signs out or switches role;
- the account changes in a way that signs its other sessions out: a
  password, email or two-factor change, a deactivation or a merge.

After a role switch the client reconnects and gets a socket for the new
role. After a sign-out, the reconnection is refused.

**One server process.** Rooms live in the memory of the process holding the
connection. Running several backend instances would need Socket.IO's Redis
adapter; that's listed in the deferred improvements.

## Client → server events

Both events are validated like a REST body: the gateway has its own
`ValidationPipe`, with the same options as the global one ([unknown fields
refused, types converted](./03-conventions.md#requests)).

### Acknowledgements: how each event ends

Pass a callback as the last argument of `emit`. It receives one shape for
success and failure alike:

```ts
type WsAnswer<T> =
  | { ok: true; data: T }                                       // what REST would answer
  | { ok: false; status: number; message: string[]; requestId?: string }
```

- `status` and `message` are those the REST route would give for the same
  refusal (`404`, `409`…, and the same sentences). Database refusals are
  translated by the same function as over REST
  ([conventions](./03-conventions.md#database-refusals-become-the-same-answers)).
- An unexpected failure answers `status: 500`,
  `message: ["Internal server error"]` and a `requestId`. An event on an
  open socket is not an HTTP request, so it has no `X-Request-Id` header;
  this id plays that role and is the one in the server's log.
- **Use the acknowledgement.** Without one, a refusal arrives as a separate
  `exception` event (`{ status, message }`) that doesn't say which `emit`
  failed. A screen that sent two messages couldn't tell which one to mark
  "not sent". The `exception` event is kept only for clients that send no
  callback.

### `sendMessage`

```ts
socket.emit(
  'sendMessage',
  { conversationId: 12, messageBody: 'See you at 3pm' },
  (answer) => { /* { ok: true, data: PublicMessage } */ },
)
```

The same as `POST /conversations/:id/messages`:

- `conversationId` is a positive integer.
- `messageBody` is a string of up to 5,000 characters that isn't blank.
- The caller must be one of the conversation's two participants
  (`403 You are not a participant in this conversation`). A conversation
  the caller can't see at all answers `404`: Row-Level Security hides it
  before any participant check runs.
- The two must still share a care team. Otherwise the conversation is
  read-only (`403`). If the patient's account is deactivated, it's a `409`
  that says so; reactivating the account clears it.
- A new message brings the conversation back out of both participants'
  archives.

On success, `newMessage` is pushed to both participants, the sender's other
tabs included, and the acknowledgement carries the message. The sender's
own screen can use it to replace its "sending…" bubble.

### `deleteMessage`

```ts
socket.emit(
  'deleteMessage',
  { conversationId: 12, messageId: 501 },
  (answer) => { /* { ok: true, data: PublicMessage with messageBody: null } */ },
)
```

The same as `DELETE /conversations/:id/messages/:messageId`, a **soft**
delete: the row stays, its text is no longer shown. All of these must hold:

- the message is in that conversation (`404` otherwise);
- the caller sent it (`403 You can only delete your own messages`);
- it hasn't been read yet (`409`);
- it was sent less than **15 minutes** ago (`409`). The database's clock
  decides, and a trigger enforces the same rule if two requests race.

Deleting a message you already deleted (from another tab) succeeds again
without changing anything.

## Server → client events

The full list, with payloads, is the `ServerEvents` type in
[`messaging-events.ts`](../../src/messaging/messaging-events.ts). Every
event goes to both participants' `user:` rooms, except
`conversationArchived`.

### `newMessage`

A message was sent, through REST or the socket. The payload is a
`PublicMessage`:

```json
{
  "id": 501,
  "conversationId": 12,
  "senderId": 7,
  "messageBody": "How's the knee feeling today?",
  "sentAt": "2026-11-03T14:22:03.101Z",
  "readAt": null,
  "deletedAt": null
}
```

### `messageDeleted`

A message was deleted. The same `PublicMessage`, with
**`messageBody: null`** and `deletedAt` set. Every later read of the thread
shows it the same way.

### `conversationRead`

The reader marked the thread read (`PATCH /conversations/:id/read`). That
gives the sender's "Seen", and clears the reader's unread badge in their
other tabs.

```json
{ "conversationId": 12, "readerId": 9, "readAt": "2026-11-03T14:25:00.000Z", "messageIds": [501, 502] }
```

### `conversationArchived`

I archived or unarchived the conversation (`archivedAt: null` means
unarchived). It goes **to my own connections only**: archiving is per
participant, so the other person's view doesn't change.

```json
{ "conversationId": 12, "archivedAt": "2026-11-03T14:30:00.000Z" }
```

## End-to-end example

```ts
import { io } from 'socket.io-client'

const API = 'https://api.stridecare.app'

// 1. Sign in over REST: this sets the session cookie.
await fetch(`${API}/auth/login`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'patient@example.com', password: '…' }),
})

// 2. Connect: the browser sends the same cookie with the handshake.
const socket = io(API, { withCredentials: true })
socket.on('connect_error', (err) => console.warn('refused:', err.message))

// 3. Listen. No room to join: every conversation's events arrive here.
socket.on('newMessage', (message) => console.log('new message', message))
socket.on('messageDeleted', (message) => console.log('deleted', message.id))
socket.on('conversationRead', (receipt) => console.log('seen', receipt.messageIds))

// 4. Send, and learn how it ended from the acknowledgement.
socket.emit('sendMessage', { conversationId: 12, messageBody: 'See you at 3pm' }, (answer) => {
  if (answer.ok) console.log('sent', answer.data.id)
  else console.warn(answer.status, answer.message.join(' '))
})
```
