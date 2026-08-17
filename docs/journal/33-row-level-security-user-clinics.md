# Row-Level Security, `user_clinics`: Pass 4, the trust-anchor table

This is Pass 4 of `RLS-ROADMAP.md`, the last item on the roadmap and the
one it named the highest-risk, most novel pass on purpose: `user_clinics`
is what every clinic-scoped policy on the six already-shipped tables
depends on, via `EXISTS` subqueries (`rls_practitioner_manages_patient()`,
`0003_assigned_programs_rls.sql`) or the app-layer equivalent
(`UsersService.getClinicIdsForUser()`/`isPatientManagedBy()`). The
roadmap sequenced its own investigation in four ordered steps and asked
for real, adversarial SQL at each one — not reasoning alone — before
anything got implemented against the real schema. This entry follows that
order.

## Step 1 — INSERT/DELETE: three tables' worth of precedent, plus one real
## new finding

A fresh grep across all of `src/` and `scripts/` re-confirmed the write
call sites, and corrected the roadmap's own framing on one point:

- **`ClinicsService.addMember()`** (`POST /clinics/:id/members`) and
  **`removeMember()`** (`DELETE /clinics/:id/members/:userId`) — both
  `@Roles(UserRole.ADMIN)`-gated at the controller, both already wrapped in
  `withRlsContext` with a real `currentUser` (pre-existing, uncommitted
  work confirmed unchanged, not re-fixed this pass).

**That fix is worth narrating here, not just referenced as already
done.** Investigating this pass's scope found both methods running on
plain `this.db` — no `currentUser` parameter anywhere in either method's
signature, no `withRlsContext` at all — despite being admin-only routes.
A fourth and fifth instance of the identical pattern already found twice
before: `ClinicsController` missing `@CurrentUser()` entirely (Pass 1,
doc 34) and `grantRole()` (Pass 2, doc 29). Fixed as prep work ahead of
this pass, the same relationship docs 30/31 had to Pass 3: `@CurrentUser()`
added to both routes in `ClinicsController`, threaded through to
`ClinicsService`, and the actual `INSERT`/`DELETE` in each method wrapped
in `withRlsContext(this.db, currentUser, ...)`, matching the pattern
already used by every other RLS-aware write path in the same file.

Since `user_clinics` carried no RLS policy at all at the time of this
fix, it was required to produce zero observable behavior change — checked
directly, not assumed: full unit and e2e suites re-run before and after,
plus the `clinics` e2e file run in isolation both ways, no differences.
Two new regression tests were added (`clinics.service.spec.ts`) asserting
`db.transaction` was actually entered and that the RLS context variables
(`app.current_user_id`/`app.current_role`) were genuinely present in the
resulting `tx.execute()` calls — decoded via a small `flattenSqlChunks`
helper, since Drizzle's `sql` template internals don't stringify usefully
on their own. The tests were then proven to actually catch the bug they
claim to, not just pass regardless of it: the `withRlsContext` wrapping
was temporarily reverted back to plain `this.db` calls, the two new tests
were re-run and genuinely failed (`db.transaction` never invoked — zero
calls, not a subtler mismatch), then the real fix was restored and the
same tests passed again. Unit suite went from 171/171 to 173/173 (the two
new tests); e2e stayed at 107/107, unaffected, matching the "zero
observable behavior change" requirement.

- **`AuthService.registerClinic()`** — the founding-admin bootstrap, the
  fifth insert of a five-statement transaction (`clinics` → `users` →
  `user_roles(role='admin')` → `admin_profiles` → `user_clinics`), no
  session to derive context from.
- **Not in the roadmap's own framing, a real finding**:
  `UsersService.create()`'s `dto.clinicId` branch. `POST /users` is
  `@Roles(PRACTITIONER, ADMIN)`, not admin-only — a **real practitioner
  session** can reach this insert (a practitioner creating their own
  managed patient with `dto.clinicId` set), gated by `create()`'s own
  app-layer ownership check
  (`getClinicIdsForUser(requestingUser.id).includes(dto.clinicId)`) before
  the transaction even opens. Unlike `practitioner_profiles` in Pass 3
  (confirmed: no real call site ever needed a practitioner-session
  branch), this table genuinely does.

DELETE has no such gap — `removeMember()` is the only DELETE call site
anywhere against this table, and it's admin-only; no practitioner or
no-context branch was needed there.

The bootstrap `INSERT` branch could not be copied verbatim from
`clinics_insert`/`user_roles_insert`'s plain
`NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')` — doing so
would have repeated `admin_profiles_insert`'s own first-draft bug from
Pass 3 exactly. By the time `registerClinic()`'s fifth insert runs,
`user_roles(role='admin')` for this same new user already exists in the
same transaction (inserted third), so a plain `NOT EXISTS` is already
false by the time `user_clinics` is reached — the bootstrap's own earlier
statement tripping its own later check. Built from the start with
`admin_profiles_insert`'s corrected shape: "no *other* admin exists yet,"
excluding the row's own `user_id`.

## Step 2 — SELECT: proven, not assumed, with real SQL and real output

This was the pass's actual center of gravity, and the roadmap was
explicit that it shouldn't be treated as a formality. A restrictive
candidate was installed for real on `user_clinics` in `stride_test`, a
real practitioner with a real clinic membership was seeded, and the
*exact* query `getClinicIdsForUser()` issues was run through `stride_app`
with zero session context — matching how the function is actually called
in the real authorization-check code path (`this.db`, never a `tx`, from
`isPatientManagedBy()`, `findPatientsForPractitioner()`, and `create()`'s
own ownership check, all of which run before any `withRlsContext`
transaction opens).

Candidate:

```sql
CREATE POLICY user_clinics_select_candidate ON user_clinics
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'admin'
    OR user_id = current_setting('app.current_user_id', true)::integer
  );
```

Real seed (owner connection): a practitioner (id `10`), a clinic (id
`10`), one real `user_clinics` row linking them. Then, as `stride_app`,
zero context set:

```
=== EXACT query getClinicIdsForUser(practitionerId) issues, NO context, restrictive candidate LIVE ===
 clinic_id
-----------
(0 rows)
```

Zero rows, for a real practitioner's own real membership. This breaks
three things simultaneously, not just one: `isPatientManagedBy()` sees
`clinicIds.length === 0` and returns `false` immediately — a real managed
patient reads as unmanaged everywhere that check gates (`UsersController`,
`MedicalFilesService`, `AssignedProgramsService`, `SessionsService`,
`MessagingService` — nearly every authorization check in the app routes
through it); `findPatientsForPractitioner()` returns `[]` for every
practitioner, for the identical reason; and `create()`'s own
`ownClinicIds.includes(dto.clinicId)` check would reject a practitioner
adding a patient to a clinic they genuinely belong to. Not a narrow edge
case — every practitioner-gated authorization check in the app depends on
this exact contextless read.

A second, managing-practitioner-shaped candidate was also tried (adding a
branch that lets a practitioner see any `user_clinics` row for a clinic
they themselves belong to, via a self-join `EXISTS` against the same
table) and failed a *different* way:

```
ERROR:  infinite recursion detected in policy for relation "user_clinics"
```

A self-referencing `EXISTS` subquery against the very table whose policy
it's part of. This is a second, independent structural reason a
restrictive policy is wrong here, layered on top of the contextless-read
problem: `rls_practitioner_manages_patient()` itself joins `user_clinics`
against itself, so reusing its shape *inside* `user_clinics`' own policy
is circular in a way it never is when called from a different table's
policy — every one of the six already-shipped tables calls it from
outside `user_clinics`, never from within.

Swapping in `USING (true)` and re-running the identical query confirmed
the fix — the same real row came back (`clinic_id = 11`, a fresh seed for
this specific check), with the same zero context set:

```
=== getClinicIdsForUser(practitionerId), NO context, USING (true) ===
 clinic_id
-----------
        11
(1 row)
```

`stride_test` was re-confirmed back to its original state after every
experiment (RLS disabled, no policy, zero scratch rows) before moving on.

**This also settles the roadmap's own Step 3 question without needing to
prototype it.** `SECURITY DEFINER` changes *which privileges* a
function's query runs with — it doesn't change what `current_setting()`
returns. `getClinicIdsForUser()`'s callers don't fail because `stride_app`
lacks privilege to see the row; they fail because no RLS context is set
at all in this call path, by design — the same structural reason
`users_select` (0007) and `user_roles_select` (0009) each already landed
on `USING (true)`, one level further removed. A `SECURITY DEFINER`
wrapper around the identical self-or-managing-practitioner condition would
evaluate the identical `current_setting(...)` calls and get the identical
`NULL`s — it doesn't address the actual failure mechanism. Per the
roadmap's own instruction ("don't jump ahead to implementing
`SECURITY DEFINER` before step 2 is resolved, since its answer determines
whether step 3 is even needed"), Step 3 was not prototyped against the
real schema. This is a considered "not worth it," reached *after*
investigating what it would actually buy, not before — the fourth time
this rollout has reached the identical "load-bearing pre-context read"
conclusion (`users`, `user_roles`, all three profile tables, now
`user_clinics`), each time proven the same way: real SQL, real empty
result, not reasoning alone.

## Step 3 — skipped, per the above

A real, considered outcome of this pass, not a shortcut: Step 2's evidence
is structural (no context exists to check against), not a privilege gap
`SECURITY DEFINER` could close. Prototyping it against the real schema
would have spent real effort confirming something the mechanism already
rules out.

## Step 4 — UPDATE: genuinely none

Re-confirmed directly, not assumed from any other table's precedent: a
fresh grep across `src/` and `scripts/` found no `.update(userClinics)`
call anywhere, and no raw SQL touching `user_clinics` outside the
migration files themselves. Membership is genuinely insert/delete-only —
join a clinic via `addMember()`/bootstrap, leave via `removeMember()`, no
in-between state. No `UPDATE` policy shipped.

## The shipped policy

Migration `0011_user_clinics_rls.sql`, reusing `rls_is_admin()` and
`rls_current_user_id()` (both from `0003_assigned_programs_rls.sql`) — no
new helper function needed anywhere in this pass.

```sql
CREATE POLICY user_clinics_select ON user_clinics
  FOR SELECT USING (true);

CREATE POLICY user_clinics_insert ON user_clinics
  FOR INSERT
  WITH CHECK (
    rls_is_admin()
    OR (
      current_setting('app.current_role', true) = 'practitioner'
      AND EXISTS (
        SELECT 1 FROM user_clinics existing
        WHERE existing.user_id = rls_current_user_id()
          AND existing.clinic_id = user_clinics.clinic_id
      )
    )
    OR (
      NULLIF(current_setting('app.current_role', true), '') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_roles ur
        WHERE ur.role = 'admin' AND ur.user_id <> user_clinics.user_id
      )
    )
  );

CREATE POLICY user_clinics_delete ON user_clinics
  FOR DELETE
  USING (rls_is_admin());
```

The `INSERT` policy's practitioner branch is a real, deliberate departure
from this rollout's own established "coarse RLS boundary, finer rule
stays app-layer-only" precedent (`users_insert`, `patient_profiles_insert`
both admit *any* practitioner session unconditionally, leaving the finer
per-target-role check to the service layer). Here the finer check —
"only into a clinic the practitioner themselves already belongs to" — is
enforced at the database layer too, mirroring `create()`'s own real
app-layer invariant directly against the table rather than leaving it
app-layer-only. Given this table's role as the dependency root for every
other clinic-scoped policy in the app, the extra defense-in-depth is
proportionate here in a way it wasn't judged to be for the profile
tables. The `EXISTS` subquery only ever reads pre-existing rows — a
practitioner is onboarded into any clinic exclusively via `addMember()`,
an admin-only insert, before they can ever reach this branch — so unlike
the bootstrap branch, it can't be satisfied by the very row being
inserted; no self-referential trap to guard against there.

## Adversarial verification, both directions, every branch, real output

Run as `stride_app` against a real, committed scratch fixture in
`stride_test` (an admin, a practitioner belonging to clinic A only, a
patient, two clinics) — each scenario its own isolated connection and
transaction (deliberately, after an earlier combined-session attempt
produced ambiguous stdout/stderr interleaving that made results
unreliable to read; isolating each scenario also more faithfully matches
a genuinely virgin, never-`set_config`'d pooled connection for the
no-context cases than an in-session `RESET`/`SAVEPOINT` simulation would
have — and separately, `RESET app.current_role` turned out not to parse
at all, `current_role` colliding with the SQL-reserved `CURRENT_ROLE`
token):

| # | Scenario | Expected | Result |
|---|---|---|---|
| T1 | INSERT, admin session | allow | `INSERT 0 1` |
| T2 | INSERT, practitioner session, into own clinic | allow | `INSERT 0 1` |
| T3 | INSERT, practitioner session, into a clinic NOT their own | reject | RLS violation |
| T4 | INSERT, patient session | reject | RLS violation |
| T5 | INSERT, no context, a real admin exists elsewhere | reject | RLS violation |
| T6 | INSERT, no context, genuinely admin-less DB, `registerClinic()`-shaped order (`user_roles(admin)` for the target user inserted first, same tx, then `user_clinics` for that same user) | allow | `INSERT 0 1` |
| T7 | INSERT, same admin-less-except-the-new-admin state, but the `user_clinics` row targets a DIFFERENT user than the one holding the only admin role | reject | RLS violation |
| T8 | DELETE, admin session | allow | `DELETE 1` |
| T9 | DELETE, practitioner session, their own clinic's membership | reject | `DELETE 0` |
| T10 | DELETE, patient session | reject | `DELETE 0` |
| T11 | DELETE, no context | reject | `DELETE 0` |

T6/T7 needed a genuinely admin-less database, not a simulated one — the
two real admin rows present in `stride_test` (one left over from an
earlier e2e run, one from this pass's own fixture) were deleted for real
via the owner connection, T6 and T7 run against that real state, then
both rows were restored via the owner connection afterward and
re-confirmed present. T7 specifically closes the same gap Pass 3's T13
closed for `admin_profiles_insert`: confirms the "exclude the row's own
`user_id`" fix isn't over-broad — a state with exactly one real admin
(the newly-bootstrapped one) does *not* grant a free pass to insert
`user_clinics` rows for some *other* user, only for itself. `DELETE`'s
reject cases come back as `0` rows rather than an error, same shape every
prior `UPDATE`/`DELETE` policy in this rollout has (filtered by `USING`,
not rejected by `WITH CHECK`). The scratch fixture (three users, two
clinics) was deleted via the owner connection afterward;
`user_clinics_select`'s `USING (true)` was re-confirmed to leave `stride_test`
with exactly the one real pre-existing row it had before this pass began.

## Full verification

- Exhaustive scope search re-run fresh across all of `src/` and
  `scripts/`, not trusted from the roadmap's own prompt or any prior
  pass's account of a different table — matched the roadmap's framing on
  three of four points, with one real correction: `UsersService.create()`
  needs a real practitioner-session `INSERT` branch, unlike
  `practitioner_profiles` in Pass 3.
- Step 2's restrictive `SELECT` candidate adversarially proven to return
  zero rows for a real practitioner's own real membership under the exact
  no-context call shape `getClinicIdsForUser()` uses — real SQL, real
  empty result, not reasoning alone — and a second, managing-practitioner-
  shaped candidate separately proven to cause infinite recursion, a
  structural reason on top of the contextless-read one.
- `SECURITY DEFINER` (roadmap Step 3) not prototyped against the real
  schema — a considered "not worth it," reasoned from the actual failure
  mechanism Step 2 exposed (no context to check, not insufficient
  privilege), not skipped as a shortcut.
- All 11 real adversarial `INSERT`/`DELETE` scenarios (4 allow, 7 reject)
  confirmed directly against `stride_app`, including a genuinely
  admin-less database for the two bootstrap-adjacent scenarios that
  couldn't be safely simulated.
- `drizzle-kit migrate` re-run fresh against both `stride` and
  `stride_test` after applying, each confirmed to have nothing pending,
  and confirmed genuinely idempotent on a second consecutive run (12 rows
  in `__drizzle_migrations`, unchanged, on both). The stored hash
  (`4e708f18...f51f93b`) cross-checked against a fresh `sha256` of
  `0011_user_clinics_rls.sql`'s actual current content — matches exactly
  on both databases and the file itself.
- The `_journal.json` bookkeeping trap doc 32 identified (a generated
  `when` timestamp that sorts before the previous synthetic entry silently
  no-ops the migration) was hit again on the first `generate --custom`
  run of this pass (real `Date.now()` output, `1786899716149`, sorting
  before `0010`'s `1787305945000`) and fixed the same way: continuing the
  established `+86,400,000ms` stride (`1787392345000`), confirmed to
  actually apply this time.
- Full unit suite: 173/173 passing, both before and after this pass.
- Full e2e suite (`test:e2e:fresh`): 107/107 passing, both before and
  after this pass. No application-layer bug surfaced during the run —
  unlike Pass 3, where the analogous `admin_profiles_insert` bootstrap bug
  was only found by running the suite against the naive shape. That clean
  run is not independent proof the naive, un-excluded `NOT EXISTS` would
  have failed here too: this pass reasoned forward from Pass 3's
  documented failure mode (identical transaction position relative to the
  same `user_roles(admin)` row that tripped it there — see Step 1 above)
  and built the excluding version from the start, rather than reproducing
  the failure first and fixing it the way doc 32 did. The reasoning for
  why the naive shape would break is solid and stated in Step 1, but it
  was never separately tested by shipping that shape and watching it fail.
  What's actually proven empirically is narrower: T6/T7 (above) confirm
  the *shipped*, excluding version behaves correctly in both directions —
  allowing the real bootstrap insert, rejecting the same-state insert for
  a different user — not that an alternate, un-excluded version would have
  been caught by the suite.

## Current status

`user_clinics` carries real, `FORCE`-enforced Row-Level Security —
migration `0011`, applied to both `stride` and `stride_test`. This closes
Pass 4, the last item on `RLS-ROADMAP.md`: every table the roadmap
scoped (`clinics`, `user_roles`, the three profile tables, `user_clinics`)
now carries real, database-enforced RLS, joining the six (eight, counting
child tables) tables the original rollout (docs 23–24) already covered.
Everything in this pass is deliberately **uncommitted**, per instruction,
pending review — alongside the pre-existing uncommitted
`ClinicsService.addMember()`/`removeMember()` `withRlsContext` wiring this
pass's own scope search re-confirmed but did not need to change.
