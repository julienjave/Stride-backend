# A systematic codebase review: nine improvements, three priority tiers

With every module from the original spec built, tested, and audited, this
phase stepped back from feature work to review the codebase as a whole —
producing a prioritized list of nine improvements, each with a stated reason
and expected benefit, rather than a generic best-practices checklist applied
without justification.

## Critical tier — fixed before anything else

**`SESSION_SECRET` silently fell back to a hardcoded value.**
`process.env.SESSION_SECRET ?? 'dev-secret-change-me'` meant a real
deployment missing this variable would run — insecurely, signing every
session cookie with a string sitting in the repo's own history — with zero
indication anything was wrong. The fix extends an already-established
pattern (`getDatabaseUrl()`'s own fail-loudly validation) rather than
introducing a new dependency: `validateEnv()` runs as the literal first line
of `bootstrap()`, before `NestFactory.create()` even executes, and refuses
to start at all if the secret is missing *or* still set to the
`.env.example` placeholder value — closing the case where someone copied the
example file but forgot to actually change it.

**No indexes existed on foreign key columns.** Worth the precise mechanism:
Postgres automatically indexes the *referenced* side of a foreign key (the
primary key) but never the referencing column itself. Every frequent query
in this app — `eq(assignedPrograms.patientId, ...)`,
`eq(sessionExercises.sessionId, ...)`, `eq(userClinics.userId, ...)` — filters
on exactly these un-indexed columns, invisible at the current tiny dataset
size but a real, predictable degradation into sequential table scans as the
data actually grows. Fourteen targeted indexes were added across six schema
files, matched specifically to columns genuinely filtered on in the services
already built (not a blanket "index everything"); the three profile tables
needed nothing added, since their `userId` column is already the primary
key and therefore already indexed automatically.

## High-value tier

**API documentation via `@nestjs/swagger`.** Rather than manually annotating
roughly 30 DTOs with `@ApiProperty()`, the CLI plugin
(`nest-cli.json`'s `compilerOptions.plugins`) infers Swagger metadata
directly from the `class-validator` decorators and TypeScript types already
present — a build-time static analysis step, not a runtime one, so it only
takes effect through `nest start`/`nest build`, never plain `ts-node`.
`@ApiTags()` was added to all 11 controllers via a small script; the first
version of that script had a real bug worth recording — it inserted the new
import line using naive "first newline after `import`" logic, which landed
*inside* multi-line `import { ... } from '@nestjs/common'` blocks rather
than after them, silently breaking six of the eleven files. This was caught
by explicitly checking every file's actual output before presenting any of
them, rather than trusting the script had worked uniformly — the same
"verify, don't assume" discipline applied throughout this project whenever
an automated or bulk edit touches multiple files at once.

**A health check endpoint**, via `@nestjs/terminus`. Terminus ships
indicators for TypeORM/Mongoose but nothing for Drizzle, so a small custom
`DrizzleHealthIndicator` (a `SELECT 1` query) was written — the same
"no official client, write a small correct one" situation already
encountered with RustFS. While implementing it, Terminus's `HealthCheckError`
turned out to be deprecated in favor of an injected `HealthIndicatorService`
with a fluent `.up()`/`.down()` builder — verified against a current source
rather than assumed, the same instinct applied to `otplib`'s earlier
rewrite. Functionally identical either way (a "down" result still produces
an overall `503`); only the mechanism for signaling it changed. The endpoint
itself is deliberately public (no `SessionAuthGuard`) and exempted from
global rate limiting (`@SkipThrottle()`), since monitoring systems need to
poll it without credentials or restriction.

**Pagination on list endpoints.** A real gotcha was identified *before*
writing any broken code: `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted`
options validate the entire object handed to a single `@Query()` binding —
splitting pagination (`page`/`limit`) into one DTO while a route's existing
filters (`search`, or `AuditController`'s three separate filter params)
stayed as individual `@Query('x')` extractions would cause the DTO validator
to reject the whole request the moment any of those undeclared fields
appeared in the query string. The fix: one combined DTO per route, always
extending a shared `PaginationQueryDto` base, never splitting query params
across multiple `@Query()` decorators. Applied fully (with a real `COUNT`
query run in parallel via `Promise.all` alongside the page of rows, not
sequentially) to `exercises` (873 rows, previously unbounded) and
`audit-logs` (previously a silent, un-navigable hard cap of 200 rows — a
real bug in disguise, now real pagination instead) — establishing the exact
reusable pattern for extending to the remaining list endpoints later.

## Lower-urgency tier

**The exception filter**, built out from a placeholder that had sat unused
since the very first folder scaffold. Its real value is narrower than
"consistent error formatting" — it's the one place guaranteeing an
unexpected error (a dropped DB connection, a genuine bug) never leaks
internal detail (a stack trace, a raw Postgres error naming real
table/column names) to a client, while still logging the full detail
server-side. Deliberately registered via the same `APP_FILTER` global
pattern already used for `ThrottlerGuard` and `AuditLogInterceptor`.

**Structured logging** via `nestjs-pino`, replacing Nest's default console
logger globally — every `new Logger(X.name)` already scattered through the
app (`AuditLogInterceptor`, `MessagingGateway`, `StorageService`, the new
exception filter) automatically gained structured JSON output with no
changes to any of those files, since `nestjs-pino` swaps the underlying
implementation Nest's own `Logger` class delegates to. Redaction was
configured explicitly, not left to defaults — session cookies,
`Authorization` headers, and plaintext passwords in request bodies are all
stripped from every logged line, the same "never let a sensitive field
leak" discipline already applied to API responses (`passwordHash`/`mfaSecret`
stripping) extended to logs. Confirmed working directly in a real e2e run's
output (`"cookie": "[REDACTED]"`), not just assumed from configuration.

**WebSocket test coverage** — a real, named gap: the 198 tests generated
earlier cover every REST route thoroughly, but `supertest` has no concept of
a WebSocket upgrade at all, leaving `MessagingGateway`'s actual live
behavior (session-authenticated handshake, room joins, real-time broadcast)
entirely untested. A new file uses a genuine `socket.io-client` against a
truly listening server (`app.listen(0)`, letting the OS assign a free port —
unlike REST e2e tests, which can drive supertest against the app instance
without necessarily binding one). A deliberate implementation choice: HTTP
setup calls in this file use plain `fetch()` rather than `supertest`,
specifically to get direct, unambiguous access to the raw `Set-Cookie`
response header — the exact thing that has to be handed to
`socket.io-client` explicitly via `extraHeaders`, since it has no automatic
cookie-jar behavior linking it to a prior login call.

This file's first run failed with the same `db.execute()` row-shape issue
Claude Code had already found and fixed across the other ten e2e files —
because the safety-check pattern had been copied from an older, pre-fix
reference copy rather than the corrected version actually sitting in the
project. The fix was made twice: once functionally (using `.rows`), and
once again for styling, after the actual current file was shared directly
for comparison — matching Claude Code's cleaner convention (a generic type
argument on `db.execute<T>()`) rather than leaving a subtly different,
inconsistent style sitting in a sibling test file. Both corrections were
verified by comparing directly against the real, current file rather than
assumed, one more instance of the same discipline this project has returned
to repeatedly whenever a reference copy and the real project risked
diverging.
