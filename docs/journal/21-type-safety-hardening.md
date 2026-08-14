# Systematic type-safety hardening: four passes, one recurring root cause

Following the bug hunts, a `tsc`/`eslint` pass surfaced roughly 200 lint
findings — the overwhelming majority tracing back to a single, recurring
root cause repeated across the codebase: `any`-typed values standing in
for data that genuinely had a real, well-defined shape. Rather than patch
individual call sites, each instance of this pattern was fixed at its
actual source, systematically, one root cause at a time.

## The foundational realization

`@CurrentUser()` — used in nearly every protected controller and the
WebSocket gateway — returned `any`. Every subsequent property access or
function argument built from that value was therefore correctly flagged
as unsafe by TypeScript's own tooling: not 150 separate problems, but one
missing type definition, echoing through every file that used it. Tracing
the real runtime shape (from session deserialization through to what the
decorator actually extracts) and defining a proper `CurrentUser` interface
once eliminated the vast majority of findings in a single pass — existing,
narrower local `CurrentUser`-shaped types already in a few services were
deliberately left untouched, since TypeScript's structural typing means a
fuller type automatically satisfies a narrower one with zero risk.

## The same pattern, twice more, at different boundaries

A second pass closed an identical gap for `express-session`'s own
`SessionData` interface, which had no knowledge of `mfaPending` — a real,
custom property this app adds during the two-step MFA flow — forcing
`as any` casts everywhere it was read. Fixed via TypeScript's declaration
merging, extending the library's own interface in a dedicated `.d.ts` file
rather than casting at each read site. A related but genuinely distinct
gap was found alongside it: Socket.IO's `socket.request` isn't typed as an
Express `Request` at all, even though `SessionIoAdapter` genuinely attaches
Express's session middleware to it at runtime — closed with a local type
rather than forcing the same fix to cover two different underlying
problems.

A third pass found the same shape of gap one boundary further out: several
`context.switchToHttp().getRequest()` calls (an audit interceptor, two
guards) were untyped for the same underlying reason `@CurrentUser()` once
was. Rather than type each locally, a shared `AuthenticatedRequest` type
was added once, colocated with `CurrentUser`, and reused everywhere.

One deliberate *non*-fix is worth recording precisely: applying a global
`Express.User` augmentation (matching how `@types/passport` itself expects
consuming apps to describe their user shape) was investigated and
explicitly rejected, because it would have been *wrong*, not just risky.
Tracing every `req.login()` call site found a genuine divergence — the
plain-password login path deliberately strips `mfaSecret` before it's ever
assigned to `req.user`, while every other path (registration, MFA
verification, subsequent-request deserialization) carries it. A blanket
global type would have silently asserted these two shapes were always the
same, which they provably aren't for a real security reason. Scoping the
new type narrowly avoided baking in a false guarantee to save a global
augmentation from being noted as merely "unapplied."

## The fourth pass: real type safety, not just cosmetic consistency

A separate but related preference — enum-typed fields being compared
against plain string literals in some places and actual enum members in
others — was deliberately not treated as pure style. `activeRole`
specifically had never actually been typed as the real `UserRole` enum
anywhere in the codebase (the session augmentation, `CurrentUser`, and
several service-local types all declared it as plain `string`) — meaning
comparing it against an enum member gained nothing at compile time; it
was cosmetically longer, not actually safer. The real fix widened
`activeRole`'s type everywhere first, *then* swept every comparison
against every enum in the project (not just `UserRole`) to use the actual
member — including `RolesGuard`'s `@Roles()` membership check, correctly
recognized as sharing the identical underlying gap despite being a
different kind of check than a direct equality comparison.

This pass also required exactly one deliberate, documented boundary cast:
Drizzle infers a `pgEnum` database column's type as a string-literal
union, a fundamentally different TypeScript construct from a nominal enum
— even though their runtime values agree exactly, the two type systems
were never actually unified. A single cast at the one point role data
crosses from the database into enum-typed application code, with a comment
explaining why, was the correct and complete fix — not a workaround, the
standard pattern for exactly this situation.

## What was deliberately left as noise, not silently ignored

After all four passes, roughly 55 lint findings remain, explicitly
recorded as accepted rather than treated as an open TODO — the
qualitative difference from everything fixed above is real: these are
overwhelmingly Jest's own mock-typing limitations (`jest.fn()` is
inherently loosely typed without significant additional effort, a known
situation in any TypeScript/Jest project) and a few third-party libraries'
own loosely-typed public APIs (`class-validator`'s `ValidationArguments
.constraints`, Express/Socket.IO's integration boundaries). Continuing to
chase these to zero would be real, ongoing effort against very little
actual correctness value — a deliberate stopping point, not an oversight.
