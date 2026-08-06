# Roles & Authorization Model

Every claim below was read directly from the `@Roles(...)` decorators on
each controller and the `assertCan*`/inline authorization checks inside each
service — not inferred from the domain description. Several of these are
genuinely non-obvious; don't assume a "reasonable-sounding" permission model
without checking this table.

## The three roles

A user account can hold **more than one role at once** (`user_roles` is a
one-to-many table — e.g. a clinic owner can be both `admin` and a treating
`practitioner`). Only one role is ever *active* for a given session at a
time (`activeRole`), selected at login or via `POST /auth/switch-role` — see
[Authentication](./01-authentication.md). Every authorization check in this
API is against the session's current `activeRole`, never the full set of
roles the account holds.

- **`admin`** — clinic/practice-level oversight. Can manage clinics, users,
  and correct/moderate almost any clinical content — but **cannot author
  new clinical content** in several places (see the exercises/programs rows
  below). Admins edit and archive; practitioners create.
- **`practitioner`** — the primary content author: exercises, program
  templates, assigned programs, medical file entries. Actions are
  **clinic-scoped**: a practitioner can only manage patients who share at
  least one clinic membership with them (`UsersService.isPatientManagedBy`,
  reused by nearly every module below as the definition of "my patient").
- **`patient`** — largely read-and-self-report: views their own assigned
  programs and medical history, and drives their own workout sessions
  (start, complete, mark exercises done). Patients never edit clinical
  prescriptions.

## Authorization is layered

Most routes have **two** layers of checking, and both matter:

1. **`RolesGuard`** (`@Roles(...)` on the controller) — a coarse gate: is
   this role even allowed to call this endpoint at all? Failing this is
   always `403 Forbidden`.
2. **Service-level checks** (`assertCanModify`, `assertCanManage`,
   `assertCanView`, `isPatientManagedBy`, ownership comparisons, etc.) — a
   finer-grained check against the *specific resource* being acted on
   (do you own this exercise; do you actually manage this patient; is this
   your own session). Also `403 Forbidden` when it fails, but the message is
   specific to the resource, not the generic "you do not have permission to
   access this resource" `RolesGuard` produces.

A route with no `@Roles()` at all is reachable by any authenticated user
(any role) — but that doesn't mean unrestricted: it usually means the
service scopes the returned/affected data by role internally instead (e.g.
`GET /assigned-programs` — a patient only ever sees their own, a
practitioner only their managed patients', an admin sees everything, all
from the *same* endpoint with no role restriction on the route itself).

## Resource-by-resource reference

**Legend:** ✅ allowed at the route level · — not allowed at all · a note
means the route allows the role, but a service-level check narrows it
further.

### Clinics (`/clinics`)

| Action | admin | practitioner | patient |
|---|---|---|---|
| Create a clinic | ✅ | — | — |
| List / view a clinic | ✅ (any authenticated user, in fact) | ✅ | ✅ |
| List clinic members | ✅ | — | — |
| Add / remove a member | ✅ | — | — |
| Update clinic / upload logo | ✅ | — | — |
| Deactivate a clinic | ✅ | — | — |

Note: `POST /auth/register-clinic` (the *very first* clinic + its founding
admin) is a separate, one-time bootstrap path — see
[Authentication](./01-authentication.md). This table is for creating
*additional* clinics once at least one admin already exists.

### Users (`/users`)

| Action | admin | practitioner | patient |
|---|---|---|---|
| Create a user | ✅ any role | ✅ **patients only** — `UsersService.create` throws `403` if a practitioner submits any other role | — |
| Grant an additional role to an existing user | ✅ | — | — |
| List users | ✅ sees everyone | ✅ sees only their own managed patients (clinic-scoped) | — (no listing at all) |
| View a specific user (`GET /users/:id`) | ✅ any user | ⚠️ **any** user, not clinic-scoped — see note below | only themself |
| Update a user | ✅ any user | ✅ only their own managed patients, or themself | only themself |
| Deactivate (soft-delete) a user | ✅ any user | ✅ only their own managed patients, or themself | only themself |
| Upload a user's avatar | ✅ any user | self only | self only |

**Verified: `GET /users/:id` is not clinic-scoped, unlike its siblings.**
`UsersController.findOne` (`users.controller.ts:113-122`) checks only
`isSelf || isElevated`, where `isElevated` is simply `activeRole ===
'practitioner' || activeRole === 'admin'` — there is no call to
`isPatientManagedBy` here at all. Practically: **any practitioner can view
any single user's full profile by id** — including practitioners at other
clinics, admins, or patients they have no clinical relationship with — not
just "their own patients." This is a real inconsistency with `PATCH
/users/:id` and `DELETE /users/:id` on the very same controller, which
*do* correctly restrict a practitioner to `isPatientManagedBy(id,
currentUser.id)`. Worth confirming with the backend team whether this is
intentional (e.g. "any staff member can look up any account") or a gap —
don't assume clinic-scoping applies here just because it applies to the
neighboring routes.

### Exercises (`/exercises`)

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** an exercise | — | ✅ | — |
| List / view exercises | ✅ | ✅ | ✅ (any authenticated user) |
| Update / archive / manage images | ✅ **any** exercise | ✅ **only their own `custom`-sourced exercises** | — |

This is the "admins can't create, only edit" case called out explicitly in
the project brief: `POST /exercises` has `@Roles('practitioner')` only — no
`admin`. But `PATCH`/`DELETE`/image routes have `@Roles('practitioner',
'admin')`, and `ExercisesService.assertCanModify` lets an admin correct
*any* exercise (including the shared, non-custom seeded library), while a
practitioner may only touch a `custom`-sourced exercise they personally
created (`exercises.service.ts:224`).

### Program templates (`/programs`)

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** a template | — | ✅ | — |
| Add / update / reorder / remove a template's exercises | ✅ **any** template | ✅ **only templates they created** | — |
| List / view templates | ✅ | ✅ | ✅ (any authenticated user) |
| Update / archive a template | ✅ **any** | ✅ **only their own** | — |

Identical shape to exercises: authorship is practitioner-only; admin
correction rights apply after the fact, scoped to *any* template, while a
practitioner is scoped to templates they personally authored
(`programs.service.ts:233`).

### Assigned programs (`/assigned-programs`)

A patient's actual, individualized treatment plan — created by copying a
template's exercises (or an ad-hoc list) at the moment of assignment; later
edits to the source template never retroactively affect an already-assigned
program.

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** (assign a program to a patient) | — | ✅ **only patients they manage** (clinic-scoped) | — |
| Add / update / reorder / remove exercises, update, archive | ✅ any | ✅ **only for patients they manage** | — |
| View | ✅ all | ✅ only their managed patients' | ✅ **only their own** |
| List (`GET /assigned-programs`) | sees all | sees only their managed patients' | sees only their own |

Patients can view but never manage — `AssignedProgramsService.assertCanManage`
(`assigned-programs.service.ts:316`) has no patient branch at all, even for
their own program.

### Sessions (`/sessions`)

A single workout instance the patient actually performs, generated from an
assigned program's current exercises at the moment the session is created.

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** (start a session) | — | — | ✅ **only for their own assigned programs** |
| Update session / update a session's exercises | — | — | ✅ **only their own sessions** |
| View | ✅ all | ✅ only their managed patients' | ✅ only their own |

This is the strictest module in the API: `SessionsService.assertIsOwner`
(`sessions.service.ts:205`) has **no admin-or-practitioner branch at all**
for writes — practitioners and admins get read-only visibility via
`assertCanView`, full stop. Starting and progressing a session is something
only the patient themselves ever does.

### Medical files (`/medical-files`)

Append-only clinical record entries — deliberately **no update or delete
route exists anywhere in this controller**; a correction is a new entry,
never an edit to an old one.

| Action | admin | practitioner | patient |
|---|---|---|---|
| **Create** an entry | — | ✅ **only for patients they manage** | — |
| List / view entries | ✅ any patient (via `?patientId=`) | ✅ only patients they manage (via `?patientId=`) | ✅ only their own (implicit — no query param needed) |

Every read (list *and* single-entry view) is separately audit-logged
(`ACCESS_MEDICAL_FILE_LIST` / `ACCESS_MEDICAL_FILE`) against the viewer and
the patient whose record was viewed — this module is the one place in the
API where reads, not just writes, generate an audit trail.

### Messaging (`/conversations`, WebSocket)

| Action | admin | practitioner | patient |
|---|---|---|---|
| Start a conversation | — | ✅ **only with a patient they manage** | ✅ **only with a practitioner who manages them** |
| Send / read messages, mark read | ✅ any conversation | ✅ only conversations they're a participant in | ✅ only conversations they're a participant in |
| Archive / unarchive | ⚠️ see note below | ✅ own side only | ✅ own side only |
| Delete a message | ✅ own messages, unread, within 15 min of sending (see note) | ✅ own messages, unread, within 15 min of sending | ✅ own messages, unread, within 15 min of sending |

Only `practitioner` and `patient` can create a conversation at all —
`MessagingService.createConversation` throws `403` for any other active
role. See [WebSocket API](./02-websocket-api.md) for the important caveat
that the `joinConversation` WS event currently performs **no** participant
check, unlike every REST/other-WS operation in this module.

**Note on admin and message deletion:** `assertParticipant` lets an admin
call `sendMessage` on *any* conversation, not just view it — `createConversation`
is the only place admin is actually blocked from participating (`403`,
"Only practitioners and patients can start conversations"). So an admin who
sends a message into an existing conversation is that message's
`senderId`, and `deleteMessage`'s ownership check (`message.senderId !==
currentUser.id`) treats them identically to any other sender — same 15-minute,
unread-only rule, no special admin bypass. In practice this only matters if
an admin actually sends a message in the first place, which the UI may
never expose, but the underlying rule has no role-based exception for
admins specifically.

**Verified discrepancy — archive/unarchive and admins:** the comment above
`archiveConversation` in the source (`messaging.service.ts:145-149`) states
"Admins don't get an archive action at all," but tracing the actual code
shows otherwise. `assertParticipant` (`messaging.service.ts:248-258`)
explicitly lets an `admin` through even though an admin is never the
`practitionerId` or `patientId` on a conversation:
`if (!isParticipant && currentUser.activeRole !== 'admin') throw
ForbiddenException(...)`. Having passed that check, the column-selection
ternary right below it (`currentUser.activeRole === 'practitioner' ? {...}
: {...}`) only special-cases `'practitioner'` — anything else, admin
included, falls into the `else` branch and sets `patientArchivedAt`. So as
actually implemented: **`PATCH /conversations/:id/archive` (and
`/unarchive`) do not reject an admin caller** — they silently set
`patientArchivedAt` on an arbitrary conversation the admin isn't part of.
This looks like a genuine gap between the documented intent and the code,
not a deliberate design choice — worth raising with the backend team rather
than building frontend behavior around either the comment's stated intent
or the current (likely unintended) runtime behavior.

### Audit logs (`/audit-logs`)

Admin-only, full stop — `@Roles('admin')` at the controller level, no
service-level nuance beneath it. Practitioners and patients have no access
of any kind, not even to entries about themselves.

### Health (`/health`)

No authentication or role requirement at all, and explicitly exempt from
rate limiting — this endpoint exists for load balancers and monitoring
systems, not application clients.
