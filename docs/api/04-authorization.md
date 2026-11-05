# Roles & Authorization

Who may do what, and how the API decides. The **gate** of each route (public,
any signed-in user, or a list of roles) is in the generated
[endpoint index](./06-endpoints.md). This document explains everything
behind the gate: the relationships that grant access, the three layers of
checks, and the rules of each resource.

Every rule below is read from the code (the services, and the Row-Level
Security policies in [`src/database/migrations/`](../../src/database/migrations/)).
Each comes with the end-to-end test file that pins it; the tests' names
state the rules almost word for word.

---

## Contents

- [The three roles, and the active one](#the-three-roles-and-the-active-one)
- [The two relationships that grant access](#the-two-relationships-that-grant-access)
- [The three layers, and why many refusals are `404`](#the-three-layers-and-why-many-refusals-are-404)
- [Admins and clinical data](#admins-and-clinical-data)
- [Resource by resource](#resource-by-resource)
  - [Users](#users--userse2e-spects-admin-users-liste2e-spects)
  - [Invitations](#invitations--invitationse2e-spects)
  - [Care team](#care-team--care-teame2e-spects)
  - [Clinics](#clinics--clinicse2e-spects)
  - [Exercise library](#exercise-library--exercisese2e-spects)
  - [Program templates](#program-templates--programse2e-spects-workoutse2e-spects)
  - [Assigned programs](#assigned-programs--assigned-programse2e-spects-program-lifecyclee2e-spects-deactivated-patiente2e-spects)
  - [Sessions](#sessions--sessionse2e-spects)
  - [Medical file](#medical-file--medical-filese2e-spects)
  - [Range of motion](#range-of-motion--range-of-motione2e-spects)
  - [Alerts ("For review")](#alerts-for-review--alertse2e-spects)
  - [Messaging](#messaging--messaginge2e-spects-messaging-gatewaye2e-spects)
  - [Records export](#records-export--records-exporte2e-spects-records-export-linkse2e-spects)
  - [Audit log](#audit-log--audit-log-viewere2e-spects)
  - [Admin home](#admin-home--admin-metricse2e-spects)
  - [Public routes](#public-routes)
- [Deactivated accounts](#deactivated-accounts)
- [The demo deployment's locks](#the-demo-deployments-locks)

---

## The three roles, and the active one

- **`admin`** runs the practice: clinics, accounts, invitations, the audit
  log, merges, and the formal record releases (complaint reviews, legal
  disclosures). An admin has **no standing access to clinical data**
  ([below](#admins-and-clinical-data)).
- **`practitioner`** treats patients: exercises and templates in the shared
  library, and, for the patients on their care team, programs, the medical
  file, range-of-motion assessments, session reviews and messages.
- **`patient`** reads their own record, does their sessions, and messages
  their care team. A patient never edits a prescription, even their own.

An account can hold several roles (`user_roles`); someone can be both
`admin` and `practitioner`, say. **Every check is made against the
session's active role**, chosen at sign-in or with `POST /auth/switch-role`,
never against the full set. The database applies the same rule: each
transaction runs with the session's user id and active role set
(`app.current_user_id`, `app.current_role`), and the policies read those.
An admin + practitioner account signed in **as admin** sees no clinical data
at all, even for patients on its own care team.

## The two relationships that grant access

**Clinic membership** (`user_clinics`) says where someone works or is
treated. Admins manage it (`/clinics/:id/members`). On its own, membership
grants **no** clinical access. A same-clinic practitioner who isn't on a
patient's care team is refused every clinical route
([`care-team.e2e-spec.ts`](../../test/care-team.e2e-spec.ts), "before anyone
joins: same clinic is NOT enough"). What membership does give a
practitioner is the clinic **directory** (`GET /directory/patients`): names
and directory fields, nothing clinical.

**The care team** (`care_team_members`) is the clinical relationship. A
practitioner is on a patient's care team when a link between them is
**current** (started, and not ended) **and** they share a clinic. Both
halves are checked in one SQL function, `rls_care_team_member()`, used by
the policies of every clinical table. The services check the same thing
in TypeScript (`isPatientManagedBy`). A test asserts that the two answer
the same in every situation.

How a link is made:

- **Creating a patient** (`POST /users`, as a practitioner) puts the creator
  on the new patient's care team.
- **"Add to my patients"** (`POST /users/:id/care-team`): a practitioner who
  shares a clinic with the patient joins **with no approval**. This is
  deliberate: it's the practice's emergency access ("break-glass"), and it
  stays accountable. It's audited (`CARE_TEAM_JOINED`), visible to the
  patient on their team page, and every other current member gets an item to
  review. A practitioner of another clinic is refused (`403`).
- **Adding a colleague** (same route, with the colleague and an optional
  planned end, as planned cover): by a practitioner who shares a clinic
  with the patient, or an admin. The colleague must work at one of the
  patient's clinics too (`400` otherwise).
- `GET /users/:id/care-team/candidates` lists who could be added: the
  practitioners of the *patient's* clinics.

How a link ends: `POST /users/:id/care-team/:practitionerId/end`, by the
practitioner on the link (for themselves only) or an admin. A link is
**never deleted** and can only be ended, now. A database trigger refuses
any other change, for an admin too. The history therefore keeps every past
member, and the patient sees them. Leaving a clinic, or being deactivated,
ends a practitioner's links there.

## The three layers, and why many refusals are `404`

1. **The guard** (`SessionAuthGuard`, `RolesGuard` reading `@Roles`): is
   this session signed in, in a role this route accepts? It fails with `401`
   or `403 You do not have permission to access this resource`. The
   [endpoint index](./06-endpoints.md) lists the gate of every route, and its
   test checks the guards are wired so this holds.
2. **The service**: may *this* caller act on *this* record? For example:
   is the patient on my care team, did I write this template, is this my
   session? These refusals are `403`s with words naming the rule, or `409`
   when it's the record's state that refuses (a closed program, a
   deactivated patient).
3. **Row-Level Security**: the same rules again, enforced by PostgreSQL on
   every query, for the restricted `stride_app` role the API connects as.
   Even a query the code got wrong can't read or write outside them.

The third layer changes some answers. A policy doesn't refuse a row; it
makes the row **invisible**. So when a service first loads the record and
only then checks the caller, a caller with no relationship to it gets `404
<Resource> <id> not found`: the same answer as an id that doesn't exist.
That's on purpose. A `403` would confirm that the record exists, which for
a patient's file is itself information. The pattern across the API:

- **one record you have no relationship with**: `404` (a program, a
  session, a file entry, an assessment, a conversation);
- **a list, or a route about a patient you named**: often `403`, because
  the service checks the relationship before reading anything (`GET
  /medical-files?patientId=` off the care team, `GET
  /assigned-programs?patientId=`);
- **a list that's simply scoped**: an empty answer, not an error (for
  example, the alerts of a practitioner on no care team).

Each resource below says which applies.

Some tables are readable by everyone on purpose, because the login path
itself reads them before any user is known. That's `users`, `user_roles`,
the profile tables, `clinics` and `user_clinics`: `SELECT USING (true)`,
proven necessary in the RLS passes (journal entries 29–34). The *services*
then decide which users a caller is shown. "Covered by RLS" and
"restrictive" are different claims, and here only the first is true for
those tables.

## Admins and clinical data

**An admin can't read or change clinical data**: programs, sessions,
medical files, range-of-motion assessments, alerts or messages. That was
decided in two steps: messages and medical files from the start, programs
and sessions in Phase 6 (decisions §16). An admin runs clinics and
accounts; clinical access comes with the practitioner role and a place on
the care team. The rule holds in all three layers:

- every clinical route's gate leaves `admin` out (`403` from the guard);
- the policies have no admin branch, so an admin's query returns **0 rows**
  (tested as the database role, not only through the API);
- in the audit log, an admin sees **that** clinical data was read or
  changed, by whom and when, but not the details, which hold clinical
  content (a prescription before and after, a session's scores). The
  details stay stored.

There are two ways an admin can see a record, both **narrow, time-boxed or
one-off, and recorded** (decisions §25):

- **A complaint review** (`/users/:id/complaint-reviews`): for a complaint
  about care. The admin opens it on one patient, with a required reason
  and an optional case reference. It lasts 7 days and can be ended early.
  It gives no clinical route. What the admin gets is the records PDF,
  stamped "Review copy", each copy audited with the ids of what went in
  (only the opener may make copies). The care team is told.
- **A legal disclosure** (`/users/:id/legal-disclosures`): for a court
  order, a subpoena or a legal requirement. The recipient, the legal basis,
  and the parts and period released are recorded, with a PDF of exactly
  those parts. Messages are released **only** this way. Each disclosure is
  listed in the patient's own accounting of disclosures (`GET
  /legal-disclosures`, and their export), unless held back until a date set
  by the order.

## Resource by resource

### Users — [`users.e2e-spec.ts`](../../test/users.e2e-spec.ts), [`admin-users-list.e2e-spec.ts`](../../test/admin-users-list.e2e-spec.ts)

- **Create** (`POST /users`): an admin creates any role, in any clinic. A
  practitioner creates **patients only**, in a clinic they belong to
  (`clinicId` required) and joins their care team. The account is invited;
  a `password` in the body is refused.
- **List** (`GET /users`): a practitioner gets their **care-team
  patients**, and an admin everyone. The admin's paged, filtered list is
  `GET /admin/users` ([conventions](./03-conventions.md#pagination)).
- **Read one** (`GET /users/:id`): yourself, a practitioner on the
  patient's care team, or an admin. Others get `403`.
- **Update** (`PATCH /users/:id`): yourself, a managing practitioner for
  their patient, or an admin.
  - Which profile fields apply follows the **target's** roles.
  - A practitioner can't change their own license number (`403`); only an
    admin can.
  - An email can't be changed here at all: that's the
    [verified email change](./01-authentication.md#changing-the-email-address).
- **Deactivate** (`DELETE /users/:id`, a soft delete) and **reactivate**
  (`POST /users/:id/reactivate`, admin only):
  - A patient may deactivate their own account, and so may a managing
    practitioner or an admin.
  - A practitioner's account may be deactivated only by an admin or by the
    practitioner themselves. Their care-team links end, in their name.
  - The account's sessions end.
- **Grant a role** (`POST /users/:id/roles`): admin only.
- **Avatar**: your own, or anyone's for an admin.
- **Merge duplicate patients** (`POST /users/:id/merge`, `GET
  /patient-merges`): admin only, and only for two patient accounts. An
  account that is also staff can't be merged away; a merged account can't
  be reactivated; the survivor must be active. The merge runs as one
  database function that only the app's role may execute
  ([`patient-merges.e2e-spec.ts`](../../test/patient-merges.e2e-spec.ts)).
- **Reset someone's two-factor sign-in** (`POST /users/:id/mfa/reset`):
  admin only, with the admin's own re-confirmation.

### Invitations — [`invitations.e2e-spec.ts`](../../test/invitations.e2e-spec.ts)

Seeing, re-sending and revoking an account's invitation: an admin, or a
practitioner on the (patient's) care team. A same-clinic practitioner off
the care team can't see it, and their revoke changes nothing. Looking up and
accepting are public and use only the token, which sees **only its own
invitation**: a policy branch matches the token's hash, set for that one
transaction. Invitations are never deleted, and one account has at most one
open invitation.

### Care team — [`care-team.e2e-spec.ts`](../../test/care-team.e2e-spec.ts)

- **Seeing a patient's team** (`GET /users/:id/care-team`): the patient
  (directory fields only, with no contact details, license or reason), an
  admin, and a practitioner sharing a clinic with the patient. A
  practitioner of another clinic gets `403`. An id that isn't a patient
  gets `404`.
- Joining, adding and ending are [above](#the-two-relationships-that-grant-access).
  Ending someone else's link is `403`, except for an admin.

### Clinics — [`clinics.e2e-spec.ts`](../../test/clinics.e2e-spec.ts)

Reading clinics (`GET /clinics`, `/clinics/:id`) is open to every
signed-in user: names, contact details and logos are display data, not
patient data. Everything else is admin only: creating, editing,
deactivating and reactivating clinics, their logos, and their members. A
clinic is **branding and directory data, not a security boundary**, since
Stride is single-tenant. What the clinic does decide is the care-team rule
above (a link needs a shared clinic).

### Exercise library — [`exercises.e2e-spec.ts`](../../test/exercises.e2e-spec.ts)

- **Read**: every signed-in user. It's a shared library (RLS `SELECT USING
  (true)`) with no patient data.
- **Create**: practitioners. A new exercise is `source: "custom"`, owned by
  its author.
- **Edit, archive, photos**: the author of a custom exercise, or an admin.
  An admin may also correct the imported library. Anyone else gets `403`
  ("You can only modify custom exercises you created, unless you are an
  administrator").

### Program templates — [`programs.e2e-spec.ts`](../../test/programs.e2e-spec.ts), [`workouts.e2e-spec.ts`](../../test/workouts.e2e-spec.ts)

- **Read**: every signed-in user, the same shared library as exercises.
- **Create and duplicate**: practitioners only (an admin gets `403`).
- **Edit, archive, workouts, exercises**: the template's author, or an
  admin. A different practitioner gets `403`.

### Assigned programs — [`assigned-programs.e2e-spec.ts`](../../test/assigned-programs.e2e-spec.ts), [`program-lifecycle.e2e-spec.ts`](../../test/program-lifecycle.e2e-spec.ts), [`deactivated-patient.e2e-spec.ts`](../../test/deactivated-patient.e2e-spec.ts)

- **Read**: the patient (their own), and the patient's care team. Anyone
  else, an admin included, gets nothing.
  - `GET /assigned-programs` is scoped by role: a patient's own, a
    practitioner's patients'. An admin gets `403`.
  - `?patientId=` off the care team is a `403`, not an empty list.
  - One program off the care team is a `404`.
- **Change** (create, edit, workouts, exercises, schedules, cancel,
  complete, delete): the care team. **The patient can never change their
  own program** (`403`), and neither can an admin.
  - A closed (cancelled or completed) program is read-only (`409`); only
    archiving remains.
  - A program with sessions can't be deleted.
  - A deactivated patient's open programs can't change, and no new one can
    be assigned (`409`) until the account is reactivated.

### Sessions — [`sessions.e2e-spec.ts`](../../test/sessions.e2e-spec.ts)

- **Start, update, skip, complete, stop**: **the patient only**, on their
  own program's sessions. Starting a session of someone else's program is
  refused. A practitioner or an admin can't drive a session at all.
- **Read** (`GET /sessions/:id`): the patient, and their care team.
- **Review** (`POST /sessions/:id/review`): a care-team practitioner. A
  managing practitioner can **view** a session and review it, but never
  write to it.
- Some rules are enforced by the database too, against races: one finished
  session a day, no change to a finished session.

### Medical file — [`medical-files.e2e-spec.ts`](../../test/medical-files.e2e-spec.ts)

- **Read**: the patient (their own file), and their care team. Off the care
  team: `403` for the list, `404` for one entry. An admin is refused on
  every route, and the policy returns 0 rows to an admin too.
- **Write** (`POST /medical-files`): a care-team practitioner, decided by
  the policy itself. Entries are **append-only**: no edit, no delete. A
  correction is a new entry *amending* an earlier one, which forms a chain;
  two simultaneous amendments can't both win.
- The same account acting in another role sees nothing.

### Range of motion — [`range-of-motion.e2e-spec.ts`](../../test/range-of-motion.e2e-spec.ts)

The medical file's rules, for measured assessments: the patient reads their
own; the care team reads and records (`403` for the list off the team,
`404` for one); an admin gets nothing. Assessments are append-only with
amendment chains. The author and the moment are set by the server and
can't be sent.

### Alerts ("For review") — [`alerts.e2e-spec.ts`](../../test/alerts.e2e-spec.ts)

Practitioners only (a patient or an admin gets the guard's `403`). Each
practitioner sees the alerts of **their** care-team patients:

- a same-clinic practitioner on no care team gets an empty list;
- reviewing one off the team is a `404`;
- a review is written in **your own name** only, never in a colleague's.

### Messaging — [`messaging.e2e-spec.ts`](../../test/messaging.e2e-spec.ts), [`messaging-gateway.e2e-spec.ts`](../../test/messaging-gateway.e2e-spec.ts)

Practitioners and patients only; admins read no messages (the socket
refuses them too).

- A conversation is between one practitioner and one patient who share a
  care team. Each participant sees only their own conversations; one they
  aren't in is a `404`.
- Sending needs a **current** care-team link, decided by the policy.
  Without one the conversation becomes read-only (`403`). If the patient is
  deactivated, it's a `409` until reactivation. The history stays readable.
- Deleting is your own message only, unread, within 15 minutes.
- Archiving is per participant.
- Details: [WebSocket API](./02-websocket-api.md).

### Records export — [`records-export.e2e-spec.ts`](../../test/records-export.e2e-spec.ts), [`records-export-links.e2e-spec.ts`](../../test/records-export-links.e2e-spec.ts)

- **`GET /records-export`**: the patient's own whole record, as a PDF.
  Patients only, with each export audited. HIPAA's right of access is
  self-service.
- **Export links**: for a patient who can't sign in, an admin sends a
  single-use link (`/users/:id/records-export-links`, admin only).
  - The download (`POST /records-export/download`, public) needs the token
    **and** the patient's date of birth.
  - Wrong dates are counted, and the link locks after too many.
  - Links expire after 72 hours. A newer link replaces the older one.

### Audit log — [`audit-log-viewer.e2e-spec.ts`](../../test/audit-log-viewer.e2e-spec.ts)

Admins only, for the log and the list of actions. Clinical areas' details
are withheld from the admin ([above](#admins-and-clinical-data)). The log is
insert-only for the app's role
([conventions](./03-conventions.md#audit-trail)).

### Admin home — [`admin-metrics.e2e-spec.ts`](../../test/admin-metrics.e2e-spec.ts)

`GET /admin/metrics`: admins only. Counts and attention lists (for example,
patients without a care team, or invitations to send again); no clinical
data.

### Public routes

The rest of the public routes are listed in the [endpoint
index](./06-endpoints.md). Signing in, the password reset, the email-change
links, invitations and the export download each rely on a secret: a
password, or a random 256-bit token kept only as a hash. The two others:

- `GET /health` answers whether the database is up.
- `POST /monitoring` passes browser error reports to GlitchTip. It accepts
  only the app's own project and a Sentry envelope of up to 256 KB, so it
  can't be used as an open relay
  ([`monitoring.e2e-spec.ts`](../../test/monitoring.e2e-spec.ts)).

## Deactivated accounts

A deactivated account can't sign in (`401`, checked after the password).
Its sessions end, it gets no password reset
([details](./01-authentication.md#forgot--reset)), and its existing sessions
stop working on the next request. A deactivated **patient's** record stays
readable by their care team, but **nothing clinical can be added or
changed** until reactivation: no new program, no change to an open one, no
message (`409`, in all three layers)
([`deactivated-patient.e2e-spec.ts`](../../test/deactivated-patient.e2e-spec.ts),
[`practitioner-deactivation.e2e-spec.ts`](../../test/practitioner-deactivation.e2e-spec.ts)).

## The demo deployment's locks

On the reviewers' demo (`DEMO_MODE`), the shared demo accounts can't have
their password, email or two-factor sign-in changed, and can't be
deactivated or merged (`403`, with words explaining why). One reviewer can't
lock the others out. The routes are marked *demo lock* in the
[endpoint index](./06-endpoints.md)
([`demo-mode.e2e-spec.ts`](../../test/demo-mode.e2e-spec.ts)).
