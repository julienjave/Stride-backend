# Multi-role authorization & clinic bootstrap

This document picks up after `exercise-seeding-and-storage-migration.md`,
covering the `ExercisesModule` build, and — the larger piece of this phase — a
mid-project redesign of how user roles work, triggered by a real-world case a
strict single-role model couldn't represent.

## `ExercisesModule`

Built on the established DTO/service/controller template, with one addition:
`RolesGuard` alone can express "is this user a practitioner," but not
"does this practitioner own this specific exercise" — that check depends on
data (`exercises.createdBy`) that only exists once the row has already been
fetched, so it lives in the service (`assertCanModify`), not the guard.
Practitioners are restricted to editing their own custom exercises; admins can
correct anything, including the shared seeded library — curation of shared
reference data is administrative oversight, not the same clinical judgment
call as authoring new content, so `POST /exercises` (create) remains
practitioner-only even though `PATCH`/`DELETE` allow both roles.

A related fix applied to both `ExercisesController` and `UsersController`:
soft-delete routes now return the updated row with a plain `200`, not `204 No
Content`. `204` is correct for a true, irreversible delete — the resource is
gone, there's nothing left to describe. A soft-delete's resource still exists,
and its new state is worth handing back directly rather than making the
frontend re-fetch or assume it changed.

## The case that broke the single-role model

A clinic owner who is also a treating practitioner is common in real
practices, not an edge case. The schema already supported one user holding
rows in more than one profile table (`practitioner_profiles`,
`admin_profiles`, etc. are independently keyed by `user_id`), but the single
`users.role` column made it structurally impossible to express "this account
is both." Two rejected alternatives, and why:

- **Two separate accounts** — not impractical, and arguably still defensible
  on separation-of-duties grounds (an unambiguous "which hat was this action
  taken under" in the audit trail), but a worse day-to-day experience than
  necessary for a single real person.
- **An `is_practitioner` boolean flag** — rejected because it would allow
  someone to act clinically with no `license_number` on file (undermining the
  `NOT NULL` constraint deliberately placed there), and doesn't generalize
  (a patient who is also a practitioner elsewhere would need a different flag
  again).

## The redesign: `user_roles`, and a session-scoped active role

`users.role` was removed entirely and replaced with a `user_roles` join table
— one person, several rows, no risk of two columns disagreeing about what
role someone holds (avoiding the same "two sources of truth" failure mode
this project has hit and fixed several times in infrastructure config).
Separately, the **session** tracks which one role is *active* for that
specific login — the same pattern AWS IAM uses for role assumption. Concretely:

- `LoginDto` accepts an optional `role`. Required only when an account holds
  more than one; a single-role account still logs in exactly as before, no
  role field needed.
- `AuthService.validateUser()` decides the active role: auto-selects if there
  is exactly one, requires an explicit choice if there is more than one, and
  rejects a requested role the account doesn't actually hold.
- The session stores `{ id, activeRole }`, not a bare user id.
  `SessionSerializer.deserializeUser` re-validates on every request that the
  stored `activeRole` is still among the account's real roles — if an admin
  revokes a role mid-session, the next request fails deserialization
  immediately (`isAuthenticated()` becomes false), rather than the change only
  taking effect at the next login.
- `POST /auth/switch-role` changes the active role without a full
  logout/login, by calling `req.login()` again with an updated `activeRole` —
  which also, as a side effect, rotates the session ID (Passport's built-in
  protection against session fixation).
- `UsersService.grantRole()` adds an additional role to an existing account,
  creating the corresponding profile row if one doesn't already exist — this
  is the actual mechanism that resolves the practitioner-who-owns-the-clinic
  case: create the account once, grant the second role later.

Every place that previously read `user.role` — `RolesGuard`, the ownership
checks in `UsersController`, `ExercisesService.assertCanModify` — was updated
to read `user.activeRole` instead, since authorization now depends on which
role is active for *this* session, not merely which roles the account holds
in general.

## `ClinicsModule` and the registration bootstrap problem

Restricting `POST /users` to authenticated staff (a consequence of the access-
map work) created a real gap: nothing could create the very first account in a
fresh deployment. `POST /auth/register-clinic` resolves this — creating a
clinic and its founding admin together in one transaction — but is
deliberately gated to refuse running at all once any admin account already
exists anywhere in the system. This is intentional, not a limitation to relax
later: the schema's own design treats `clinics` as branding/display, not a
multi-tenant isolation boundary, so an ungated version of this endpoint would
let anyone spin up unlimited clinics in the same database — a materially
different, and much higher-stakes, product than the single-tenant one that
was actually designed.

`ClinicsService` deliberately does not inject `UsersService` (and vice versa)
— both independently query whatever tables they need via the shared, global
`DRIZZLE` token. Neither module needing the other's NestJS module imported
avoids a circular dependency that would otherwise appear the moment each
needed to reference the other's data.

### Who can see whom: clinic-scoped, not strictly assigned

`GET /users` for a practitioner returns patients who share a clinic with
them — the only relationship table available (no `AssignedProgramsModule` or
`MedicalFilesModule` yet to define a stricter "actually treating"
relationship). Whether clinic-wide visibility among colleagues is
appropriate was checked against HIPAA's actual text, not assumed: the
"minimum necessary" standard explicitly does not apply to provider-to-provider
disclosures for treatment purposes, so clinic-wide access among practitioners
at the same practice is legally defensible, not merely convenient — a
reasonable default for a PT clinic specifically, where patients commonly see
more than one provider at the same practice over time.

### Single-tenant, confirmed deliberately

Revisiting multi-tenant vs. single-tenant directly, rather than assuming: the
schema's own framing of `clinics` (display/branding, not an isolation
boundary) was treated as the deciding factor. True multi-tenancy would need
every query in the application to correctly filter by `clinic_id`, forever —
a categorically stricter security bar than what this project actually needs,
for a capability nothing in the original spec asked for. Staying single-
tenant keeps the design consistent with earlier scoped-down infrastructure
choices (Caddy over Traefik, in-memory throttling over Redis) — solving the
problem this project actually has, not a larger one it doesn't.
