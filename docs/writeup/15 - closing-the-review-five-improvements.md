# Closing out the review: five follow-up improvements

This document continues directly from `codebase-review-nine-improvements.md`
— a second sync-check against an updated codebase snapshot, followed by five
further improvements it and a fresh look surfaced.

## The second sync-check: one real finding

Comparing the updated snapshot against the tracked reference copy found one
genuine, if non-critical, gap: `validateEnv()` was correctly wired into
`bootstrap()` and functioning — a missing or placeholder `SESSION_SECRET`
would already crash the app before boot completed — but `main.ts` line 99
still read the *old* fallback (`?? 'dev-secret-change-me'`) instead of the
non-null assertion the fix was supposed to leave behind. Not a live security
hole (by the time that line executes, `validateEnv()` has already
guaranteed the value is set), but confusing, contradictory-looking dead
code misrepresenting what was actually guaranteed at that point — corrected
to `process.env.SESSION_SECRET!`. Every other targeted check (FK indexes,
pagination shape, the whitelist-safe combined query DTOs, the current
Terminus API, global filter/logger registration, and every previously-found
bug pattern) came back clean.

## CORS: supporting more than one origin

The original CORS config hardcoded exactly one `FRONTEND_URL` string. This
wasn't just inflexible — a CORS spec rule made it a structural limitation,
not a preference: **the moment `credentials: true` is set, a server is no
longer permitted to respond with a wildcard origin; it must echo back one
exact match.** A hardcoded single string meant there was no way to support
even the ordinary case of a staging deployment alongside production. The
fix — `getAllowedOrigins()`, parsing a new comma-separated `FRONTEND_URLS`
— had to be applied to *two* independent places, not one: Socket.IO's CORS
handling is entirely separate from Express/Nest's HTTP-level CORS, and
`MessagingGateway`'s own `@WebSocketGateway({ cors: ... })` config would
otherwise have silently continued rejecting a second origin's WebSocket
connections even after the HTTP side was fixed — a genuinely confusing
partial-failure bug to trace, since ordinary requests would have worked
fine. One shared helper, not two independent copies of the parsing logic,
closes off the two configs quietly drifting apart from each other later.

`FRONTEND_URL` (singular) was deliberately kept as its own, separate
variable — it serves a different purpose entirely (building the canonical
link inside password-reset emails), not origin matching, so collapsing it
into the new plural variable would have conflated two unrelated concerns.

## DTO length caps: a full sweep, not just the two original examples

Extended from the two representative DTOs built earlier to every DTO in the
app with an unbounded string or array — 24 files in total. Caps were
assigned by *category* (name/title, email, password, free-text
notes/feedback, phone, storage object keys, id-arrays) rather than picked
ad hoc per field, most matched directly to the corresponding schema
column's own `varchar` length where one existed. `CreateMedicalFileDto`'s
`clinicalData` needed a genuinely different technique — no single string to
measure on an intentionally unstructured JSON object — resolved with a
custom `class-validator` decorator (`MaxJsonSize`, via `registerDecorator`)
checking the value's *serialized byte size* rather than any string length,
the same underlying mechanism every built-in decorator is itself built
from. A final automated sweep (grep for `@IsString()`/`@IsEmail()` without
an accompanying `@MaxLength`) confirmed completeness, with one deliberate
false positive: `MfaCodeDto`'s `@Length(6, 6)` is stricter than a max-length
check would be, just expressed through a different decorator entirely.

## `avatarPath`: closing a real inconsistency the DTO sweep surfaced

While auditing `UpdateUserDto`, `avatarPath` turned out to still be a
plain, client-settable string — despite the dedicated, Multer-backed
`POST /users/:id/avatar` upload flow existing specifically to guarantee
that field only ever points at something genuinely uploaded.
`CreateClinicDto` had already correctly excluded the equivalent `logoPath`
field from the start; `UpdateUserDto` had simply been missed applying the
same principle. The fix removed the field entirely rather than merely
capping its length — a length cap doesn't address the real problem, which
is a client being able to set it to *any* string at all, including one
pointing at nothing ever actually uploaded, or used to probe for real
object keys in storage.

## `StorageService`: an independent size guard, not solely Multer's

The existing 5MB limit lived entirely in `image-upload.config.ts`'s Multer
options — meaning it only ever applied to callers routed through that
specific interceptor. `StorageService.upload()` itself had no size
enforcement of its own; a future caller bypassing that Multer config
(a new feature, a script) would have had zero protection. The fix adds a
generic ceiling directly inside the service, deliberately using a
*different* number (10MB) than the route-level 5MB limit — not a duplicate
of that specific business rule, but a different kind of check: not "is
this appropriate for a profile photo," but "is this an absurd upload no
matter what it's for." Verified with a standalone script calling
`StorageService.upload()` directly, bypassing HTTP and Multer entirely, to
confirm the guard genuinely travels with the service rather than depending
on which route happened to call it.

## Explicit, tunable Postgres connection pool configuration

Both `Pool` instances in the real app (Drizzle's main pool, and the
separate session-store pool `connect-pg-simple` uses) had been relying on
`pg`'s own implicit defaults. Two real issues, not one: `max` defaulting to
10 with no visibility into that number at all, and — more significant —
`connectionTimeoutMillis` defaulting to `0`, meaning a fully exhausted pool
would leave a request hanging indefinitely rather than failing fast with a
clear error. A shared `getPoolConfig()` helper makes both pools'
sizing independently tunable via environment variables, with defaults
chosen to match prior behavior exactly (no functional change today) while
adding an explicit 5-second connection timeout as a deliberate,
fail-fast replacement for the dangerous "wait forever" default. Test files'
own manually-created pools were deliberately left unconfigured — pool
*sizing* tunes for sustained concurrent load, which a single short-lived
test run never produces, so applying it there would be noise without
benefit.
