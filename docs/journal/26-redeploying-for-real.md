# Redeploying for real: a full pipeline test, and everything it found

This document covers the actual execution of what doc 25 set up for:
destroying and recreating the production Droplet from scratch, both to
ship the accumulated RLS rollout and bug-hunt fixes for real and to
validate `DEPLOYMENT.md` itself by actually following it step by step,
rather than trusting it because it read correctly. It was, by a wide
margin, the most productive single exercise this project has done —
nearly every phase that hadn't been exercised end-to-end yet surfaced
something real.

## Merging a second runbook found a load-bearing gap before it shipped

Before the actual redeploy, an independently-written recreation runbook
was compared against `DEPLOYMENT.md`'s existing Part 2, phase by phase,
rather than assumed to agree with it. Most of the runbook's detail was
genuinely more field-tested — a swap file sized for the Droplet's single
vCPU, the exact `awscli` installation Ubuntu 24.04 now requires,
`git config core.fileMode false`, a `POSTGRES_HOST`/`STORAGE_ENDPOINT`
warning called out explicitly as the easiest mistake to make — and was
merged in directly. But one line in it was a real risk, not a style
difference: its "bring up the stack" step ran `docker compose up -d
--build` for every service at once, including `app`, with no
`create-app-role` step anywhere in the document at all. Since
`drizzle.provider.ts` connects as `stride_app` — a role that doesn't exist
until that script creates it — following that version as written would
have brought the app up, had it immediately fail to authenticate to
Postgres, and given no indication why without already knowing doc 23's
reasoning. Caught by comparison before ever being run, not after.

## A new instance of the `ts-node`-vs-`tsc` gap, this time from ambient declarations

The first real failure once seeding was actually attempted: `ts-node`
failed to compile `auth.controller.ts` — a file with nothing wrong with
it — over `mfaPending` supposedly not existing on `SessionData`. The
actual cause: that property only exists via ambient declaration merging in
`src/auth/express-session.d.ts`, a file nothing ever `import`s (by design
— that's how declaration merging works). `nest build`/`tsc` picks it up
anyway, because they eagerly compile everything matched by `tsconfig.json`'s
`include` glob, regardless of the real import graph. `ts-node`, run
directly on an entry script, does not — by default it only compiles files
actually reached through the real `require` graph, and
`scripts/seed-exercises.ts` (which boots the full DI graph via
`NestFactory.createApplicationContext()`, reaching `auth.controller.ts`
transitively) never imports the ambient file directly, so ts-node's
program never included it. The fix: `"ts-node": { "files": true }` in
`tsconfig.json`, which tells ts-node to eagerly load everything in
`include`, restoring parity with `tsc`'s own behavior — the durable,
config-level fix, not a per-invocation `--files` flag, matching this
project's own stated preference from the original `types` array
investigation (doc 13). Worth naming precisely as a second instance of
the same underlying class of problem doc 13 already solved once — a
different specific mechanism (ambient declarations vs. the `types` array),
the same root shape (`ts-node` and `tsc` seeing a different program
depending on how each is actually invoked).

## "Which image is this container actually running" — the same mistake, twice

Fixing the `ts-node` issue didn't fix the seed script on the first retry.
`docker run --rm ... stride-migrate ...` — a bare `docker run`, with zero
awareness of `docker-compose.prod.yml`'s `build:` block — was still
running whatever had been tagged `stride-migrate` before the fix was
pulled. An explicit `docker compose build migrate` first resolved it.

The same shape of mistake reappeared later, in `DEPLOYMENT.md`'s own
"redeploying after a code change" recipe — which used `docker compose run
--rm migrate`, not a bare `docker run`. That looked safer, but wasn't:
Compose only auto-builds an image the *first* time it doesn't exist; once
built, both `run` and `up` silently reuse the existing image regardless of
source changes, unless `--build` is passed explicitly. The redeploy
recipe never had a `build` step for `migrate` at all — a real bug in the
documentation itself, not just a gap, fixed by adding an explicit `build`
before every `run --rm` on any `profiles: ["tools"]` service, and stated
as a general rule rather than patched only where it had already bitten:
rebuild whatever's source actually changed, not just the one service
you're about to restart.

## A genuine, previously-undiscovered scope gap in the RLS rollout

Once the tooling issues were cleared, the seed script hit a real
application-level failure: `new row violates row-level security policy
for table "exercises"` — on the very first genuinely new row, after 800+
idempotency-check reads had already succeeded without issue.

The cause, confirmed directly against the actual script source: `const db
= app.get<DrizzleDb>(DRIZZLE)` — the seed script pulls the same DI-provided
Drizzle client every real service uses. Since doc 23's connection split,
that resolves to `stride_app`, the restricted role, not the Postgres
owner. `exercises` gained `FORCE ROW LEVEL SECURITY` in doc 24's rollout,
with an `INSERT ... WITH CHECK` policy that consults session context —
context this script, being a one-off operational task with no real
authenticated user, never sets. The 800+ successful reads never revealed
this, because `exercises`' `SELECT` policy is a plain `USING (true)` that
never consults session context at all — only the write path does.

Worth being precise about why the original RLS rollout's own review never
caught this: doc 24 describes real scope corrections found mid-pass
(`SessionsService`, `AuthService`'s direct writes), but those were found
by searching for callers of the affected tables. `seed-exercises.ts` is
deliberately never imported by `AppModule`, specifically so it stays out
of the deployed application — the exact property that made it invisible
to a caller-search sweep. Not carelessness in the original rollout; a
genuine blind spot in the method used to find gaps, only closed by
actually running the full pipeline for real.

The fix follows a pattern this project already established for exactly
this category of problem: `create-app-role.ts` and `drizzle-kit migrate`
both deliberately use the Postgres *owner* connection, not `stride_app`,
because they're privileged, one-time, operational tasks rather than real
application requests. Seeding is the same category. Rather than carve a
bypass into `exercises`' security policy, the script now opens its own
owner-connection client (`getDatabaseUrl()`, mirroring
`create-app-role.ts`'s own construction exactly) instead of reusing the
app's restricted one.

Verified two separate ways, not just one: isolated, rolled-back
transactions proved the mechanism directly (the identical `INSERT`
genuinely fails as `stride_app` and genuinely succeeds as the owner role,
with a follow-up count confirming the test itself left nothing behind),
and — after resolving a real local-vs-production `.env` mix-up that
initially produced a misleadingly clean "imported 0" result against an
already-seeded local database — a real production run against the actual,
empty Droplet database completed with a genuine `Done. Imported 873,
skipped 0`.

## A recurring failure mode worth naming once, not documenting as three separate incidents

Several distinct confusions this session shared the same actual shape:
losing track of *which environment* a given command, file, or result
actually belonged to.

- A `.env` edited locally never reaches the Droplet through `git
  push`/`pull` at all — it's gitignored, by design. Fixes applied to a
  local `.env` during debugging can look identical to a real fix while
  being completely invisible to production.
- The same local `.env` needs genuinely different values (`localhost` vs.
  Docker service names) depending on whether it's running the app
  directly on the host (Part 1) or validating a `docker-compose.prod.yml`
  service locally — two correct answers to the same variable, depending
  on context that isn't recorded anywhere in the file itself.
- A seed run against an already-populated database and a seed run against
  a genuinely empty one produce different-looking success, for reasons
  that have nothing to do with whether the actual fix works.
- Some verification steps need to run *on* the Droplet (anything reading
  its Docker logs); others are just external-client requests against the
  public domain and are actually *more* correct run from an external
  machine, not less. `DEPLOYMENT.md`'s Phase 7 didn't originally
  distinguish these at all.

None of these were mistakes in the underlying fixes — every one of them
was a genuine "which of two plausible contexts am I actually looking at"
error, the infrastructure equivalent of the local-file-drift problem this
project solved with sync-checks much earlier (doc 06, 16). The concrete
mitigation adopted for the `.env` case specifically: stop reusing one file
for two genuinely different contexts, and use a separate
`.env.compose-test`-style file for local Compose validation instead of
toggling the same file back and forth and risking forgetting which state
it's currently in.

## Real operational characteristics, not bugs — documented so they don't cause a false alarm next time

Three things looked like failures in the moment and weren't:

- **A `525` from Cloudflare on the very first request after a fresh
  `caddy` boot.** Caddy's own access log showed successful TLS handshakes
  for other requests moments later — this was the narrow window before
  the first Let's Encrypt certificate finished issuing, not a
  misconfiguration. A retry a few seconds later succeeded cleanly.
- **Better Stack's Live Tail lagging behind real time.** A shutdown/restart
  test initially looked like log shipping had silently stopped working;
  the entries appeared correctly, just delayed.
- **`docker compose stop app` doesn't come back on its own.** Obvious in
  hindsight, easy to miss mid-verification — `DEPLOYMENT.md` didn't
  originally mention the corresponding `start` at all.

All three are now documented inline in `DEPLOYMENT.md`'s Phase 10, at the
exact point they'd otherwise cause confusion again.

## The schema's own `RESTRICT` design, confirmed by accident

Attempting to clean up a verification account with a direct `DELETE`
failed on `audit_logs_performed_by_users_id_fk` — the same `RESTRICT`
behavior doc 02 describes as deliberate, encountered here not as a planned
test but as a genuine obstacle during real cleanup. Worth recording as a
small, honest data point: a design decision made early in the project,
justified in the abstract at the time, held up exactly as intended the
first time it was actually pushed against for real, years (in project
time) later. The practical resolution was to not fight it — register
under a different email rather than delete audit history to force a
hard delete through, and add a proper final-reset step (`docker compose
down -v`, now `DEPLOYMENT.md` Phase 11) for genuinely clearing test data,
rather than trying to make individual test artifacts surgically removable.

## Current status

`scripts/seed-exercises.ts`, `tsconfig.json`, and `docker-compose.prod.yml`
(a new `seed` service, mirroring `migrate`) all carry real fixes from this
pass, each verified against actual output rather than assumed correct
once the diff looked reasonable. `DEPLOYMENT.md` gained a genuine amount
of hard-won detail it didn't have before this exercise: the deploy-key
persistence step, the rebuild-before-you-rely-on-it rule, concrete
copy-pasteable commands for Phase 7 (verified against the real `RegisterDto`/
`LoginDto`/controller routes, not improvised), the local-vs-Droplet
distinction for where each check needs to run, and a new Phase 11 for a
final clean reset once verification is complete.

Phases 8 through 11 — firewall lockdown, backups, observability, and the
final clean reset — were completed afterward with no further findings
worth recording individually. Combined with Phase 7's verification earlier
in this same document, the redeploy is now fully validated end to end: a
freshly recreated Droplet, running the current code (RLS rollout, the
full bug-hunt series, and everything found during this exercise itself),
following `DEPLOYMENT.md` as written start to finish. This is the first
time that's been true of this project's deployment documentation — every
earlier version was believed correct; this one has actually been run.

