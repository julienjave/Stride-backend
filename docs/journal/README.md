# Stride — engineering writeups

This is a chronological log of the decisions, tradeoffs, and real bugs behind
Stride's backend — a NestJS/Drizzle/PostgreSQL physiotherapy platform with
multi-role authorization, session-cookie auth, real-time messaging, and a
deployed production environment. It's written as a journal, not a spec: each
entry documents a phase as it actually happened, including the things that
were wrong at the time and fixed later. Read in order for the full narrative,
or use the index below to jump to a topic.

**A note on self-correction:** doc 01 describes PostgreSQL Row-Level Security
as an active guarantee. It wasn't — every check lived in the application
layer until docs 23–24 built real RLS. Doc 01 is deliberately left
unedited, since it was an accurate description of the plan at the time it
was written; doc 23 is where the gap between that plan and what actually
got built is named explicitly. Read 01 as the plan, and 23 as the record of
where reality diverged from it.

---

## Reading order

| # | Title | What it covers |
|---|---|---|
| 01 | Backend architecture & technology decisions | Why Postgres+Drizzle, NestJS, session cookies over JWT, Socket.IO, MinIO, Caddy — framed against HIPAA's technical safeguards. *(Contains the RLS overclaim corrected in 23.)* |
| 02 | Database schema design | Entity overview, split identity/profile tables, copy-not-reference for assigned programs, insert-only audit log, soft delete via `RESTRICT`, per-relationship `ON DELETE` choices, selective JSONB. |
| 03 | Application layer & authentication | The DI/module template, the full session-auth stack (store, strategy, serializer, guards), CORS, rate limiting, `trust proxy`, and the gaps deliberately left for later. |
| 04 | Exercise seeding & storage migration | The seed script pattern, and MinIO's Community Edition discontinuation discovered mid-project — full migration to RustFS + `@aws-sdk/client-s3`. |
| 05 | Multi-role authorization & clinics | The `users.role` → `user_roles` redesign, session-scoped active role (AWS IAM-style), and the clinic-bootstrap problem. |
| 06 | Testing infrastructure & debugging | Unit tests via DI substitution, a dedicated test database, and the investigation that traced a session-persistence bug to a real `@nestjs/passport` gap. |
| 07 | File upload system | One shared Multer config for three upload routes, ordered `mediaUrls` arrays instead of a rigid schema, cover image as `mediaUrls[0]`. |
| 08 | Core clinical domain | `ProgramsModule`, `AssignedProgramsModule` (where copy-not-reference is actually built), `SessionsModule`'s patient-only write model. |
| 09 | Messaging system | Reusing session auth for WebSocket handshakes, per-participant conversation archiving, the narrow (unread + 15-minute) message-delete rule. |
| 10 | Audit logging system | The hybrid design (one global interceptor + explicit calls for auth events), the `performedBy NOT NULL` constraint's real limitation, fire-and-forget writes. |
| 11 | Medical files module | Append-only by design (no update/delete), auditing reads (not just writes) for clinical records, a duplicate-logging bug caught before shipping. |
| 12 | Password reset & MFA | Token design (random + SHA-256, not bcrypt), why MFA forced `LocalStrategy` to be retired, `otplib`'s live API rewrite. |
| 13 | tsconfig, types, and test generation | The `types` array regression and its durable fix, delegating full unit/e2e coverage to Claude Code, and the infra bugs that surfaced running it. |
| 14 | Codebase review: nine improvements | `SESSION_SECRET` fail-loud validation, FK indexes, Swagger docs, a Drizzle health indicator, pagination. |
| 15 | Closing the review: five improvements | Multi-origin CORS (and *why* it's structurally required once `credentials: true`), a full DTO length-cap sweep, `avatarPath` lockdown, an independent `StorageService` size guard, tunable connection pools. |
| 16 | Docker deployment foundations | The multi-stage `Dockerfile`, three chained build bugs (`rootDir`, stale `.tsbuildinfo`, a missing prod dependency), and prod-only cookie/proxy config. |
| 17 | Real email and MFA encryption | Swapping the console-log `EmailService` for Resend (and the never-throw quirk that protects no-enumeration), AES-256-GCM for `mfaSecret` at rest. |
| 18 | Deployment: provisioning through backups | The Droplet, the Cloudflare/domain architecture, Docker's first real production run, and a backup verified by an actual restore with row counts. |
| 19 | Deployment verification and observability | The Cloudflare-firewall/`tcpdump` diagnostic chain, the `X-Forwarded-For` vs. `CF-Connecting-IP` bug, a WebSocket smoke test, and settling on Better Stack + Vector. |
| 20 | Two bug hunts | A documentation task that surfaced four real bugs (unscoped `GET /users/:id`, an unenforced admin-archive comment, a missing WS auth check, a WS auth race), then a deliberate five-category hunt that found a cross-clinic leak and a `reorderExercises` flaw copy-pasted three times. |
| 21 | Type-safety hardening | Four passes tracing ~200 lint findings back to `any` at its root (`@CurrentUser()`, `SessionData`, a shared `AuthenticatedRequest`, enum typing) — plus one deliberate non-fix. |
| 22 | Scoped bug hunt and verification loop | A five-category hunt built from the prior two hunts' own track record; a real PII-leak fix in `toPublic()`, an admin-bypass gap on `sendMessage`/`markAsRead`, and the investigate-then-fix-then-reverify loop as an explicit process. |
| 23 | Row-Level Security, step zero | Why RLS had done nothing until now (superuser bypass), the restricted `stride_app` role, and the narrow connection split that makes real policies possible. |
| 24 | Row-Level Security rollout | The six/eight-table rollout, the `withRlsContext` pattern, what genuinely differed per table, and a real migration-bookkeeping incident caught before it could reach production. |
| 25 | Closing the log-rotation gap | A `PROJECT.md` claim checked against real git history and found never actually implemented (not a regression) — the fix, its verification via `docker compose config`, and a secrets-in-transcript exposure caught and rotated along the way. |
| 26 | Redeploying for real | A full Droplet destroy-and-recreate, executed to actually validate `DEPLOYMENT.md` rather than trust it — a genuine RLS-rollout scope gap in the seed script, a second `ts-node`/`tsc` ambient-declaration gap, a stale-image documentation bug, a recurring local-vs-Droplet environment confusion, and several real-but-not-buggy operational characteristics, all found by actually running the pipeline end to end. |
| 27 | Message normalization & an API docs accuracy pass | A real API contract fix (error `message` is now always an array, in both exception filters) — and a documentation review that found the RLS rollout had silently changed `403` to `404` on four resources, confirmed against a real passing test, with none of the API reference docs ever updated to match. |
| 28 | A flaky test, a timing side-channel, and a false claim | A one-line fix for a real flake (a live Resend round-trip in a test) led directly to measuring a genuine account-enumeration timing side-channel in `forgotPassword()`, a fire-and-forget fix for it, and — while confirming the fix's blast radius — discovering doc 17 describes a regression test that, per full git history, was never actually committed. *(Doc 17 is left unedited, per this project's established policy — this is where that gap is named.)* |
| 29 | Row-Level Security, `user_roles` | Pass 2 of the RLS roadmap: the roadmap's own proposed `SELECT` policy adversarially proven to break login for every non-admin account before being rejected in favor of `USING (true)`; a three-branch `INSERT` policy verified against all eight real allow/reject scenarios; a genuine RLS scope gap in `grantRole()` (no session context reached its own write) and a second, pre-existing, RLS-unrelated bug in the same method (a read-your-own-write race across two connections) both found and fixed. |

---

## Looking for a specific topic?

| Topic | Docs |
|---|---|
| Stack & technology rationale | 01, 04, 16 |
| Database schema & design patterns | 02, 23, 24 |
| Authentication (sessions, login, logout) | 03, 06, 12, 16, 21 |
| Authorization / RBAC / multi-role | 03, 05, 08, 20, 22, 29 |
| Row-Level Security | 23, 24, 26, 27, 28, 29 |
| Real-time messaging / WebSockets | 09, 19, 20, 21 |
| File & object storage | 04, 07 |
| Audit logging & compliance | 01, 02, 10, 11, 22, 24 |
| Clinical domain (programs, sessions, medical files) | 08, 11 |
| Email & MFA | 12, 17, 28 |
| Testing infrastructure | 06, 13, 17, 20, 21, 22, 28, 29 |
| TypeScript / type safety | 06, 08, 13, 21, 26 |
| Security bug hunts | 20, 21, 22, 28, 29 |
| Deployment & production infrastructure | 16, 18, 19, 25, 26 |
| Observability (monitoring, logging) | 19 |
| Process & discipline (verification, sync-checks) | 06, 09, 13, 14, 16, 17, 22, 24, 25, 26, 27, 28, 29 |

---

## Known open items

- Doc 02's "(planned)" phrasing for Row-Level Security likely still needs
  updating to reflect 23–24 — unconfirmed against the live file. (Doc 01's
  equivalent framing is **not** an open item — see the note at the top of
  this README: it's deliberately left as-written, by design, not an
  oversight.)
- RLS is **not** applied to the three profile tables or `user_clinics` —
  `user_clinics` is a deliberate, permanent exception (see doc 24); the
  profile tables are an open question for a future pass. `clinics` (doc 24's
  Pass 1, migration `0008`) and `user_roles` (doc 29's Pass 2, migration
  `0009`) are both done.
- `deferred-improvements.md` (referenced in doc 22) is the terse, changelog-style
  companion to this narrative series, if one exists in the repo.
- Doc 25's log-rotation fix was confirmed working locally but explicitly
  left as "not yet live" pending a real container recreation on the
  Droplet. Doc 26's full redeploy almost certainly picked it up (fresh
  containers get `logging:` config at creation, no extra step needed) —
  but that's an inference, not something either confirmed directly (e.g.
  via `docker inspect` on the running container). Worth a real check
  before treating it as closed.
- Two real, verified pieces of work from this exercise are now written up
  as doc 27: normalizing error `message` to always be an array (both
  exception filters, a real commit, a full passing test-suite re-run), and
  a full accuracy review of the `docs/api/` reference against the RLS
  rollout (docs 01, 02, 04 there needed real fixes — a confirmed `403`→`404`
  change on four resources the original docs never caught). One thing doc
  27 leaves open: the five API docs' "Verified against commit" headers
  still need bumping to the real current commit — flagged there, not yet
  confirmed done.
