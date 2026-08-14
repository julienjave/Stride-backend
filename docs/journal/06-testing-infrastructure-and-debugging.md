# Testing infrastructure & a real debugging investigation

This document covers the testing setup built during this phase, and — worth
recording in detail, since it's a genuine demonstration of systematic
debugging rather than guesswork — the investigation that traced a subtle
session-persistence bug back to a well-known but undocumented gap in
`@nestjs/passport` itself.

## Unit testing: isolating logic via dependency injection

`AuthService.validateUser()` (the role-selection logic: auto-select for a
single-role account, require an explicit choice for several, reject an
unheld requested role) was chosen as the first unit test specifically because
it has real branching logic worth verifying, and depends only on
`UsersService`, not the database directly.

The mechanism is the same dependency-injection pattern used throughout this
project, applied to testing: `Test.createTestingModule({ providers: [...] })`
lets a fake `UsersService` (a plain object of `jest.fn()` stand-ins) be
substituted for the real one — `AuthService` itself never changes, since it
only ever declared "inject me a `UsersService`," never `new UsersService()`
directly. This is the concrete payoff of having built the whole application
around DI from the start.

## End-to-end testing: a real, running stack, and the friction that surfaced

`test/exercises.e2e-spec.ts` boots the entire app (`AppModule`, real guards,
real session middleware, a real Postgres connection) and exercises the actual
multi-role, ownership-based scenario debugged this phase: a practitioner can
create a custom exercise; a patient cannot; an admin can correct any exercise,
including one they didn't create; a *different* practitioner cannot edit
another's custom exercise. Getting this test running surfaced several real,
worth-recording lessons:

- **Every standalone entry point needs its own `dotenv` loading.** `main.ts`,
  `scripts/seed-exercises.ts`, and this test file each run outside of any
  single shared bootstrap — NestJS itself never auto-loads `.env`, so each
  independent process needs `import 'dotenv/config'` as its own first line.
  This was missing from `main.ts` for an unknown period (it likely worked by
  accident, from state inherited across terminal sessions) and was
  independently missing from this test file too — the same root cause,
  recurring because there is no single place that "always" handles it.
- **A dedicated test database, not the shared dev database.**
  `POST /auth/register-clinic`'s deliberate one-time bootstrap gate — correct
  behavior, confirmed working exactly as designed — meant the test could
  never pass against the real `stride` database once real admin accounts
  existed there. A second database (`stride_test`) inside the same Postgres
  container resolves this with no new infrastructure, using a property of
  `dotenv` (it never overrides an already-set environment variable) to target
  it via a `POSTGRES_DB=stride_test` prefix, requiring zero code changes.
- **A repeatable test cleans up its own starting state.** The first
  successful run left real data behind, which then broke the *second* run
  the same way real dev data had blocked the first. The test now truncates
  its own tables at the start of every run (`TRUNCATE ... RESTART IDENTITY
  CASCADE`) — safe specifically because `stride_test` is dedicated and
  disposable, never real data.
- **Hardcoded IDs are fragile even with a reset database.** The test
  initially assumed a freshly created clinic would have `id = 1`; this broke
  again the moment `TRUNCATE` ran a second time without `RESTART IDENTITY`
  resetting the sequence. The durable fix was to stop assuming an ID at all —
  `AuthService.registerClinic()` now returns the real `clinicId` in its
  response, and the test reads it back rather than guessing.
- **Manually created resources need explicit cleanup.** `Jest did not exit`
  warnings traced to two separate un-closed connections: a `pg.Pool` created
  directly in the test's `beforeAll` for session storage (fixed by closing it
  in `afterAll`), and — a deeper, genuinely valuable fix — Drizzle's own
  connection pool, which had no closable reference anywhere in the
  application at all. `drizzle.provider.ts` was restructured to expose the
  raw pool as its own provider, with a small `DrizzlePoolCloser` class
  implementing `OnModuleDestroy` to close it when Nest tears the module down.
  `main.ts` also gained `app.enableShutdownHooks()`, so this same cleanup now
  correctly runs on a real `SIGTERM` (what `docker stop` sends), not only in
  tests — a genuine production-correctness fix, not just a test-hygiene one.

## The investigation: why a session never persisted

A login request returned a fully correct user object, yet the session table
remained empty and no cookie was issued. Ruling this out took several
independently-verified steps, each confirmed with direct evidence rather than
assumption, in order: session-store table existence (present), raw response
headers (`Set-Cookie` genuinely absent), `AuthModule`'s configuration
(`PassportModule.register({ session: true })` correctly present). None of
these explained it.

The actual cause, confirmed against `@nestjs/passport`'s own issue tracker
(open since 2018) and current independent guidance: **`AuthGuard`'s default
`canActivate()` runs the strategy and attaches the user to the request, but
never calls Passport's own `logIn()`**, the step that actually establishes and
persists a session. This is a well-known but non-obvious gap in the library —
`PassportModule.register({ session: true })` and `app.use(passport.session())`
are both necessary but not sufficient. The fix, matching the pattern shown
across multiple independent sources: override `canActivate()` in
`LocalAuthGuard` to explicitly call `super.logIn(request)` after the inherited
guard succeeds.

## A second, unrelated bug found via the same rigor

Once the guard fix resolved login, a second issue surfaced: an admin could not
edit an exercise they hadn't created, despite `assertCanModify`'s logic being
verified correct. Systematic elimination (session store contents, cookie/session
ID cross-reference, a direct diagnostic log statement inside the failing
method) traced this to `exercises.controller.ts` passing `user.id` (a bare
number) into a service method that had been updated, in an earlier change, to
expect the full `{ id, activeRole }` object — a call site that was never
updated when the method's signature changed. TypeScript's structural typing
did not catch this at compile time, since a number was still a valid argument
positionally; the bug only manifested at runtime, when `.activeRole` was read
off a plain number and evaluated as `undefined`.

## The recurring lesson: a shared codebase-snapshot sync-check

Several of the issues above stemmed from local project files having quietly
drifted from what had been discussed and shared — not unique to any one
mistake, but a repeating pattern worth solving structurally. A workflow was
established using an external coding tool (configured to only export, never
modify, the codebase) to produce a single combined markdown file of the real
project source, which could then be diffed programmatically against the
tracked reference copy. This caught, in one pass: a stale schema field that
had only ever been wrong in the tracked reference (not the real project), and
a genuinely broken import (`import { table } from 'console'`) accidentally
introduced by editor auto-import — both far faster than manual file-by-file
comparison would have found them.
