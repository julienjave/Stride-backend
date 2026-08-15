# Row-Level Security, `user_roles`: the pass the roadmap called hardest

This is Pass 2 of `RLS-ROADMAP.md` (`docs/extra/RLS-ROADMAP.md`), following
Pass 1's `clinics` (migration `0008`). The roadmap named this the pass
needing real investigation before a policy could even be drafted, and asked
for it to be treated with the same rigor doc 24 applied to `users` itself,
not Pass 1's lighter precedent. That turned out to be the right call: the
policy the roadmap itself proposed as a starting candidate would have broken
login for every non-admin account, and the pass surfaced two independent,
real bugs along the way — one a genuine RLS scope gap, and one pre-existing,
unrelated to RLS, and a real recurrence of a bug category doc 08 already
named once. A prior e2e test already exercised `POST /users/:id/roles`, but
only ever checked its status code, never its response body — the first
assertion this project ever wrote against what `grantRole()` actually
returns is what caught it.

## Scope, confirmed and corrected

The roadmap's own prompt for this pass named four call sites as the
confirmed set. A fresh grep across all of `src/` (not just what the prompt
already knew about) found six:

- `UsersService.getRolesForUser(userId)` — the broad read, attaches `roles`
  to a user object from `findOne`, `update`, `softDelete`, `updateAvatar`,
  `grantRole`, and (critically, see below) `AuthService.validateUser()`,
  `forgotPassword()`, and `resetPassword()`.
- `UsersService.grantRole()` — admin-only role grant, real session.
- `UsersService.create()` — used by both `POST /users` (real session) and
  `POST /auth/register` (fully public, self-registration as `patient`).
- `AuthService.registerClinic()` — fully public, inserts `role: 'admin'`,
  gated on no admin existing yet; also does the unauthenticated `SELECT`
  checking that gate.
- **Not in the roadmap's list**: `ClinicsService.listMembers()` (admin-only
  route, attaches each clinic member's roles for `GET /clinics/:id/members`)
  and `UsersService.findPatientsForPractitioner()` (joins `user_roles` to
  filter to `role = 'patient'` for a practitioner's own patient list).

Neither of the two extra call sites needed any code change, for the same
reason explained below — but both are real, confirmed traffic against this
table, and undercounting them would have repeated the exact kind of gap this
project's own methodology (doc 24, "investigate scope honestly") exists to
catch.

No `UPDATE` or `DELETE` against `user_roles` exists anywhere in the
codebase — re-confirmed directly rather than trusted from the roadmap's own
note, since the instruction for this pass was explicitly not to trust prior
claims blindly. Only `SELECT` and `INSERT` policies were needed.

## The `SELECT` policy: what was proposed, what broke, what shipped

The roadmap's own draft candidate was a narrower policy: self, admin, or a
managing practitioner, plus one exception — a no-context branch scoped
specifically to `role = 'admin'`, so an unauthenticated connection could see
only admin rows, not the whole table. The stated goal was avoiding
`users_insert`'s broader "no context = everything visible" shape by scoping
the exception to the real invariant, the same lesson Pass 1 drew for
`clinics_insert`.

**This was tested adversarially before being trusted, not assumed to work
from the reasoning alone.** The policy was applied for real to `user_roles`
in `stride_test`, a real patient row was seeded, and the exact call
`getRolesForUser` makes — a bare `SELECT ... WHERE user_id = $1` through
`stride_app`, with zero session context set — was run directly:

```
=== simulating getRolesForUser(3) at login, NO context set (stride_app) ===
 role
------
(0 rows)
```

Zero rows, for a real patient. The reason traces back one level further than
the roadmap's own framing anticipated: `getRolesForUser` always queries
through `this.db`, never a transaction handle, so it never carries whatever
RLS context an *outer* `withRlsContext` call might have set — and critically,
it's called directly from `AuthService.validateUser()`, the login path
itself, before any session or `activeRole` exists at all. Under the narrow
policy, this means `roles` comes back `[]` for every patient or
practitioner login (only `role = 'admin'` rows are visible with no context)
— which `validateUser()` then turns into either a wrong `403` ("account does
not have that role," if a role was requested) or a wrong `400` ("account has
multiple roles," since `0 !== 1`). Not a narrow edge case: every non-admin
login, unconditionally.

This is structurally the same problem `users_select` was already written
around in doc 24 — `findByEmailWithHash()` also runs pre-session — one level
removed through a service method the roadmap's own investigation notes
hadn't traced that far. The candidate fix of threading real (or a Pass-1-
style synthetic) session context through every `getRolesForUser` call site
instead of loosening the policy was considered and rejected too, not
skipped: `forgotPassword()`/`resetPassword()` can synthesize a self-context
because ownership is already proven out-of-band by the time they call it
(an email or token match). `validateUser()` cannot — it calls
`getRolesForUser()` specifically to *find out* what `activeRole` should be,
so there is no role value yet to put into a context that would satisfy a
narrower policy's self-branch. A user-id-only context variant of
`withRlsContext` (the self-branch only needs `app.current_user_id`, never
`app.current_role`) would solve the circularity in principle, but it's real
new mechanism for a table where the ceiling on what it protects is already
low: `users_select` leaves the far more sensitive `users` row (email, name,
avatar, `mfaEnabled`) completely open to any `stride_app` connection with no
read-side RLS defense at all. A row that only ever says "this `user_id`
holds this role" is a strictly smaller disclosure than what's already
unconditionally open one table over.

**Shipped**: `user_roles_select` is `USING (true)`, matching `users_select`'s
own precedent and its own stated reasoning, not a lighter "no sensitivity"
call like `clinics_select`. `UsersController`'s existing
isSelf/isAdmin/isManagingPractitioner checks remain the only real read-side
authorization for whose roles are actually exposed over HTTP — unchanged by
this pass, and re-confirmed passing (`test/users.e2e-spec.ts`'s
`GET /users/:id` scoping test).

## The `INSERT` policy: three branches, keyed on the role being written

Unlike `users_insert` — which couldn't see the role being assigned at all,
since it lives in this sibling table — `user_roles_insert` governs the row
that *has* the role column, so `WITH CHECK` can reference it directly rather
than only checking whether a session exists.

```sql
CREATE POLICY user_roles_insert ON user_roles
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR (
      current_setting('app.current_role', true) = 'practitioner'
      AND role = 'patient'
    )
    OR (
      NULLIF(current_setting('app.current_role', true), '') IS NULL
      AND (
        role = 'patient'
        OR (
          role = 'admin'
          AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
        )
      )
    )
  );
```

Three branches: a real admin session (any role, any user — `grantRole()`,
and the admin branch of `create()`); a real practitioner session (`role =
'patient'` only, mirroring `create()`'s own existing
"practitioners can only create patient accounts" check a second time at the
DB layer); and no context at all, which needs two *different* conditions
under one umbrella rather than a single shared rule — `register()`'s
bootstrap (`role = 'patient'`, always allowed — confirmed as the only
reachable case, since `RegisterDto` has no role field and `register()`
hardcodes `UserRole.PATIENT` regardless of request body) and
`registerClinic()`'s bootstrap (`role = 'admin'`, only when
`NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')`, the identical
invariant `clinics_insert` already checks against this same table, applied
here directly). That subquery is itself governed by `user_roles_select`
(`USING (true)`), so it always sees every existing admin row regardless of
the inserting connection's own context — which is also what keeps
`clinics_insert`'s own, pre-existing subquery against `user_roles` working
correctly now that this table carries its own `FORCE`d RLS for the first
time, rather than querying an unprotected table the way it did before this
pass.

`role = 'practitioner'` is deliberately reachable by neither the
practitioner-session branch nor the no-context branch — there is no real
call site that ever inserts a practitioner role without an admin session.

### Adversarial verification, all eight real scenarios

Run directly against `stride_test` as `stride_app`, inside
`BEGIN; ... ROLLBACK;` blocks so nothing persisted:

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Real admin session, insert `role='practitioner'` | allow | `INSERT 0 1` |
| 2 | Real practitioner session, insert `role='patient'` | allow | `INSERT 0 1` |
| 3 | Real practitioner session, insert `role='admin'` | reject | RLS violation |
| 4 | Real practitioner session, insert `role='practitioner'` | reject | RLS violation |
| 5 | No context, insert `role='patient'` | allow | `INSERT 0 1` |
| 6 | No context, insert `role='practitioner'` | reject | RLS violation |
| 7 | No context, insert `role='admin'`, admin already exists | reject | RLS violation |
| 8 | No context, insert `role='admin'`, **no admin exists** | allow | `INSERT 0 1` |

Scenario 8 needed a genuinely admin-less database to test honestly, not a
simulated one — `stride_app` can no longer freely delete from `user_roles`
to fake that state the way Pass 1's own `clinics_insert` verification could
before this table had `FORCE` RLS of its own (there's no `DELETE` policy, so
any `DELETE` by `stride_app` is now unconditionally rejected, correctly).
Instead, the one real admin row was removed via the owner connection
(bypassing RLS, as owners do), the no-context insert was confirmed to
succeed as `stride_app` against a database with zero real admins, and the
original row was restored via the owner connection afterward. `stride_test`
was left in its original state once the experiment concluded.

## Two real bugs, found by verifying rather than assuming

**Scope gap**: `grantRole()`'s own `INSERT` into `user_roles` ran inside a
plain `this.db.transaction()`, not `withRlsContext` — and the controller
method didn't even accept a `@CurrentUser()` at all, despite the route being
admin-gated. This meant the actual write, once `FORCE` RLS went live, would
have run with **no** RLS context set — not `rls_is_admin()`, just "no
context" — satisfying none of the three `INSERT` branches for anything but
`role = 'patient'`. A live admin granting a `practitioner` or `admin` role
through the real route would have failed outright. Fixed by threading
`currentUser` from `UsersController.grantRole()` into
`UsersService.grantRole()` and switching to `withRlsContext`, the same
template every prior pass in this rollout has used.

**Pre-existing, unrelated to RLS, and a recurrence of a category doc 08
already named**: `POST /users/:id/roles` was *not* untested before this pass
— `auth.e2e-spec.ts`'s "requires an explicit role choice for a dual-role
account" test already calls it, with a real admin session, and checks
`grantRes.status === 201`. What it never did was assert on `grantRes.body`.
Its later assertions (login with no role specified → `400`, the wrong role
→ `403`) only run once `grantRole()`'s own transaction has already
committed — by then, any fresh read sees the row correctly regardless of
whether the bug below is present, since the underlying `INSERT` itself was
never broken, only the same-transaction read-back was. The pre-existing
unit test (`users.service.spec.ts`) only ever checked `insert` call counts,
never the returned value either. So: real prior e2e coverage of the route
existed, but no test anywhere — unit or e2e — had ever asserted on what
`grantRole()` actually returns, until this pass wrote one that does. That's
what surfaced a second, independent problem: `grantRole()` calls
`this.getRolesForUser(userId)` as its last step, *inside* its own
still-open transaction — but `getRolesForUser` reads via `this.db`, a
separate connection, which under normal `READ COMMITTED` visibility cannot
see a row the transaction it's nested inside hasn't committed yet. The
newly-granted role was silently missing from the response:

```
Expected: ArrayContaining ["patient", "practitioner"]
Received: ["patient"]
```

This bug predates this pass entirely — the old `db.transaction()` shape had
the identical problem, just never caught, since no test ever asserted on the
real returned array before. It's also not a new category of mistake for this
project: doc 08 documents the exact same pitfall in
`AssignedProgramsModule`, and deliberately built around it — "a read using
the pooled connection (`this.db`) issued *inside* an uncommitted transaction
block would not reliably see rows the transaction has inserted but not yet
committed (different connections, read-committed isolation) — so the
detailed read happens as a separate step immediately after the transaction
resolves, not nested inside it." `grantRole()`, in a different module,
landed in exactly the pitfall doc 08 had already named and worked around
once. Fixed here the same way that lesson implies, adapted to a method that
needs the read to still happen inside the transaction rather than after it:
an optional `dbOrTx` parameter on `getRolesForUser` (`this.db` by default,
so every other call site — which all run *after* their own transaction has
already resolved — is unaffected), with `grantRole()` passing its own `tx`
through explicitly so the read happens on the same connection as the write
it needs to see.

## Verification

- Full exhaustive scope search re-run, not trusted from the roadmap's own
  notes: six real call sites confirmed, two beyond the original four named.
- The roadmap's own proposed `SELECT` policy candidate adversarially proven
  to break login for every non-admin account before being rejected — real
  SQL, real zero-row result, not reasoning alone.
- All eight real `INSERT` scenarios (four allow, four reject) adversarially
  confirmed directly against `stride_app`, including a genuinely admin-less
  database for the one bootstrap-allow case that couldn't be safely faked.
- `clinics_insert`'s own pre-existing bootstrap subquery against
  `user_roles` re-confirmed still working now that this table carries real,
  `FORCE`d RLS of its own for the first time.
- New e2e coverage added for `POST /users/:id/roles`, specifically closing
  the gap the existing test never covered — asserting on the actual
  response body, not just its status code: admin grants a role and it's
  provably real (the account can immediately `switch-role` into it, not
  just receive a response that looks right); a non-admin is rejected; a
  duplicate grant is rejected. Deliberately verifies via `/auth/switch-role`
  on an already-authenticated session rather than a fresh `/auth/login` —
  `login` is throttled to 5/60s and this file's own fixture setup already
  spends most of that budget.
- `drizzle-kit migrate` re-run fresh against both `stride` and
  `stride_test`, each confirmed to have nothing pending — not just trusted
  from the original apply earlier in the pass. `__drizzle_migrations` is
  identical before and after on both databases: 10 rows, entry 10 is
  migration `0009_user_roles_rls`
  (`329f09db0262b00e3cac1e4ea4ed68f07d4147336fafbd50fa52d3fc339eaaac`,
  `created_at` `1787219545000`). `stride_test` was additionally re-run a
  second time immediately after the first, with a byte-identical result
  both times — a genuine no-op on repeat, not a first run that merely
  looked clean. The stored hash was also cross-checked against a fresh
  `sha256` of `0009_user_roles_rls.sql`'s actual current file content,
  not trusted as a stored number — matches exactly, confirming the applied
  migration is the real, current file, not a stale or diverged version.
- Full unit suite: 165/165 passing.
- Full e2e suite (`test:e2e:fresh`): 98/98 passing before this pass
  (baseline, re-confirmed), 99/99 after (the one new test added).

## Current status

`user_roles` carries real, `FORCE`-enforced Row-Level Security — migration
`0009`, applied to both `stride` and `stride_test`. Everything in this pass
is deliberately **uncommitted**, per instruction, pending review. Still open
per the roadmap: the three profile tables (`practitioner_profiles`,
`patient_profiles`, `admin_profiles` — Pass 3) and the `user_clinics`
`SECURITY DEFINER` spike (Pass 4, sequenced last on purpose).
