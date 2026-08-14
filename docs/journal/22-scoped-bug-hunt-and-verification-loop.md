# A scoped bug hunt, and the verification loop behind it

By the time both prior bug hunts and the four-pass type-safety hardening
were done, `tsc` and `eslint` had nothing further to say — every remaining
lint finding was a genuinely accepted limitation (Jest's own mock typing,
a couple of third-party libraries' loosely-typed public APIs), not an open
gap. But both earlier hunts had already demonstrated that lint-clean and
bug-free are different claims: the `GET /users/:id` scoping gap, the
archive/unarchive comment-vs-code mismatch, the missing `joinConversation`
check, and the `reorderExercises` permutation flaw were all things a type
checker was structurally incapable of ever flagging. The next pass had to
look for exactly that category on purpose, rather than wait for it to
surface by accident again.

## Five categories, chosen from what had already worked

Rather than a generic "find bugs" request, the categories investigated
were picked directly from what the two prior hunts had actually found,
treated as a track record rather than a hunch: cross-tenant/clinic
boundary leaks (the shape of the patient-planting bug), TOCTOU races (the
shape of the WebSocket auth race), array/object mutation validation before
an overwrite (the shape of the `reorderExercises` flaw), comments claiming
a restriction the code doesn't actually enforce (the exact technique that
caught the archive/unarchive gap, applied again deliberately this time),
and copy-paste propagation of a bug found in one place into siblings
(the pattern the closing note of the first bug-hunt writeup names directly).
Investigation was also kept explicitly separate from fixing — a full
read-through reported findings, with a concrete reproduction scenario and
a confidence rating per finding, before any fix was written.

## Two confirmed bugs

The first: `UsersService.toPublic()` — the one method every user-returning
endpoint in the API funnels through — stripped `passwordHash` before a
user object left the server, but never `mfaSecret`, `passwordResetTokenHash`,
or `passwordResetTokenExpiresAt`. Because session deserialization builds
`req.user` through exactly this method, `GET /auth/me`, `POST
/auth/mfa/verify`, and `POST /auth/switch-role` all echoed these fields
straight back — directly contradicting an explicit comment elsewhere in
the codebase asserting the opposite was already guaranteed. Fixed at the
single funnel point. Applying the same "search for the same shape
elsewhere" discipline the earlier hunts had already validated turned up
two further real instances of the identical mistake, in `AuthService`'s
`validateUser()` and `registerClinic()` — the latter harmless today only
because a brand-new account's fields happen to be null, not because
anything actually prevented the leak.

The second is a direct continuation of the comment-vs-code technique from
the first bug hunt. `archiveConversation`/`unarchiveConversation` had
already been fixed to genuinely enforce the "admin gets no archive action"
comment, rather than merely claiming it — but `sendMessage` and
`markAsRead`, which read from the exact same unconditional admin bypass in
`assertParticipant`, never received the equivalent explicit block. An
admin could still write a message into, and mark-as-read on, a
conversation between a patient and practitioner they had no clinical
relationship with — and marking as read had a real secondary effect,
closing the real participants' 15-minute message-delete window without
their involvement. The fix was mechanical once found: apply the identical
block already proven correct on archive/unarchive to the two remaining
write paths. `getMessages` was deliberately left alone, since full
oversight read access for admin is the actual intended design, not a gap.

## Three follow-ups, investigated rather than assumed

The same pass surfaced three more things that looked suspicious without a
constructible failure scenario at the time. Rather than either dismissing
or fixing them on the spot, each was logged and later given a dedicated
investigation before deciding what, if anything, to do:

A missing existence check in `ClinicsService.removeMember` — confirmed
genuinely cosmetic after checking whether anything downstream relied on
the response as confirmation of an actual deletion (nothing did) — fixed
for consistency with every sibling method regardless, since the fix
carried no real risk either way.

The absence of a per-route rate limit on MFA enable/disable, unlike MFA
verification itself. Investigating this meant checking the actual TOTP
library configuration rather than assuming a textbook tolerance window —
it turned out this app runs with zero tolerance beyond the single current
code, a narrower exposure than the original flag assumed. Fixed anyway,
for consistency with the app's own stated rationale for requiring a fresh
code on sensitive MFA actions — cheap to add, no real cost to legitimate
users.

A read-then-write race in the reorder endpoints: current state read,
validated, and only then written inside a separate transaction, leaving a
window where a concurrent change could make the write silently no-op or
skip a row. Tracing the actual failure mode precisely — rather than
assuming the worst from the shape of the bug alone — resolved it to a
harmless sort-order inconsistency, never a boundary violation. The
specific gap (the read happening outside the transaction that later
writes) was closed by folding both into one transaction; a narrower
theoretical race remains under Postgres's default isolation level,
documented in code rather than chased further, since fully closing it
would be disproportionate effort against a risk with no privilege
implications.

## The verification loop

Worth naming explicitly, since by this point it had become the actual
process, not an afterthought: every finding above was investigated and
reported with no fixes attached, each with an explicit confidence rating
(confirmed / likely / worth a second look) rather than a flat list. Every
"confirmed" finding was then independently re-traced against the real
source before a fix was even planned — reading the actual file and line
directly, not trusting a summary of what it does. Fixes were requested
with the specific pattern to reuse already identified (reuse
archive/unarchive's block, don't invent a new mechanism), one fix per
commit, with instructions to flag rather than silently paper over anything
that touched an existing test's assumptions. And every fix's actual diff
was checked against real source again before being accepted as closed —
including, for the reorder regression test specifically, tracing the
duplicate-padded-array example by hand against both the old and the fixed
permutation logic to confirm the test would actually have caught the
original bug, not merely that it passed.

One correction from that same discipline, applied to this document itself
rather than the code: an earlier draft of this writeup flagged what looked
like a contradiction — a historical commit message claiming a
`WsHttpExceptionFilter` was added to convert generic WebSocket errors into
real ones, against an API reference document claiming no such filter
exists. Re-checking the actual gateway source directly resolved it: the
filter is real, applied via `@UseFilters(new WsHttpExceptionFilter())` on
`MessagingGateway`, and covered by its own test. The API reference
document's claim was simply stale and has been corrected — the earlier
"discrepancy" was a documentation gap, not an unresolved question about
the code.

## Current status

Every item described across all three parts of this document is resolved
and covered by a regression test. [`deferred-improvements.md`](../deferred-improvements.md)
tracks this and other work as a running, terse ledger for anyone who wants
the changelog version instead of the narrative one.
