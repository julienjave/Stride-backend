# Backend architecture & technology decisions

This document explains the reasoning behind each technology choice in the backend
stack. The goal throughout was not just to make something work, but to make
deliberate choices appropriate for a healthcare-adjacent application — one that
should be built with the discipline of the HIPAA Security Rule's technical
safeguards in mind, even though this project (with no real patient data) does not
carry the full legal obligations of a HIPAA-covered production system.

## Database layer: PostgreSQL + Drizzle

**PostgreSQL** was chosen over alternatives (MySQL/MariaDB) for two reasons specific
to this domain:

- **Row-Level Security (RLS)** lets access control be enforced *inside the
  database itself* — a patient can only ever `SELECT` their own records, even if
  a bug exists in the application layer. This is defense-in-depth: authorization
  isn't only an `if` statement in a controller, it's a guarantee the database
  makes regardless of what queries the application sends.
- **JSONB** support gives a clean way to store genuinely variable-shaped data
  (audit log details, parts of medical history) without forcing everything into
  either rigid columns or an unstructured blob.

**Drizzle** was chosen over Prisma as the ORM because its query syntax stays close
to actual SQL rather than abstracting further away from it — a deliberate choice
to keep the reasoning behind every query visible and explainable, rather than
hidden behind a heavier abstraction layer.

## Backend framework: NestJS on Node.js

NestJS was chosen over plain Express specifically because its architectural
patterns map cleanly onto this project's two most compliance-relevant
requirements:

- **Guards** provide declarative, centralized role-based access control
  (`@Roles('practitioner')`) rather than repeated `if (req.user.role !== ...)`
  checks scattered across route handlers.
- **Interceptors** implement the immutable audit log as a genuine cross-cutting
  concern — one interceptor writes to `audit_log` on every mutating request,
  rather than relying on a manual call being remembered in every controller
  method.

Express remains the more common default in the Node.js ecosystem and was
seriously considered; NestJS was chosen because its structure directly serves
the RBAC and audit-logging requirements this domain has, at the cost of a
steeper learning curve.

## Authentication: Passport.js, session-based

Passport.js (`passport-local` strategy) was chosen over a managed auth service
(e.g. Supabase Auth) to demonstrate direct implementation of HIPAA's
Person/Entity Authentication safeguard: password hashing via bcrypt, rate-limited
login endpoints, and every authentication event (success and failure) written to
the audit log.

**Session cookies were chosen over JWTs.** This is a single first-party web
client (one frontend, one backend, same origin) — the classic case where
`httpOnly` session cookies are both simpler and more secure than hand-rolled
JWTs, since the cookie is inaccessible to JavaScript (closing off a common XSS
attack vector) and sessions can be revoked instantly by deleting a row, rather
than waiting out a token's expiry. JWTs earn their complexity when multiple
independent clients (e.g. a future native mobile app) need to verify identity
without a shared session store — that isn't the case here yet, but the
migration path is intentionally documented rather than pre-built.

## Real-time messaging: NestJS WebSocket Gateway

Practitioner–patient chat uses a NestJS `@WebSocketGateway()` (Socket.IO)
instead of Supabase Realtime's write-ahead-log-based approach. For a two-party
chat feature, explicitly emitting an event right after saving a message is
simpler to reason about than relying on database replication-stream detection,
and it reuses the same session-cookie authentication already established for
REST routes, rather than introducing a second trust mechanism.

## File storage: MinIO (self-hosted, S3-compatible)

Practitioner/patient photos and clinic logos are stored as object storage via
MinIO, an open-source, S3-API-compatible server — the database stores a path,
never binary image data.

MinIO runs self-hosted in this project's Docker Compose stack because there is
no real PHI involved in a bootcamp demo, so the added privacy/compliance
question doesn't yet apply. For a genuine production deployment with real
patient data, storage would migrate to a provider that can sign a Business
Associate Agreement (e.g. Backblaze B2 or AWS S3) — because compliance is
established by a signed BAA with the party handling the data, not merely by
self-hosting on infrastructure you happen to control. Because MinIO speaks the
same S3 API, this migration is a configuration change (endpoint + credentials),
not a rewrite.

## Infrastructure: Docker Compose + Caddy

Each service (`db`, `api`, `storage`, `proxy`) runs as its own container,
mirroring how production container orchestration (Kubernetes, ECS) separates
responsibilities — one process, one container. Named volumes persist Postgres
and MinIO data independently of container lifecycle.

**Caddy** was chosen as the reverse proxy / TLS-termination layer over nginx for
its automatic HTTPS certificate issuance and renewal via Let's Encrypt, removing
an entire category of manual-certificate-management failure that's common in
small deployments. nginx remains the more widely recognized name in the
industry, but Caddy is a production-grade, actively used choice, and its
reduced operational risk was judged more valuable for a solo-maintained project.

## Deliberately excluded

- **Full self-hosted Supabase stack** — its Auth and auto-generated REST API
  (PostgREST) services would sit unused given the choice of Passport.js and a
  hand-built NestJS API layer. Only Storage and Realtime would have added real
  value, and both are covered more simply (and more consistently with the rest
  of the stack) by MinIO and a NestJS WebSocket gateway respectively.
- **Appwrite** — its default database is MariaDB/MySQL, which conflicts with the
  project's PostgreSQL + Drizzle foundation.
- **Fastify** — its main advantage (raw throughput) is not a constraint at this
  project's scale, and its Passport.js integration is a community plugin rather
  than a first-class one.

## A note on HIPAA framing

This project is built to follow the *technical safeguards* described in the
HIPAA Security Rule (45 CFR §164.312) — access control, audit controls,
integrity controls, authentication, and transmission security — as a
demonstration of understanding how healthcare software should be architected.
It does not claim full HIPAA compliance, which is a legal/organizational status
requiring signed Business Associate Agreements with every vendor handling real
PHI, a documented risk assessment, and organizational policies — obligations
outside the scope of a solo academic project with no real patient data.
