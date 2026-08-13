# Row-Level Security, step zero: a restricted role for the app's own queries

This document covers the first step of an incremental Row-Level Security
rollout — not RLS itself yet, but the prerequisite that makes RLS capable
of doing anything at all in this app. Nothing in this step enables RLS on
any table; it exists entirely to fix a structural fact about how the app
connects to Postgres that would otherwise make every future policy inert.

## Why this had to happen before anything else

Revisiting the original architecture-decision writeup surfaced a real
overclaim: it described Row-Level Security as an active guarantee ("a
patient can only ever `SELECT` their own records, even if a bug exists in
the application layer"), when in fact RLS had never been implemented —
every authorization check in this app has always lived entirely in the
application layer (NestJS guards, plus service-level checks like
`isPatientManagedBy`/`assertCanModify`). That's a legitimate, common
design, but a materially weaker guarantee than RLS specifically provides,
and the gap is worth naming plainly rather than letting the overclaim
stand unaddressed.

The original writeup was deliberately left as it was written, rather than
edited after the fact: it was an accurate description of the plan at the
time, and quietly rewriting it once the plan changed would trade a real
record of how the design evolved for a cleaner-looking one. This document
is that correction — the place where the gap between the original plan
and what actually got built is made explicit, not a patch to the
original file itself.

Closing that gap for real means enabling genuine, database-enforced RLS —
but doing that immediately would have accomplished nothing, for one
specific, absolute reason: **Postgres superusers bypass Row-Level Security
unconditionally.** Not "unless a flag is set" — there is no setting that
makes RLS apply to a superuser connection, not even the strongest form
(`FORCE ROW LEVEL SECURITY`, which normally applies RLS even to a table's
own owner, explicitly carves out an exception for superusers too). Every
connection this app has ever made — migrations, the main query pool, the
session store — has gone through one function, `getDatabaseUrl()`, using
`POSTGRES_USER` from `.env`. In the official Postgres Docker image,
`POSTGRES_USER` is created as a superuser by default. So: writing
`CREATE POLICY` statements against the schema as it stood would have
produced SQL that looked like real security but silently did nothing —
arguably worse than no RLS at all, since it would misrepresent what's
actually protected the exact same way the original architecture-doc
overclaim did, just baked into the database itself instead of a markdown
file.

## What was actually built

### A second, deliberately powerless role

A new Postgres role, `stride_app`, was created with three properties that
all matter for the same reason: it is not a superuser, it owns no tables,
and its only grants are `SELECT, INSERT, UPDATE, DELETE` on every table
plus `USAGE, SELECT` on every sequence (needed for `RETURNING id` on
inserts against serial/identity primary keys) — no `CREATE`, `ALTER`, or
`DROP` rights of any kind. This is the role every one of the app's *normal*
queries now runs as. Two Postgres mechanisms had to work together for RLS
to eventually have real teeth against this role specifically: not being a
superuser (the absolute rule above), and not owning the tables either —
table owners also bypass RLS by default unless a policy is explicitly
forced, and even then only non-superusers are actually subject to that
force. `stride_app` fails both exemptions on purpose, so a future policy
enabled on a table this role queries will be the first role in this
project actually subject to one.

One easy-to-miss detail, included specifically to avoid a recurring
maintenance trap: `ALTER DEFAULT PRIVILEGES ... GRANT ... TO stride_app`
was set at the same time as the role itself, scoped to whichever role runs
migrations. Without it, every future migration that adds a table or
sequence would silently leave that new object ungranted to `stride_app` —
not a loud failure, just a query against a brand-new table quietly
returning a permissions error the first time the app actually tried to use
it, in production, discovered the hard way. With it, new tables inherit the
same grants automatically going forward.

### A standalone, idempotent setup script

`scripts/create-app-role.ts` creates the role if it doesn't exist, or syncs
its password via `ALTER ROLE` if it does — safe to re-run, matching the
same idempotent-by-design pattern this project already established for
`scripts/seed-exercises.ts`. It deliberately connects using the *existing*
owner connection (`getDatabaseUrl()`), not the role it's creating — issuing
`CREATE ROLE` and `GRANT` statements requires real administrative rights,
which is exactly the category of privilege `stride_app` is never meant to
have. It lives outside `src/`, is never imported by `AppModule`, and is run
manually, the same operational shape as every other one-off setup script in
this project (`seed-exercises.ts`, `backup-database.sh`).

This had to be a standalone script rather than a Drizzle migration file for
a specific reason: migrations are plain, versioned SQL checked into git,
and `CREATE ROLE ... PASSWORD '...'` needs a real secret — baking one into
a migration file would put it in git history permanently, the exact
mistake `SESSION_SECRET` and `MFA_ENCRYPTION_KEY` are deliberately kept out
of version control to avoid.

### The connection split

`getDatabaseUrl()` — the one function every connection in this app used to
go through — was left completely untouched, still returning the owner
connection. A new, separate function, `getAppDatabaseUrl()`, was added
alongside it, reading `POSTGRES_APP_USER`/`POSTGRES_APP_PASSWORD` instead.
Only one call site in the entire app was actually switched to it:
`drizzle.provider.ts`, the factory behind the `DRIZZLE` injection token
every service in the app uses for its real query traffic. Everything else
that genuinely needs owner-level rights — `drizzle-kit`'s own config (real
DDL rights required to run migrations at all), the session store's
connection pool, and the role-creation script itself — was deliberately
left on the original, unchanged `getDatabaseUrl()`.

This is a narrow, single-purpose split, not a general "the app now has two
identities" architecture change: exactly one thing (the app's own ORM
query layer) moved to the restricted role: nothing else needed to, and
widening the change further would have meant more blast radius for no
additional benefit toward the actual goal.

### Docker Compose

`docker-compose.prod.yml` gained a `create-app-role` service mirroring the
existing `migrate` service's shape exactly — same builder-stage/`env_file`
pattern, and critically, the same `profiles: ["tools"]` gate, so it never
runs automatically with a plain `docker compose up`. It has to be invoked
explicitly, the same operational discipline already established for
running migrations in production. Local dev's `docker-compose.yml`
deliberately did *not* get an equivalent service — the app runs directly on
the host in dev, not in a container, so the equivalent step there is just
running `npm run db:create-app-role` directly.

## Consequences for actually running or deploying the app

**Two new required environment variables**, `POSTGRES_APP_USER` and
`POSTGRES_APP_PASSWORD`, both enforced by `validateEnv()` at boot the same
fail-loudly way every other required secret already is — a deployment
missing either one will refuse to start at all, with an error message that
points directly at `npm run db:create-app-role` as the fix, rather than
surfacing as a confusing connection failure buried inside
`drizzle.provider.ts` sometime later.

**One new manual step before the app can boot for the first time** (or
after a fresh database reset): `npm run db:create-app-role` has to actually
run, successfully, before `npm run start:dev` (or the equivalent Compose
service in production) will be able to connect at all. This is a genuine
new step in the setup sequence — anyone following the existing installation
instructions from scratch needs this added between "run migrations" and
"start the app."

**No behavioral change to the running application today.** No table has
RLS enabled yet, so every query the app issues — now running as
`stride_app` instead of the superuser — returns exactly what it always has.
This was verified directly, not assumed: the full unit and e2e suite passed
unchanged against the app running on the new role, and a standalone check
confirmed the role can genuinely do everything the app's normal traffic
needs (`SELECT`/`INSERT`/`UPDATE`/`DELETE`, including sequence-backed
primary keys) while being unable to do anything the app was never supposed
to do in the first place (`CREATE TABLE`, `ALTER TABLE`, and `DROP TABLE`
were all attempted directly as this role and confirmed rejected).

**One real test-infrastructure consequence, not an application one**:
every e2e spec's own cleanup logic used to `TRUNCATE` tables between test
runs using the app's own connection — which worked fine under the old,
superuser-backed connection, but `TRUNCATE` is a DDL-adjacent privilege
`stride_app` correctly does not have. This isn't a gap in the new role; a
test harness needing to wipe an entire table between runs is a different,
more privileged operation than anything the running application itself
should ever need to do, so it was correctly *not* granted. Each spec's
cleanup was moved to use its already-existing, separately-instantiated
`sessionPool` (which still connects as the owner) instead — a test-only
fix, with no equivalent change needed anywhere in actual application code.

**One thing worth remembering, not yet a problem**: the role-creation
script interpolates `POSTGRES_APP_PASSWORD` directly into a SQL string,
since Postgres has no parameterized-identifier syntax for a `CREATE ROLE`
statement. This is safe as long as the password never contains a single
quote — true by construction if it's generated the way `.env.example`
recommends (`openssl rand -hex 24`, hex characters only), but worth
knowing if that value is ever hand-typed to something else instead.

## What this unlocks

Every future step is now small and independently reviewable, because the
hard, one-time part — making Postgres capable of enforcing anything against
this app's actual query traffic — is done. Adding real RLS to any single
table going forward is always the same three-part recipe: enable and force
RLS on that table, write a policy whose logic mirrors that table's already-
correct application-layer rule, and verify it two ways — the existing test
suite still passing, and a direct, adversarial query as `stride_app`
confirming a row it shouldn't be able to see genuinely doesn't come back.
`medical_files` — the single highest-stakes, already-audited-on-read table
in this schema — is the natural first candidate, but nothing about this
step commits to covering any particular set of tables, or all of them; each
one is now a deliberate, separate decision rather than a package deal.
