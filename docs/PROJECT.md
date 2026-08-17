# Stride — Project Decisions & Rationale

A comprehensive reference for every major choice made across this project's
design, build, and deployment — what was decided and why. Written to stand
alone: useful for picking up work in a new conversation, or for explaining
the project to someone who wasn't there for any of it.

## Project shape

Stride is a multi-role physiotherapy practice management backend —
admins run clinics, practitioners build exercise programs and assign them
to patients, patients complete sessions and message their practitioner.
Built as a capstone specifically to demonstrate real backend engineering
and infrastructure understanding, not just CRUD — which shaped several
choices below toward "the more instructive, more genuinely understood
option" over "the fastest path to a working demo."

---

## Technology stack

**NestJS (TypeScript)** — chosen over a lighter framework (Express alone,
Fastify) specifically for its structure: dependency injection, guards,
interceptors, and decorators give a capstone real, demonstrable
architecture (module boundaries, testable services) rather than a pile of
route handlers.

**PostgreSQL + Drizzle ORM** — Drizzle chosen for staying close to real
SQL (migrations are genuine SQL files, not a black-box abstraction),
useful for a project meant to demonstrate understanding rather than hide
it behind heavy tooling.

**Session-cookie authentication (Passport), not JWT** — a deliberate,
non-default choice. Sessions store only `{ id, activeRole }`; the full
user is reloaded via `deserializeUser` on every request, meaning a
role change or account deactivation takes effect immediately, not only
after a token expires. Traded away JWT's "no server-side session store"
convenience for this correctness property, and accepted the real
downstream complexity it created at deployment (cross-site cookies needing
`secure: true` + `sameSite: 'none'`, CORS with `credentials: true`).

**RustFS (self-hosted, S3-compatible object storage)** — chosen over a
managed object storage service to keep the whole stack self-hosted and
inspectable, consistent with the project's infrastructure-first goal.

**bcrypt** for password hashing; **AES-256-GCM** (Node's built-in
`crypto`, no new dependency) for encrypting MFA secrets at rest —
deliberately *not* the same treatment as passwords, since a TOTP secret
must remain genuinely readable to verify codes, unlike a password hash.
The real, explicitly documented limitation: this protects against
database-only compromise, not full server compromise, since the
decryption key lives in the same environment. A real production system
handling real patient data would use a genuine KMS with the key in
separate infrastructure — accepted as a deliberate scope decision here,
not a gap glossed over.

**Resend** for transactional email — chosen for its generous free tier and
zero-setup sandbox mode during development, later given a real verified
sending subdomain (`send.notify.stridecare.app`, apex domain
deliberately protected from the sending subdomain's reputation) once a
real domain existed. Email send failures are caught and logged, never
thrown — a failure and a nonexistent recipient must be indistinguishable
to the API caller, preserving the no-enumeration guarantee on
`forgot-password`.

**Socket.IO** for real-time messaging, layered over the same session-cookie
auth as REST (via a custom `SessionIoAdapter`) — deliberately not a
separate token-based auth scheme for WebSockets, keeping one authorization
model for the whole app rather than two to maintain and keep in sync.

**pino / nestjs-pino** for structured JSON logging, **@nestjs/throttler**
for rate limiting, **@nestjs/terminus** for health checks,
**class-validator/class-transformer** for DTO validation, **@nestjs/swagger**
for auto-generated interactive API docs.

---

## Application architecture & domain design

**Clinic-scoped authorization is the core trust boundary of the entire
app.** A practitioner can only act on a patient they genuinely share a
clinic with — enforced via one canonical check
(`UsersService.isPatientManagedBy`), reused everywhere a
practitioner-patient relationship needs verifying (user profiles,
assigned programs, sessions, medical files, messaging), rather than
reimplemented per-module. When this check was ever bypassed or
insufficiently applied, it produced the most serious bugs found in the
whole project (cross-clinic patient planting via `POST /users`, missing
scoping on `GET /users/:id`) — reinforcing why having one shared,
correctly-tested implementation matters more than convenience.

**Row-Level Security as a second, database-enforced authorization layer**
— added after the app-layer model above had already been running in
production. The app's own runtime queries connect as `stride_app`, a
Postgres role created specifically to have no RLS bypass: not a superuser,
and owning none of the tables it queries (both are independent, absolute
Postgres exemptions from RLS otherwise). `FORCE`d RLS policies now cover
**all 18 tables in the schema** — the original six-group rollout
(`medical_files`, `audit_logs`,
`assigned_programs`+`assigned_program_exercises`,
`sessions`+`session_exercises`, `conversations`+`messages`,
`exercises`+`program_templates`+`template_exercises`, and `users`), plus
four further passes that closed every table originally left open:
`clinics`, `user_roles`, the three profile tables
(`practitioner_profiles`/`patient_profiles`/`admin_profiles`), and
`user_clinics` — the schema's own trust-anchor table, at one point
expected to remain a permanent exception.

Worth being precise: full coverage doesn't mean every table restricts who
can read it. Several tables (`users`, `user_roles`, the three profile
tables, `clinics`, `user_clinics`, `exercises`, `program_templates`)
carry a deliberately permissive `SELECT USING (true)` policy — either
because the data is genuinely shared and non-sensitive by design, or
because the table backs a read that has to succeed *before* any session
exists (login itself, or a one-time unauthenticated bootstrap), where a
restrictive policy would silently break authentication rather than add
protection. Real, per-row restriction is concentrated on the tables where
it actually matters, and every table's write policies (`INSERT`/
`UPDATE`/`DELETE`) are genuinely restrictive throughout, `user_clinics`
included — a practitioner may only insert a membership row into a clinic
they themselves already belong to, mirroring a real vulnerability closed
once already at the application layer.

`user_clinics` specifically is worth naming directly, since the original
plan for it didn't survive investigation: it was expected to need a
`SECURITY DEFINER` function so other tables' policy-internal SQL
functions could keep working once it carried its own restriction. That
turned out not to be the real obstacle — the actual blocker was a
completely different, TypeScript-side contextless read
(`getClinicIdsForUser()`, underlying `isPatientManagedBy()`, the
authorization gate for most of the app) that needed `SELECT USING (true)`
regardless of any privilege question, the same reason `users` and
`user_roles` already needed it. Once that was proven with real adversarial
evidence, `SECURITY DEFINER` had nothing left to solve — a genuine,
evidenced "not needed," reached by investigating the question rather than
assuming an answer either way.

This is additive, not a replacement: it closes the gap between what the
original architecture writeup once described as an active guarantee and
what was actually true at the time (app-layer checks only) — the two
layers are independently verified, not redundant with each other.

**Role-based access control**, layered as `SessionAuthGuard` at the
controller class level (authentication) with `RolesGuard` +
`@Roles(...)` at the method level (authorization) — a consistent
ordering convention relied on throughout the app (e.g., a guard
correctly asserting a user must already be authenticated by the time a
role check runs).

**Multi-role accounts with an explicit active role**, not separate
accounts per role. Single-role accounts auto-select their role at login;
multi-role accounts must explicitly choose, and can switch mid-session via
`POST /auth/switch-role`.

**Two-step MFA login** — `POST /auth/login` returns `{ mfaRequired: true }`
with a pending (not yet authenticated) session state when MFA is enabled,
completed via a separate `POST /auth/mfa/verify` call using the same
session.

**Password reset** stores only a hash of the reset token (never the raw
token) with an expiry, and the endpoint always returns `204` regardless of
whether the email exists — deliberate account-enumeration protection,
verified directly via pino logs showing the code path never reaches
`EmailService` for a nonexistent address, yet the client sees an
identical response either way.

**Messaging** is a hybrid of REST (conversation/message history,
archiving) and WebSocket (real-time delivery), both authorized through the
same underlying `assertParticipant` check. Archiving is a per-participant
column flip (`practitionerArchivedAt`/`patientArchivedAt`), never a delete
— each participant's inbox state is independent, and admins are
explicitly barred from it (a personal inbox concern, not an oversight
one).

**Standardized cross-cutting shapes**: a consistent pagination envelope
(`{ data, meta }`) on list endpoints, a consistent error response shape
from a global exception filter, and a dedicated `WsHttpExceptionFilter`
ensuring WebSocket errors carry the same real, meaningful messages as REST
ones rather than collapsing to a generic failure.

**Audit logging** as a first-class, structured concern (dedicated
service + interceptor + real relational table), not just text log lines
— covers every mutating action with who did what to which resource.

---

## Security-specific decisions

- **Rate limiting**, tighter on sensitive endpoints (login, password reset)
  than the global default.
- **DTO-level caps** (`@MaxLength`, `@ArrayMaxSize`, a custom
  `@MaxJsonSize` validator) on every user-controlled input shape, not
  just type validation.
- **An independent file-size guard inside `StorageService` itself**,
  not solely relying on upstream body-size limits.
- **Reorder-endpoint permutation checks** were found, across three
  separate implementations, to only compare deduplicated `Set` sizes —
  allowing a duplicate-padded array to pass while silently omitting a
  real entry. Fixed everywhere the pattern was copy-pasted, not just the
  one originally flagged instance.
- **A real, previously-invisible WebSocket auth race condition**: the
  original `handleConnection` lifecycle hook ran without actually
  blocking further events, meaning a client could reach a handler before
  session data was populated. Fixed by moving authentication into genuine,
  blocking Socket.IO middleware (`server.use()`).
- **`X-Forwarded-For` was found, via direct evidence from real production
  logs, to not reliably carry the true visitor IP through this specific
  Cloudflare + Caddy chain** — contradicting generic documentation.
  Fixed by reading Cloudflare's own dedicated `CF-Connecting-IP` header
  directly, verified by confirming both headers match in a live request
  afterward.
- **A security-claiming code comment that the code never actually
  enforced**: `archiveConversation`/`unarchiveConversation` stated admins
  don't get an archive action, but nothing checked for it — an admin
  calling either endpoint would silently fall into the patient's own
  archive-state branch. The same unconditional admin bypass was later found
  to also reach `sendMessage` and `markAsRead` on the identical code path,
  the second of which had a real secondary effect (closing the 15-minute
  message-delete window without the real participants' involvement) — both
  fixed with the same block once the pattern was recognized, not just the
  instance first reported.
- **`UsersService.toPublic()` — the single funnel every user-returning
  endpoint relies on** — stripped `passwordHash` but not `mfaSecret`,
  `passwordResetTokenHash`, or `passwordResetTokenExpiresAt`, meaning
  `GET /auth/me` and related endpoints echoed them straight back. Fixed at
  the one funnel point, then confirmed absent from two further call sites
  (`AuthService.validateUser()`, `registerClinic()`) that had independently
  made the identical mistake.
- **A five-category deliberate bug hunt**, built directly from what the
  bugs above actually looked like rather than a generic review: cross-
  tenant/clinic leaks, TOCTOU races, array/object mutation validated before
  an overwrite, comments claiming an unenforced restriction, and copy-paste
  propagation of one bug into sibling implementations. Findings were
  investigated and confidence-rated *before* any fix was written, and every
  fix re-traced against real source after landing — the same discipline
  applied to the RLS rollout afterward.

---

## Type safety — four systematic passes, one recurring root cause

A large stretch of work found and fixed the same underlying pattern
repeatedly: `any`-typed values standing in for data that had a real,
well-defined shape, disabling TypeScript's checking entirely at that
point and cascading into ~150 individual lint findings from one root
cause. Fixed systematically rather than patched per call site:

1. `@CurrentUser()`'s return type, widened from `any` to a real
   `CurrentUser` interface.
2. `express-session`'s `SessionData` interface, extended via declaration
   merging to know about the app's real custom session fields
   (`mfaPending`), plus a separate fix for Socket.IO's `request` object
   not being typed as an Express `Request` at all.
3. The same `any`-`getRequest()` gap, closed in the remaining guards and
   interceptor still using it directly.
4. `activeRole` widened from plain `string` to the real `UserRole` enum
   everywhere, then every enum comparison project-wide converted to use
   the actual member — a genuine type-safety upgrade, not just cosmetic
   consistency, since a `string`-typed field gains nothing from being
   compared against an enum member.

One deliberate *non*-fix is worth recording: a global `Express.User`
augmentation was investigated and correctly rejected, because it would
have papered over a real, intentional divergence — the plain-password
login path deliberately strips `mfaSecret` before it reaches `req.user`,
while every other path carries it. Recognizing when the more sweeping fix
would be *wrong*, not just riskier, mattered more here than closing the
gap completely.

---

## Development practices

- **A running `deferred-improvements.md`** tracks small, real
  improvements deliberately not tackled immediately — not urgent, not
  forgotten, revisited explicitly rather than left to fall out of memory.
- **Prettier configured to match actual preferences** (`semi: false`,
  `singleQuote: true`, `trailingComma: "all"`) rather than fighting the
  default — with the honest, verified limitation that Prettier's
  blank-line collapsing is not configurable at all, accepted as a real
  tradeoff.
- **`.gitattributes` enforcing LF line endings** and **`core.fileMode
  false`** — both closing recurring Windows/Linux cross-platform friction
  at the repository-configuration level, rather than re-fixing the same
  symptom repeatedly.
- **A codebase-snapshot sync-check discipline**: before any significant
  edit, verify the actual current state of relevant files directly rather
  than work from an assumed or remembered state — this caught real drift
  multiple times and avoided proposing fixes against stale code.
- **Delegating large, well-scoped mechanical tasks to Claude Code**, with
  prompts that explicitly demand root-cause fixes over local patches, real
  verification (not just "should work"), and explicit reporting of
  anything ambiguous rather than a silent guess — and reviewing its output
  critically rather than accepting a summary at face value.
- **A five-check bug-hunt methodology**, developed after bugs were found
  by accident while writing documentation, then applied deliberately:
  cross-check sibling routes for inconsistent authorization, cross-check
  security-claiming comments against actual enforcement, verify every
  WebSocket handler has a real check, trace what a client actually
  receives on error, and check for lifecycle-ordering assumptions the
  framework doesn't actually guarantee.
- **Test suite philosophy: review-and-fix, not wholesale regenerate** —
  deliberately preserving already-valuable existing test patterns (a
  copy-not-reference test explicitly called out as the suite's most
  important single test) while fixing genuine staleness and closing real
  coverage gaps for newly-shipped security fixes.

---

## Deployment infrastructure

**A raw DigitalOcean Droplet (Ubuntu 24.04 LTS, 2GB/1vCPU) with Docker
Compose, chosen deliberately over a PaaS** (Render/Railway/Fly.io) —
explicitly because the project's value included demonstrating real
infrastructure understanding, not abstracting it away. This choice is the
direct cause of needing to solve TLS, a domain, firewalling, and process
management by hand — treated as the point, not a cost.

**Caddy** as the reverse proxy, chosen for its genuinely simple automatic
HTTPS (a real Let's Encrypt certificate with essentially zero
configuration) over more complex alternatives.

**Cloudflare** in front of the Droplet — DNS, DDoS protection, and TLS
termination at the edge, in **Full (strict)** mode specifically (verifying
the origin's certificate is genuinely valid, not just present). The
domain itself (`stridecare.app`) was purchased directly through
Cloudflare specifically to skip a separate nameserver handoff step. The
apex domain is deliberately reserved for the eventual frontend, with the
API on `api.stridecare.app` — mirroring how real products like Stripe
separate their marketing site from their API subdomain.

**A hardened Droplet**: SSH key-only auth, root login and password auth
both disabled, a DigitalOcean Cloud Firewall initially open on 80/443 and
later — once Caddy existed and was confirmed working — restricted to
Cloudflare's own published IP ranges specifically, closing the direct-IP
bypass. This restriction was verified not just via dashboard inspection
but via a real `tcpdump` packet capture confirming only legitimate
Cloudflare-range traffic ever reaches the origin.

**A `migrate` service inside `docker-compose.prod.yml` itself**, gated
with Compose profiles so it never runs automatically — replacing an
initial ad hoc `docker build --target builder` command with something
self-documenting, discoverable by anyone reading the one file everyone
already looks at. A second service, `create-app-role`, was added the same
way once the RLS work needed it (see above) — same builder-stage/profile
shape, invoked once before the app's first boot.

**`db` has no published port at all — not even loopback — and `storage`
is bound to `127.0.0.1` only**, deliberately different treatment for a
real reason: nothing outside the compose network ever needs Postgres
directly, while RustFS genuinely needs host-level access (the admin
console over an SSH tunnel, the backup script), so it gets the narrower
127.0.0.1 binding instead of none at all. Either way, both are
categorically unreachable from the public internet regardless of any
firewall rule, not just blocked by one.

**Required secrets are enforced at two separate layers**: Compose itself
refuses to start `db`/`storage` at all if `POSTGRES_PASSWORD`,
`RUSTFS_ACCESS_KEY`, or `RUSTFS_SECRET_KEY` are unset
(`${VAR:?must be set in .env}`), one layer earlier than the app's own
`validateEnv()` catching its own required secrets at boot.

**Caddy's config is a single `reverse_proxy app:3000` block** — a real
domain name is what makes it request and auto-renew a Let's Encrypt
certificate and redirect HTTP→HTTPS with zero further configuration,
including proxying WebSocket upgrade requests automatically. It logs to
stdout as JSON, deliberately separate from the app's own pino output —
the only record of a request that never reached the app at all (e.g. a
502 while the app container is down).

**A genuinely tested backup strategy**: `pg_dump`, compressed and uploaded
to RustFS via a cron-scheduled script, with an explicit restore test
performed and verified against real row counts — not just assumed to
work because the script exits cleanly. The real, documented limitation:
this protects against application-level mistakes, not a whole-Droplet
disaster, since RustFS lives on the same machine as Postgres; real
production would use off-Droplet storage.

---

## Observability & operations

**Better Stack**, chosen over the more famous UptimeRobot specifically
because UptimeRobot's free tier is restricted to non-commercial personal
use, while Better Stack carries no such restriction and additionally
bundles log management — one account closing two separate operational
gaps (uptime monitoring and log persistence) rather than two disconnected
tools.

**A lightweight Vector agent for log shipping, not Better Stack's full
eBPF-based collector** — the fuller collector failed outright on the
Droplet's single vCPU (Docker refused a CPU allocation its bundled config
requested), read correctly as a genuine hardware mismatch rather than
something to patch around, and resolved by switching to the tool actually
sized for this deployment's scale.

**Log rotation is genuinely implemented and verified locally**, closing a
gap that had previously existed only as documentation, not configuration
(see doc 25 in the journal series for the full finding-and-fix). A shared
`x-logging: &default-logging` anchor (`json-file`, `max-size: "10m"`,
`max-file: "3"`) is referenced by `db`, `storage`, `app`, and `caddy` —
deliberately excluded from `migrate`/`create-app-role`, which are
short-lived, on-demand tools rather than permanently-running containers
that accumulate logs over time. Verified via `docker compose config`
resolving the anchor into a full `logging:` block on all four target
services. Almost certainly live in production too, by mechanism —
doc 26's full redeploy recreated every container from the current compose
file, and Compose logging config applies at creation — but that's an
inference from how Compose works, not something separately confirmed via
direct inspection of the running Droplet container. Worth a real check
(`docker inspect` on the deployed containers) before treating it as fully
verified rather than very likely true.

**Graceful shutdown verified directly, not just configured**:
`app.enableShutdownHooks()` confirmed via a timed `docker stop` completing
in a fraction of a second (rather than the full grace period before a
forced kill), deliberately sequenced *after* log shipping was already
working — so the same test proved both that shutdown hooks work and that
a container's very last log lines make it out before the process exits.
