# Row-Level Security: the six-table rollout

This document picks up directly from "Row-Level Security, step zero" —
the restricted `stride_app` role that made any of this possible at all —
and covers the six tables (eight, counting the child tables) that
actually got real, database-enforced policies: `medical_files`,
`audit_logs`, `assigned_programs`+`assigned_program_exercises`,
`sessions`+`session_exercises`, `conversations`+`messages`,
`exercises`+`program_templates`+`template_exercises`, and finally
`users`. Each pass is covered here for what was genuinely distinctive
about it, not as a repeat of the SQL itself — that lives in the
migration files, which are the actual source of truth.

## The pattern that held, and why it was worth extracting early

`medical_files` established the shape everything else reused: a shared
`withRlsContext(db, currentUser, fn)` helper — a transaction that sets
`app.current_user_id`/`app.current_role` via `set_config(..., true)`
before running the caller's queries — and a small set of reusable SQL
functions (`rls_is_admin()`, `rls_current_user_id()`,
`rls_practitioner_manages_patient()`) added once `assigned_programs`
needed the same clinic-membership condition a second time, rather than
inlining it repeatedly. Extracting both early, rather than waiting for
the pattern to prove itself further, meant every later pass was mostly
"apply the known template, then find out what's actually different this
time" instead of rebuilding the mechanism from scratch six times.

The template itself: thread `currentUser` through whatever private
helper method a table's controllers already shared (`findProgramOrThrow`,
`findSessionOrThrow`, `findConversationOrThrow`, and so on), wrap only
the queries that actually touch an RLS-protected table, and leave
business-rule logic (ownership messages, time windows, permutation
checks) entirely alone — RLS's job was always the structural boundary,
never a replacement for the specific, human-readable errors the app
already produced.

## Where the shape genuinely differed, table by table

**`medical_files`** set the first real precedent, and the one that
recurred most often afterward: once a table's `SELECT` policy filters
who can see a row, any method that fetches-then-authorizes collapses its
own `403` into a `404` for a caller RLS never let the row reach in the
first place. Decided once, deliberately, rather than engineered around:
not confirming a record's existence to someone unauthorized to see it is
the *more* conservative posture, not a regression. Every subsequent
table re-derived this same tradeoff on its own terms rather than
assuming it — and in `exercises`/`program_templates`, it turned out not
to apply at all (see below).

**`audit_logs`** introduced the first genuinely asymmetric table: read
restricted to admin, write (`WITH CHECK (true)`) deliberately
unrestricted, because there's no per-row write rule to encode when a
`LOGIN_FAILURE` entry is legitimately written by someone who is
specifically *not* authenticated as the account it's filed against. This
pass also surfaced two Postgres facts worth knowing going forward, not
just once: `RETURNING` after an `INSERT` is checked against the table's
`SELECT` policy too, not just `WITH CHECK` (irrelevant here, since
`audit_logs`' writer never calls `.returning()`, but real for
`medical_files`, where it only worked because that table's `INSERT` and
`SELECT` policies happen to encode the identical condition); and running
more than one query through the same `withRlsContext` transaction trades
away real parallelism, since a transaction is pinned to one physical
connection by definition — measured directly (two queries: ~530ms
pooled/parallel vs. ~1006ms transaction-bound/serial), not assumed.

**`assigned_programs` + `assigned_program_exercises`** was the first
table where the write rule was *narrower* than the read rule in a way
that mattered: a patient can view their own assigned program but can
never manage it, full stop, even their own — unlike `medical_files`,
where authorization mostly tracked one rule shape. This is also where
the "child inherits parent visibility" simplification first appeared for
`SELECT` — a child table with no independent authorization rule of its
own can just check whether the parent row is selectable at all, relying
on the parent's own `FORCE ROW LEVEL SECURITY` to do the real filtering,
rather than re-deriving the same clinic-membership condition a second
time. This pass also produced the first scope correction: `SessionsService`
turned out to query `assigned_programs`/`assigned_program_exercises`
directly, outside the one service the task was originally scoped to —
caught, flagged, and fixed in the same pass rather than shipped as a
silent gap.

**`sessions` + `session_exercises`** was the strictest rule in the whole
rollout: only the owning patient may ever write, with *no* admin or
practitioner branch at all, even though both can read. It also produced
the sharpest proof of a real regression: `SessionsService.create()` had
already been partially wired for RLS as a side effect of the
`assigned_programs` pass, but its final call —
`findSessionWithExercises()`, deliberately outside the insert transaction
since the transaction had already committed by then — was still running
on the plain, unscoped connection. Once `FORCE ROW LEVEL SECURITY` was
live, that call would have returned nothing. This wasn't caught by
reasoning about it; it was caught by deliberately reverting just that
one fix and re-running the e2e suite to watch `create()` actually fail
with a `500`, then restoring it — proof, not inference.

**`conversations` + `messages`** had visibility living directly on two
columns (`practitionerId`/`patientId`), no clinic join needed at all for
read — the first and only table where participation was that simple.
Creating a conversation, though, needed a genuinely new kind of check:
the existing `rls_practitioner_manages_patient()` function assumes the
*current session* is the practitioner, but a patient starting a
conversation needs the inverse direction of the identical clinic-overlap
question. Rather than force the existing function to cover a case it
wasn't built for, a second, role-agnostic function
(`rls_clinic_overlap(user_a, user_b)`) was added specifically for it.
This pass also caught a correctness risk *before* it shipped, not after:
`createConversation`'s idempotent "find existing or insert" flow needed
both queries genuinely inside the same RLS-scoped transaction, or a
second attempt to start an already-existing conversation would never
find it and would hit the unique constraint instead of gracefully
returning the existing row.

**`exercises` + `program_templates` + `template_exercises`** was the one
genuine exception to nearly everything above. Both parent tables are
visible to any authenticated user by design — a shared library, not
per-patient data — so their `SELECT` policies are a plain `USING (true)`,
and for the first time, entire categories of query (`findAll`, `findOne`,
the existence-check inside `addExercise`) needed no RLS wrapping at all,
since their policies never consult a session setting. This also meant
the usual "read becomes invisible, `403` becomes `404`" tradeoff simply
never applied here — every unauthorized-write test kept its original
`403`, because the row was never hidden from the fetch-then-check flow
to begin with, which was the correct, predicted outcome rather than a
surprise.

**`users`**, saved for last deliberately, turned out to be the hardest
table in the rollout, and not for the reason originally guessed. The
assumption going in was that it would need a join to `user_roles` to
know a target row's own role — it didn't, because
`isPatientManagedBy()`, and the SQL function mirroring it, never checked
the target's role either, only clinic overlap; the existing function
reused directly. The real difficulty was structural: `SELECT` cannot be
restricted at all, for a load-bearing reason no other table had — login
itself (`findByEmailWithHash`) runs before any session exists, so a
restrictive read policy would break authentication permanently, not just
narrow visibility. `INSERT` can't fully encode "a practitioner may only
create a patient," since a user's role lands in the sibling `user_roles`
table within the same transaction, invisible to a `WITH CHECK` on `users`
itself. And two genuinely unauthenticated flows — public self-registration
and the one-time founding-admin bootstrap — insert into `users` with no
session to set as context at all, requiring an explicit third policy
branch for "no context set," reasoned through carefully rather than
assumed to be safe (it isn't a new exposure — `POST /auth/register` was
already fully public before RLS existed).

This pass also caught two real problems that would have shipped
otherwise. First, a genuine Postgres subtlety, worked out independently
and confirmed rather than guessed at: a custom session setting's "off"
state is `NULL` only on a connection that has *never once* had it set;
the moment any other request on that same pooled connection sets real
context and its transaction commits, the setting reverts to an empty
string, not back to `NULL`. Under connection pooling, a genuinely virgin
connection is the exception, not the rule — a bare `IS NULL` check on
the bootstrap branch would have made it fire almost never, breaking
registration intermittently in a way that would have looked like flaky
infrastructure, not a policy bug. Fixed with `NULLIF(..., '') IS NULL`.
Second, `AuthService` turned out to have five direct writes to `users`
entirely outside `UsersService` — MFA setup/enable/disable, and the two
token-based password-reset methods. The three authenticated MFA methods
just needed the real session threaded through, same as everywhere else.
The two token-based flows had no session at all, and — rather than
loosen `UPDATE` with the same "no context" branch `INSERT` got, which
would have been a materially bigger hole (a stray unrestricted `INSERT`
can only ever create a new row; a stray unrestricted `UPDATE` could
target any existing one) — they use a synthetic self-context built from
the identity already proven out-of-band: an email match for
`forgotPassword`, a token-hash match for `resetPassword`. Not a
loosening of the policy, just an accurate description of what's already
true by the time the write happens.

## A real operational incident, not a design one

Midway through the rollout, migration `0005` (`conversations`/`messages`)
was applied by hand — `docker exec ... psql`, not `drizzle-kit migrate`
— during a session where the automated path wasn't reached for. This
went unnoticed until a direct question surfaced it: would a fresh
deployment actually pick up all of this? Investigating properly (rather
than trusting the "should be fine" instinct) found the real state: every
migration `0000` through `0004` had genuinely gone through real
`drizzle-kit migrate` runs — confirmed by matching stored hashes and
timestamps in `__drizzle_migrations`, not assumed — and `0005` alone was
missing its bookkeeping row, in both `stride` and `stride_test`
identically. Confirmed empirically, not just predicted, that this would
break a real deploy: running `drizzle-kit migrate` for real against a
disposable copy of the test database failed immediately with `function
"rls_clinic_overlap" already exists`. Fixed by inserting the one missing
row — the actual hash `drizzle-kit` computes for that file, not a
recomputed one — into both databases, `stride_test` first, each verified
independently by actually re-running `migrate` again and confirming a
clean exit with nothing pending, rather than trusting the row's mere
presence. Production was never at risk; it's never had any of this
applied yet, so its first real run goes through every migration in order
with nothing to reconcile. Worth recording as what it actually was: a
one-off deviation under time pressure, not a hidden pattern needing
retroactive justification, and a reminder that even a fully correct
migration file isn't equivalent to a properly applied one.

## The verification discipline, held constant across all six passes

The same loop that governed every fix in the earlier bug-hunt work
applied here without exception: every SQL claim checked against the real
schema before being trusted, every application-code diff read in full
rather than sampled, every predicted test change (or, in `exercises`'
and `users`' cases, predicted *lack* of change) confirmed against the
actual updated test file rather than taken on a summary's word. Adversarial
verification always ran in both directions, not just the rejection case
— a managing practitioner's or an owning patient's legitimate write
confirmed to actually succeed, not only an unrelated party's confirmed
to fail, since a policy that rejects everything indiscriminately would
pass a suite that only tested rejection. And where a scope gap turned up
mid-pass — `SessionsService` touching `assigned_programs`, `AuthService`
writing to `users` directly — it was investigated and fixed within the
same pass rather than deferred, with the reasoning recorded, not just
the diff.

## Current status

All six tables carry real, `FORCE`-enforced Row-Level Security, verified
adversarially at the SQL level and exercised by the full application
test suite with no mocks standing in for the database. Explicitly out of
scope for this rollout, and worth naming rather than leaving implicit:
`user_roles`, the three profile tables, `clinics`, and `user_clinics`
carry no RLS policies of their own. `user_clinics` in particular is a
deliberate, permanent exception — it's the trust-anchor every clinic-scoped
policy above depends on via its own `EXISTS` subqueries; giving it a
restrictive policy of its own would risk silently narrowing what every
other table's policies can see through it. The others were never in the
original six-table plan and remain open questions for a future pass, not
oversights in this one.
