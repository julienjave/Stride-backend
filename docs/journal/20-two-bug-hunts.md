# Two bug hunts: one accidental, one deliberate

This document covers the security and correctness bugs found across this
project's most recent stretch of work — starting with a documentation task
that surfaced real bugs unexpectedly, then a deliberate, methodology-driven
hunt for more.

## It started with API documentation, not a security review

Asked for professional API documentation, complementing (not duplicating)
the auto-generated Swagger reference already live at `/api-docs` — focused
specifically on what Swagger structurally can't express: the session-cookie
auth model, the WebSocket API, and a real getting-started path. Writing
accurate documentation forces a careful trace through actual behavior
rather than trusting a comment or a controller's apparent shape — and that
process surfaced three genuine, unrelated bugs along the way, entirely as
a side effect of the documentation task actually being done properly.

**`GET /users/:id` had no clinic-scoping at all** — its `PATCH`/`DELETE`
siblings on the same resource correctly verified a real managed
relationship (`isPatientManagedBy`); the `GET` route trusted the
practitioner *role* alone, letting any practitioner view any user's full
profile regardless of any actual connection to them.

**A code comment claimed something the code never enforced.**
`archiveConversation`/`unarchiveConversation` stated admins don't get an
archive action — a deliberate design choice — but nothing actually checked
for it; an admin calling either endpoint would silently fall into the
patient's own archive-state branch, corrupting a real participant's data on
a conversation the admin wasn't even part of.

**`joinConversation` had zero authorization check.** Any authenticated
WebSocket connection could join any conversation's room purely by knowing
its numeric id — receiving every real-time message broadcast to a clinical
conversation with no actual relationship to it at all.

## Fixing the third bug surfaced a fourth, more serious one

Writing a genuine test for the missing join check — rather than trusting
the fix once it compiled — exposed a real, previously invisible race
condition: `handleConnection` ran asynchronously without actually blocking
further events, meaning a client emitting an event immediately after
connecting could reach its handler before session data had finished
populating. Fixed by moving authentication into genuine Socket.IO
middleware (`server.use()`), which — unlike the lifecycle hook it replaced
— must fully resolve, `await`s included, before a connection is considered
established at all. The regression test written for this specifically
emits its event in the same tick as `connect`, with zero artificial delay
— the one test shape that actually re-triggers the original bug, since any
natural pause between connecting and emitting would never have caught it.

A closely related bug was fixed in the same pass: WebSocket errors were
collapsing into a generic "Internal server error" regardless of what was
actually thrown, since Nest's default WS exception handling only
recognizes `WsException` specifically — not the ordinary `HttpException`
subclasses this app's services throw everywhere else, deliberately, to
keep authorization logic identical whether reached via REST or a gateway.
A custom filter now converts a caught `HttpException` into its WS
equivalent before it reaches the client.

## The deliberate hunt: a five-check methodology, not a general review

Given how effective checking *stated intent against enforced behavior* had
just proven to be, a second pass applied the same technique deliberately
and systematically, rather than waiting for it to happen by accident again:
cross-checking sibling routes for inconsistent authorization, cross-checking
security-claiming comments against what's actually enforced, verifying
every WebSocket handler has a real check rather than an assumed one,
tracing what a client actually receives on error (not just what server
logic does), and checking for lifecycle-ordering assumptions that aren't
actually guaranteed by the framework.

This found one further real bug: **`POST /users` verified a submitted
`clinicId` existed, but never that the *requesting* practitioner actually
belonged to it** — meaning a practitioner in one clinic could plant a
patient record directly into an entirely different clinic's roster purely
by knowing its id. Fixed by reusing the same clinic-membership check
already established elsewhere, extracted into a shared helper along the
way (it had already been independently duplicated in two other methods).

## A smaller, separate correctness bug, found later during test-suite review

While reviewing test coverage for staleness, a third distinct bug was
found in `reorderExercises`'s permutation check — and turned out to be
copy-pasted across three separate implementations (program templates,
assigned programs, and exercise image galleries). The check compared only
*deduplicated* Set sizes, never the raw submitted array's actual length or
internal duplicates — meaning a client could pad an array with a
duplicated id, satisfying the size check while silently omitting a real
entry, corrupting the resulting sort order (or, for image reordering,
silently dropping a real image from the gallery entirely). Fixed
identically in all three places once the shared root cause was recognized,
rather than treating the originally-flagged instance as the whole story.

## A pattern worth naming directly

Twice in this arc, a bug initially reported in one specific location
turned out to be broader on inspection — the `reorderExercises` flaw across
three files, and separately, a cosmetic `@ApiTags` copy-paste bug that
turned out to affect seven controllers, not the three first spotted. Both
times, doing a full sweep for the same pattern rather than fixing only
what was explicitly named caught real, additional instances that would
otherwise have been missed indefinitely.
