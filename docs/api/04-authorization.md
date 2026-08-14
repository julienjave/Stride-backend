# Roles & Authorization Model

Verified against commit `a3531f1c2a66c113e2fbcdd74365797e9670b949`. Every
claim below was read directly from the `@Roles(...)` decorators on each
controller and the `assertCan*`/inline authorization checks inside each
service — never inferred from what a "reasonable" physiotherapy API might
do. Several rows are genuinely non-obvious; don't assume a permission model
without checking this table against the source it links to.

## The three roles

A single user account can hold **more than one role at once** —
`user_roles` is a one-to-many table (e.g. a clinic owner can be both `admin`
and a treating `practitioner`). Only one role is ever *active* for a given
session at a time (`activeRole`), chosen at login or via
`POST /auth/switch-role` (see [Authentication](./01-authentication.md)).
Every authorization check anywhere in this API is against the session's
current `activeRole` — never the full set of roles the account holds.

- **`admin`** — clinic/practice-level oversight: manages clinics, users, and
  corrects or archives clinical content created by others. Deliberately
  **cannot author new clinical content** in several places (exercises,
  program templates) — admins edit and archive; practitioners create.
- **`practitioner`** — the primary content author: exercises, program
  templates, assigned programs, medical file entries. Almost every
  practitioner action is **clinic-scoped**: a practitioner can only act on a
  patient who shares at least one clinic membership with them
  (`UsersService.isPatientManagedBy`, reused throughout the codebase as the
  definition of "my patient").
- **`patient`** — reads and self-reports: views their own assigned programs
  and medical history, and drives their own workout sessions (start,
  progress, complete). Patients never edit a clinical prescription, even
  their own.

## Authorization is layered

Most protected routes have **two** independent layers, and both matter:

1. **`RolesGuard`** (driven by `@Roles(...)` on the controller or a specific
   handler) — a coarse gate: is this `activeRole` even allowed to call this
   route at all? Failing this is always `403 Forbidden`, with the generic
   message `"You do not have permission to access this resource"`.
2. **Service-level checks** — `assertCanModify`, `assertCanManage`,
   `assertCanView`, `assertIsOwner`, `isPatientManagedBy`, direct ownership
   comparisons, etc. — a finer-grained check against the *specific resource*
   being acted on (do you own this exercise; do you actually manage this
   patient; is this your own session). Usually `403 Forbidden` on failure,
   with a message specific to the resource and rule that rejected it, not
   the generic `RolesGuard` text — **except for four resources, where the
   real answer is `404` instead. See the callout immediately below.**

**A third, Row-Level-Security-driven outcome, on four specific resources.**
`medical_files`, `assigned_programs`, `sessions`, and `conversations` all
carry database-level RLS policies that mirror the service-level check
above. Every route on these four resources fetches the target row first,
*then* runs its ownership/participant check against it — and since RLS
filters an out-of-scope row out of the query entirely, that row is simply
never there for the check to reject in the first place. The practical
effect: for these four resources only, a caller with no real relationship
to the resource gets `404 Not Found` (`"<Resource> <id> not found"`), not
`403 Forbidden` — the identical status a genuinely nonexistent id would
produce. This is deliberate, confirmed directly against each service's
source and its passing tests, not an inconsistency — but it means a
resource's existence and a caller's right to see it are genuinely
indistinguishable from outside, for these four tables specifically. `users`
(the check runs before any RLS-scoped fetch at all), `exercises`, and
`program_templates` (both fully visible to any authenticated user via RLS
by design) are unaffected — their service-level checks still produce a real
`403`. Each affected resource section below is flagged accordingly.

A route with no `@Roles()` at all is reachable by any authenticated user of
any role — that does not mean it's unrestricted, usually it means the
*service* scopes the returned or affected data by role internally instead.
`GET /assigned-programs` is the clearest example: no role restriction on the
route itself, but a patient only ever sees their own programs, a
practitioner only their managed patients', and an admin sees everything —
all from the same endpoint.

## Resource-by-resource reference

**Legend:** ✅ = allowed at the route level · — = not allowed at all · a note
after ✅ means the route-level check passes, but a service-level check
narrows it further.

### Clinics (`/clinics`) — [`clinics.controller.ts`](../../src/clinics/clinics.controller.ts)

| Action | admin | practitioner | patient |
|---|---|---|---|
| Create a clinic | ✅ | — | — |
| List / view a single clinic | ✅ (any authenticated user, in fact — no `@Roles()` on these two routes) | ✅ | ✅ |
| List a clinic's members | ✅ | — | — |
| Add / remove a member | ✅ | — | — |
| Update a clinic / upload its logo | ✅ | — | — |
| Deactivate a clinic | ✅ | — | — |

`POST /auth/register-clinic` (the *very first* clinic and its founding
admin) is a separate, one-time bootstrap path documented in
[Authentication](./01-authentication.md) — this table covers creating
*additional* clinics once at least one admin already exists.

### Users (`/users`) — [`users.controller.ts`](../../src/users/users.controller.ts)

| Action | admin | practitioner | patient |
|---|---|---|---|
| Create a user | ✅ any role | ✅ **patients only** — `UsersService.create` throws `403` if a practitioner submits any other `role` | — |
| Grant an additional role to an existing user | ✅ | — | — |
| List users (`GET /users`) | ✅ sees every active user | ✅ sees only their own managed patients (clinic-scoped) | — no listing at all |
| View a specific user (`GET /users/:id`) | ✅ any user | ✅ only themself, or a patient they manage (clinic-scoped via `isPatientManagedBy`) | only themself |
| Update a user | ✅ any user | ✅ only themself, or a patient they manage | only themself |
| Deactivate (soft-delete) a user | ✅ any user | ✅ only themself, or a patient they manage | only themself |
| Upload a user's avatar | ✅ any user | self only | self only |

`GET /users/:id`, `PATCH /users/:id`, and `DELETE /users/:id` all run the
identical three-way check in `UsersController` —
`isSelf || isAdmin || isManagingPractitioner` — where
`isManagingPractitioner` calls `isPatientManagedBy(id, currentUser.id)`, the
same clinic-membership check used everywhere else in this API. A
practitioner cannot look up an arbitrary account by id; only their own
profile or a patient they actually share a clinic with.

### Exercises (`/exercises`) — [`exercises.controller.ts`](../../src/exercises/exercises.controller.ts)

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** an exercise | — | ✅ | — |
| List / view exercises | ✅ | ✅ | ✅ (any authenticated user) |
| Update / archive / manage images | ✅ **any** exercise | ✅ **only their own `custom`-sourced exercises** | — |

The "admins can't create, only edit" case: `POST /exercises` carries
`@Roles(UserRole.PRACTITIONER)` only — no `admin`. `PATCH`/`DELETE`/image
routes carry `@Roles(UserRole.PRACTITIONER, UserRole.ADMIN)`, and
`ExercisesService.assertCanModify` lets an admin correct *any* exercise
(including the shared, non-`custom` seeded library), while a practitioner
may only touch a `custom`-sourced exercise where `createdBy` is their own id.

### Program templates (`/programs`) — [`programs.controller.ts`](../../src/programs/programs.controller.ts)

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** a template | — | ✅ | — |
| Add / update / reorder / remove a template's exercises | ✅ **any** template | ✅ **only templates they created** | — |
| List / view templates | ✅ | ✅ | ✅ (any authenticated user) |
| Update / archive a template | ✅ **any** | ✅ **only their own** | — |

Same shape as exercises: authorship is practitioner-only via
`@Roles(UserRole.PRACTITIONER)` on `POST /programs`; admin correction rights
apply after the fact to *any* template, while `ProgramsService.assertCanModify`
scopes a practitioner to templates where `practitionerId` matches their own id.

### Assigned programs (`/assigned-programs`) — [`assigned-programs.controller.ts`](../../src/assigned-programs/assigned-programs.controller.ts)

A patient's individualized treatment plan, created by copying a template's
exercises (or an ad-hoc list) at the moment of assignment — later edits to
the source template never retroactively change an already-assigned program.

> **RLS-affected resource**: fetching a program with no relationship to the
> caller returns `404 Not Found`, not `403` — see the callout above.

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** (assign a program to a patient) | — | ✅ **only patients they manage** (clinic-scoped) | — |
| Add / update / reorder / remove exercises; update; archive | ✅ any | ✅ **only for patients they manage** | — |
| View a specific program | ✅ all | ✅ only their managed patients' | ✅ **only their own** |
| List (`GET /assigned-programs`) | sees all | sees only their managed patients' | sees only their own |

`AssignedProgramsService.assertCanManage` has **no patient branch at all** —
a patient can view their own program (`assertCanView` does allow this
specific case), but never edit its prescription, even their own.

### Sessions (`/sessions`) — [`sessions.controller.ts`](../../src/sessions/sessions.controller.ts)

A single workout instance a patient actually performs, generated from an
assigned program's current exercises at the moment the session is created.

> **RLS-affected resource**: fetching a session with no relationship to the
> caller returns `404 Not Found`, not `403` — see the callout above.

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** (start a session) | — | — | ✅ **only for their own assigned programs** |
| Update a session / a session's exercises | — | — | ✅ **only their own sessions** |
| View a session | ✅ all | ✅ only their managed patients' | ✅ only their own |

The strictest module in the API: both `POST /sessions` and
`PATCH /sessions/:id`(`/exercises/:id`) carry `@Roles(UserRole.PATIENT)`
only — no practitioner or admin can even reach these routes at the
`RolesGuard` layer, and `SessionsService.assertIsOwner` has no
admin-or-practitioner branch either. Practitioners and admins get read-only
visibility via `assertCanView`, full stop; starting and progressing a
session is something only the patient themselves ever does.

### Medical files (`/medical-files`) — [`medical-files.controller.ts`](../../src/medical-files/medical-files.controller.ts)

Append-only clinical record entries — this controller deliberately has **no
`PATCH` or `DELETE` route at all**; a correction is a new entry, never an
edit to an old one.

> **RLS-affected resource**: fetching a single entry (`GET
> /medical-files/:id`) with no relationship to the caller returns `404 Not
> Found`, not `403` — see the callout above. The list endpoint's `403` for
> `?patientId=` a practitioner doesn't manage is unaffected — that check
> runs before any RLS-scoped query, since it validates the query parameter
> itself rather than fetching a specific row first.

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** an entry | — | ✅ **only for patients they manage** | — |
| List / view entries | ✅ any patient, via `?patientId=` | ✅ only patients they manage, via `?patientId=` | ✅ only their own (implicit — `patientId` query param not needed, and ignored if sent) |

`POST /medical-files` carries `@Roles(UserRole.PRACTITIONER)` only — not
admin, the same authorship pattern as exercises and program templates.
Every read (both the list and a single-entry `GET`) is separately
audit-logged (`ACCESS_MEDICAL_FILE_LIST` / `ACCESS_MEDICAL_FILE`) against
both the viewer and the patient whose record was viewed — this is the one
module in the API where *reads*, not just writes, generate an audit trail.

### Messaging (`/conversations`, WebSocket) — [`messaging.controller.ts`](../../src/messaging/messaging.controller.ts), [`messaging.gateway.ts`](../../src/messaging/messaging.gateway.ts)

> **RLS-affected resource**: fetching or joining a conversation with no
> relationship to the caller returns `404 Not Found`, not `403` — see the
> callout above, and [WebSocket API](./02-websocket-api.md) for the exact
> confirmed payload over the socket transport specifically. An admin is
> unaffected by this — admins are visible to every conversation's RLS
> policy by design, so the explicit `403` blocks below (which exist
> specifically to stop an admin from writing, not to hide the row) still
> fire normally.

| Action | admin | practitioner | patient |
|---|---|---|---|
| Start a conversation | — | ✅ **only with a patient they manage** | ✅ **only with a practitioner who manages them** |
| View / list messages | ✅ any conversation | ✅ only conversations they participate in | ✅ only conversations they participate in |
| Send a message | — (blocked explicitly, participant-only action) | ✅ only conversations they participate in | ✅ only conversations they participate in |
| Mark a conversation as read | — (blocked explicitly) | ✅ own conversations | ✅ own conversations |
| Archive / unarchive | — (blocked explicitly) | ✅ own side only | ✅ own side only |
| Delete a message | not reachable in practice — see note below | ✅ own messages, unread, within 15 min of sending | ✅ own messages, unread, within 15 min of sending |

Only `practitioner` and `patient` can create a conversation at all —
`MessagingService.createConversation` throws `403` for any other active
role. `joinConversation` on the WebSocket gateway performs the identical
participant check as every REST route in this module — see
[WebSocket API](./02-websocket-api.md) for the exact mechanics.

**Admin's messaging access is read-only, and it's enforced per-action, not
by a single blanket rule.** `assertParticipant` (`messaging.service.ts`)
lets an authenticated `admin` through its own check unconditionally — that
alone would let an admin act on any conversation. But `sendMessage`,
`markAsRead`, `archiveConversation`, and `unarchiveConversation` each add
their *own* explicit, unconditional block immediately after that check:
`if (currentUser.activeRole === UserRole.ADMIN) throw new
ForbiddenException(...)`. So none of those four actually let an admin write
into or manage a conversation, even though the shared participant check
alone wouldn't have stopped them. `getMessages` carries no such block, so
`GET /conversations/:id/messages` stays available to an admin for any
conversation — consistent, read-only oversight, matching what
`GET /conversations` (`findConversationsForUser`) already provides for
admins at the list level.

One consequence worth noting: since admin is unconditionally blocked from
`sendMessage`, an admin can never become a message's `senderId` — so
`deleteMessage`'s ownership check (`message.senderId !== currentUser.id`)
is always false for an admin caller. This isn't a separate, special-cased
admin exception in `deleteMessage` itself; it falls out naturally from the
precondition (having sent a message at all) never being reachable for that
role.

### Audit logs (`/audit-logs`) — [`audit.controller.ts`](../../src/audit/audit.controller.ts)

Admin-only, full stop — `@Roles(UserRole.ADMIN)` at the controller level
(combined with `SessionAuthGuard` also at the controller level), with no
further service-level nuance beneath it. Practitioners and patients have no
access of any kind, not even to log entries about themselves.

### Health (`/health`) — [`health.controller.ts`](../../src/health/health.controller.ts)

No `SessionAuthGuard`, no role requirement, and explicitly exempt from rate
limiting (`@SkipThrottle()`) — this endpoint exists for load balancers and
monitoring systems to poll, not application clients.
