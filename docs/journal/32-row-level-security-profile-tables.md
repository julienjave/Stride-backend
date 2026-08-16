# Row-Level Security, the three profile tables: Pass 3

This is Pass 3 of `RLS-ROADMAP.md`, covering `practitioner_profiles`,
`patient_profiles`, and `admin_profiles` — the last item on the roadmap
before the `user_clinics` `SECURITY DEFINER` spike (Pass 4). Docs 30 and 31
were prerequisite work, not incidental: doc 30 built the only real read
path against these three tables (`UsersService.attachProfile()`/
`attachProfilesToMany()`), and doc 31 built the only real `UPDATE` path
(`UsersService.update()`) — both landed specifically so this pass could be
designed against corrected, real behavior instead of the "nothing reads
this" gap that predated them. The roadmap itself expected three tables and
three policies; doc 31 changed that to four real command types once it
added a genuine `UPDATE` path where none existed before, so this pass
needed `SELECT`, `INSERT`, *and* `UPDATE` policies for each table, not two.

## Scope, confirmed by a fresh grep, not trusted from the roadmap's prompt

- **`SELECT`**: `UsersService.attachProfile()` (`create`/`findOne`/`update`/
  `softDelete`/`updateAvatar`) and `attachProfilesToMany()` (`findAll`/
  `findPatientsForPractitioner`), both querying all three tables
  conditionally on the target's held roles. `attachProfile()`'s `dbOrTx`
  parameter defaults to `this.db`, so any call site that doesn't pass a
  real `tx` explicitly runs with whatever RLS context (if any) that
  connection happens to carry — and `AuthService.validateUser()`, the
  login path itself, calls it with no context at all, before any session
  exists.
- **`INSERT`**: `UsersService.create()` (all three tables, gated on
  `dto.role`), `UsersService.grantRole()` (all three, admin-only route,
  already running inside `withRlsContext` per doc 29's own scope-gap fix —
  confirmed, not re-fixed), and `AuthService.registerClinic()`
  (`admin_profiles` only, the founding-admin bootstrap, a plain
  `db.transaction()` with no session).
- **`UPDATE`**: `UsersService.update()` only, all three tables, always
  inside `withRlsContext` with a real `currentUser` — unlike
  `users_insert`/`user_roles_insert`/`clinics_insert`, this route has no
  unauthenticated bootstrap path at all (`UpdateUserDto` has no equivalent
  to `CreateUserDto`'s public-`register()` branch).
- **`DELETE`**: none anywhere, re-confirmed directly by grep rather than
  inferred from any other table's precedent — no
  `.delete(practitionerProfiles/patientProfiles/adminProfiles)` call exists
  in `src/`, and `scripts/` touches none of these three tables either.

This matched the roadmap's own expectations closely, with one real
correction: the roadmap described three policies; the actual shape needed
was `SELECT` + `INSERT` + `UPDATE` per table (nine policies total), because
doc 31 had, by design, already closed the "no `UPDATE` path exists" gap
before this pass started.

## `SELECT`: `USING (true)`, proven the same way Pass 2 proved its rejected candidate

Same load-bearing reasoning as `users_select` (0007) and `user_roles_select`
(0009), not the lighter "no sensitivity" call `clinics_select` made. A
narrower self-or-admin-or-managing-practitioner candidate — the shape this
table's `UPDATE` policy actually uses — was drafted and adversarially
tested before being rejected, not assumed to fail:

With that candidate policy live on `patient_profiles` in `stride_test` and
a real patient row seeded (`date_of_birth '1990-05-15'`), the exact query
`attachProfile()` issues during login — a bare
`SELECT * FROM patient_profiles WHERE user_id = $1` through `stride_app`,
zero session context set, the precise shape of `AuthService.validateUser()`
calling `attachProfile()` with no `tx` — returned:

```
 user_id | phone | address | date_of_birth
---------+-------+---------+---------------
(0 rows)
```

Zero rows, for a real patient's own profile. Under the narrow policy,
`patientProfile` would silently vanish from every patient login response —
not a hard failure the way `user_roles_select`'s rejected candidate
produced (a wrong `400`/`403`), but a real regression: it would silently
resurrect the exact "written once, never read back" bug doc 30 had just
finished fixing, via a different mechanism (RLS instead of a missing read
path). Swapping in `USING (true)` and re-running the identical query
confirmed the fix — the same real row came back, with no context set,
exactly matching a genuine no-context login. `stride_test` was left in its
original state once the experiment concluded: the candidate policy
dropped, RLS disabled again on `patient_profiles`, the scratch user deleted
(cascading to its `patient_profiles`/`user_roles` rows), re-confirmed
empty. The same structural cause (`attachProfile()` querying via `this.db`,
never a `tx`) applies identically to `practitioner_profiles` and
`admin_profiles` — not re-tested table-by-table, since `attachProfile()`
is one shared function, not three independent implementations.

This doesn't expose anything downstream doesn't already gate: every real
call site that reaches `attachProfile()`/`attachProfilesToMany()` does so
only after the app-layer check that decides whether the underlying user
row is returned at all — `UsersController`'s `isSelf`/`isAdmin`/
`isManagingPractitioner` for single-user routes, `findAll()` being
admin-only, `findPatientsForPractitioner()`'s row set already being
clinic-scoped by its own join before the batched read ever runs. RLS
provides no additional read-side defense-in-depth on these three tables,
the same conclusion `users_select` and `user_roles_select` each already
reached for their own tables.

## `INSERT`: confirmed asymmetric across the three tables, not assumed

- **`practitioner_profiles`: admin session only.** `create()` forbids a
  practitioner session from inserting `dto.role !== 'patient'` at all, so a
  practitioner session can never reach this table's insert branch;
  `register()` (the one no-context caller of `create()`) hardcodes
  `role: UserRole.PATIENT` unconditionally, so the no-context path can't
  reach it either. `grantRole()` is `@Roles(UserRole.ADMIN)`-gated at the
  controller. `registerClinic()` never touches this table. No
  practitioner-session or no-context branch exists in the shipped policy,
  because no real call site needs one.
- **`patient_profiles`: admin, practitioner, or no context.** The exact
  shape of `users_insert` (0007) — this table has no `role` column of its
  own to gate on the way `user_roles_insert`'s `WITH CHECK` could, so the
  finer rule ("a practitioner may only create a patient," already checked
  once at the app layer) stays enforced solely by `UsersService.create()`.
  The no-context branch covers `register()`'s public self-registration
  bootstrap, which hardcodes `role: UserRole.PATIENT`.
- **`admin_profiles`: admin session, or no context specifically when no
  admin exists yet.** `create()`'s admin branch and `grantRole()` both
  satisfy `rls_is_admin()` directly. `registerClinic()` is the one
  no-context caller. This is where the pass's one real bug turned up — see
  below.

`grantRole()`'s conditional inserts (all three tables, admin-only,
already running inside `withRlsContext` since doc 29's own fix) needed no
change — confirmed by the adversarial suite below, not just re-stated from
doc 29's account of a different table.

## The real bug: a self-defeating bootstrap check, caught by the full e2e suite, not by inspection

The first version of `admin_profiles_insert`'s no-context branch copied
`clinics_insert`/`user_roles_insert`'s own bootstrap invariant verbatim:

```sql
NULLIF(current_setting('app.current_role', true), '') IS NULL
AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
```

This looked identical to two already-proven policies, and it was wrong.
Running the actual migration against the full e2e suite (not a targeted
scenario — every suite, since every suite's fixture setup calls
`registerClinic()` to bootstrap its founding admin) failed **every single
suite** identically:

```
Error: Failed query: insert into "admin_profiles" ("user_id", "position") values ($1, default)
Failed to bootstrap the founding admin: {"statusCode":500, ...}
```

The cause: `registerClinic()` runs `clinics → users → user_roles(role='admin') →
admin_profiles`, all four inserts inside **one transaction**. By the time
execution reaches `admin_profiles`, the `user_roles(role='admin')` row for
this exact new user has already been inserted by the *preceding* statement
in the same transaction — and a transaction always sees its own prior
writes, committed or not. A plain `NOT EXISTS (admin)` is therefore already
false by the time `admin_profiles` is reached: the bootstrap's own earlier
statement trips its own later check. This is *not* the situation
`clinics_insert` or `user_roles_insert` are in — `clinics` is inserted
*before* `user_roles` in the same transaction, and `user_roles_insert`'s
own `NOT EXISTS` runs at the exact moment that row is being created, before
it exists to see itself. Copying a working pattern into a structurally
different position in the same transaction broke it, and only running the
real flow end-to-end surfaced that — reasoning about the SQL in isolation
would not have.

**Fixed** by excluding the row's own `user_id` from the check — "no
*other* admin exists yet," not "no admin row exists at all":

```sql
NULLIF(current_setting('app.current_role', true), '') IS NULL
AND NOT EXISTS (
  SELECT 1 FROM user_roles ur
  WHERE ur.role = 'admin' AND ur.user_id <> admin_profiles.user_id
)
```

By the time `admin_profiles` is reached, the only `user_roles(role='admin')`
row that can possibly exist is the one for this same new user (an
admin-less database is the precondition `registerClinic()`'s own app-layer
check already enforced before the transaction opened at all), so requiring
no *different* admin to exist is equivalent to the intended invariant
without being defeated by the transaction's own prior statement. Re-run
after the fix: full e2e suite, 107/107, clean.

## A second, independent bug: a migration bookkeeping trap in `_journal.json`

Separately from the policy logic, the newly-generated migration was
silently **never applied** the first two times `drizzle-kit migrate` was
run against it, despite the CLI reporting `migrations applied
successfully!` both times with no error. Traced to drizzle-orm's own
migrator (`node_modules/drizzle-orm/pg-core/dialect.js`): it fetches only
the single most-recently-applied migration
(`order by created_at desc limit 1`) and applies each pending file only if
`lastDbMigration.created_at < migration.folderMillis` — comparing against
that one row, not against whether the file's hash is already recorded.

Every existing entry in `_journal.json` (migrations `0001`–`0009`) carries
a `when` timestamp exactly 86,400,000 ms (one day) after the previous
entry's — a deliberately maintained synthetic sequence, not real
`Date.now()` output from when each file was actually generated. `drizzle-kit
generate --custom` populates `when` with the real current timestamp at
generation time, and this session's real "now" landed *earlier* than
migration `0009`'s synthetic future-dated `when` (`1787219545000`, which
decodes to a date after this project's fictional "current" date). The
comparison above, `1787219545000 < <new file's real, smaller timestamp>`,
evaluated false — so the migrator silently treated the new file as
already superseded and skipped executing it entirely, without erroring,
because nothing in that comparison distinguishes "this migration already
ran" from "this migration's timestamp doesn't sort after the last one."

Confirmed directly, not inferred: a deliberately broken SQL statement was
appended to the migration file and `drizzle-kit migrate` was re-run — it
still reported success with the broken file present, proving the file's
contents were never being executed at all. **Fixed** by setting migration
`0010`'s `when` to `1787305945000` (continuing the same +86,400,000 ms
sequence the project's own prior entries already established), which made
`drizzle-kit migrate` actually apply the file. Confirmed idempotent
afterward: re-running `migrate` a second time on both `stride` and
`stride_test` left both at 11 rows in `__drizzle_migrations`, no error, no
duplicate application.

This has a real, practical implication worth stating for whoever runs
`drizzle-kit generate --custom` next in this project: **the `when` value it
writes cannot be trusted as-is if any prior journal entry carries a
synthetic, forward-dated timestamp** (as every entry since `0001` in this
project does) — it must be checked against the previous entry's `when` and
bumped forward if it doesn't already sort later, or the generated migration
will silently no-op, indefinitely, with no error at any point in the
pipeline.

## `UPDATE`: `users_update`'s exact condition, reused unchanged across all three tables

Authorization for *who* may update a profile already fully happens at the
app layer — `UsersController.update()`'s existing `isSelf`/`isAdmin`/
`isManagingPractitioner` check, unchanged by this pass, plus
`UsersService.update()`'s own target-role field-applicability check (doc
31). This policy is a database-level backstop mirroring that same rule,
not a new one — so rather than design a new condition, `users_update`'s
(0007) exact current shape was found and reused verbatim, against each
table's own `user_id` column:

```sql
USING (
  rls_is_admin()
  OR user_id = rls_current_user_id()
  OR rls_practitioner_manages_patient(user_id)
)
WITH CHECK ( ... same ... )
```

`rls_practitioner_manages_patient()` doesn't inspect the target row's own
role (pure clinic-overlap, mirroring `UsersService.isPatientManagedBy()`,
which `users_update` already reuses this way against *any* `users.id`
regardless of role) — reused unchanged here for the identical reason. All
three tables get the identical policy shape, deliberately: the same way
`users_update` covers `uploadAvatar()`'s narrower self-or-admin rule
without a dedicated branch for it, this policy covers the broadest
legitimate case across all three tables and leaves the finer per-field,
per-target-role rule enforced solely by `UsersService.update()`.

## Adversarial verification, both directions, all three tables, every branch

A scratch fixture was seeded directly in `stride_test` (real, committed
rows via the owner connection): an admin, two practitioners (one sharing a
clinic with a patient, one with no clinic at all), a managed patient, an
unmanaged patient, and one bare candidate user with no role or profile.
Every scenario below ran as `stride_app` (via `SET LOCAL ROLE stride_app`
from an owner connection, so state setup and the restricted-role test
statement could share one transaction), each wrapped in its own
`BEGIN`/`ROLLBACK` so nothing persisted:

| # | Scenario | Expected | Result |
|---|---|---|---|
| T1 | `practitioner_profiles` INSERT, admin session | allow | `INSERT 0 1` |
| T2 | `practitioner_profiles` INSERT, practitioner session | reject | RLS violation |
| T3 | `practitioner_profiles` INSERT, no context | reject | RLS violation |
| T4 | `practitioner_profiles` INSERT, patient session | reject | RLS violation |
| T5 | `patient_profiles` INSERT, admin session | allow | `INSERT 0 1` |
| T6 | `patient_profiles` INSERT, practitioner session | allow | `INSERT 0 1` |
| T7 | `patient_profiles` INSERT, no context | allow | `INSERT 0 1` |
| T8 | `patient_profiles` INSERT, patient session | reject | RLS violation |
| T9 | `admin_profiles` INSERT, admin session | allow | `INSERT 0 1` |
| T10 | `admin_profiles` INSERT, practitioner session | reject | RLS violation |
| T11 | `admin_profiles` INSERT, no context, genuinely admin-less DB, candidate holds the only admin role | allow | `INSERT 0 1` |
| T12 | `admin_profiles` INSERT, no context, a *different* admin already exists, candidate holds no role | reject | RLS violation |
| T13 | `admin_profiles` INSERT, no context, candidate holds its own admin role **and** a different real admin also exists | reject | RLS violation |
| T14 | `patient_profiles` UPDATE, self | allow | `UPDATE 1` |
| T15 | `patient_profiles` UPDATE, admin | allow | `UPDATE 1` |
| T16 | `patient_profiles` UPDATE, managing practitioner (shared clinic) | allow | `UPDATE 1` |
| T17 | `patient_profiles` UPDATE, non-managing practitioner (no shared clinic) | reject | `UPDATE 0` |
| T18 | `patient_profiles` UPDATE, unrelated patient | reject | `UPDATE 0` |
| T19 | `practitioner_profiles` UPDATE, admin | allow | `UPDATE 1` |
| T20 | `practitioner_profiles` UPDATE, self | allow | `UPDATE 1` |
| T21 | `admin_profiles` UPDATE, admin | allow | `UPDATE 1` |
| T22 | `admin_profiles` UPDATE, self | allow | `UPDATE 1` |

T13 specifically exists to confirm the fixed bootstrap condition isn't
over-broad — a candidate holding its own admin role does *not* get a free
pass once a genuinely different admin exists, closing off the obvious way
the T11 fix could have been too permissive. `UPDATE`'s reject cases (T17,
T18) come back as `0` rows rather than an error — expected, since `UPDATE`
is filtered by `USING`, not rejected by `WITH CHECK`, the same shape every
prior `UPDATE` policy in this rollout has. A final sanity `SELECT`
confirmed the candidate user has zero rows across all three tables and
`user_roles` after every scenario — every transaction genuinely rolled
back, nothing persisted. The fixture (six users, one clinic) was deleted
via the owner connection afterward; `stride_test` was re-confirmed back to
its pre-fixture state.

## Full verification

- Exhaustive scope search re-run fresh across all of `src/` and `scripts/`,
  not trusted from the roadmap's own prompt or docs 30/31's account of
  themselves — matched the expected scope with one real correction: three
  command types needed policies (`SELECT`/`INSERT`/`UPDATE`), not two,
  because doc 31 added a genuine `UPDATE` path before this pass started.
- The roadmap's own implied `SELECT` candidate (self/admin/managing-
  practitioner) adversarially proven to silently drop profile data from
  every login response before being rejected — real SQL, real zero-row
  result, not reasoning alone.
- One real application-layer bug found and fixed:
  `admin_profiles_insert`'s bootstrap condition, self-defeated by its own
  transaction's prior statement — caught by running the actual, complete
  e2e suite against the real migration, not by inspection, since every
  suite's fixture setup depends on `registerClinic()` succeeding.
- One real tooling/infrastructure bug found and fixed: a migration
  bookkeeping trap in `drizzle-orm`'s `created_at`-comparison migrator,
  surfaced by this project's own established (and, until now, unexamined)
  convention of hand-maintained synthetic journal timestamps.
- All 22 adversarial `INSERT`/`UPDATE` scenarios (13 allow, 9 reject),
  covering every branch of every policy on all three tables, confirmed
  directly against `stride_app`.
- `drizzle-kit migrate` re-run fresh against both `stride` and
  `stride_test` after the fix, each confirmed to have nothing pending, and
  confirmed genuinely idempotent on a second consecutive run (11 rows in
  `__drizzle_migrations`, unchanged, on both). The stored hash for this
  migration was corrected on both databases to match the corrected file's
  real `sha256` after the `admin_profiles_insert` fix, then cross-checked
  against a fresh `sha256` of the file — matches exactly on both databases
  and the file itself, restoring the same invariant doc 29 established
  ("the stored hash is the real, current file, not a stale or diverged
  version").
- Full unit suite: 171/171 passing, both before and after this pass —
  unchanged, since no application code changed, only the database schema's
  policies.
- Full e2e suite (`test:e2e:fresh`): 107/107 passing after the fix (an
  initial run failed 100% of suites on the bootstrap bug above; re-run
  clean after the fix, and re-confirmed clean a second time after the
  adversarial-verification fixture was cleaned up).

## Current status

`practitioner_profiles`, `patient_profiles`, and `admin_profiles` all carry
real, `FORCE`-enforced Row-Level Security — migration `0010`, applied to
both `stride` and `stride_test`. Everything in this pass is deliberately
**uncommitted**, per instruction, pending review. This closes Pass 3 of
`RLS-ROADMAP.md`. The only item left on the roadmap is Pass 4 — the
`user_clinics` `SECURITY DEFINER` spike, sequenced last on purpose and
explicitly allowed to conclude "not worth it" as a legitimate outcome, not
just a rollout to attempt.
