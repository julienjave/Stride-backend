# Stride — Project Decisions & Rationale

What was decided across this project's design, build and deployment, and
why: the alternatives weighed, and what each choice costs. Written to stand
alone, for someone picking the project up or reviewing it without having
been there.

Three neighbours divide the rest of the work:
[`ARCHITECTURE.md`](ARCHITECTURE.md) explains *how* the system works as it
stands; the [API reference](api/README.md) is the contract a client relies
on; the [journal](journal/README.md) tells the story, mistakes included.
This document is the summary of decisions between them.

**"decisions §N" in the code.** About 450 comments in this repository cite
"decisions §N". They refer to the project's design-decisions log,
[`docs/stride-design-decisions.md`](https://github.com/julienjave/Stride-frontend/blob/main/docs/stride-design-decisions.md)
in the **frontend** repository, where each feature was designed with the
person, one section per item (§1–§47). That log is the long form, with
every option weighed; this document keeps the choices that shaped the
backend. A few comments also cite `deferred-improvements.md`, a working
ledger of postponed improvements kept outside the repositories; what is
still open in it is summarised under "Known limits and what's deferred"
below.

---

## Table of Content

- [Project shape](#project-shape)
- [Technology stack](#technology-stack)
- [Who may see a patient's data](#who-may-see-a-patients-data)
- [The clinical domain](#the-clinical-domain)
- [Accounts and sign-in](#accounts-and-sign-in)
- [The audit trail](#the-audit-trail)
- [Records leaving Stride, and accounts merged](#records-leaving-stride-and-accounts-merged)
- [The database's half of the rules](#the-databases-half-of-the-rules)
- [Security-specific decisions](#security-specific-decisions)
- [Type safety](#type-safety)
- [Development practices](#development-practices)
- [Deployment infrastructure](#deployment-infrastructure)
- [Observability & operations](#observability--operations)
- [Known limits and what's deferred](#known-limits-and-whats-deferred)

---

## Project shape

Stride is a multi-role physiotherapy practice management application:
admins run clinics, practitioners build exercise programs and assign them
to patients, patients complete sessions and message their practitioner. It
is two repositories. This one is the backend (a NestJS API over PostgreSQL,
with object storage, email and a WebSocket gateway); the frontend is a
React single-page app, [`Stride-frontend`](https://github.com/julienjave/Stride-frontend).

It was built as a bootcamp capstone, specifically to show real backend,
frontend and infrastructure understanding rather than CRUD. That goal
shaped many choices below toward the option that is more instructive and
better understood, over the fastest path to a working demo — a
self-managed server rather than a platform, rules enforced by the database
as well as the code, and tests that prove a race is closed rather than
hoping it is.

The backend was built in two eras. Until journal entry 35 it was built on
its own and deployed. From entry 36 on it grew phase by phase with the
frontend (the frontend's Phases 1–7), and that work was deployed with it
on 2026-11-03 (see "Deployment infrastructure").

---

## Technology stack

**NestJS (TypeScript).** Chosen over Express alone or Fastify for its
structure: dependency injection, guards, interceptors and decorators give
real module boundaries and services that can be tested in isolation. The
decorators carry more than routing here. The same metadata Nest reads to
build the router is read by tests (every write route must declare its audit
behaviour) and by the generator of the endpoint table in the API reference.

**PostgreSQL + Drizzle ORM.** Drizzle stays close to SQL: migrations are
real SQL files that can be read and, when needed, edited by hand — as
about ten were, to repair existing rows before a new constraint
(ARCHITECTURE §3). Postgres is used for more than storage: row-level
security, triggers, exclusion constraints, partial unique indexes,
multiranges and deferred constraint triggers all carry rules.

**Session cookies (Passport), not JWT.** A session stores only the account
id and the active role; the user is reloaded on every request, so a role
change or a deactivation takes effect at once, not when a token expires.
Sessions live in Postgres (`connect-pg-simple`), so the server can also end
them: a password change, a reset, a deactivation, a merge and the fifth
failed re-confirmation each delete the sessions they end, and close those
sessions' sockets. The cost of not using JWT is a session store, and
cookie settings that must match the deployment (below).

**RustFS** (self-hosted, S3-compatible) for files, through the AWS SDK.
Chosen over managed storage to keep the whole stack self-hosted and
inspectable. MinIO was the first choice, and was replaced when its
Community Edition was discontinued (journal 04). Storage stays private:
every response carries short-lived **signed URLs**, never storage keys.

**bcrypt** for passwords, **AES-256-GCM** (Node's `crypto`) for two-factor
secrets at rest, and **HMAC-SHA256** for recovery codes. A TOTP secret must
stay readable to check codes, so it is encrypted, not hashed. The known
limit: the key lives in the server's environment, so this protects against
a stolen database, not a stolen server — a real deployment with patient
data would keep it in a key-management service.

**Email through a port with adapters.** `EmailService` decides what an
email says; an `EmailTransport` decides how it leaves: **Resend** in
production (a verified sending subdomain, `send.notify.stridecare.app`, so
the apex domain's reputation is kept apart), **SMTP to Mailpit** in
development, a console transport, and an in-memory outbox in the tests.
`EMAIL_TRANSPORT` is required with no default, because any default is
wrong somewhere. A transport **rejects** on failure and the caller decides
what that means (an invitation reports `emailSent: false`; forgot-password
still answers `204`). This replaced an early "never throws" wrapper.

**Socket.IO** for live messaging, authenticated by the same session cookie
as HTTP. That keeps one identity model, not a second token scheme to keep
in step.

**Also:** pino / nestjs-pino (structured JSON logs), @nestjs/throttler
(rate limits), @nestjs/terminus (`/health`), class-validator and
class-transformer (DTOs), @nestjs/swagger (interactive docs at `/api-docs`),
otplib (TOTP), **pdfkit + fontkit** (the records PDF, with an emoji
fallback font), **GlitchTip** with the **Sentry SDKs** (error tracking,
self-hosted).

---

## Who may see a patient's data

**The care team is the trust boundary.** Sharing a clinic with a patient
gives *directory* access: name, date of birth, photo, who treats them.
*Clinical* access (programs, sessions, the medical file, range of motion,
messages) needs a **current care-team link and a shared clinic**. It
replaced "any practitioner of the clinic" (journal 36). Joining a patient's
care team is self-service and immediate (a colleague covering on a Monday
can't wait for an approval), and it is audited and shown to the patient
and to the others on the team. Links are ended, never deleted: who treated
whom, and when, is history.

**Every clinical rule exists twice.** A service decides what the API
allows; a row-level security policy decides what Postgres returns. The app
connects as `stride_app`, a role with no way around row security (not a
superuser, owner of nothing it queries), so a service bug alone can't leak
data (journals 23–24). All **42 tables** are `ENABLE` + `FORCE ROW LEVEL
SECURITY`. For the central rule, the care team, a **parity test** runs the
same cases through the TypeScript and the SQL and requires the same
answers. "Covered" isn't "restrictive", though: `users`,
`user_roles`, `user_clinics`, `clinics`, the three profile tables and the
exercise library and templates keep a deliberate `SELECT USING (true)`,
because the sign-in path reads them before anyone is signed in, or because
the data is shared by design. Their protection is which *columns* each
endpoint selects. Writes are restricted everywhere.

**A refusal says as little as possible.** When row security hides a record,
the API answers `404`, not `403`: whether a patient's program exists is
itself clinical information. Lists answer `403`, never an empty list, when
the caller may not ask at all — an empty list would claim "this patient has
no programs". The rules are in
[`api/04-authorization.md`](api/04-authorization.md).

**Admins run the organisation, not the care.** Admins manage accounts,
clinics, memberships, care teams and the audit log. They read no clinical
row — no program, session, medical file, assessment or message — at either
layer, and the audit log withholds clinical entries' details from them. A
"break-glass" read was considered and replaced by **record access** with a
purpose and a trace: a **complaint review** (one admin, one patient, a
reason the care team never sees, 7 days, a stamped PDF copy) and a **legal
disclosure** (recipient, legal basis, the parts and period ordered, an
optional hold, a stamped copy). Both read the record *as the patient*, so
they can never contain more than the patient can see, and both tell the
care team (journal 39).

**Deactivation changes the account, not the record.** A deactivated patient
keeps their care team: the team must still read the file and may write to
the *record* (a discharge note, closing a program). Writing *to the
patient* stops: no new program, no change, no message (the database refuses
it). Deactivating a practitioner ends their current links in the same
transaction. Where row security would silently skip those links, the
deactivation is refused instead of half-done.

**Roles.** One account may hold several roles, with one **active** at a
time: single-role accounts get theirs at sign-in, multi-role accounts
choose, and can switch (`POST /auth/switch-role`, a new session id, the old
sockets closed). Controllers use `SessionAuthGuard` at the class level and
`RolesGuard` + `@Roles(…)` per route. A route without its guard still meets
the policies.

---

## The clinical domain

**Copy, not reference, at every level.** Assigning a template copies its
workouts, exercises and prescriptions into the program, so a later edit to
the template can't change what a patient was given. One level down, each
session keeps its own copy of what it was prescribed (name, prescription,
description), so a later edit to the program can't rewrite past sessions.
Photos are the deliberate exception: a program shows the library's photos,
read live, because they illustrate rather than prescribe, and a better
photo should reach every patient. A practitioner can choose photos of the
program's own instead (copied, or uploaded for this patient).

**A schedule is a history.** Specific weekdays or N a week, as **versions**
with an "applies from" date. A change is a new version from a chosen day;
past days stay judged by the version in force then. The database refuses
any change to a version that has already judged a day. Sessions due are
**calculated, never pre-created**, by one pure module (`summarizeSchedule`)
that every screen asks: done, made up, made up late, done early, swapped,
missed, due, upcoming. A label that seemed wrong was always a model that was
wrong ("done early" is not a swap). A pause is a schedule version, so a
paused week accrues nothing (journal 36).

**A session is a state machine the database enforces.** `in_progress`,
`completed` (on its own day only), `incomplete` (stopped with a reason, or
closed by the app) and `skipped`. No `pending`: a row exists only once the
patient acts. Every moment is the database's `now()`, a finished session is
final, one session may be open per program, and at most one session a day
counts (journal 37). Clinical rules about *what may happen* are server rules;
which option a screen offers first is the screen's choice. A preference
written as a server rule was removed for exactly that reason.

**Closed means read-only, for everyone.** A completed or cancelled program
refuses every change, in the service and in a database trigger (the
project's first). "Assign again" creates a new program from the tailored
one rather than reopening it. An exercise a session used is **retired**,
not deleted.

**Alerts are computed, reviews are stored.** "For review" (misses in a row,
inactivity, a painful session, a new member on a care team, a review or
disclosure of a record) is computed per request, in a fixed number of
queries. A stored alert would need a job to keep it true, and a job has no
user to sign its audit entries. Only the practitioner's review is stored.

**The medical file is append-only.** Entries are typed SOAP notes
(Subjective, Objective, Assessment, Plan). A correction is a new entry that
**amends** one earlier entry of the same patient, at most once, so versions
form a chain. Nothing is updated or deleted. **Range of motion** follows the
same model: an assessment holds measurements from a fixed catalogue of 33
movements, each checked against its plausible range, and is corrected by
amendment (journal 41).

**Messaging** is between a patient and a practitioner on their care team.
History stays readable after a link ends (it is the patient's record), but
sending stops, decided by the database at the moment of writing. Text is
fixed once sent. A sender may delete an unread message within 15 minutes.
"Read" is set once, by the recipient. Live events are emitted after the
commit, through rooms derived from the session (journal 38). An email says
a message is waiting, never what it says, at most once per conversation
until it is read.

---

## Accounts and sign-in

**Accounts by invitation only.** Public registration was removed. An admin
or a practitioner creates the account without a password, and a one-time,
7-day invitation lets its owner choose one. Nobody sets someone else's
password. The account exists at once, so care can be prepared before the
patient signs in. The very first admin is created by a one-time
`register-clinic`, refused once any admin exists.

**Tokens.** Invitations, password resets, email changes and the records
link all use 32 random bytes, stored only as a SHA-256 hash (a 256-bit
token can't be guessed, and a deterministic hash makes the lookup an
index). Each is single-use, decided inside a transaction so two tabs can't
both spend it, and travels in request bodies, never URLs, which get logged.

**Two-factor, hardened before its screens were built.** Optional for every
role. Reading the existing code first found a set-up that replaced a
working secret, enrolment possible from a stolen session, no recovery, and
codes reusable within their window. Now: set-up asks the password; a code
is spent under the account's row lock; ten recovery codes are stored as
keyed hashes; an admin can reset another account's two-factor, with the
admin's own re-confirmation. Turning it off asks the password *and* a code
(journal 39).

**Re-confirmation ("step-up").** Changing the email or password, turning
two-factor off, generating codes, an admin's reset and a merge each ask the
current password (and a code, if two-factor is on). The session alone isn't
enough, because a stolen session must not be able to take the account
over. Each failure is recorded after the change rolls back, and five in a
row sign that session out.

**Changing the email** has its own design. One stored spelling per address
(trimmed, A–Z lowercased — the database's `lower()` follows the server's
locale, so only ASCII is safe to agree on). The link goes to the new
address, and the old address gets a notice with the new one masked and a
cancel link. A taken address reveals nothing to the requester. Confirming
signs the account out everywhere else.

**What the timing says.** Sign-in performs exactly one bcrypt comparison
whether or not the account exists, so an unknown address takes as long as a
wrong password (6 ms against 75 ms before the fix; 70 against 72 after).
Forgot-password always answers `204`, without waiting on the mail server.

**Cookies.** `httpOnly`, `secure` in production, and `SameSite=Lax`
everywhere since 2026-11-03. Production first sent `SameSite=None`, chosen
when the frontend was expected on another domain (journal 16); with the
frontend and the API sharing `stridecare.app`, the browser treats the
frontend's calls as same-site, and `Lax` keeps the cookie off every other
site's background requests (forged form posts, cross-site `fetch`). The cost:
a frontend served from another site, such as a Cloudflare Pages preview on
`*.pages.dev`, can't keep a session with this API.

---

## The audit trail

**One complete entry per change, in the change's own transaction.** Who,
what, about which patient, before → after. If the entry fails, the change
rolls back; if the change rolls back, so does the entry. A no-op writes
nothing. The first design (a global interceptor recording "`PATCH
/assigned-programs/3`" after the response, fire-and-forget, with
duplicates) was **deleted**. In its place, a test fails the build for any
write route that is tagged neither `@AuditedByService()` nor
`@NotAudited(reason)` (journal 39).

**Clinical reads are recorded too.** When someone other than the patient
reads programs, sessions, alerts, range of motion or messages, one entry
per patient shown is awaited before the answer is sent: no answer without
its trace. The medical file records every read, the patient's own included.

**Kept whole, shown by need.** Entries are append-only for the app. Admins
see clinical entries with their details withheld. Retention is decided at
**6 years** (HIPAA's period for required documentation); the purge job
isn't built, since nothing can be that old yet.

Not every change is the trail's business. The "easier-to-read font" setting
is written without an entry: it concerns only its owner, and is visible to
nobody else.

---

## Records leaving Stride, and accounts merged

**A patient's right of access.** "Download a copy" builds one PDF of the
medical file, range of motion, programs and sessions, read *as the patient*
in one consistent snapshot (`REPEATABLE READ`), made on request and never
stored. Its audit entry lists the ids of what went in. For a patient who
can't sign in, an admin emails a link (one download, 72 hours, the date of
birth asked, five tries).

**Duplicate patients** are caught at creation (same date of birth and
normalised name → a warning the creator can override, recorded) and fixed
by a **merge**. The merge is the first of the project's two `SECURITY
DEFINER` functions: it moves every row in one transaction, splits
overlapping care-team links, deactivates the merged account with a pointer
to the survivor, and can't be undone in the app. It runs with five locks
against misuse (journal 40). The other definer function hands the message
sweep its due notices, because a job has no user to act as. Everything else
runs under the caller's own row security.

**Files outlive transactions, so they are compensated.** A file stored
before a transaction that then fails is deleted again; a file a row stops
naming is deleted after the commit, best-effort; archiving a program
removes its own photos. A sweeper (run by hand, dry run by default) lists
what no row references, and never touches a file younger than 24 hours.

---

## The database's half of the rules

Wherever a rule protects the clinical record, the database states it too,
so it holds for a direct query, a script or a route added later. The
patterns repeat:

- **CHECKs for one row's shape**, one constraint per rule, so a refusal
  names the rule it broke. "Not blank" is `~ '\S'` everywhere, the DTOs'
  own test.
- **Partial unique indexes and exclusion constraints for "at most one"**
  (one open session, one open invitation, no overlapping links). The
  constraint decides a race; the service only translates its refusal into a
  `409`. No check-then-insert.
- **Triggers for what a CHECK can't see**: comparing `OLD` and `NEW` (a
  finished session is final), or reading another row (a closed program).
  Most exempt the tables' owner, by role membership, so migrations and the
  seed still work with no role name in the SQL. A policy decides *which
  rows* someone may write; a trigger decides *which values*.
- **Named refusals**: each trigger raises its own constraint name, and the
  global exception filter turns the known ones into the API's own words.
- **Hand-edited migrations**: a constraint checks every existing row, so a
  migration first repairs the rows it would refuse. Every migration is
  created with `drizzle-kit generate` (or `--custom`), never a hand-written
  journal entry (journal 32).

---

## Security-specific decisions

- **Rate limits** on every route (60 a minute per address), tighter on
  sign-in, resets, invitations, re-confirmations and downloads (5 a minute
  on 21 routes). A refused request says how
  long to wait, in words and in `Retry-After`. The limits can be switched
  off only outside production (`RATE_LIMITS=off`), and one test suite keeps
  them on to prove they work.
- **Validation on every input**: lengths, list sizes, calendar dates
  checked to exist, unknown fields refused. `null` is refused for every
  required column (`@ValidateIf(isPresent)`, never `@IsOptional()` — the
  "null trap" that recurred four times before it became the rule).
- **One funnel for what a user record exposes** (`toPublic()`): secrets,
  hashes and storage keys stripped, photos as signed URLs. A person's own
  answers (`toSelf()`) add only their own settings.
- **Secrets in bodies, hashes in the database**, as above; nothing secret
  in a URL.
- **WebSocket authentication in blocking middleware**, at the handshake; the
  sockets of every ended session are closed.
- **Behind Cloudflare and Caddy**, the client's address is read from
  `CF-Connecting-IP`, after `X-Forwarded-For` proved unreliable in that
  chain (journal 19).
- **CORS** names its origins and exposes only the headers the frontend
  reads (`Content-Disposition`, `Retry-After`, `X-Request-Id`).
- **Bug hunts by category**, built from what earlier bugs looked like:
  cross-clinic leaks, TOCTOU races, comments claiming an unenforced rule,
  one bug copied into sibling code (journals 20, 22).
- **Nothing that leaves the server names a patient.** Logs and error
  reports are built from allow-lists: the path without its query, no
  headers, no IP addresses, no database values, emails masked (journal 41).

---

## Type safety

A long stretch of work traced about 150 lint findings to one root cause:
`any` standing in for data with a real shape (`@CurrentUser()`,
express-session's `SessionData`, untyped requests, `activeRole` as a plain
string). Each was fixed at the root rather than per call site (journal 21).
One sweeping fix was deliberately rejected: a global `Express.User`
augmentation would have hidden a real difference between two sign-in
paths. The backend has linted with **0 problems** since 2026-11-01; e2e
files relax only the `no-unsafe-*` rules, because supertest's `res.body` is
untyped by nature.

---

## Development practices

- **Design with the person, then build in passes.** Each feature was
  proposed (as screens when it had any), its choices made by the person, and
  built in passes, each confirmed green on the person's machine before the
  next. The decisions log records each choice with what was rejected.
- **Verify against the code, never memory.** Every change starts from the
  current files, and every document claim is traced to a file (this
  document included).
- **Mutation testing, by hand.** After each pass, deliberate bugs are put
  into the new code (a condition removed, a bound moved, a lock dropped, a
  policy weakened) and the tests must fail. A surviving mutant is either a
  missing test or dead code, and which one is proven before acting. See
  [`TESTING.md`](TESTING.md).
- **Races proven, not hoped for**: a conflicting write is held open on
  another connection while the request is sent (`whileHolding`).
- **Rules checked across the whole codebase by tests**: every write route
  audited, no log line interpolating an address, the endpoint table equal
  to the code, every storage column known to the sweeper.
- **Known, deliberately postponed work is written down** with its reason,
  in a working ledger kept outside the repository. What is still open and
  matters to a reader is summarised under "Known limits" below.
- **Formatting and line endings**: Prettier (`semi: false`, `singleQuote:
  true`, `trailingComma: "all"`, `endOfLine: "auto"`, because the working
  copy is CRLF on Windows), and `.gitattributes` keeping shell scripts and
  systemd units LF, since a CRLF script fails on Linux.
- **AI assistance, reviewed.** Much of the code and documentation was
  written with an AI assistant (Claude). The rule throughout was root causes
  over patches, real verification over "should work", and every
  ambiguity raised rather than guessed. The person reviewed, ran and
  confirmed each pass.

---

## Deployment infrastructure

**A self-managed DigitalOcean Droplet** (Ubuntu 24.04, 2 GB / 1 vCPU) with
Docker Compose, chosen over a platform (Render, Railway, Fly.io) because
handling TLS, DNS, firewalling and processes by hand was part of the point.
The backend-only pipeline was run end to end twice: built, then destroyed
and recreated to prove the guide (journals 18, 26). **The whole system,
frontend included, was then deployed on 2026-11-03** by following the
current guides from start to finish; what's still open is ARCHITECTURE
[§12](ARCHITECTURE.md#12-open-items).

**Cloudflare in front, Caddy behind.** Cloudflare gives DNS, DDoS
protection and TLS at the edge, in Full (strict) mode. The firewall admits
only Cloudflare's ranges, verified with a packet capture. Caddy obtains its
own certificates and serves two sites: `api.stridecare.app` → the app, and
`files.stridecare.app` → storage, `GET` only, so that photo URLs are signed
for an address browsers can reach (journal 42). The frontend will be
`stridecare.app` on Cloudflare Pages.

**Least exposure.** Postgres has no published port at all; RustFS is bound
to `127.0.0.1` (for the backup script and the admin console over SSH), as is
GlitchTip's web console; GlitchTip's own Postgres isn't published. Required
secrets are refused at two layers: Compose won't start without them, and the
app's `validateEnv()` refuses unset or placeholder values at boot, including
the production-only ones (`STORAGE_PUBLIC_URL`, `https` origins).

**One-shot tools as Compose services** behind the `tools` profile:
`migrate`, `create-app-role`, `seed` and `demo-reset`, each built from the
image's builder stage and never started automatically.

**Backups**: `pg_dump`, compressed, uploaded to RustFS by cron, with a
restore performed and checked against real row counts. The known limit is
that storage sits on the same machine, so this protects against mistakes,
not against losing the Droplet.

**Demo mode** for reviewers (off by default): a card on the sign-in page
with four published accounts, those accounts locked against changes that
would spoil them for the next reviewer, and a nightly reset (a systemd
timer at 04:00 Toronto time stops the app, reseeds, sweeps storage and
restarts it).

**CI** (GitHub Actions: checks, the API's e2e suite and the browser suite)
was built and rehearsed while the repositories were private, and runs since
they went public.

---

## Observability & operations

**Logs**: structured JSON (pino), one line per request with a random,
server-made **request id**, the path, the status and the user id — never a
query string, a header or an IP address. The id is also in every error
body and response header, so a person can quote it ("Reference: 2dc325cf")
and it finds the request in the logs and in the error tracker. Docker
rotates the logs (`max-size: 10m`, 3 files). **Better Stack**
(uptime and log shipping through a small Vector agent) was chosen in
journal 19. Its own page says it isn't HIPAA compliant, which is why the
log rules above exist.

**Error tracking**: self-hosted **GlitchTip**, with the official Sentry
SDKs on the backend and, through the API (`POST /monitoring`), the frontend.
Only real bugs report (a `500`, a crash), never an answer the app chose to
give. Each report is collected minimally and rebuilt from an allow-list
before it is sent (journal 41).

**Resilience checked by breaking things**: a database restart no longer
takes the API down (idle connections' errors are handled); graceful
shutdown was timed with `docker stop`; the storage client has timeouts that
throw.

---

## Known limits and what's deferred

Postponed on purpose, each with its reason. None is an unknown.

**Scale and operations**
- **One API instance.** Rate-limit counters and Socket.IO rooms live in the
  process's memory; two instances would need Redis for both, and sticky
  sessions. Not needed at one clinic's scale.
- **No scheduled jobs beyond the message sweep.** The audit purge (nothing
  is old enough yet), the storage sweeper (run by hand) and closing sessions
  left in progress (today they close at the next start, or with their
  program) would each need a job with no user. The message sweep's definer
  function is the pattern to follow.
- **Backups on the same machine**, as above.
- **Signed URLs** are cacheable (stable for an hour) only for the library's
  thumbnails; other photos are signed fresh each time. Thumbnails are the
  whole photo scaled down; generating small images needs an image library
  (a native dependency, not chosen yet).

**Security and privacy**
- **Two-factor is optional for admins**, by choice: requiring it would
  change every admin's sign-in, the reviewers' included.
- **The encryption key lives with the server** (above).
- **A patient can't remove a practitioner from their care team** — a
  meaningful privacy right, left for later because it needs a design (a
  practitioner could simply rejoin).

**Clinical features**
- **Referrals to another clinic** aren't built: they hand a record to
  another organisation, which needs the patient's consent and a record of
  its own. A care-team link never crosses clinics.
- **Medical file templates** (practitioner-defined sections) — SOAP is
  fixed today.
- **Schedules:** no minimum rest between sessions, no second session a day,
  no backdated sessions, no removing a planned change except by replacing
  it.
- **The records PDF** draws emoji in black and white and has no fallback
  font for Chinese, Japanese, Korean, Arabic or Hebrew text yet; it isn't a
  tagged (screen-reader structured) PDF.
- **A legal disclosure's copy can't be downloaded again** (it is the
  request's answer and is never stored), and its hold can't be ended early.
- **Merges** keep the surviving account's profile details and fill only its
  empty fields; choosing each field isn't offered.

**Still to check now that it's deployed**: that a portrait photo from a
real phone keeps its orientation through the avatar crop.
