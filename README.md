# Stride — backend

A physiotherapy practice-management system: admins run the practice's
clinics and accounts, practitioners build exercise programs and assign them
to their patients, patients complete them session by session and message
their practitioners in real time. This repository is the backend — a NestJS
API over PostgreSQL, with object storage, email and a WebSocket gateway —
built with the discipline of the HIPAA Security Rule's technical safeguards
in mind. The frontend, a React single-page app, is its own repository,
`Stride-frontend` (TODO-LINK).

This is a bootcamp capstone, built specifically to demonstrate real
backend, frontend and infrastructure understanding rather than CRUD — which
pushed many choices toward the option that is more instructive and better
understood over the fastest path to a working demo. It doesn't claim HIPAA
compliance (that's a legal and organizational status, not a code property —
see [Production Readiness](#production-readiness--what-would-change-for-real-patients)
below). What it does claim is a demonstrated understanding of how
healthcare-adjacent software should actually be architected, and a
development process built around verifying claims against real evidence
rather than assuming they hold.

**Status.** The backend's first era (journal entries 01–35) was deployed to
a real production environment, with monitoring and a backup verified by an
actual restore, and that deployment was then destroyed and rebuilt from its
own runbook. Everything built since, together with the frontend, hasn't been
deployed yet: the deployment guide for it is written and partly
sandbox-checked, and says plainly which steps haven't run on a server.
The reviewers' demo will live at `https://stridecare.app` (TODO-LINK).

## Key Features

- **The care team is the trust boundary.** Sharing a clinic with a patient
  gives a practitioner *directory* access — name, date of birth, photo, who
  treats them. *Clinical* access (programs, sessions, the medical file,
  range of motion, messages) needs a current care-team link *and* a shared
  clinic. Joining a care team is self-service, audited, and shown to the
  patient and to the rest of the team; links are ended, never deleted.
- **Multi-role accounts** — one account can hold several roles (admin,
  practitioner, patient), with exactly one *active* role per session,
  switchable without a full logout.
- **Two independent layers of access control** — NestJS guards and
  service-level checks in the application layer, *plus* database-enforced
  Row-Level Security forced on **all 42 tables**, for a connection running
  as a genuinely restricted, non-superuser Postgres role. Neither layer is a
  substitute for the other — and "every table covered" isn't the same claim
  as "every table restricts reads": a few identity and library tables carry
  a deliberate, documented `USING (true)` read policy, where a restrictive
  one would break sign-in itself or add nothing over data that is shared by
  design.
- **The full prescribe → perform loop** — practitioners build exercise
  programs from a shared library of 873 exercises or their own, and assign
  them as an independent, permanent copy (editing the template later never
  changes what a patient was actually told to do). Schedules are kept as
  versioned history, and the sessions due are *calculated*, never
  pre-created, by one pure module every screen asks. A session is a state
  machine the database itself enforces.
- **Accounts by invitation only** — no public sign-up. An admin or a
  practitioner creates the account, and a one-time, 7-day invitation lets
  its owner choose a password; nobody ever sets someone else's.
- **Real-time messaging** — patient–practitioner chat over Socket.IO,
  authenticated with the same session cookie as the REST API. History stays
  readable after a care-team link ends; sending stops, decided by the
  database at the moment of writing. A deliberately narrow deletion window
  (unread *and* within 15 minutes — clinical communication shouldn't
  quietly disappear once acted on).
- **An append-only clinical record and an audit trail built into every
  write** — SOAP notes and range-of-motion assessments are corrected by
  amendment, never edited or deleted. Every change writes one complete
  audit entry in its own transaction, and every clinical read by someone
  other than the patient is logged before the answer is sent.
- **Record access with a purpose, instead of an admin back door** — admins
  run the organization but read no clinical row. A *complaint review* or a
  *legal disclosure* reads a patient's record as the patient, for a stated
  reason, with a stamped PDF copy, and tells the care team. Patients can
  download their own full record as a PDF.
- **Account security, done properly** — TOTP two-factor with encrypted
  secrets and hashed recovery codes, re-confirmation before every sensitive
  change, single-use hashed tokens for every emailed link, no user
  enumeration (by answer *or* by timing), and every affected session — and
  its open sockets — ended on a password change, a reset or a deactivation.
- **Duplicate patients caught and merged** — a warning at creation, and a
  one-transaction merge behind five locks against misuse.
- **Observability that names no patient** — structured logs with a request
  id shown to the user as a reference, and self-hosted error tracking
  (GlitchTip), both built from allow-lists so nothing that leaves the server
  names or locates a patient.
- **A reviewers' demo mode** — four published accounts on the sign-in page,
  locked against changes that would spoil them for the next reviewer, and a
  nightly reset.

## Tech Stack & Architecture

| Layer | Choice |
|---|---|
| Backend | NestJS 11 (TypeScript) on Express |
| Database | PostgreSQL 16 + Drizzle ORM, Row-Level Security on every table, triggers and constraints for the rules a CHECK can't hold |
| Auth | Passport.js, `httpOnly` session cookies stored in Postgres (not JWT); TOTP two-factor with `otplib` |
| Real-time | Socket.IO, reusing the same session auth as REST |
| Object storage | RustFS (S3-compatible, self-hosted) via `@aws-sdk/client-s3`; PDFs drawn with `pdfkit` |
| Email | Resend in production, SMTP to Mailpit in development |
| Observability | pino JSON logs shipped to Better Stack; `@sentry/nestjs` reporting to a self-hosted GlitchTip |
| Infra | Docker Compose on a DigitalOcean Droplet, Caddy (auto-HTTPS), Cloudflare in front |
| Testing | Jest — unit tests, and an API end-to-end suite against a real Postgres (114 unit files / 2,593 tests, 50 e2e files / 1,346 tests, 2026-11-03); the frontend's Playwright suite drives this API too |

Every one of these was a deliberate choice, not a default — including one
mid-project reversal (object storage was originally MinIO, migrated to
RustFS after MinIO's open-source edition was discontinued) and one honest
correction of an early architectural overclaim (Row-Level Security was
originally described as active before it actually was — see the journal's
entries 01 and 23 for the full story). The system as it stands *today* is
described in [**`ARCHITECTURE.md`**](./docs/ARCHITECTURE.md), and the
reasoning behind each choice in [`PROJECT.md`](./docs/PROJECT.md) — this
README stays high-level on purpose.

## Documentation & links

This project has more documentation than a capstone strictly requires,
because the documentation itself — the decisions, the real bugs found by
actually running things, and the corrections made when something turned
out wrong — is as much a part of what this project demonstrates as the
code is.

| Document | What it's for |
|---|---|
| [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | The system **as it currently stands** — components, data model, who may do what and how it's enforced, the audit trail, deployment topology, security posture. Living, not historical. |
| [`PROJECT.md`](./docs/PROJECT.md) | The decisions and their reasons, by topic — the alternatives weighed and what each choice costs, ending with what's deliberately deferred. |
| [`docs/api/README.md`](./docs/api/README.md) | The integration reference for anyone building a client — sessions and cookies, the WebSocket API, response conventions, the authorization model, a copy-pasteable walkthrough, and an endpoint index generated from the code. Complements the interactive OpenAPI docs at `/api-docs`. |
| [`TESTING.md`](./docs/TESTING.md) | The test suites: how to run them, what each proves, the techniques (race tests, mutation testing), and what they don't cover. |
| [`DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Local development, then the production runbook phase by phase — each step with how to verify it — the reviewers' demo, and every environment variable. |
| [`docs/journal/README.md`](./docs/journal/README.md) | An index into a 42-entry chronological log of the real decisions, tradeoffs and bugs — with a "Start here" path of six entries, and the list of what's still open. |
| [`demo-accounts.md`](./docs/demo-accounts.md) | The seeded accounts, their password, and what each one shows. |
| The frontend repository (TODO-LINK) | The other half: its own README, architecture, decisions, tests, deployment guide and journal. |
| The design-decisions log (TODO-LINK) | `docs/stride-design-decisions.md` in the frontend repository — where every feature was designed, one section per item. The code's comments cite it as "decisions §N". |

## Getting Started

**Prerequisites:** Node.js 24, Docker with Compose. Full instructions — and
why each step exists — are in [`DEPLOYMENT.md`, Part 1](./docs/DEPLOYMENT.md#part-1--local-development).
The short version, for local development:

```bash
git clone TODO-LINK stride-backend && cd stride-backend
npm ci
docker compose up -d          # Postgres, RustFS (S3 storage) and Mailpit (catches every email)
cp .env.example .env          # then set SESSION_SECRET, MFA_ENCRYPTION_KEY, POSTGRES_APP_PASSWORD
npx drizzle-kit migrate       # as the database's owner
npm run db:create-app-role    # the restricted role the app connects as
npm run seed                  # the exercise library (needs internet), then the demo accounts
npm run start:dev             # http://localhost:3000
```

The three secrets are generated with `openssl rand -hex 32` (the first two)
and `openssl rand -hex 24`; the app refuses to start with a placeholder.
`GET /health` and `/api-docs` are good first checks once it's running; the
accounts to sign in with, all with the password `password123`, are in
[`demo-accounts.md`](./docs/demo-accounts.md), and Mailpit's inbox is at
http://localhost:8025. The tests: `npm test` (unit) and `npm run test:e2e`
(see [`TESTING.md`](./docs/TESTING.md) for what the e2e suite needs).

For the screens, the frontend runs against this API on
`http://localhost:5173` — its own README says how.

## Project Structure

```
src/
  auth/  mfa/  invitations/  password-change/  email-change/   # signing in, and the account's own security
  users/  clinics/  care-team/  patient-merges/                 # identity, roles, clinics, who treats whom
  exercises/  programs/  assigned-programs/  sessions/          # the library, templates, the prescribe → perform loop
  medical-files/  range-of-motion/  alerts/                     # the clinical record, and the practitioner's "For review"
  messaging/                                                    # REST + WebSocket chat, one shared service
  records-export/  complaint-reviews/  legal-disclosures/       # records leaving Stride, each with its trace
  audit/  admin-metrics/                                        # the audit trail and the admin's home
  database/                                                     # Drizzle schema, row-security context, migrations
  storage/  email/  observability/  health/  demo/              # the platform: files, mail, logs and reports
  config/  common/                                              # validated settings, guards, filters, shared DTOs
scripts/      # operational scripts: seeding, the app's role, backups, the storage sweeper, the endpoint index
test/         # API end-to-end specs, against a real Postgres and storage
docs/
  api/        # the integration reference
  journal/    # the chronological decision log
```

The frontend's feature folders mirror these module names, so a screen's
code sits under the same name as the routes it calls.

## Technical Highlights

A few decisions worth calling out specifically, for anyone skimming:

- **RLS as genuine defense-in-depth, not a demo of the feature.** The
  database connection the app itself uses (`stride_app`) was deliberately
  built to have *zero* RLS bypass — not a superuser, and owning none of the
  tables it queries — specifically so a bug in the application layer can't
  silently become a real data leak. Rolled out table by table — a first
  rollout, then four passes for the identity tables — each one
  adversarially verified (a legitimate query still succeeds, an
  illegitimate one genuinely fails) rather than assumed correct from the
  policy's SQL alone; every table added since has its own. The hardest pass — `user_clinics`, the schema's own
  trust-anchor table — was expected to need a `SECURITY DEFINER` function;
  live investigation found a different, more load-bearing reason `SELECT`
  had to stay permissive, making that added complexity unnecessary. And for
  the central rule, the care team, a **parity test** runs the same cases
  through the TypeScript and the SQL and requires the same answers.
- **The database states the rules too.** One CHECK per rule (so a refusal
  names the rule it broke), partial unique indexes and exclusion
  constraints for every "at most one" — the constraint decides a race and
  the service only translates the refusal — and 29 triggers for what a
  CHECK can't see, such as "a finished session is final" or "a closed
  program is read-only". A direct query, a script or a route added later
  meets the same rules.
- **Races proven, not hoped for.** Tests hold a conflicting write open on a
  second connection while the request is sent, so "two tabs can't both
  spend this token" is something a test watched fail before the fix.
- **Copy-not-reference for anything a patient was actually told to do.** An
  assigned program is an independent copy of its template, and each
  session keeps its own copy of what it prescribed — editing either later
  never rewrites a patient's actual history. The same principle governs why
  medical records are append-only and why the audit log is insert-only:
  clinical history doesn't get to quietly change after the fact.
- **An audit trail the build enforces.** The first design — a global
  interceptor writing after the response, fire-and-forget — was deleted.
  Each change now writes its entry in its own transaction (if one fails,
  both roll back), and a test fails the build for any write route that
  declares neither how it's audited nor why it isn't.
- **A session-scoped active role**, the same pattern AWS IAM uses for role
  assumption — one account, several possible roles, exactly one active per
  session, switchable without a full re-authentication.
- **Rules checked against the code by tests, documentation included.** The
  endpoint index in the API reference is generated from the controllers,
  and a unit test fails when the two differ. After each pass, deliberate
  bugs were put into the new code to prove the tests fail (mutation
  testing, by hand).
- **Every production-infrastructure claim was exercised, not just
  configured** — for the deployment that ran. Backups were verified by an
  actual restore with real row counts checked, and the runbook was run end
  to end against a genuinely destroyed-and-recreated Droplet, which is how
  several of the real bugs below were found. The current guide applies the
  same standard: each step comes with how to verify it, and the steps that
  haven't run on a server yet are named as such.

## Lessons Learned

The chronological journal ([`docs/journal/`](./docs/journal/README.md)) is
the full version of this; a few of the more instructive moments:

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
  issues no amount of re-reading the diffs would have caught. Rewriting the
  documentation against the code did the same, late in the project: a
  sign-in timing side channel (an unknown address answered in 6 ms, a wrong
  password in 75), and every photo URL signed for an address only Docker
  could resolve.
- **Read the old code before building on it.** Before the frontend's
  messaging screens were built, reading the existing messaging code found
  nine gaps — a former care-team member able to write forever, deleted
  text served back, admins reading everything. The same reading of
  two-factor sign-in found a set-up that replaced a working secret and
  codes that could be replayed. None had a failing test, because nothing
  had asked the question.
- **A preference written as a server rule binds every client for ever.**
  "Do the on-time catch-up before a late make-up" was first enforced by the
  API; it would have made a later screen refuse the late one. It became
  the home screen's ordering instead. Rules about what *may* happen belong
  to the server; which option is offered first belongs to a screen.
- **"Verify, don't assume" is a discipline, not a one-time lesson.** It
  shows up dozens of times across this project's development — checking a
  claimed fix against the actual file, checking a database claim against
  real `SELECT` output, checking a backup against an actual restore — and
  it kept catching real problems just as late into the project as it did
  at the start.

## Future Improvements

What's next, by area. The frontend's README lists the items that sit mostly
there (TODO-LINK); [`PROJECT.md`'s "Known limits"](./docs/PROJECT.md#known-limits-and-whats-deferred)
gives each postponed item its reason.

**Security and data integrity**

- **Requiring two-factor sign-in for admins** is the one that matters:
  admins hold the most power. It changes the sign-in flow (and the demo
  reviewers' with it), which is why it's optional today.
- **Audit-log retention: a purge job.** The 6-year policy is decided; the
  job isn't built, since nothing can be that old yet.
- **Cacheable photo URLs everywhere.** Signed photo URLs change on every
  response, so the browser can't cache them and downloads them again after
  every refetch. The exercise library's photos already sign with a time
  rounded to the hour; extending that to avatars, clinic logos and program
  photos would fix it, at the cost of a slightly longer URL lifetime.

**Legal disclosures**

- **A lost download can't be fetched again**: today the admin has to record
  a second disclosure. The real question is whether a later copy, made from
  a record that has since changed, counts as "the one that left".
- **Ending or extending a hold early.** An agency that lifts or extends its
  request can't be followed today; it needs an audited correction row.
- **The 30-day limit of a hold asked for by phone or in person** isn't
  modelled; only written statements are recorded.
- **The recipient's address** isn't recorded; HIPAA's accounting asks for
  it "if known".

**Clinical features**

- **Medical file templates** — practitioners defining their own note shapes
  (a sports-injury intake, say) beside the built-in SOAP note.
- **Referring a patient to another clinic.** Sending a record to another
  organization needs the patient's consent and a referral record: a real
  workflow Stride lacks.
- **A patient removing a practitioner from their care team.** It's a
  privacy right; it needs a design, since a practitioner can rejoin today.
- **Schedules**: removing a planned change directly; a practitioner-set
  number of sessions per day, or several workouts on one day; a minimum
  rest between sessions; recording a session on an earlier day.
- **Closing abandoned sessions on a timer.** It needs a "system" actor for
  the audit entry, and a scheduler.
- **Other ways for patients to get an account** — a clinic join code, a
  patient's request to join, or booking.
- **A practitioner's own to-do list** beside the computed "For review"
  alerts (a new table).
- **Admin cross-clinic oversight dashboards**, once what they may show is
  defined (admins read no clinical row).
- **A multi-tenant version** — see [the note below](#a-note-on-multi-tenancy):
  not a feature but a different security bar.

**Health-record PDF**

- **Colour emoji, other writing systems and a tagged PDF.** Emoji print in
  black and white today, and Chinese, Japanese, Korean and right-to-left
  scripts as empty boxes. A tagged PDF would let screen-reader users
  navigate their record.

**Performance and infrastructure**

- **More than one API instance.** Rate-limit counters and Socket.IO's rooms
  live in one process's memory — correct today specifically because there
  is one. Several instances would need Redis for both (Socket.IO's Redis
  adapter), and sticky sessions; today a message never crosses between
  instances.
- **Other deployment paths in `DEPLOYMENT.md`.** This deployment path (a
  self-managed Droplet, Docker Compose, and Caddy) was chosen deliberately,
  as a learning exercise in owning the full stack — provisioning, TLS,
  process management, backups, all of it, rather than abstracting them
  away. A PaaS-based alternative (Railway, Fly.io, Render) would trade that
  hands-on control for meaningfully less operational burden, and would be a
  reasonable, worthwhile pipeline to document for anyone who wants the
  convenience over the learning experience. Not written up here because it
  wasn't the point of this particular exercise, not because it wouldn't
  work.

**Avatar uploads**

- **Server-side image processing**: resizing with `sharp` (which also
  strips GPS data from a photo), a pixel limit, and HEIC support.

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
  replacing with one that offers one. That chain is the host
  (DigitalOcean); Cloudflare, which terminates TLS at its edge and so sees
  every request in the clear, PHI included; and email delivery (currently
  Resend), whose BAA support hasn't been verified either way for this
  project and would need to be before real PHI touched it. Better Stack,
  which receives the logs, says on its own security page that it isn't
  HIPAA compliant — which is exactly why logs and error reports are built
  from allow-lists that never name or locate a patient. That rule would
  need an independent review rather than this project's own word.
  GlitchTip is self-hosted on the same Droplet, so error reports reach no
  third party.
- **Secrets that are currently plain environment variables** — the MFA
  encryption key, most notably, and the session secret — would move to a
  real secrets manager or KMS (AWS KMS, HashiCorp Vault), held separately
  from both the database and the application server, closing the "full
  server compromise" gap that's an explicitly accepted limitation today.
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

## A note on multi-tenancy

This system is deliberately single-tenant — one practice per deployment.
Its clinics are the practice's locations, not separate tenants: admins are
practice-wide, and clinic membership shapes who appears in a practitioner's
directory and who may join a patient's care team, rather than isolating one
organization's data from another's. That was a considered decision, not a
default (see the journal's
[entry 05](./docs/journal/05-multi-role-authorization-and-clinics.md) on the
clinic-bootstrap problem, and ARCHITECTURE's
[§13](./docs/ARCHITECTURE.md#13-deliberate-limits)). Going multi-tenant —
supporting multiple independent clinic organizations with real data
isolation from each other — would not be a configuration change. It would
mean revisiting nearly every access-control decision in this project: every
query scoped by organization, forever, correctly, with no exceptions — in
the services *and* in every row-security policy — which is a categorically
stricter security bar than the one this system was actually built to meet.
Worth stating plainly as a real architectural boundary, the same way
Production Readiness states the HIPAA-compliance boundary above — not a
gap, a deliberate line.

## License

Licensed under the Apache License, Version 2.0 — see [`LICENSE`](./LICENSE)
and [`NOTICE`](./NOTICE). Copyright 2026 Julien Javelaud.
