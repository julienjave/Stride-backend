# A small documentation gap, a real credential-parsing bug, and a duplicate of it in the docs

This document covers what started as a two-line fix flagged in
`DEPLOYMENT.md` — the `backups` S3 bucket was never auto-created — and
turned into a real, previously-invisible authentication bug in the actual
backup path, plus an identical copy of that same bug sitting unnoticed in
the deployment documentation itself.

## The starting gap, and where the fix belongs

`scripts/backup-database.sh` uploads to a bucket named `backups`, distinct
from `stride` (which `StorageService` creates automatically on app boot).
Nothing ever created `backups` — `DEPLOYMENT.md` had covered it with a
one-off manual step instead. Two ways to close it: teach `StorageService`
to create both buckets, or make the script self-sufficient. The second was
the right call, deliberately: `backups` is used exclusively by a
standalone cron script that runs entirely outside the NestJS app — coupling
`StorageService` to a bucket it never itself reads or writes would trade a
few lines in the right file for an architectural dependency that doesn't
belong. Fixed with the standard idempotent shape already used elsewhere in
this project (`create-app-role.ts`, `seed-exercises.ts`): check first,
create only if missing.

```bash
aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3api head-bucket \
  --bucket backups 2>/dev/null || \
aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 mb s3://backups
```

Verified genuinely idempotent — two consecutive runs, the first creating
the bucket, the second finding it already present and proceeding straight
to upload with no error — and confirmed end-to-end via a real `aws s3 ls`
showing the actual uploaded files, not just a clean exit code.

## The real bug this surfaced

Verifying the fix against this environment's actual `.env` produced a
genuine `InvalidAccessKeyId` failure — not from the new bucket-check line,
but from the credential extraction every `aws` call in the script already
depended on. The cause: `grep|cut` never stripped a trailing inline
comment, and `.env.example`'s own documented format for these two
variables — `RUSTFS_ACCESS_KEY=rustfsadmin # Generate: openssl rand -hex
16` — triggers it directly. A deployer following the example file exactly
as written, generating a value and editing it in place with the comment
left intact, ends up with a credential string carrying `# Generate:
openssl rand -hex 16` appended to it. Every `aws` call in the script was
exposed, not just the new one — including the actual backup upload this
whole script exists to perform.

Worth naming as a recurrence, not a coincidence: this is the same category
of problem as doc 18's original `EMAIL_FROM`/`source .env` incident —
`.env` parsing edge cases in this exact script, found a second time by a
different specific mechanism. Fixed with a single shared helper rather
than patching the two variables that happened to be affected today:

```bash
env_var() {
  grep -E "^$1=" .env | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}
```

Tested against both real formats directly — a comment-style value
(matching `.env.example`) and a bare one — confirming the fix handles the
one that broke it without regressing the one that already worked. `.env`
itself was never modified; the fix makes the script robust to either
format rather than asking anyone to reformat their real secrets.

## A question worth asking, and the answer it actually needed

Before treating this as closed, a good clarifying question came up: could
this actually be a local-vs-production environment mismatch instead —
`.env`'s `POSTGRES_HOST`/`STORAGE_ENDPOINT` values genuinely do differ
between `localhost` (local dev) and `db`/`storage` (production's Compose
service names). Worth answering precisely rather than waved past: **no**,
for three separable reasons. The script hardcodes `localhost` for its S3
endpoint by design — it always runs directly on the host, in cron, in both
environments, never inside a container, and RustFS being bound to
`127.0.0.1` (not left unpublished) exists specifically to let the host
reach it directly. The credential values themselves aren't
environment-conditional placeholders; they're real generated secrets that
authenticate identically regardless of which environment's real values are
being parsed. And the failure signature itself was diagnostic:
`InvalidAccessKeyId` is what a corrupted credential string produces — a
genuine connectivity mismatch would surface as a connection-level failure
instead, not an authentication one.

That question was still worth asking, though, because it pointed at a
real, different, legitimate risk in the same neighborhood: does `pg_dump`
assume direct host connectivity to Postgres, the way the local
`docker-compose.yml` would allow but `docker-compose.prod.yml` explicitly
does not (`db`'s port isn't published in production at all, unlike local
dev)? Checked directly rather than assumed either way — already correct:
`pg_dump` goes through `docker compose exec -T db`, not a direct
connection. The `aws` calls' own direct-host assumption is *also* correct,
for the mirror-image reason: `storage`, unlike `db`, genuinely is
published to `127.0.0.1` in production. Two different connectivity
assumptions, in the same script, both right — but for reasons specific to
each service, not a blanket rule, and worth having verified rather than
inferred.

## The duplicate bug, found in the doc meant to be followed by hand

`DEPLOYMENT.md`'s Phase 9 manual restore instructions carried the
identical broken extraction — introduced by its own comment as *"the same
credential-extraction the backup script itself uses."* That comment was
accurate when written and became silently false the moment the script was
fixed without the doc following. Fixed to match, with the same shared-helper
shape. Four separate references to the bucket needing manual creation were
also found and updated across the document — Phase 3's original manual
step, Phase 9's "should already exist" framing, and two mentions inside
Phase 11's teardown/recovery instructions — since a single behavior change
had rippled into every place the document described the old state, not
just one.

## Current status

`scripts/backup-database.sh` now self-creates its bucket and correctly
parses `.env` regardless of formatting style; `DEPLOYMENT.md` reflects
both changes everywhere they were previously described, and no longer
carries a second copy of the bug it just helped find. Verified together,
not independently: two full backup runs against the corrected script, both
succeeding, with real `aws s3 ls` confirmation of the uploaded files.
Committed as `[commit hash — to be filled in]`.
