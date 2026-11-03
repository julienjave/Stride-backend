# Phase 7: observability that names no patient, a crash only an outage could show, and rules across two tables

This entry covers the backend side of the frontend's Phase 7, the
nice-to-have backlog (2026-10-30 → 2026-11-03). Most of its items were
screens: snackbars, the session timer, the browser test suite, the brand,
code splitting. The backend's share was error tracking, practitioner-
measured range of motion, branded emails and records, demo mode for
reviewers, and CI, built and then parked. Two bugs from this phase only
showed because someone looked at the running system rather than at the
tests.

Condensed to four stories; [`PROJECT.md`](../PROJECT.md) has the rest. The
frontend journal's Phase 7 entry (TODO-LINK) covers the screens, among them
the Playwright suite's first run, which found a frozen role switch no unit
test could see.

## The rule: nothing that leaves the server names a patient

Error tracking was designed around one rule: a log line or an error report
that leaves the server must not name or locate a patient. The logs were
going to be shipped to Better Stack, whose own security page says it is not
HIPAA compliant (no BAA), so a shipped log line is a third-party copy, just
like an error report. Entry 19 had chosen the log pipeline; this phase
decided what may travel through it.

- **A request id, made by the server.** Every request gets a random UUID
  (pino-http's default was a counter, so "request 42" existed once per boot
  and per instance). It goes in the `X-Request-Id` header, in every error
  body, on every log line and on every error report. That makes it the one
  key for finding a request in all four places. A client-sent id is ignored:
  it would let anyone write text into the logs. The exception filter assigns
  one too, because Express's body parser runs before Nest's middleware, and
  a malformed body is refused before pino-http has seen it.
- **Allow-lists, not deny-lists.** A log line keeps the method, the *path*
  (no query string — search terms are names), the status and the user id;
  no headers (the cookie is a credential), no IP address (one of HIPAA's 18
  identifiers). An error keeps its type, message, stack and Postgres's
  `code` / `constraint` / `table`, and never Drizzle's `params` or
  Postgres's `detail`, because those hold the *values*. A library that adds
  a property later can't widen an allow-list. Building it found one trap.
  pino-http hands a custom error serializer pino's *already serialized*
  copy, params included, and the original only on a `raw` getter; reading
  the copy would have shipped the values. A test that runs a real logger
  caught it. Messages are scrubbed too (`scrubText`, run on every log line
  through pino's `logMethod` hook: anything shaped like an email becomes
  `[email]`). `logging-convention.spec.ts` fails on a log call that
  interpolates an address, and on its first run it found two lines that had
  been missed.
- **Error reports, with two locks.** GlitchTip, self-hosted beside the app,
  with the official Sentry SDKs (`@sentry/nestjs` 11.7.0). The first lock is
  what the SDK *collects*: every `dataCollection` key off, eight chosen
  integrations, no breadcrumbs, no tracing. The second is what it *sends*:
  `beforeSend` rebuilds each report from named fields. A future SDK version
  that gathers something new still can't send it. Only real bugs report — the
  filters' `500` branch, the message sweep, the process handlers — never a
  `404` or a refusal the app chose to give.
- **The browser's reports go through the API** (`POST /monitoring`). The
  tunnel forwards only error events, only for *our* project's DSN (it isn't
  an open relay), and replaces whatever user id the page claimed with the
  signed-in session's own.

The live check found the last bug in it. The frontend retries a `5xx` twice,
so three identical failures produced three reports; the SDK's **Dedupe**
integration dropped the second and third as repeats of the first. The
reference shown on screen is the *last* attempt's, so it found nothing in
GlitchTip. Dedupe was removed on both sides (GlitchTip groups repeats into
one issue anyway). The unit tests had reported one failure each and could
never have seen it.

## The crash only an outage could show

To check that a database outage produced `500`s with their references, the
live test stopped Postgres. The whole API exited instead. node-postgres's
`Pool` emits an `'error'` event when an *idle* pooled client's connection
dies, and an `EventEmitter` with no `'error'` listener **throws** that event.
A query in progress gets its error through its own promise; an idle client
has no caller to tell, only the pool's event, and nothing was listening, on
the app's pool or on the session store's. `survivePoolErrors()`
(`src/database/pool-errors.ts`) now logs a warning on both. The pool has
already dropped the dead client, and the next query opens a new connection.
Live, requests during the outage answered `500` with their reference, and the
first one after Postgres came back answered `200`, with no restart. Before
this fix, the first database restart in production would have taken the API
down until Docker restarted the container.

A second bug found by looking: on the library's thumbnails' live check,
"Frog Hops" appeared among the A's. `findAll` had no `ORDER BY` at all, and
SQL promises no order without one. An `UPDATE` writes a new row version
elsewhere on disk, so the physical order moves, and two `LIMIT`/`OFFSET`
pages could show one exercise twice and another never. The order is now
`lower(name), id`: `lower()` so the order holds under both the sandbox's `C`
collation and the person's en-US one, and the id so no two rows ever tie.
The tests are built to fail on *either* collation without the fix. The
thumbnails themselves needed signed URLs a browser can cache. A presigned
URL contains its signing time to the second, so every refetch handed out new
addresses for the same photos. The library now signs with the time rounded
down to the hour, for two hours of life, and asks storage for
`Cache-Control: private, max-age=3600` through the signed
`response-cache-control` parameter.

## Range of motion: rules across two tables

Practitioner-measured range of motion was the phase's one large backend
feature: an assessment (a visit) holds measurements (joint, side, mode,
degrees), checked against a fixed catalogue of 33 movements, correctable
only by an amendment (migrations 0076–0077). Two rules spanned two tables,
and each needed a Postgres feature the project hadn't used before.

- **"An assessment has at least one measurement"** can't be a CHECK, since
  that would mean reading another table. It can't be checked when the
  assessment is inserted either: the measurements point *at* it, so they
  come after. A **deferred constraint trigger**
  (`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`) runs at
  `COMMIT`, once the transaction has inserted everything. It applies to the
  owner too, so the seed now writes each assessment in a transaction of its
  own.
- **Measurements only in their assessment's transaction.** The trigger
  stamps the assessment's `created_at` with `now()`, and the measurements'
  `INSERT` policy requires `created_at = now()`. `now()` is the
  transaction's start, the same in every statement of it, so the condition
  is true only in the transaction that recorded the assessment. Once
  committed, it is closed for good, with no extra trigger.
- **Moving two tables in one statement.** A merge (entry 40) must move a
  patient's medical-file notes *and* the assessments that link to them,
  through a composite key `(note, patient)`. Two `UPDATE`s fail: after the
  first, an assessment still points at `(note, old patient)`. A `WITH`
  holding two data-modifying queries is **one statement**, and a `NO ACTION`
  foreign key is checked at the end of the statement, by which time both
  have moved. This was checked in Postgres before relying on it.

## And the rest, in brief

- **Branded emails** are one layout (`renderEmail()`) for all fifteen,
  written as tables with inline styles (desktop Outlook renders with Word's
  engine) and the logo attached inline (`cid:`) — nothing fetched, so no
  tracking pixel. Every interpolated value is escaped by default through a
  tagged template, ``markup`…` ``. Only the tag can make a `SafeHtml` value,
  because its constructor needs a `Symbol` key no other module holds. It is
  called `markup`, not `html`, because Prettier reformats templates tagged
  `html`. The records PDF got the same brand, positioned so no page count
  moved.
- **A setting only its owner reads.** The "easier-to-read font" setting
  (migration 0079) left every answer about *other* people (`toPublic()`
  strips it; `toSelf()` puts it back for the person's own answers), and it
  is written without an audit entry, because an audit trail is for changes
  that matter to others. Two conditions keep that honest: the full diff
  decides the `UPDATE`, the diff minus `UNAUDITED_ACCOUNT_FIELDS` decides
  the entry.
- **Demo mode for reviewers** (`DEMO_MODE`, off by default — the safe value
  is "nothing published") answers the sign-in page's "For reviewers" card,
  locks the four published accounts with a guard that runs *before* any
  step-up (so a refused request spends no code), and resets every night at
  04:00 Toronto time. A systemd timer stops the app, reseeds, sweeps, and
  restarts it with `trap … EXIT`, so a failed reset still restarts. Addresses
  on reserved domains (`.test`, `example.com`…) are never handed to Resend:
  sent there, they would bounce and damage the sending domain's reputation.
- **CI** (GitHub Actions: checks, API e2e and the browser suite, one job
  each) was built and rehearsed from fresh clones, then **parked**: the
  workflows live outside the repos until they are public, to spend no
  Actions minutes and hold no token while private. The pre-CI tidy-up took
  backend lint to **0 problems** for the first time, and found an alerts
  test fixture that failed within 14 days of a clock change (`'13 days 23
  hours'` is calendar arithmetic, as in entry 37; now written in hours).

## Current status

Phase 7's chosen items were all built by 2026-11-03. None of the work since
entry 35 has been deployed yet (the last full run of the pipeline written
up here is entry 26's), and the next deployment is the one the
documentation's deployment stage will describe. That, the unpinned images and the cookie change are
the README's open items. Logging and error reports as they stand
are ARCHITECTURE's
[§10](../ARCHITECTURE.md#logs-request-ids-and-error-reports), and demo mode
is its [§10 "Demo mode"](../ARCHITECTURE.md#demo-mode).
