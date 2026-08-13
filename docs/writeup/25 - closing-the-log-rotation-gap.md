# Closing a documentation gap: Docker log rotation, actually implemented

This document covers a small, self-contained fix — but one that started as
a documentation-accuracy check, not a feature request, and is worth
recording for the same reason several earlier entries are: the process of
verifying a claim mattered as much as the fix itself.

## How the gap was found

While updating `PROJECT.md` to reflect the RLS rollout and recent bug
hunts, one existing claim — "log rotation configured on every long-running
container" — was checked directly against the real, current
`docker-compose.prod.yml` rather than trusted at face value, the same
discipline applied to every other claim in that pass. It didn't hold up:
no `logging:` key, no `x-logging` anchor, on any service.

That alone was ambiguous — stale documentation and a genuine regression
look identical from the file's current state. The distinguishing question
(was this ever there and removed, or never there at all?) needed git
history, not just the current file, to answer honestly. Claude Code — with
real filesystem and git access this conversation doesn't have — was asked
to check both the full working tree and the complete commit history of
`docker-compose.prod.yml` for any trace of logging configuration, at
either the per-service or Docker-daemon level, and to report exact
citations (file, line, commit hash) rather than an inference.

The answer was unambiguous: the file has exactly four commits total, every
diff was read directly, and none of them ever added a `logging:` block.
The only place this configuration had ever existed was a single sentence
in `PROJECT.md` itself, written as prose describing work that, on the
evidence, was never actually committed. Worth stating plainly, the same
way the RLS overclaim in doc 01 was named rather than quietly corrected:
this was aspirational documentation, not a regression — the distinction
mattered enough to verify rather than assume either way.

## The fix

A shared `x-logging: &default-logging` YAML anchor, defined once at the
top of `docker-compose.prod.yml`:

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Applied via `logging: *default-logging` to the four services that run
continuously — `db`, `storage`, `app`, `caddy` — and deliberately *not* to
`migrate` or `create-app-role`, both already gated behind `profiles:
["tools"]` and invoked only on demand. A short-lived, on-request container
doesn't accumulate the unbounded log growth this fix exists to bound in
the first place; applying it there would be noise, not protection. 10MB
per file, 3 files retained caps each of the four services at 30MB of log
history before Docker discards the oldest entries — generous enough to
stay useful for debugging, bounded enough to never silently fill the
Droplet's disk the way the default, unbounded `json-file` driver genuinely
could over time.

This addresses unbounded *growth* specifically, not log *persistence*
across a full container recreation — a distinction worth keeping separate,
matching the same accepted-limitation framing already applied to the
backup strategy (doc 18) and observability setup (doc 19). In practice,
the Vector agent shipping logs to Better Stack already covers persistence
independently, but that was never the reason this fix was made.

## Verification, not just a syntactically valid diff

`docker compose -f docker-compose.prod.yml config` was run to confirm the
anchor actually *resolves* — the output showed a fully expanded `logging:`
block under `db`, `storage`, `app`, and `caddy`, and confirmed its absence
under `migrate`/`create-app-role` (forced into the output via `--profile
tools` specifically so their config could be inspected at all, since
they're excluded from a plain `config` call otherwise). Real evidence that
the anchor reference behaves as intended, not just that the YAML parses.

## A real, unplanned finding from running the verification command itself

`docker compose config` fully resolves environment variables into its
output by design — normal, documented behavior, not a bug in the tool or
in this fix. But it meant the verification step itself printed real
secret values (`RESEND_API_KEY`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`,
`POSTGRES_APP_PASSWORD`, the database password) directly into that
session's output. This was flagged immediately rather than treated as
incidental noise, and every exposed secret was rotated as a precaution —
treating "this appeared somewhere its exposure can't be fully accounted
for" as sufficient reason to rotate, rather than trying to first determine
whether it was actually seen by anyone.

`MFA_ENCRYPTION_KEY` was the one rotation that wasn't a simple swap: every
currently-encrypted `mfaSecret` value is encrypted under the *current* key
specifically, so rotating it without a migration step would break
verification for any already-enrolled account (loudly, by design — AES-GCM
fails decryption rather than silently producing garbage, exactly the
property doc 17 built this around in the first place). With no real
enrolled accounts yet at this stage of the project, the pragmatic choice
was accepting a forced MFA re-enrollment over writing a one-off
decrypt/re-encrypt migration script for zero real users — the kind of
scope judgment this project has made repeatedly (RLS's table-by-table
rollout, the deliberately-scoped bug hunts) rather than defaulting to the
more thorough option regardless of what it actually buys.

## Status: fixed locally, not yet live

The change is committed to `docker-compose.prod.yml`, but Compose's
logging configuration is applied at container *creation*, not on a
restart — the Droplet's currently-running containers predate this file
and won't pick it up until an actual `docker compose -f
docker-compose.prod.yml up -d --force-recreate` (or an equivalent full
`down`/`up`) runs against the real deployment, not just once the repo
itself is updated. Recorded here as the honest current state rather than
implied as already deployed — worth checking explicitly at actual deploy
time rather than assumed to have happened automatically.
