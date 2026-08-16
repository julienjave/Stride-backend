# The write-only profile fields, found while investigating Pass 3

This document covers a real application bug — not RLS work — found while
doing the "investigate the real current rule first" step the RLS roadmap
requires before designing any policy. It's recorded separately from the
eventual Pass 1–3 RLS write-up on purpose: this wasn't a change to how the
database enforces access, it's a bug the *investigation* for Pass 3
happened to surface, the same shape as doc 28's Resend detour — a real
finding that came from process discipline, not from the plan.

## What Pass 3's investigation actually found

Reading every real call site against `practitioner_profiles`,
`patient_profiles`, and `admin_profiles` — not the roadmap's guesses about
them — turned up something more fundamental than a policy design question:
`licenseNumber`/`specialties` (practitioners), `dateOfBirth` (patients),
and `position` (admins) were written correctly on account creation and
never read back, anywhere, by anyone. Not `GET /users/:id`. Not the
`create()` response itself, immediately after a successful creation. Not
a single test anywhere asserted on these fields appearing in a response
body — confirmed by direct search, not assumed from their absence being
merely unlikely.

This isn't a security issue — it's the opposite, over-restriction rather
than under. But it's a real functional gap: no way for a practitioner to
see their own license number reflected back, no way for an admin to
review a managed practitioner's credentials through the API, no way for a
practitioner to see a managed patient's date of birth — information that
can be genuinely load-bearing for clinical judgment, not incidental. It
also meant `FRONTEND.md`'s anticipated feature set (a practitioner profile
page, a patient chart header) had no real data to build against, with
nothing in any API doc flagging the gap as intentional.

## The decision, made deliberately rather than defaulted

Three ways to proceed were on the table: design Pass 3's RLS policy to
match the current, broken reality (narrow, effectively admin-only,
correct today but encoding a bug as if it were permanent); design a
policy for the *probably intended* rule despite nothing currently
exercising it that way (a real departure from this project's own
"investigate the real rule, don't invent one" discipline, held to
consistently since the original six-table rollout); or fix the actual gap
first, then design Pass 3 against corrected, real behavior. The third was
chosen, and the reasoning is worth restating plainly: designing a security
policy around behavior that's *already correct* is more solid ground than
designing around a known gap or a guessed-at future rule.

## The fix

`UsersService` gained `attachProfile()` (public, single-user — used by
`create`, `findOne`, `update`, `softDelete`, `updateAvatar`) and
`attachProfilesToMany()` (private, batched via `inArray` for `findAll`/
`findPatientsForPractitioner`, avoiding an N+1 query pattern). Both query
only the profile table(s) matching the roles an account actually holds,
nested under role-named keys — `practitionerProfile`, `patientProfile`,
`adminProfile` — present conditionally, not flattened into ambiguous
top-level fields that only sometimes exist. A multi-role account carries
more than one, and this was specifically verified to follow *held* roles,
not just the session's *active* one — a dual patient+practitioner
account's login and post-switch-role responses both carry both nested
objects, confirmed directly, not assumed from the implementation's shape.

**No new authorization logic was written.** Whoever already passes
`UsersController`'s existing self/admin/managing-practitioner check —
already the sole gate deciding whether a user record is returned at all —
gets the same additional fields; there was no finer-grained rule to
design. Doc 04 now states this explicitly, rather than leaving it
implicit.

Two hand-built code paths bypass `UsersService`'s normal methods entirely
and needed their own fix: `AuthService.registerClinic()` (the founding-
admin bootstrap) and `AuthService.validateUser()` (login, which
hand-strips fields rather than reusing `toPublic()`). Both now call the
same `attachProfile()` rather than maintaining a third, divergent copy of
this logic.

**One real non-instance of the bug, confirmed rather than assumed**:
`grantRole()` never returned a user object at all — just a bare `roles`
string array, per its own existing e2e assertion. Left untouched, and a
new assertion now locks that in deliberately, so a future change can't
silently alter it without a test noticing.

**One decision made directly between the user and Claude Code, outside
this document's own investigation**: `findAll()`/`findPatientsForPractitioner()`
turned out to have an even more basic gap than profile data — they didn't
attach `roles` at all, unlike every single-user route. Brought in line
with the rest, by deliberate choice, not a default extension of scope.

## Verification, and why it mattered specifically here

Every e2e assertion added checks response *bodies*, not just status codes
— the same blind spot that let this bug exist unnoticed for as long as it
did, and the same blind spot doc 29 separately caught in `grantRole()`'s
own read-after-write bug. Notably, zero new `it()` blocks were added to
either e2e file — every assertion extended an existing test rather than
duplicating one, confirmed directly via diff rather than assumed from the
test count staying flat. Three new `it()` blocks exist only in the unit
specs. Full suite, after the fix: 168/168 unit, 99/99 e2e, `tsc --noEmit`
and the production build both clean.

## A second instance of doc 28's exact Resend flake

Writing new coverage surfaced a second, independent instance of the same
root cause doc 28 diagnosed and fixed — but at a call site doc 28's own
fix never touched. The `PASSWORD_RESET_REQUESTED` audit test (itself
added by doc 28) used a fresh `@example.com` address, which Resend's
sandbox rejects outright (`422`, visible directly in console output) —
exactly the class of problem `delivered@resend.dev` exists to solve, doc
28's own words limiting that fix to "touching only that one test." This
one was never given the same treatment.

Worth being honest about how this was actually found: an initial pass
called the flake "unrelated noise" without checking the address directly
— wrong, and only corrected under direct pushback to actually verify
rather than assert. Fixed by reusing the MFA test's already-registered
`delivered@resend.dev` account, with `orderBy: desc(auditLogs.id)` added
since that account now carries more than one audit entry across two
tests. The resulting cross-test dependency was verified structurally, not
just empirically: both usages confirmed in the same file and `describe`
block, zero `.concurrent` markers, `maxWorkers: 1` and `--runInBand` both
set — three independent guarantees that rule out any possible ordering
race, not just an absence of one observed so far.

## A real, deliberately unfixed finding: WSL2 clock drift

Diagnosing the flake's remaining timing-assertion failures (after the
address fix) found a separate, genuine condition: the WSL2/Docker Desktop
VM clock running several seconds ahead of the host — confirmed across
both the `db` and `storage` containers, so VM-wide rather than
container-specific. `wsl --shutdown` resyncs it; restarting the affected
container alone did not, confirming the drift isn't per-container.
Deliberately left unfixed as part of this work — genuine host-level
infrastructure outside this task's scope, and possibly a one-off (the
laptop sleeping while Docker Desktop stayed running is a plausible,
unconfirmed cause) rather than a recurring pattern worth solving
preemptively. Recorded here, and as an inline comment near the affected
assertion plus a short note in `DEPLOYMENT.md`'s local-dev section, so a
future recurrence reads as "known WSL2 quirk, here's the fix" rather than
a fresh mystery.

## Current status

Committed (`[commit hash — to be filled in]`). Docs 01, 04, and 05 updated
to reflect the real new response shape. This document is what makes
explicit, for whoever picks up Pass 3 next, that the "current rule" for
`practitioner_profiles`/`patient_profiles`/`admin_profiles` is no longer
"nothing reads this" — it's the corrected, verified visibility described
above, and Pass 3's RLS policy should be designed against this, not
against `RLS-ROADMAP.md`'s original, now-outdated assumption.
