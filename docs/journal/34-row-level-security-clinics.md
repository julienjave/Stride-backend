# Row-Level Security, `clinics`: Pass 1, written up out of order

This is Pass 1 of `RLS-ROADMAP.md` — the first table actually rolled out
under the four-pass plan, and, unusually, the last to get its own journal
entry. Passes 2 through 4 (`user_roles`, the three profile tables,
`user_clinics`) each got a full write-up as they landed — docs 29, 32,
and 33 — while this one sat as "we'll cover it later, combined with
Passes 2 and 3." By the time that combined write-up was actually
attempted, Passes 2 and 3 already had thorough entries of their own, and
duplicating them would have been worse than useless. What was actually
missing was just this table.

**A deliberate choice, not an oversight**: this document is numbered 34,
not inserted earlier to preserve strict chronological order. Renumbering
docs 29 through 33 — each already verified, already cross-referenced by
number in each other's text — for the sake of tidiness would have meant
touching five correct documents to fix something cosmetic, the same shape
of low-value, real-risk bulk edit doc 14's `@ApiTags` mistake came from.
This follows the same precedent doc 01 already established: a document
being out of chronological position, clearly labeled as such, is more
honest than a clean-looking number that hides how the work actually
happened.

## Why `clinics` went first

Not because it mattered least — because it was, correctly, expected to be
the lowest-risk of the four. `clinics` is branding/display data with no
per-row filtering anywhere: `ClinicsService.findAll()`/`findOne()`/
`exists()` are plain `isActive`/`id` lookups, confirmed directly against
source before any policy was designed, and every write
(`create`/`update`/`deactivate`/`updateLogo`) is gated purely by
`@Roles(UserRole.ADMIN)` with no ownership concept beyond "is the caller
an admin" — clinics don't have owners the way exercises or program
templates do.

**A real gap surfaced before any SQL was written**: `ClinicsController`
never used `@CurrentUser()` anywhere in the file — not one route passed
the calling user into `ClinicsService` at all. Every write policy needs
`app.current_role` set via `withRlsContext`, which needs a real
`currentUser` to thread through — this had to be added as part of the
pass, not discovered as a surprise mid-implementation.

## What shipped: migration `0008`

- **`SELECT`: `USING (true)`** — matching the confirmed, unrestricted
  read behavior, and the same shape `exercises`/`program_templates`
  already established for "any authenticated user, no per-row filter."
- **`UPDATE`: `USING (rls_is_admin()) WITH CHECK (rls_is_admin())`** —
  reusing the existing `rls_is_admin()` helper, no new SQL function
  needed.
- **No `DELETE` policy at all** — deliberate, not an omission. There's no
  real `DELETE` route on `clinics`; `deactivate()` only ever issues an
  `UPDATE`. Under `FORCE ROW LEVEL SECURITY` with no policy for a given
  command, that command is rejected outright for every role, including
  admin — a correct safety property here, since nothing in the app ever
  needs a real `DELETE` against this table to work.

## The real design question: how broad should the bootstrap exception be

The first draft of `clinics_insert` copied `users_insert`'s own shape for
handling `registerClinic()`'s unauthenticated founding-admin bootstrap — a
blanket "no RLS context set at all" branch
(`NULLIF(current_setting('app.current_role', true), '') IS NULL`). This
was reasonable by precedent, and wrong for this specific table. Pushed
back on directly: that shape permits *any* insert from *any* code path
with no context set, forever — not just the one legitimate, time-bounded
bootstrap case — which is a materially broader hole than `clinics`
actually needs open.

Compared for real, not just by inspection: the broad version and a
narrower alternative — `NOT EXISTS (SELECT 1 FROM user_roles WHERE role =
'admin')`, matching `registerClinic()`'s own actual business gate — were
both tested against two real scenarios. **Direction A**, the genuine
bootstrap (no admin exists yet, no context): both versions correctly
allow it. **Direction B** — an admin already exists, but no RLS context
happens to be set, the exact scenario a stray unwrapped `INSERT`
elsewhere in the codebase would produce — is where they diverge: the
broad version would silently permit it, forever; the narrow version
correctly rejects it. The narrow version was adopted, specifically
because it closes the moment its own justification stops being true,
rather than leaving a standing exception open indefinitely.

## The exhaustive bypass search

Before trusting any bootstrap branch's scope, every write call site
against `clinics` across the codebase needed to be known, not assumed.
Grepped across `src/`, `scripts/`, `test/`, and the compiled `dist/` for
every `insert(clinics)`/`.into(clinics)`/raw `INSERT INTO clinics`
pattern, then every one of the 21 files referencing `clinics` at all was
checked by hand, not just pattern-matched: `AuthService.registerClinic()`
was confirmed as the **only** bypass of `ClinicsService` anywhere in the
project — nothing else was missed.

## Two things the review round caught, not the first pass

**A single-row `SELECT` test result turned out to be a coincidence, not
evidence.** The original unrestricted-read verification showed exactly
one clinic visible with no context set — real, but weak evidence that
*all* rows are visible rather than just the one that happened to exist.
Re-run with three real, committed clinics present: all three visible to
a no-context caller, the actual claim now properly supported.

**A ~20-minute Jest hang was investigated rather than dismissed.**
Confirmed unrelated to doc 06's previously-fixed pool-cleanup category —
`DrizzlePoolCloser` and `sessionPool.end()` were verified present and
correctly wired in every e2e spec file. The hang was a byproduct of all
eleven suites throwing in `beforeAll` simultaneously during a run against
the still-broken first-draft policy, not a resource leak recurring.

## Final verification

Eight adversarial scenarios against `stride_app`, both directions, each
checked against a known real row rather than trusted from a bare row
count: bootstrap insert with no context (allow), non-admin insert
(reject), admin insert (allow), non-admin update against a real existing
clinic (reject, confirmed `UPDATE 0` against a row proven to exist),
admin update (allow), unrestricted select with three real rows present
(all visible), admin delete (rejected — no `DELETE` policy exists, even
for admin), and the narrow bootstrap policy's actual defense-in-depth
case — no context, but a real admin already exists (rejected, the exact
scenario the broad version would have silently allowed). Full suite
clean: 165/165 unit, 97/97 e2e.

## Worth remembering: the same gap recurred twice more, later, in this same file

This document only covers `clinics` itself — but `ClinicsController`'s
missing-`@CurrentUser()` pattern, the first real finding of this pass,
turned out not to be a one-off. Investigating Pass 4's scope
(`user_clinics`) later found the identical gap twice more, in the same
service file: `addMember()` and `removeMember()` had no `currentUser`
parameter and no `withRlsContext` at all, despite being admin-only
routes, for the same underlying reason this pass's original gap existed —
code written before RLS existed, never revisited once it did. Fixed as
prep work ahead of Pass 4, not as part of this document's own scope, but
worth naming here directly: three instances of the identical bug, in one
file, across two separate passes, is a pattern worth remembering as a
category — not written to shame the codebase, but because "a write path
built without RLS in mind becomes a silent scope gap the moment RLS
actually lands" (the exact words used when this same shape of bug turned
up a third time) is exactly the kind of lesson worth being able to find
later, from any of the places it recurred.

## Current status

`clinics` carries real, `FORCE`-enforced Row-Level Security — migration
`0008`, applied to both `stride` and `stride_test`. Alongside docs 29
(`user_roles`), 32 (the profile tables), and 33 (`user_clinics`), this
closes out all four passes of `RLS-ROADMAP.md`. The roadmap's own
Pass 4 spike concluded with a genuine, evidenced "not needed" on
`SECURITY DEFINER` rather than either skipping the question or shipping
unwarranted complexity — a legitimate outcome the roadmap explicitly
allowed for from the start, and the same standard of real, adversarial
evidence established in this first pass held all the way through the
last one.
