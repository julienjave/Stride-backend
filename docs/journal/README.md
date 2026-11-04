# Stride — engineering writeups

This is a chronological log of the decisions, tradeoffs, and real bugs behind
Stride's backend — a NestJS/Drizzle/PostgreSQL physiotherapy platform with
multi-role authorization, session-cookie auth, real-time messaging, and a
deployed production environment. It's written as a journal, not a spec: each
entry documents a phase as it actually happened, including the things that
were wrong at the time and fixed later. Read in order for the full narrative,
use the index below to jump to a topic, or begin with the six entries under
"Start here".

**A note on self-correction:** doc 01 describes PostgreSQL Row-Level Security
as an active guarantee. It wasn't — every check lived in the application
layer until docs 23–24 built real RLS. Doc 01 is deliberately left
unedited, since it was an accurate description of the plan at the time it
was written; doc 23 is where the gap between that plan and what actually
got built is named explicitly. Read 01 as the plan, and 23 as the record of
where reality diverged from it. Doc 02's "(planned)" Row-Level Security is
the same plan, and is left as written for the same reason. The rule holds
for every entry: a later entry names an earlier one's error, and this README
keeps the list of what is still open; the entries themselves are a frozen
record.

**Two eras, two kinds of entry.** Entries 01–35 cover the backend on its
own, each written as its phase happened. From entry 36 on, the backend was
built alongside the frontend, phase by phase. Those entries are one per
build phase, written after the fact (2026-11-03) and condensed to the three
or four decisions or bugs worth telling as a story. The complete "what and
why" of each phase is in [`PROJECT.md`](../PROJECT.md), and the system as
it stands is in [`ARCHITECTURE.md`](../ARCHITECTURE.md). Each of those
entries names its counterpart in the
[frontend repository's journal](https://github.com/julienjave/Stride-frontend/blob/main/docs/journal/README.md),
which covers the same phase from the screens.

---

## Start here

Six entries that show how this project works, more than what it contains:

| # | Why read it first |
|---|---|
| [20](20-two-bug-hunts.md) | A documentation task that found four real bugs, then a deliberate hunt that found a cross-clinic leak — the habit every later entry relies on: write it down against the code, and the code's errors show. |
| [23](23-row-level-security-step-zero.md) | Where the journal corrects itself: why Row-Level Security had done nothing at all (the superuser bypass), and the role split that made every later policy real. |
| [26](26-redeploying-for-real.md) | `DEPLOYMENT.md` validated by destroying and recreating the server, not trusted — and the real problems only running it found. |
| [28](28-resend-flake-timing-side-channel-and-a-false-claim.md) | A flaky test that led to a timing side channel, and to a claim in an earlier entry that was never true — how the journal handles its own mistakes. |
| [36](36-care-team-invitations-and-schedules-as-history.md) | The frontend era's foundations: who may read a patient, kept as a rule in TypeScript *and* in SQL with a test that they agree, and the first database triggers. |
| [39](39-audit-review-account-security-and-record-access.md) | An audit trail rebuilt so the build fails when a route forgets it, the account-security bugs only close reading found, and record access instead of an admin back door. |

---

## Reading order

| # | Title | What it covers |
|---|---|---|
| [01](01-backend-architecture-decisions.md) | Backend architecture & technology decisions | Why Postgres+Drizzle, NestJS, session cookies over JWT, Socket.IO, MinIO, Caddy — framed against HIPAA's technical safeguards. *(Contains the RLS overclaim corrected in 23.)* |
| [02](02-database-schema-design.md) | Database schema design | Entity overview, split identity/profile tables, copy-not-reference for assigned programs, insert-only audit log, soft delete via `RESTRICT`, per-relationship `ON DELETE` choices, selective JSONB. |
| [03](03-application-layer-and-authentication.md) | Application layer & authentication | The DI/module template, the full session-auth stack (store, strategy, serializer, guards), CORS, rate limiting, `trust proxy`, and the gaps deliberately left for later. |
| [04](04-exercise-seeding-and-storage-migration.md) | Exercise seeding & storage migration | The seed script pattern, and MinIO's Community Edition discontinuation discovered mid-project — full migration to RustFS + `@aws-sdk/client-s3`. |
| [05](05-multi-role-authorization-and-clinics.md) | Multi-role authorization & clinics | The `users.role` → `user_roles` redesign, session-scoped active role (AWS IAM-style), and the clinic-bootstrap problem. |
| [06](06-testing-infrastructure-and-debugging.md) | Testing infrastructure & debugging | Unit tests via DI substitution, a dedicated test database, and the investigation that traced a session-persistence bug to a real `@nestjs/passport` gap. |
| [07](07-file-upload-system.md) | File upload system | One shared Multer config for three upload routes, ordered `mediaUrls` arrays instead of a rigid schema, cover image as `mediaUrls[0]`. |
| [08](08-core-clinical-domain.md) | Core clinical domain | `ProgramsModule`, `AssignedProgramsModule` (where copy-not-reference is actually built), `SessionsModule`'s patient-only write model. |
| [09](09-messaging-system.md) | Messaging system | Reusing session auth for WebSocket handshakes, per-participant conversation archiving, the narrow (unread + 15-minute) message-delete rule. |
| [10](10-audit-logging-system.md) | Audit logging system | The hybrid design (one global interceptor + explicit calls for auth events), the `performedBy NOT NULL` constraint's real limitation, fire-and-forget writes. |
| [11](11-medical-files-module.md) | Medical files module | Append-only by design (no update/delete), auditing reads (not just writes) for clinical records, a duplicate-logging bug caught before shipping. |
| [12](12-password-reset-and-mfa.md) | Password reset & MFA | Token design (random + SHA-256, not bcrypt), why MFA forced `LocalStrategy` to be retired, `otplib`'s live API rewrite. |
| [13](13-tsconfig-types-and-test-generation.md) | tsconfig, types, and test generation | The `types` array regression and its durable fix, delegating full unit/e2e coverage to Claude Code, and the infra bugs that surfaced running it. |
| [14](14-codebase-review-nine-improvements.md) | Codebase review: nine improvements | `SESSION_SECRET` fail-loud validation, FK indexes, Swagger docs, a Drizzle health indicator, pagination. |
| [15](15-closing-the-review-five-improvements.md) | Closing the review: five improvements | Multi-origin CORS (and *why* it's structurally required once `credentials: true`), a full DTO length-cap sweep, `avatarPath` lockdown, an independent `StorageService` size guard, tunable connection pools. |
| [16](16-docker-deployment-foundations.md) | Docker deployment foundations | The multi-stage `Dockerfile`, three chained build bugs (`rootDir`, stale `.tsbuildinfo`, a missing prod dependency), and prod-only cookie/proxy config. |
| [17](17-real-email-and-mfa-encryption.md) | Real email and MFA encryption | Swapping the console-log `EmailService` for Resend (and the never-throw quirk that protects no-enumeration), AES-256-GCM for `mfaSecret` at rest. |
| [18](18-deployment-provisioning-through-backups.md) | Deployment: provisioning through backups | The Droplet, the Cloudflare/domain architecture, Docker's first real production run, and a backup verified by an actual restore with row counts. |
| [19](19-deployment-verification-and-observability.md) | Deployment verification and observability | The Cloudflare-firewall/`tcpdump` diagnostic chain, the `X-Forwarded-For` vs. `CF-Connecting-IP` bug, a WebSocket smoke test, and settling on Better Stack + Vector. |
| [20](20-two-bug-hunts.md) | Two bug hunts | A documentation task that surfaced four real bugs (unscoped `GET /users/:id`, an unenforced admin-archive comment, a missing WS auth check, a WS auth race), then a deliberate five-category hunt that found a cross-clinic leak and a `reorderExercises` flaw copy-pasted three times. |
| [21](21-type-safety-hardening.md) | Type-safety hardening | Four passes tracing ~200 lint findings back to `any` at its root (`@CurrentUser()`, `SessionData`, a shared `AuthenticatedRequest`, enum typing) — plus one deliberate non-fix. |
| [22](22-scoped-bug-hunt-and-verification-loop.md) | Scoped bug hunt and verification loop | A five-category hunt built from the prior two hunts' own track record; a real PII-leak fix in `toPublic()`, an admin-bypass gap on `sendMessage`/`markAsRead`, and the investigate-then-fix-then-reverify loop as an explicit process. |
| [23](23-row-level-security-step-zero.md) | Row-Level Security, step zero | Why RLS had done nothing until now (superuser bypass), the restricted `stride_app` role, and the narrow connection split that makes real policies possible. |
| [24](24-row-level-security-rollout.md) | Row-Level Security rollout | The six/eight-table rollout, the `withRlsContext` pattern, what genuinely differed per table, and a real migration-bookkeeping incident caught before it could reach production. |
| [25](25-closing-the-log-rotation-gap.md) | Closing the log-rotation gap | A `PROJECT.md` claim checked against real git history and found never actually implemented (not a regression) — the fix, its verification via `docker compose config`, and a secrets-in-transcript exposure caught and rotated along the way. |
| [26](26-redeploying-for-real.md) | Redeploying for real | A full Droplet destroy-and-recreate, executed to actually validate `DEPLOYMENT.md` rather than trust it — a genuine RLS-rollout scope gap in the seed script, a second `ts-node`/`tsc` ambient-declaration gap, a stale-image documentation bug, a recurring local-vs-Droplet environment confusion, and several real-but-not-buggy operational characteristics, all found by actually running the pipeline end to end. |
| [27](27-message-normalization-and-api-docs-rls-review.md) | Message normalization & an API docs accuracy pass | A real API contract fix (error `message` is now always an array, in both exception filters) — and a documentation review that found the RLS rollout had silently changed `403` to `404` on four resources, confirmed against a real passing test, with none of the API reference docs ever updated to match. |
| [28](28-resend-flake-timing-side-channel-and-a-false-claim.md) | A flaky test, a timing side-channel, and a false claim | A one-line fix for a real flake (a live Resend round-trip in a test) led directly to measuring a genuine account-enumeration timing side-channel in `forgotPassword()`, a fire-and-forget fix for it, and — while confirming the fix's blast radius — discovering doc 17 describes a regression test that, per full git history, was never actually committed. *(Doc 17 is left unedited, per this project's established policy — this is where that gap is named.)* |
| [29](29-row-level-security-user-roles.md) | Row-Level Security, `user_roles`: the pass the roadmap called hardest | RLS Pass 2. The roadmap's own proposed starting policy would have broken login for every non-admin account — caught by live adversarial reproduction, not assumed. Two real bugs found: a scope gap in `grantRole()` (missing RLS context, the same shape as Pass 1's `ClinicsController` gap) and a pre-existing read-after-write bug, unmasked by the first e2e test to ever check this route's response body instead of just its status code. |
| [30](30-write-only-profile-fields.md) | The write-only profile fields, found while investigating Pass 3 | Not RLS work — a real application bug the Pass 3 investigation surfaced: `licenseNumber`/`specialties`/`dateOfBirth`/`position` were written on account creation and never read back by any route, ever, confirmed by exhaustive search. Fixed before Pass 3's policy design, deliberately, so it wouldn't encode a bug as if it were permanent — plus a second instance of doc 28's exact Resend flake, and a diagnosed-but-deliberately-unfixed WSL2 clock-drift finding. |
| [31](31-profile-field-updates-before-rls-pass-3.md) | Closing the profile-field update gap, before RLS Pass 3 | A second write-path gap found while scoping Pass 3, alongside doc 30's read-side one: `UpdateUserDto` never carried the profile fields at all, so nobody — not even an admin — could ever correct a practitioner's license number or a patient's date of birth after creation. Fixed reusing the existing `isSelf/isAdmin/isManagingPractitioner` check with one new layer (field applicability gated on the *target's* actual roles), built on `withRlsContext` from the start so Pass 3 inherits one fewer scope gap to audit for. |
| [32](32-row-level-security-profile-tables.md) | Row-Level Security, the three profile tables: Pass 3 | `SELECT USING(true)` adversarially proven required (the login path itself reads this data with no context, the same load-bearing reason `users`/`user_roles` needed it), asymmetric `INSERT` policies matched exactly to each table's real call sites, and `UPDATE` reusing `users_update`'s exact existing condition rather than a new one. Two real bugs: a self-defeating bootstrap check tripped by its own transaction's prior statement, and a migration-bookkeeping trap (a real timestamp silently sorting before an earlier synthetic one) that led directly to a new, permanent rule — every future migration goes through `drizzle-kit generate --custom`, never a hand-written journal entry. |
| [33](33-row-level-security-user-clinics.md) | Row-Level Security, `user_clinics`: Pass 4 — the trust-anchor table | The roadmap's most consequential pass, closed with a genuine, evidenced "not needed" on `SECURITY DEFINER` rather than shipping it by default. Live proof that `getClinicIdsForUser()`'s contextless read — the mechanism behind `isPatientManagedBy()`, the authorization gate for most of the app — forces `SELECT USING(true)` regardless; once that was confirmed, the `SECURITY DEFINER` question resolved itself, since the actual failure was "no context exists," not "insufficient privilege." Also confirmed the `INSERT` policy mirrors, not widens, a real vulnerability doc 20 had already closed at the app layer. |
| [34](34-row-level-security-clinics.md) | Row-Level Security, `clinics`: Pass 1, written up out of order | Pass 1 of the roadmap, documented last — deliberately numbered 34 rather than inserted earlier and renumbering four already-verified documents for the sake of chronological tidiness (see doc 01's own precedent for the same reasoning). Covers the first real RLS pass: the missing-`@CurrentUser()` gap that recurred twice more later in the same file, and the bootstrap `INSERT` policy that turned out to need a narrower, self-closing condition than the broader precedent it was first copied from. |
| [35](35-backup-bucket-and-credential-parsing.md) | A small documentation gap, a real credential-parsing bug, and a duplicate of it in the docs | A two-line fix (auto-create the backup script's S3 bucket) surfaced a genuine, previously-invisible authentication bug — `.env.example`'s own documented format broke a naive credential parser, silently exposing the actual backup upload, not just the new code. Includes a real "is this actually a local/prod mismatch?" question answered precisely (it wasn't, but asking it caught a different, legitimate connectivity check worth doing) — and the identical parsing bug found duplicated in `DEPLOYMENT.md`'s own hand-followed restore instructions. |
| [36](36-care-team-invitations-and-schedules-as-history.md) | The practitioner's loop: the care team, invitations, and schedules as history | Frontend Phases 1–3. Clinical access as an active care-team link plus a shared clinic, kept in TypeScript and in SQL with a parity test, an exclusion constraint against overlapping links, and a pooled connection's `''` that turned a policy refusal into a `500`. Accounts by invitation (hashed one-time token, single use as one conditional `UPDATE`, the email sent after the commit and its outcome stored). Schedules as versions, sessions calculated by one pure module, and "done early is not a swap". The first triggers: a closed program made read-only in the database, closing a real race. |
| [37](37-the-session-as-a-state-machine.md) | The patient's loop: a session the database can vouch for | Frontend Phase 4. A session as a state machine the database enforces (one CHECK per rule, no default status, partial unique indexes, a trigger comparing `OLD` and `NEW`, server-set moments). `FOR SHARE` against a tick racing a Finish, `whileHolding` race tests, and closing a program through a policy for *who* and a trigger for *what*. A suggestion written as a server rule, and removed. The storage client's 6-second wait per photo, and an invitation that lived 169 hours across a clock change. |
| [38](38-messaging-brought-up-to-standard.md) | Messaging, brought up to the standard the rest had reached | Frontend Phase 5. Nine gaps found by reading the old code (a former care-team member writing forever, deleted text served back, unaudited and unvalidated socket writes, admins reading everything). The database alone deciding "read-only", events emitted after the commit, rooms derived from the session, and sockets that outlived the sessions that opened them. A 15-minute boundary tested inside one transaction. |
| [39](39-audit-review-account-security-and-record-access.md) | Phase 6: an audit trail worth reading, accounts that hold, and record access instead of a back door | Frontend Phase 6. The audit interceptor deleted and replaced by a test that fails the build; every write's entry in its transaction, others' clinical reads awaited. Two-factor bugs found by reading (a working secret replaced, codes replayable, a stolen session enrolling its own phone), keyed hashes for recovery codes, failures counted after the rollback. Emails in one spelling (A–Z only, and why). Admins out of clinical data; the records export read as the patient at one snapshot, a serialization failure retried, a column hidden by a second table. |
| [40](40-defence-in-depth-leftovers-and-merges.md) | Phase 6.5: what a rollback can't undo, two accounts for one person, and a job with no user | Compensating for files a transaction can't roll back, and a storage sweeper whose read fails rather than comes back short. Detecting and merging duplicate patients — the first `SECURITY DEFINER` function, its five locks, overlapping links split with a multirange difference. Care-team links and end dates given a trigger each (and why not column grants). New-message emails sent by a job with no user, through the narrowest door. |
| [41](41-observability-without-patient-data.md) | Phase 7: observability that names no patient, a crash only an outage could show, and rules across two tables | Frontend Phase 7. Request ids, allow-list log serializers and error reports locked twice so nothing leaving the server names a patient; Dedupe hiding the reference on screen. An idle pool connection's error crashing the API. A library list with no `ORDER BY`. Range of motion's deferred constraint trigger and two tables moved in one statement. Branded emails with escaping by default, demo mode, CI built and parked. |
| [42](42-the-documentation-rewrite-finds-three-bugs.md) | Rewriting the documentation against the code, and the three bugs it found | The API reference and `ARCHITECTURE.md` rewritten as they stand, with the endpoint table generated and tested. A sign-in timing side channel (6 ms vs 75 ms) closed with a dummy hash; password resets for deactivated accounts; and every presigned photo URL signed for an address only Docker could resolve. |

---

## Looking for a specific topic?

| Topic | Docs |
|---|---|
| Stack & technology rationale | 01, 04, 16 |
| Database schema & design patterns | 02, 23, 24, 36, 37, 41 |
| Database triggers, constraints & `SECURITY DEFINER` | 36, 37, 38, 40, 41 |
| Concurrency, locks & races | 36, 37, 38, 39, 40 |
| Authentication (sessions, login, logout) | 03, 06, 12, 16, 21, 39, 42 |
| Authorization / RBAC / multi-role | 03, 05, 08, 20, 22, 31, 33, 36, 39, 40 |
| Row-Level Security | 23, 24, 26, 27, 28, 29, 31, 32, 33, 34, 36, 37, 38, 39, 40 |
| Real-time messaging / WebSockets | 09, 19, 20, 21, 38 |
| File & object storage | 04, 07, 37, 40, 41, 42 |
| Audit logging & compliance | 01, 02, 10, 11, 22, 24, 36, 39, 40 |
| Privacy (minimum necessary, what leaves the server) | 38, 39, 41 |
| Clinical domain (programs, sessions, medical files) | 08, 11, 36, 37, 39, 41 |
| Email & MFA | 12, 17, 28, 30, 36, 39, 41 |
| Testing infrastructure | 06, 13, 17, 20, 21, 22, 28, 29, 30, 31, 32, 34, 36, 37, 38, 40 |
| TypeScript / type safety | 06, 08, 13, 21, 26 |
| Security bug hunts | 20, 21, 22, 28, 29, 39, 42 |
| Deployment & production infrastructure | 16, 18, 19, 25, 26, 35, 41, 42 |
| Observability (monitoring, logging) | 19, 41 |
| Process & discipline (verification, sync-checks) | 06, 09, 13, 14, 16, 17, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 40, 42 |

---

## Known open items

Kept up to date here; the entries themselves are never edited. Last checked
against the code and the documents on 2026-11-03.

### Closed

- ~~Doc 02's "(planned)" phrasing for Row-Level Security~~ — **closed, by
  design.** Like doc 01, doc 02 described the plan when it was written and is
  left as written (see the note at the top). How row security actually works
  today is ARCHITECTURE's
  [§4](../ARCHITECTURE.md#4-who-may-do-what-and-how-its-enforced).
- ~~RLS is not applied to `user_roles`, the three profile tables, `clinics`,
  or `user_clinics`~~ — **resolved** by docs 29 and 31–34. Since then the
  schema has grown to 42 tables, and every one is `ENABLE` + `FORCE ROW LEVEL
  SECURITY`. "Covered" and "restrictive" are still different claims: several
  identity tables keep a deliberate `USING (true)` read policy, because the
  sign-in path reads them before anyone is signed in. ARCHITECTURE §4 lists
  them and why.
- ~~The five API docs' "Verified against commit" headers (doc 27)~~ —
  **closed.** The API reference was rewritten in 2026-11 (doc 42). It has no
  per-commit headers any more; instead the endpoint table is generated from
  the code and a unit test fails when the two differ
  ([`docs/api/README.md`](../api/README.md#how-this-reference-is-kept-true)).

### Still open

- **Nothing since doc 35 has been deployed.** The Droplet-based pipeline was
  last run end to end in doc 26. Before the next deployment:
  `STORAGE_PUBLIC_URL` in the production `.env` and a proxied `files` DNS
  record (doc 42 — without the setting the app now refuses to start);
  pinning `glitchtip/glitchtip:6`, `postgres:16`,
  `postgres:18` and `caddy:2`, which still float. ARCHITECTURE's
  [§12](../ARCHITECTURE.md#12-open-items-before-the-deployment) keeps the
  same list.
- **Doc 25's log rotation is still "very likely, not verified".** Doc 26's
  recreated containers almost certainly picked up the `logging:` settings,
  but nobody has run `docker inspect` on a running production container to
  confirm it. Doing that at the next deployment closes it.
- **Jobs that need to run without a user aren't scheduled yet**: the audit
  log purge (retention is decided at 6 years, doc 39), the storage sweeper
  (run by hand today, doc 40), and closing sessions left in progress (today one closes only when
  the patient next starts a session, or when its program is closed — doc 37). Doc 40's `claim_message_notices()` is the pattern for giving such
  a job its one narrow door.
- **CI is built but parked** until the repositories are public (doc 41): the
  workflows sit in `.github/`, which each repository's `.gitignore` lists,
  so that no Actions minutes are spent and no token is held while they are
  private ([`TESTING.md`](../TESTING.md#ci)).
- **Doc 22's link to `deferred-improvements.md` doesn't resolve, by
  design.** That ledger of deliberately postponed improvements was a private
  development file and isn't part of the repository. Doc 22 stays as
  written; the items still open that matter to a reader are summarised in
  [`PROJECT.md` § Known limits and what's deferred](../PROJECT.md#known-limits-and-whats-deferred)
  (and the testing ones in [`TESTING.md`](../TESTING.md#what-the-suites-dont-cover)).
- **Three commit placeholders were never filled in**: docs 28, 30 and 35
  each end with "`[commit hash — to be filled in]`". The entries stay as
  written; the repository's history is the record of those commits.
- **One instance only, for live messaging** (doc 38). Socket.IO's rooms live
  in the memory of one process. Running two API instances would need the
  Redis adapter, and sticky sessions or websocket-only transport. This is a
  deliberate limit, not a bug: ARCHITECTURE's
  [§13](../ARCHITECTURE.md#13-deliberate-limits) lists it with the others.
