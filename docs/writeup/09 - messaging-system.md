# Messaging: real-time infrastructure and two design decisions

This document covers `MessagingModule` — the last module from the original
spec — and two product-design questions worth recording in detail, since both
diverge from the app's usual default pattern for good, specific reasons.

## Reusing session authentication for WebSocket connections

WebSocket connections in NestJS do not automatically pass through Express's
middleware chain — meaning `app.use(session(...))` never runs for a socket
handshake unless something explicitly makes it. A custom `SessionIoAdapter`
resolves this: it wraps Socket.IO's own server creation and runs the *same*
session middleware instance (extracted into its own named variable in
`main.ts`, rather than passed inline, specifically so it could be reused for
both transports) against every socket handshake. This is the standard,
documented pattern for this integration — passing a non-functional
placeholder in place of Express's real `Response` object, since one
genuinely isn't available at this point in the connection lifecycle, and
isn't needed for a read-only session lookup. TypeScript requires this
placeholder be explicitly cast (`{} as Response`), rather than left
structurally untyped, along with using Express's own `NextFunction` type
directly instead of a narrower hand-written callback signature — a hand-
rolled type is an easy way to miss cases (like Express's string-based
internal `next()` calls) that aren't obvious until the type checker flags
the mismatch.

`MessagingGateway.handleConnection` then performs the WebSocket equivalent of
`SessionSerializer.deserializeUser` manually — reading `activeRole` off the
session, reloading the user, and re-validating the role is still held —
rather than trying to make Passport's own (Express-specific) deserialization
machinery run inside the WebSocket context, which would need wrapping
`passport.initialize()`/`passport.session()` too, real added complexity for
one connection event.

`MessagingService.sendMessage()` is called identically by both the REST
`POST` route and the WebSocket `sendMessage` event — there is exactly one
place a message is ever created. Only the gateway path broadcasts live (via
Socket.IO rooms, one room per conversation); the REST route is a fallback for
non-socket clients, consistent with how this was scoped from the start.

## Per-participant conversation archiving, not a shared flag

A conversation always has exactly two participants, and "archived" is a
property of each person's own relationship to it, not a shared fact about the
row — unlike every other soft-delete flag in this schema (`users.isActive`,
`exercises.isArchived`), a single boolean would incorrectly hide the
conversation from *both* people the moment either one archived it. The fix
was two independent nullable timestamp columns
(`practitionerArchivedAt`/`patientArchivedAt`), not a separate join table —
a conversation's participant count is fixed at exactly two by the schema's
own `UNIQUE(practitionerId, patientId)` constraint, so two columns is the
right amount of structure, not an under-built shortcut. Two explicit actions
(`archive`/`unarchive`) were chosen over one ambiguous toggle endpoint, each
touching only the calling user's own column. An admin's oversight view
deliberately ignores archive state entirely — it's a personal inbox action,
not something that should hide a conversation from administrative review.

## Message deletion: narrower than a typical chat app, deliberately

A naive "delete within N minutes" design (common in consumer messaging apps)
was rejected in favor of two conditions that both must hold: the recipient
must not have read the message yet, **and** it must be within a 15-minute
window of sending. Read status is the more meaningful boundary of the two —
once the other party has seen a message, retracting it is closer to rewriting
history than correcting a typo. This decision follows directly from the
schema's governing principle established from the very first design pass:
clinical communication history — reported symptoms, guidance given — should
never quietly disappear once acted upon or seen, the same reasoning behind
`audit_logs` being insert-only and `assigned_program_exercises` being a
permanent copy rather than a live reference.

Deletion is a soft delete (`messages.deletedAt`), matching the schema's
established discipline: the row is never removed. What changes is the served
representation — `MessagingService.toPublicMessage()` replaces the real
`messageBody` with a tombstone (`"[message deleted]"`) for anyone reading it,
sender included, rather than the message silently vanishing from the thread
with no trace. A dedicated `deleteMessage` WebSocket event mirrors
`sendMessage`'s live-broadcast pattern, so a deletion updates the other
party's open thread immediately rather than only on their next fetch.

## A process note: catching a self-inflicted regression immediately

While adding `deleteMessage`, a `str_replace` edit intended to insert new
methods before `findConversationOrThrow` instead replaced that method's
entire body, leaving a syntactically broken file. This was caught by
re-reading the complete file immediately after the edit, rather than trusting
the diff output alone, and fixed in the same turn before being presented —
the same "verify before presenting" discipline this project has applied
consistently since the earlier `validateUser()` and `database-url.ts`
incidents, worth naming again here as a repeated, deliberate practice rather
than a one-off catch.
