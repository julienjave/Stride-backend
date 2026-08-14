# Normalizing error messages, and a documentation-accuracy pass the RLS rollout had already broken

This document covers two separate, smaller pieces of work done in the same
pass — a real API contract cleanup, and a documentation review that turned
up a genuine, previously-unnoticed consequence of the RLS rollout (docs
23–24) on what clients actually see.

## `message` is now always an array

The global error shape (doc 03's own reference) had a real inconsistency:
`class-validator` failures return `message` as an array (one entry per
failed constraint), but every other thrown error returns a single string.
A frontend error-rendering function had to branch on which shape it got,
or break specifically on the most common real error case — the same
"two shapes for one field" problem this project has hit before, just in an
API contract rather than a database column this time.

Fixed at the source in both places a response actually gets built —
`HttpExceptionFilter` (REST) and `WsHttpExceptionFilter` (WebSocket) —
rather than only one of the two transports. Each now wraps a bare string
`message` in a single-element array immediately before it's sent, leaving
an already-array `message` untouched:

```ts
const messages = Array.isArray(message) ? message : [message]
```

Small, but genuinely required checking two things before trusting it:
whether any test asserted the old string shape directly (exactly one did
— `messaging-gateway.e2e-spec.ts`'s `joinConversation` rejection test,
updated from `.toBe(...)` to `.toEqual([...])`), and whether the fix
actually holds across the full suite, not just the one file touched — the
full run (165 unit, 97 e2e) passed clean afterward. Committed as
`a3531f1c2a66c113e2fbcdd74365797e9670b949`.

One small, familiar wrinkle surfaced getting there: the local `stride_app`
role's password had drifted out of sync with `.env` before the test run
could even start, needing a re-sync via `db:create-app-role` first. Not
itself a bug — almost certainly a leftover from local secret rotation
without a corresponding role-password sync — but worth naming as one more
small instance of the environment-drift pattern doc 26 already named
directly, recurring at a smaller scale.

## The API docs' RLS blind spot

Doc 03's docs (`docs/api/01` through `05`) were written and verified after
the two bug hunts (docs 20, 22) but **before** the RLS rollout (docs
23–24) — a fact not stated anywhere in the docs themselves, only
inferable from what they did and didn't describe. Reviewing them against
the current, post-rollout codebase surfaced a real, confirmed gap: RLS
changed a client-visible status code on four resources, and nothing had
caught it.

**The mechanism**: `medical_files`, `assigned_programs`, `sessions`, and
`conversations` all follow the same fetch-then-check pattern —
`findXOrThrow`, then a service-level ownership/participant check against
the result. Each of those tables' RLS `SELECT` policy mirrors the same
ownership rule the service check already encodes. So a caller who'd fail
the ownership check now never gets the row back from the RLS-scoped query
in the first place — `findXOrThrow` throws `NotFoundException` before the
ownership check code is ever reached. Every one of the four services
carries its own comment stating this outright (`assigned-programs.service.ts`,
verbatim: *"so an out-of-scope row reads as 404, not 403"*) — this had
already been decided and documented in code during the rollout itself; it
just never propagated to the API reference docs describing the same
behavior to frontend consumers.

The strongest evidence wasn't inference — it was `messaging-gateway.e2e-spec.ts`'s
own current, passing assertion for exactly the scenario `02-websocket-api.md`
documented as a `403`: the real test expects `404`,
`"Conversation <id> not found"`, with its own comment reading *"rather
than the `ForbiddenException` it used to be."* The documented example and
the actual enforced behavior had genuinely diverged.

**Fixed**: `01-authentication.md` (swapped a now-wrong medical-files `403`
example for a still-accurate one, and added the general exception as a
documented caveat), `02-websocket-api.md` (the `joinConversation` section
and the `exception` event's example payload, both corrected to the real
`404` shape, with the mechanism explained rather than just the value
changed), `04-authorization.md` (one general explanation where the
layered-authorization model is introduced, plus a short, consistent flag
on each of the four affected resource sections — including the one real
nuance found along the way: medical files' *list* endpoint, gated by
`?patientId=`, is genuinely unaffected, since that check runs before any
RLS-scoped query and never depends on a specific row being fetched first).
`03-conventions.md` and `05-getting-started.md` were checked directly
against the current codebase and needed no changes.

Worth naming as a pattern in its own right, not just a one-off fix: this
is the same shape of problem as `PROJECT.md`'s stale log-rotation claim
(doc 25) and the original architecture writeup's RLS overclaim (doc 01/23)
— a document that was accurate when written, quietly outlived by a later,
unrelated change to the system it describes, and never automatically
flagged as needing a second look. Nothing about this project's current
tooling catches that class of drift on its own; it still depends on
someone deliberately re-checking a document against current source, the
same discipline applied here.

## Status

Both fixes are committed and verified — the message-normalization change
against a full passing test suite, the doc corrections against actual
current source and a real passing e2e assertion. The five API docs'
"Verified against commit `4cd2176e...`" headers still need updating to the
real current commit (`a3531f1c2a66c113e2fbcdd74365797e9670b949` at time of
writing, though further commits may have landed since) — flagged, not yet
confirmed done.
