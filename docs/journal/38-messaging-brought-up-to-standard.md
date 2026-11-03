# Messaging, brought up to the standard the rest had reached

This entry covers the backend pass of the frontend's Phase 5
(2026-10-19 → 2026-10-20). Messaging had existed since entry 09, built
before the care team, before the audit convention and before any rule lived
in the database twice. Phase 5's screens were going to make it easy to use,
so the backend was first read against the standards Phases 3–4 had set
(entries 36–37). A patient describing a sharp pain is clinical content, and
the bar was the same as for a session.

Condensed to four stories; the full list is in [`PROJECT.md`](../PROJECT.md).
The live screens — the cache written from socket events, read receipts, the
15-minute delete window drawn to the millisecond — are the frontend
journal's Phase 5 entry
(`docs/journal/03-messaging-shown-once-stored.md`, TODO-LINK).

## Nine gaps, found by reading

Reading the existing code against what Phases 3–4 had made normal found nine
gaps. Six of them mattered:

- **A "deleted" message came back on refresh.** Only the delete's own answer
  hid the text; the history served rows raw. Every read now goes through one
  function, `toPublicMessage()`, which answers deleted text as `null` (not a
  placeholder sentence, which could be confused with a real message saying
  it).
- **A former care-team member could write forever.** The care team was
  checked when a conversation *started*, never when a message was *written*.
  A permission belongs at the moment of the act.
- **Socket writes left no audit entry and were never validated.** The generic
  audit interceptor and the global `ValidationPipe` both work only on HTTP. A
  gateway needs its own pipe, and an audit path that doesn't depend on the
  interceptor: the service writes one entry per write, whichever door the
  write came through.
- **Admins read every message.** Migration 0048 took the admin branch out of
  `conversations_select`. Messages' own policy is "you see a message when you
  see its conversation", so that one change covered both tables.
- **A socket kept the role it connected with**, after a role switch or a
  sign-out (next section).
- **A patient could re-point a conversation at another practitioner.** The
  `UPDATE` policy's `WITH CHECK` only required the caller to stay in the row.
  A trigger now fixes the participants (`guard_conversation_update`). A
  policy says which rows; a trigger says which values may change — entry 37's
  pattern again.

Migration 0047 added the text rules to the database (`message_body ~ '\S'`
and ≤ 5,000 characters, the DTO's own tests). It was hand-edited first to
repair the rows the old, unvalidated socket had let in, because a CHECK
checks every existing row.

## The database alone decides "read-only"

Sending is refused once the care-team link has ended; the history stays
readable, because it is the patient's record. The first version had both a
service pre-check and the policy. A mutation removing the pre-check
*survived*: the policy refused the same write with the same answer, so no
test could tell them apart. Of the two, only the policy is atomic. A
pre-check reads the care team, then writes a moment later, and a link ended
in between slips past it anyway. So the pre-check went, and the policy's
`42501` is translated into the `403`. It is the same reasoning as letting a
UNIQUE constraint decide a duplicate. The same single SQL function,
`rls_care_team_member()`, is used by the `INSERT` policy and selected as a
column in the conversation list (`canSend`), so the list's "you can reply"
and the write's permission are one definition.

Two smaller structural choices came with it. **Live events are emitted after
the commit, never inside the transaction**: pushing a message whose write
then rolled back would show people something that doesn't exist. And the
service can't inject the gateway, which already depends on the service, so a
small provider, `MessagingEvents`, holds the Socket.IO server. The gateway
hands it the server at start-up, and the service and the auth controller
emit through it.

## Sockets outlive sessions unless you close them

A socket is authenticated once, at its handshake, and then stays open. Each
connection now joins two **rooms** decided by its session:
`user:<id>:<role>` (so a two-role account hears a conversation only in the
role it's part of) and `session:<sessionId>`. Per-conversation joins, each
with a participant check of its own, are gone. Signing out or switching role
closes the session's room. A role switch gives the session a *new* id
(Passport's `req.login` regenerates it), so the controller reads the old id
first and then disconnects that room.

The same gap turned up again a phase later, which is why it is worth naming.
While building the email change (entry 39), a password reset and a
deactivation were found to end a person's *HTTP* sessions but not their
sockets: a signed-out or deactivated device kept receiving messages. Both
now take the ended sessions' ids from `DELETE … RETURNING sid` and close
those rooms after the commit, like every other path that ends a session. A
socket's errors also travel back through its acknowledgement now, instead of
Nest's default separate `exception` event. That event is linked to nothing,
so a screen that had sent two messages couldn't tell which one had failed.

## Testing an edge real timing never hits

A sender may delete their own message while it is unread and at most 15
minutes old. The trigger allows `now() - sent_at` up to `interval '15
minutes'`, the last instant included. A first round of mutations left
`>` → `>=` alive, because no real request ever lands on the exact
microsecond. The test that kills it builds the edge inside **one
transaction**, where `now()` is one instant. As the owner, it ages the
message by exactly 15 minutes; then `SET LOCAL ROLE` switches to the app's
role and it deletes. The same idea (make the boundary a single instant, then
test both sides of it) was reused in Phase 6 for the instant an invitation
expires.

Delete against read is the other race: the recipient marks the message read
at the moment the sender deletes it. The delete's `UPDATE` repeats "still
unread" in its own `WHERE`. Under READ COMMITTED, an `UPDATE` that waited on
a row lock re-checks its `WHERE` against the committed row, so it finds the
message read, updates nothing, and answers `409`. A `whileHolding` test
(entry 37) holds the read uncommitted to prove it.

## Current status

The backend pass was green on 2026-10-20, the screens the same day, and the
person confirmed the two-window demo, which completed Phase 5. A small
clean-up followed before Phase 6: backend lint went from 66 problems to 8,
each fixed rather than suppressed, including a socket.io-vs-Express `next`
mismatch the old `any`s had hidden. The socket protocol as it stands is
[`docs/api/02-websocket-api.md`](../api/02-websocket-api.md), and the design
is ARCHITECTURE's [§7](../ARCHITECTURE.md#7-real-time-messaging).
