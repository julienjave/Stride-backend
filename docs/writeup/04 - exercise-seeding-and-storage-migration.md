# Exercise data seeding & the storage backend migration

This document picks up after `application-layer-and-authentication.md`, covering
the exercise data pipeline and — the most consequential event of this phase — an
unplanned but instructive migration of the object storage backend.

## The `free-exercise-db` seed script

`scripts/seed-exercises.ts` imports the previously-selected open dataset into the
`exercises` table. A few decisions worth recording:

- **It lives outside `src/`, in a top-level `scripts/` folder**, not colocated
  with the `exercises` feature module. Everything under `src/` is compiled into
  the deployment artifact (`dist/`) by `nest build`; this script is never
  imported by `AppModule` and is meant to be run once, manually, from a
  terminal. Keeping it outside `src/` keeps the actual deployed application free
  of operational tooling that has no business shipping with it.
- **It boots the application via `NestFactory.createApplicationContext()`**
  rather than duplicating connection/upload logic — this starts Nest's full
  dependency-injection graph (every provider constructed, lifecycle hooks run)
  without starting an HTTP listener, giving the script real, DI-wired instances
  of `DRIZZLE` and `StorageService` to call directly.
- **It's idempotent.** Before inserting, it checks whether a row with the
  source's `external_id` already exists (relying on the partial unique index
  added to the schema for exactly this purpose), so interrupting and re-running
  the script never creates duplicates.
- **Images are downloaded from the source and re-uploaded into our own object
  storage**, never linked directly to GitHub's raw content URLs — consistent
  with the earlier decision to own a local copy of the dataset rather than
  depend on a third party's CDN availability at runtime.

### A schema refinement made during this pass: `instructions` as an array

The source dataset stores each exercise's instructions as an array of discrete
steps. The schema originally stored this as a single flattened `TEXT` column
(steps numbered and joined into one string at import time). This was changed to
`TEXT[]` before any real data existed, for two reasons: it avoids a lossy
round-trip (structured data → flattened text → re-parsed by the frontend just to
render a list), and it matches the pattern already used elsewhere on the same
table (`equipment`, `primaryMuscles`, `secondaryMuscles`, `mediaUrls` are all
arrays) rather than being an inconsistent exception. Numbering and formatting
are left entirely to the frontend, which is a presentation concern the stored
data shouldn't dictate.

## The storage backend migration: MinIO → RustFS

While setting up MinIO's console, a licensing question (AGPLv3 vs. this
project's Apache-2.0 license) led to research that surfaced a materially more
important fact: **MinIO's open-source Community Edition has been effectively
discontinued.** Its admin console was stripped down in mid-2025, prebuilt Docker
images stopped being published in October 2025, and the repository was placed
in maintenance mode and ultimately archived by early-to-mid 2026, with the
company steering users toward a paid commercial product.

### Why this mattered beyond the news itself

The Docker image already in use was a frozen snapshot receiving no further
security patches through official channels — a real, live risk for a project
built around HIPAA Security Rule technical safeguards, not a hypothetical one.
Continuing to build on an abandoned dependency, discovered mid-project, is
exactly the kind of licensing/vendor-risk judgment call this capstone set out to
demonstrate — so it was addressed immediately rather than deferred.

### Evaluating alternatives

Three actively-maintained, open-source, S3-compatible candidates were compared:

| | License | Architecture | Verdict |
|---|---|---|---|
| Garage | AGPLv3 | Designed for geo-distributed multi-node clusters (full redundancy wants 3 nodes across physical zones) | Solves a problem this single-VPS deployment doesn't have |
| SeaweedFS | Apache 2.0 | Most production-proven (~30K stars, since 2015); multi-component (master + volume server + filer) | More operational complexity than warranted at this scale |
| **RustFS** | **Apache 2.0** | Single binary/container, explicitly designed as a like-for-like MinIO replacement, ships its own web console | **Selected** |

RustFS was chosen for matching this project's existing "lean stack" pattern
(one container, no added architectural complexity over what MinIO already was),
its permissive license removing the licensing question entirely rather than
merely concluding AGPL didn't block the prior unmodified/network-separate usage,
and restoring the full admin console MinIO's community edition had removed. The
honest tradeoff, recorded rather than glossed over: RustFS is the newest and
least battle-tested of the three (~4K GitHub stars vs. SeaweedFS's ~30K) — an
acceptable risk for a capstone demo, and one that would be weighed differently
before a genuine production deployment handling real patient data.

### Replacing the client library, not just the container

The initial migration kept the existing `minio` npm package as the application's
S3 client, on the theory that RustFS was designed for compatibility with it.
On reflection, this was flagged as unprofessional patchwork — reusing a
vendor-branded client against a different vendor's server — and checked against
RustFS's own documentation, which confirmed it directly: RustFS ships no client
SDK of its own and explicitly directs developers to standard S3-protocol
tooling instead, stating that any AWS-S3-compatible tool works against it by
changing only the endpoint URL.

The application was switched to `@aws-sdk/client-s3` (with
`@aws-sdk/s3-request-presigner` for presigned URLs) — the genuinely
vendor-neutral standard, rather than a client incidentally compatible with the
current backend. `StorageService`'s public interface (`upload()`,
`getPresignedUrl()`) was unchanged; only its internal implementation moved from
MinIO's client-method style to the AWS SDK v3's command-object style
(`client.send(new PutObjectCommand({...}))`), and `scripts/seed-exercises.ts`
required no changes at all, since it only ever called `StorageService`'s public
methods through dependency injection.

### `forcePathStyle`: a portability lesson worth recording

`forcePathStyle: true` is required because self-hosted S3-compatible servers
lack the wildcard DNS that lets AWS route bucket-specific subdomains
(`bucket.s3.amazonaws.com`) — buckets are instead addressed via the URL path.
This setting is tied to *which storage backend is in use*, not to whether the
application is running locally or deployed. It stays `true` unchanged for both
local development and a demo VPS deployment, since both are self-hosted RustFS.
It would only need to become `false` if the application ever migrated to real
AWS S3 specifically — any bucket created there since September 2020 requires
virtual-hosted-style addressing exclusively. Backblaze B2 (the other
BAA-capable production storage option identified earlier) supports both styles,
so no change would be required there. This is the practical payoff of choosing
an S3-*compatible* API in the first place: swapping backends is a small,
localized configuration change, not an application rewrite.

## Operational notes from this phase

- **`TRUNCATE` checks for the existence of a referencing foreign key
  constraint, not whether any rows currently use it** — attempting to truncate
  `exercises` failed even though the tables referencing it
  (`template_exercises`, `assigned_program_exercises`) were still empty. `DELETE
  FROM exercises` was used instead, since it only blocks on actual referencing
  rows, and the constraint's `RESTRICT` behavior was working exactly as
  designed rather than indicating a problem.
- **`docker compose down -v` remains the correct reset tool while pre-launch**,
  used again here to cleanly regenerate all tables after the schema and storage
  backend changes. This is explicitly a pre-launch-only pattern — safe only
  because no real user data exists yet, a distinction worth remembering as the
  project approaches anything resembling real data.
