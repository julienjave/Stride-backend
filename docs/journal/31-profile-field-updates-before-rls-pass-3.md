# Closing the profile-field update gap, before RLS Pass 3 touches the same tables

`RLS-ROADMAP.md`'s Pass 3 (`practitioner_profiles`, `patient_profiles`,
`admin_profiles`) hasn't started yet — this is prep work that surfaced
while scoping it, not the RLS pass itself. Before writing a policy for a
table, the roadmap's own methodology (doc 24's "investigate the real
current rule first," restated for every pass since) calls for knowing
every real read *and write* path against it. The read side was already
correct (doc 30's `attachProfile()` writeup). The write side wasn't: a
fresh, exhaustive grep for `practitionerProfiles`/`patientProfiles`/
`adminProfiles` across `src/` found exactly two write paths —
`UsersService.create()` and `UsersService.grantRole()` — and no `UPDATE`
against any of the three tables anywhere. `UpdateUserDto` only ever
carried `firstName`/`lastName`. `licenseNumber`, `specialties`,
`dateOfBirth`, and `position` were all writable once, at creation or
role-grant time, and never again.

Fixing this now, before Pass 3, rather than after, is deliberate: doc 29's
own account of `grantRole()` (a write path that predated `user_roles`' RLS
and had never been routed through `withRlsContext`) and the
`ClinicsController` scope gap found during RLS Pass 1 (write-up still
pending — Pass 1 is planned to be combined with Passes 2–3 into one
entry) are the same category of bug — a write path built without RLS in
mind becomes a silent scope gap the moment RLS actually lands. Building
this one on `withRlsContext` from the start means Pass 3 has one fewer
write path to audit for that specific failure mode.

## Two decisions made explicitly, not defaulted into

**DTO shape.** `CreateUserDto` and `GrantRoleDto` already establish this
module's own convention for per-role profile fields: flat, optional
fields on the DTO (not nested under a `practitionerProfile`/
`patientProfile`/`adminProfile` sub-object), gated in `CreateUserDto`'s
case by `@ValidateIf(dto.role === ...)`. A codebase-wide check for
precedent on validating a *nested* sub-object turned up exactly one
`@ValidateNested()` usage (`assigned-programs`), and it validates an
*array* of sub-items, not a single nested object — no precedent for the
nested shape at all. `UpdateUserDto` extends with the same four fields,
flat, matching `CreateUserDto`/`GrantRoleDto` directly. The one structural
difference: update has no `role` field to hang `@ValidateIf` on (the
target's role was fixed at creation), so every new field is simply
`@IsOptional()`, and applicability against the target's *actual* roles is
checked in the service instead — see below.

**`licenseNumber` self-editability.** Unlike `specialties`/`dateOfBirth`/
`position`, `licenseNumber` is `UNIQUE` at the database level and
represents a real external credential this app never verifies against an
actual licensing body — a case for treating it differently from the other
three (admin-only, or extra audit detail on change) was real enough to
raise rather than decide silently. Resolved directly: `licenseNumber`
stays self-editable, on the same rule as every other field here. A
practitioner correcting their own license number (a typo, a renewal) is
authorized the same way as correcting their own name — restricting it
further is a real product decision for a future pass, not something to
back into as a side effect of this one.

## Authorization: the existing check, plus one new necessary layer

`UsersController.update()`'s `isSelf || isAdmin || isManagingPractitioner`
check is unchanged and directly reused — no new authorization logic at the
controller. But that check alone isn't sufficient once the dto can carry
role-profile fields: it answers "can this caller act on this target at
all," not "does this specific field even apply to this target." Confirmed
directly against `UsersService.update()`, not assumed: `existing.roles`
(the target's real held roles, fetched via the existing `findOne()` call)
gates each field group before the transaction opens — `licenseNumber`/
`specialties` require the target to hold `practitioner`, `dateOfBirth`
requires `patient`, `position` requires `admin`. This runs regardless of
*which* branch of the three-way check let the caller through, so an admin
— who passes that check unconditionally for any user — still gets a `400
Bad Request` sending `position` for a patient. A managing practitioner
editing their managed patient is scoped to `dateOfBirth` for the same
reason, never `practitionerProfile`/`adminProfile` fields, since the
*target* never holds those roles.

## A real bug hit building this, not just a design question

The first implementation guarded the plain-`users`-columns branch with
`Object.keys(userFields).length > 0` (skip the `users` `UPDATE` entirely
when the dto carries no `firstName`/`lastName`, since Drizzle rejects an
empty `.set({})` outright). Every e2e test sending *only* profile fields
failed with a real `500`, not the expected `200`:

```
Error: No values to set
    at mapUpdateSet (node_modules/src/utils.ts:128:9)
    at PgUpdateBuilder.set (node_modules/src/pg-core/query-builders/update.ts:98:4)
    at src/users/users.service.ts:403:18
```

The cause: this project's `tsconfig.json` targets `ES2023`, where class
fields use `useDefineForClassFields` semantics — every property *declared*
on `UpdateUserDto`, including ones the caller never sent, becomes a real
own key on the instance, valued `undefined`. Destructuring
`{ licenseNumber, specialties, dateOfBirth, position, ...rest }` still
left `rest` carrying `{ firstName: undefined, lastName: undefined }` for a
profile-only request — `Object.keys(rest).length` was `2`, not `0`, so the
guard let an all-`undefined` object reach `.set()`. Fixed by filtering
`rest`'s entries for `value !== undefined` before checking length or
writing. Caught by the e2e suite, not by inspection — the unit tests
(mocked at the Drizzle-call boundary) never would have caught this
specific failure, since the mock doesn't reproduce Drizzle's real
"empty set" rejection.

## RLS readiness and audit logging — confirmed, not assumed

**RLS**: `UsersService.update()` already ran its `users` `UPDATE` through
`withRlsContext`; the new `practitioner_profiles`/`patient_profiles`/
`admin_profiles` writes are inside the same transaction, so they already
carry `app.current_user_id`/`app.current_role` the moment Pass 3 enables
`FORCE ROW LEVEL SECURITY` on these three tables — nothing left to retrofit.

**Audit logging**: checked directly against `AuditLogInterceptor`'s actual
logic, not assumed either way. `PATCH /users/:id` was already a mutating,
non-`/auth`/non-`/medical-files` route returning a body with `id` — the
interceptor's existing generic heuristic (`entityType` from the URL,
`entityId` from `response.id`) already covered this route before this
change and needs no new handling now; the extra fields ride along on a
response shape the interceptor already reads.

## Testing

Unit coverage added directly for the new branching logic
(`src/users/users.service.spec.ts`, `describe('UsersService.update')`):
the three field/target-role mismatch rejections (checked together,
`db.transaction` never called), a combined `users`-column +
`practitionerProfiles` update in one transaction, and a profile-only
update that must skip the `users` `UPDATE` and read the row back through
the still-open transaction instead.

e2e coverage added to `test/users.e2e-spec.ts`, deliberately placed at the
very end of the file (not inline with the pre-existing update tests it
extends) since several of the new cases permanently mutate `patient1`'s
`dateOfBirth` and `practitionerA`'s `specialties` — values several
earlier, pre-existing tests in the same file assert as their original,
unmodified values:

- Self-update (`patient1` sets their own `dateOfBirth`)
- Admin updating any user's profile field (a practitioner's `specialties`)
- A practitioner self-updating their own `practitionerProfile` fields,
  `licenseNumber` included
- A managing practitioner updating a managed patient's `patientProfile`
  field
- Rejections: one patient on another's profile field, a non-managing
  practitioner on a patient they don't manage, one practitioner on
  another practitioner's profile, and a field that doesn't apply to the
  target's actual role even from an admin caller

Full suite run after the fix: **171 unit tests / 11 suites** and **107
e2e tests / 11 suites**, all passing (`test/users.e2e-spec.ts` alone: 24).

## Docs

`docs/api/01-authentication.md` (the `attachProfile()` section, noting the
new write path and the read/write authorization divergence) and
`docs/api/04-authorization.md` (the `PATCH /users/:id` paragraph, the DTO
shape decision, and the target-role field-applicability rule) were
updated. `docs/api/05-getting-started.md` was checked directly against
this change and needed none — it's a creation-only walkthrough with no
`PATCH /users` example to begin with, so nothing in it became inaccurate.

## Status

Not committed — this document, the code, and the tests are all currently
uncommitted, per instruction for this pass. RLS Pass 3 itself
(`practitioner_profiles`/`patient_profiles`/`admin_profiles`) remains
un-started; this document does not close that item in `RLS-ROADMAP.md` or
the journal README's "Known open items" list, only the write-path gap
found while scoping it.
