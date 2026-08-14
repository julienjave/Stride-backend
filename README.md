# Stride

A physiotherapy practice-management backend — practitioners prescribe
exercise programs, patients complete and report on them, and both message
each other in real time — built with the discipline of the HIPAA Security
Rule's technical safeguards in mind, deployed to a real production
environment with monitoring and tested backups.

This is a capstone project. It doesn't claim full HIPAA compliance (that's
a legal/organizational status, not a code property — see
[Production Readiness](#production-readiness--what-would-change-for-real-patients)
below) — what it does claim is a demonstrated understanding of how
healthcare-adjacent software should actually be architected, and a
development process built around verifying claims against real evidence
rather than assuming they hold.

## Key Features

- **Multi-role authorization** — a single account can hold more than one
  role (admin, practitioner, patient), with one *active* role per session,
  switchable without a full logout. Every practitioner action is
  clinic-scoped: you only ever manage patients who share a real clinic
  membership with you.
- **Two independent layers of access control** — NestJS guards and
  service-level ownership checks in the application layer, *plus*
  database-enforced Row-Level Security on the six highest-stakes clinical
  tables, running as a genuinely restricted, non-superuser Postgres role.
  Neither layer is a substitute for the other.
- **The full prescribe → perform loop** — practitioners build exercise
  programs (from a shared library or their own custom entries), assign
  them to patients as an independent, permanent copy (editing the source
  template later never changes what a patient was actually told to do),
  and patients work through them session by session with per-exercise
  completion, timing, and feedback.
- **Real-time messaging** — practitioner–patient chat over WebSocket,
  authenticated with the same session cookie as the REST API, with
  per-participant conversation archiving and a deliberately narrow
  message-deletion window (unread *and* within 15 minutes — clinical
  communication shouldn't quietly disappear once acted on).
- **Append-only medical records and an immutable audit trail** — clinical
  chart entries are never edited or deleted, only added to; every
  mutation, and every *read* of a medical record, is logged.
- **MFA and password reset**, done properly — TOTP with encrypted secrets
  at rest, cryptographically random single-use reset tokens, no user
  enumeration, every session destroyed on a successful reset.
- **A real, tested production deployment** — DigitalOcean + Cloudflare +
  Caddy, with automated backups verified by actually restoring them, and
  uptime/log monitoring, not just configured and assumed to work.

## Tech Stack & Architecture

| Layer | Choice |
|---|---|
| Backend | NestJS (TypeScript) |
| Database | PostgreSQL 16 + Drizzle ORM, with Row-Level Security |
| Auth | Passport.js, `httpOnly` session cookies (not JWT) |
| Real-time | Socket.IO, reusing the same session auth as REST |
| Object storage | RustFS (S3-compatible, self-hosted) via `@aws-sdk/client-s3` |
| Email | Resend |
| Infra | Docker Compose, Caddy (auto-HTTPS), Cloudflare |
| Testing | Jest — unit + a real, running-stack e2e suite (165 unit / 97 e2e tests as of this writing) |

Every one of these was a deliberate choice, not a default — including one
mid-project reversal (the object storage backend was originally MinIO,
migrated to RustFS after MinIO's open-source edition was discontinued) and
one honest correction of an early architectural overclaim (Row-Level
Security was originally described as active before it actually was — see
the journal's entries 01 and 23 for the full story). The full reasoning
behind every choice lives in [**`ARCHITECTURE.md`**](./docs/ARCHITECTURE.md),
which describes the system as it stands *today* — this README stays
high-level on purpose.

## Documentation

This project has more documentation than a capstone strictly requires,
because the documentation itself — the decisions, the real bugs found by
actually running things, and the corrections made when something turned
out wrong — is as much a part of what this project demonstrates as the
code is.

| Document | What it's for |
|---|---|
| [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | The system **as it currently stands** — components, data model, auth/authz model, deployment topology, security posture. Living, not historical. |
| [`DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | The full local-dev and production-deployment runbook, phase by phase, including the real failure modes hit while building it. |
| [`FRONTEND.md`](./docs/FRONTEND.md) | A planning brief for whoever builds the client — the hard constraints this backend imposes, not generic frontend advice. |
| [`docs/journal/00-README.md`](./docs/journal/README.md) | An index into a 26-entry chronological log of every real decision, tradeoff, and bug across this project's development — read start to finish for the full narrative, or by topic via the index. |
| [`docs/api/README.md`](./docs/api/README.md) | The integration reference for frontend/API consumers — session mechanics, the WebSocket API, response conventions, the full authorization model, and a real copy-pasteable walkthrough. Complements, never duplicates, the auto-generated OpenAPI docs at `/api-docs`. |
| [`PROJECT.md`](./docs/PROJECT.md) | A condensed, single-file summary of the same decisions the journal covers at length — the "just tell me the highlights" version. |

## Getting Started

Full instructions — local dev setup *and* a complete production deployment
runbook — live in [`DEPLOYMENT.md`](./docs/DEPLOYMENT.md). The short version,
for local development:

```bash
git clone <repo-url> stride-backend && cd stride-backend
npm ci
docker compose up -d                    # Postgres + object storage
cp .env.example .env                    # then fill in generated secrets — see DEPLOYMENT.md
npm run db:create-app-role              # must succeed before the app can connect at all
npx drizzle-kit migrate
npm run seed:exercises                  # optional — seeds ~870 exercises from a public dataset
npm run start:dev
```

`GET /health` and `/api-docs` are good first checks once it's running.
See [`DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for exactly why each step exists,
what to do if any of them fail, and the full production deployment phases.

## Project Structure

```
src/
  auth/               # sessions, login/MFA/password-reset, guards
  users/               clinics/            # identity, roles, clinic membership
  exercises/           programs/           # the shared library + practitioner-authored presets
  assigned-programs/   sessions/           # the actual prescribe → perform loop
  medical-files/                           # append-only clinical records
  messaging/                               # REST + WebSocket chat, one shared service
  audit/                                   # the immutable audit log + its interceptor
  storage/              email/             # RustFS and Resend, behind stable interfaces
  health/                                  # /health, for load balancers and monitoring
  database/                                # Drizzle schema, RLS context helper, migrations
  common/                                  # global filters, guards, DTO base classes, config
scripts/                                   # one-off operational scripts — seeding, role setup, backups
test/                                      # e2e specs, against a real running stack
docs/
  api/                                     # the frontend/consumer-facing API reference
  journal/                                 # the chronological decision log
```

Frontend feature folders (once built) are intended to mirror these backend
module boundaries closely — see [`FRONTEND.md`](./docs/FRONTEND.md).

## Technical Highlights

A few decisions worth calling out specifically, for anyone skimming:

- **RLS as genuine defense-in-depth, not a demo of the feature.** The
  database connection the app itself uses (`stride_app`) was deliberately
  built to have *zero* RLS bypass — not a superuser, and owning none of
  the tables it queries — specifically so a bug in the application layer
  can't silently become a real data leak. Rolled out table-by-table, each
  one adversarially verified (a legitimate query still succeeds, an
  illegitimate one genuinely fails) rather than assumed correct from the
  policy's SQL alone.
- **Copy-not-reference for anything a patient was actually told to do.**
  An assigned program is an independent copy of its source template at
  the moment of assignment — editing or deleting the template afterward
  never retroactively changes a patient's actual prescription. The same
  principle governs why medical records are append-only and why the audit
  log is insert-only: clinical history doesn't get to quietly change
  after the fact.
- **A session-scoped active role**, the same pattern AWS IAM uses for role
  assumption — one account, several possible roles, exactly one active per
  login, switchable without a full re-authentication.
- **A hybrid audit-logging design**: one global interceptor for the
  common case, with explicit calls for the cases that need real nuance
  (authentication events, and medical-record *reads*, not just writes).
- **Every real production-infrastructure claim in this repo has actually
  been exercised, not just configured.** Backups are verified by an
  actual restore with real row counts checked. The full deployment runbook
  has been run end-to-end against a genuinely fresh, destroyed-and-recreated
  Droplet — which is also how most of the real bugs listed below were
  actually found.

## Lessons Learned

The chronological journal (`docs/journal/`) is the full version of this;
a few of the more instructive moments:

- **A chosen dependency's stability can't be assumed, even mid-project.**
  MinIO's open-source edition was discontinued partway through this
  project's development, discovered while researching an unrelated
  licensing question — leading to a full storage-backend migration,
  addressed immediately rather than deferred.
- **An architectural claim can be wrong even when written in good faith.**
  The original architecture writeup described Row-Level Security as
  already active; it wasn't, for most of the project's life. The fix
  wasn't to quietly edit the record — it was to name the gap plainly in a
  later entry once it was actually closed.
- **The most valuable bugs were found by actually running things, not by
  reviewing code.** A full, real, end-to-end redeployment — done
  specifically to validate the deployment documentation itself — surfaced
  a genuine scope gap in the RLS rollout (an operational script silently
  blocked by a security policy nothing had tested it against), a stale
  Docker image masking an already-applied fix, and several other real
  issues no amount of re-reading the diffs would have caught.
- **"Verify, don't assume" is a discipline, not a one-time lesson.** It
  shows up dozens of times across this project's development — checking a
  claimed fix against the actual file, checking a database claim against
  real `SELECT` output, checking a backup against an actual restore — and
  it kept catching real problems just as late into the project as it did
  at the start.

## Future Improvements

- Row-Level Security currently covers six of the schema's tables
  (`medical_files`, `audit_logs`, `assigned_programs`, `sessions`,
  `conversations`+`messages`, and `users`) — `user_roles`, the profile
  tables, and `clinics`/`user_clinics` remain open questions for a future
  pass, not oversights (`user_clinics` in particular is a deliberate,
  permanent exception, since every other policy depends on it).
- Redis-backed rate limiting, if this ever runs as more than one instance
  — correct as in-memory today specifically because it doesn't.
- The frontend itself — see [`FRONTEND.md`](./docs/FRONTEND.md) for the full
  plan.
- A `deferred-improvements.md` running ledger (referenced in the journal)
  tracks smaller open items in changelog form, for anyone who wants that
  version instead of the narrative one.

## Production Readiness — what would change for real patients

This system is built to follow the HIPAA Security Rule's *technical*
safeguards as a demonstration of understanding, not as a claim of legal
compliance — that's a genuinely different status, and conflating the two
would be dishonest about what this project actually is. Compliance
requires signed Business Associate Agreements with every vendor handling
real PHI, a documented risk assessment, and organizational policies — none
of which are code changes. What would actually need to happen before this
system could hold real patient data:

- **Object storage would move off self-hosted RustFS** to a BAA-capable
  provider (Backblaze B2 and AWS S3 were both evaluated for exactly this
  reason during the original architecture decisions). Because the storage
  layer was built against the standard S3 API from the start, this is a
  configuration change — an endpoint and credentials — not a rewrite.
- **Every third-party vendor in the real chain needs a BAA**, or needs
  replacing with one that offers one — this includes confirming email
  delivery (currently Resend) actually supports one, which hasn't been
  verified either way for this project and would need to be before real
  PHI touched it.
- **Secrets that are currently plain environment variables** — the MFA
  encryption key, most notably — would move to a real secrets manager or
  KMS (AWS KMS, HashiCorp Vault), held separately from both the database
  and the application server, closing the "full server compromise" gap
  that's an explicitly accepted limitation today.
- **Backup storage would move off the same physical host as the primary
  database** — today's backup strategy is genuinely tested (a real,
  verified restore), but it protects against application-level mistakes,
  not a whole-machine failure, since both currently live on the same
  Droplet.
- **A formal risk assessment and documented organizational access
  policies** — who can access what, under what circumstances, reviewed on
  what cadence — none of which is a line of code, all of which real
  compliance actually depends on.
- **Single-tenancy would need revisiting** if this ever served more than
  one independent clinic organization needing real data isolation from
  each other, rather than one practice's patients commonly seeing more
  than one provider at the same practice (today's actual, deliberately
  scoped use case).

None of this is a hidden gap — it's the explicit, stated line this project
draws between "built with the right instincts" and "certified for the
real thing," and it's drawn the same way throughout: state the tradeoff
plainly, don't imply a guarantee that isn't actually true.

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE). Copyright 2026 Julien
Javelaud.
