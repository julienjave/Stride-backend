# Endpoint Index

Every REST route in the API, on one page: its method and path, who may call
it, what it answers on success, and anything special about it. The WebSocket
events aren't routes, so they're in [the WebSocket reference](./02-websocket-api.md)
instead.

**This table is generated from the code, not written by hand.** The command
`npm run docs:endpoints` ([`scripts/docs-endpoints.ts`](../../scripts/docs-endpoints.ts))
reads the metadata that each controller's decorators store (`@Controller`,
`@Get`/`@Post`/…, `@UseGuards`, `@Roles`, `@HttpCode`, `@Throttle`,
`@DemoLocked`…). That's the same metadata Nest reads to build its router,
so the table shows what the server does, not what a comment says. A unit
test ([`scripts/docs/endpoints.spec.ts`](../../scripts/docs/endpoints.spec.ts))
fails as soon as a route changes and the table doesn't. The same test checks
that every role check has a sign-in check in front of it, since the
**Who** column depends on that.

---

## Contents

- [Reading the table](#reading-the-table)
- [The routes](#the-routes)
  - [Admin](#admin)
  - [Alerts](#alerts)
  - [Assigned Programs](#assigned-programs)
  - [Audit](#audit)
  - [Auth](#auth)
  - [Care team](#care-team)
  - [Clinics](#clinics)
  - [Complaint reviews](#complaint-reviews)
  - [Exercises](#exercises)
  - [Health](#health)
  - [Invitations](#invitations)
  - [Legal disclosures](#legal-disclosures)
  - [Medical Files](#medical-files)
  - [Messaging](#messaging)
  - [Monitoring](#monitoring)
  - [Programs](#programs)
  - [Range of Motion](#range-of-motion)
  - [Records export](#records-export)
  - [Sessions](#sessions)
  - [Users](#users)

---

## Reading the table

- **Who** is the *guard-level* gate: the first check a request meets.
  - `public`: no sign-in needed.
  - `signed in`: any signed-in user, whatever their role.
  - A role list (for example `practitioner, admin`): the session's
    **active** role must be one of them (see
    [switching roles](./01-authentication.md#switching-roles-on-a-multi-role-account)).

  It is *not* the whole rule. Most routes then check the specific record in
  their service ("is this patient one of yours?"), and the database checks
  again with Row-Level Security. A `signed in` route is therefore usually
  narrower than it looks. [Roles & Authorization](./04-authorization.md)
  explains those rules resource by resource.
- **Success** is the status of a successful answer. Nest answers `201` to a
  `POST` and `200` to everything else unless the route says otherwise
  (`@HttpCode`). That's why some `POST` routes that create nothing (such as a
  review or a lookup) answer `200`.
  Errors follow one shape everywhere ([Response Conventions](./03-conventions.md#error-responses)).
- **Notes**:
  - *limit*: the route's own rate limit, tighter than the default stated
    above the table.
  - *demo lock*: on the public demo deployment, the change is refused (`403`)
    for the shared reviewer accounts, so one reviewer can't lock the others
    out.
  - *multipart upload*: the body is `multipart/form-data`, not JSON.
  - *returns application/pdf*: the body is a file, not JSON.
  - *Cache-Control*: a header the route sets itself.
  - *changes nothing (not audited)*: a `POST` that only reads. Every other
    route that changes data writes an audit entry (see the
    [conventions](./03-conventions.md#audit-trail)).

For request and response **bodies** (fields, types, validation limits), use
the Swagger UI the server publishes at `/api-docs`. It's generated from the
DTOs, the same way this table is generated from the decorators.

## The routes

<!-- BEGIN GENERATED: npm run docs:endpoints — do not edit by hand -->

149 routes. Rate limit when the Notes don't say otherwise: 60 / min per route and IP address.

### Admin

[`admin-metrics.controller.ts`](../../src/admin-metrics/admin-metrics.controller.ts), [`admin-users.controller.ts`](../../src/users/admin-users.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/admin/metrics` | admin | 200 |  |
| GET | `/admin/users` | admin | 200 |  |

### Alerts

[`alerts.controller.ts`](../../src/alerts/alerts.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/alerts` | practitioner | 200 |  |
| POST | `/alerts/care-team-joins/:linkId/review` | practitioner | 200 |  |
| POST | `/alerts/complaint-reviews/:reviewId/review` | practitioner | 200 |  |
| POST | `/alerts/legal-disclosures/:disclosureId/review` | practitioner | 200 |  |
| POST | `/alerts/patient-merges/:mergeId/review` | practitioner | 200 |  |
| POST | `/alerts/programs/:programId/review` | practitioner | 200 |  |

### Assigned Programs

[`assigned-programs.controller.ts`](../../src/assigned-programs/assigned-programs.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/assigned-programs` | practitioner, patient | 200 |  |
| POST | `/assigned-programs` | practitioner | 201 |  |
| GET | `/assigned-programs/:id` | practitioner, patient | 200 |  |
| PATCH | `/assigned-programs/:id` | practitioner | 200 |  |
| DELETE | `/assigned-programs/:id` | practitioner | 200 |  |
| POST | `/assigned-programs/:id/cancel` | practitioner | 200 |  |
| GET | `/assigned-programs/:id/closing` | practitioner, patient | 200 |  |
| POST | `/assigned-programs/:id/complete` | practitioner | 200 |  |
| POST | `/assigned-programs/:id/exercises` | practitioner | 201 |  |
| PATCH | `/assigned-programs/:id/exercises` | practitioner | 200 |  |
| PATCH | `/assigned-programs/:id/exercises/:exerciseRowId` | practitioner | 200 |  |
| DELETE | `/assigned-programs/:id/exercises/:exerciseRowId` | practitioner | 200 |  |
| POST | `/assigned-programs/:id/exercises/:exerciseRowId/images` | practitioner | 201 | multipart upload |
| PATCH | `/assigned-programs/:id/exercises/:exerciseRowId/images` | practitioner | 200 |  |
| DELETE | `/assigned-programs/:id/exercises/:exerciseRowId/images` | practitioner | 200 |  |
| POST | `/assigned-programs/:id/exercises/:exerciseRowId/images/from-library` | practitioner | 201 |  |
| GET | `/assigned-programs/:id/exercises/:exerciseRowId/removal` | practitioner, patient | 200 |  |
| POST | `/assigned-programs/:id/exercises/copy` | practitioner | 201 |  |
| POST | `/assigned-programs/:id/schedules` | practitioner | 201 |  |
| GET | `/assigned-programs/:id/sessions` | practitioner, patient | 200 |  |
| GET | `/assigned-programs/:id/summary` | practitioner, patient | 200 |  |
| POST | `/assigned-programs/:id/workouts` | practitioner | 201 |  |
| PATCH | `/assigned-programs/:id/workouts` | practitioner | 200 |  |
| PATCH | `/assigned-programs/:id/workouts/:workoutId` | practitioner | 200 |  |
| DELETE | `/assigned-programs/:id/workouts/:workoutId` | practitioner | 200 |  |

### Audit

[`audit.controller.ts`](../../src/audit/audit.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/audit-logs` | admin | 200 |  |
| GET | `/audit-logs/actions` | admin | 200 |  |

### Auth

[`email-change.controller.ts`](../../src/email-change/email-change.controller.ts), [`auth.controller.ts`](../../src/auth/auth.controller.ts), [`mfa.controller.ts`](../../src/mfa/mfa.controller.ts), [`password-change.controller.ts`](../../src/password-change/password-change.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/auth/email-change` | signed in | 200 |  |
| POST | `/auth/email-change` | signed in | 201 | limit 5 / min; demo lock: no email change when signed in as a shared demo account |
| DELETE | `/auth/email-change` | signed in | 204 |  |
| POST | `/auth/email-change/cancel` | public | 204 | limit 5 / min |
| POST | `/auth/email-change/confirm` | public | 200 | limit 5 / min |
| POST | `/auth/forgot-password` | public | 204 | limit 5 / min |
| POST | `/auth/login` | public | 201 | limit 5 / min |
| POST | `/auth/logout` | public | 204 |  |
| GET | `/auth/me` | signed in | 200 |  |
| POST | `/auth/mfa/disable` | signed in | 204 | limit 5 / min; demo lock: no two-factor change when signed in as a shared demo account |
| POST | `/auth/mfa/enable` | signed in | 200 | limit 5 / min; demo lock: no two-factor change when signed in as a shared demo account |
| GET | `/auth/mfa/recovery-codes` | signed in | 200 |  |
| POST | `/auth/mfa/recovery-codes` | signed in | 201 | limit 5 / min; demo lock: no two-factor change when signed in as a shared demo account |
| POST | `/auth/mfa/setup` | signed in | 201 | limit 5 / min; demo lock: no two-factor change when signed in as a shared demo account |
| POST | `/auth/mfa/verify` | public | 201 | limit 5 / min |
| POST | `/auth/password` | signed in | 204 | limit 5 / min; demo lock: no password change when signed in as a shared demo account |
| POST | `/auth/register-clinic` | public | 201 | limit 5 / min |
| POST | `/auth/reset-password` | public | 204 | limit 5 / min |
| POST | `/auth/reset-password/check` | public | 200 | limit 5 / min; changes nothing (not audited) |
| GET | `/auth/setup-status` | public | 200 |  |
| POST | `/auth/switch-role` | signed in | 201 |  |

### Care team

[`directory.controller.ts`](../../src/care-team/directory.controller.ts), [`care-team.controller.ts`](../../src/care-team/care-team.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/directory/patients` | practitioner | 200 |  |
| GET | `/users/:id/care-team` | signed in | 200 |  |
| POST | `/users/:id/care-team` | practitioner, admin | 201 |  |
| POST | `/users/:id/care-team/:practitionerId/end` | practitioner, admin | 201 |  |
| GET | `/users/:id/care-team/candidates` | signed in | 200 |  |

### Clinics

[`clinics.controller.ts`](../../src/clinics/clinics.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/clinics` | signed in | 200 |  |
| POST | `/clinics` | admin | 201 |  |
| GET | `/clinics/:id` | signed in | 200 |  |
| PATCH | `/clinics/:id` | admin | 200 |  |
| DELETE | `/clinics/:id` | admin | 200 |  |
| POST | `/clinics/:id/logo` | admin | 201 | multipart upload |
| DELETE | `/clinics/:id/logo` | admin | 200 |  |
| GET | `/clinics/:id/members` | admin | 200 |  |
| POST | `/clinics/:id/members` | admin | 201 |  |
| DELETE | `/clinics/:id/members/:userId` | admin | 200 |  |
| POST | `/clinics/:id/reactivate` | admin | 201 |  |

### Complaint reviews

[`complaint-reviews.controller.ts`](../../src/complaint-reviews/complaint-reviews.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/users/:id/complaint-reviews` | admin | 200 |  |
| POST | `/users/:id/complaint-reviews` | admin | 201 |  |
| GET | `/users/:id/complaint-reviews/:reviewId/copy` | admin | 200 | limit 5 / min; returns application/pdf; `Cache-Control: no-store` |
| POST | `/users/:id/complaint-reviews/:reviewId/end` | admin | 200 |  |

### Exercises

[`exercises.controller.ts`](../../src/exercises/exercises.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/exercises` | signed in | 200 |  |
| POST | `/exercises` | practitioner | 201 |  |
| GET | `/exercises/:id` | signed in | 200 |  |
| PATCH | `/exercises/:id` | practitioner, admin | 200 |  |
| DELETE | `/exercises/:id` | practitioner, admin | 200 |  |
| POST | `/exercises/:id/images` | practitioner, admin | 201 | multipart upload |
| PATCH | `/exercises/:id/images` | practitioner, admin | 200 |  |
| DELETE | `/exercises/:id/images` | practitioner, admin | 200 |  |

### Health

[`health.controller.ts`](../../src/health/health.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/health` | public | 200 | no rate limit; `Cache-Control: no-cache, no-store, must-revalidate` |

### Invitations

[`public-invitations.controller.ts`](../../src/invitations/public-invitations.controller.ts), [`invitations.controller.ts`](../../src/invitations/invitations.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| POST | `/invitations/accept` | public | 204 | limit 5 / min |
| POST | `/invitations/lookup` | public | 200 | limit 10 / min; changes nothing (not audited) |
| GET | `/users/:id/invitations` | practitioner, admin | 200 |  |
| POST | `/users/:id/invitations` | practitioner, admin | 201 |  |
| POST | `/users/:id/invitations/revoke` | practitioner, admin | 200 |  |

### Legal disclosures

[`own-legal-disclosures.controller.ts`](../../src/legal-disclosures/own-legal-disclosures.controller.ts), [`legal-disclosures.controller.ts`](../../src/legal-disclosures/legal-disclosures.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/legal-disclosures` | patient | 200 |  |
| GET | `/users/:id/legal-disclosures` | admin | 200 |  |
| POST | `/users/:id/legal-disclosures` | admin | 201 | limit 5 / min; returns application/pdf; `Cache-Control: no-store` |

### Medical Files

[`medical-files.controller.ts`](../../src/medical-files/medical-files.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/medical-files` | practitioner, patient | 200 |  |
| POST | `/medical-files` | practitioner | 201 |  |
| GET | `/medical-files/:id` | practitioner, patient | 200 |  |

### Messaging

[`messaging.controller.ts`](../../src/messaging/messaging.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/conversations` | practitioner, patient | 200 |  |
| POST | `/conversations` | practitioner, patient | 201 |  |
| GET | `/conversations/:id` | practitioner, patient | 200 |  |
| PATCH | `/conversations/:id/archive` | practitioner, patient | 200 |  |
| GET | `/conversations/:id/messages` | practitioner, patient | 200 |  |
| POST | `/conversations/:id/messages` | practitioner, patient | 201 |  |
| DELETE | `/conversations/:id/messages/:messageId` | practitioner, patient | 200 |  |
| PATCH | `/conversations/:id/read` | practitioner, patient | 200 |  |
| PATCH | `/conversations/:id/unarchive` | practitioner, patient | 200 |  |

### Monitoring

[`monitoring.controller.ts`](../../src/observability/monitoring.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| POST | `/monitoring` | public | 200 | limit 30 / min; changes nothing (not audited) |

### Programs

[`programs.controller.ts`](../../src/programs/programs.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/programs` | signed in | 200 |  |
| POST | `/programs` | practitioner | 201 |  |
| GET | `/programs/:id` | signed in | 200 |  |
| PATCH | `/programs/:id` | practitioner, admin | 200 |  |
| DELETE | `/programs/:id` | practitioner, admin | 200 |  |
| POST | `/programs/:id/duplicate` | practitioner | 201 |  |
| POST | `/programs/:id/exercises` | practitioner, admin | 201 |  |
| PATCH | `/programs/:id/exercises` | practitioner, admin | 200 |  |
| PATCH | `/programs/:id/exercises/:templateExerciseId` | practitioner, admin | 200 |  |
| DELETE | `/programs/:id/exercises/:templateExerciseId` | practitioner, admin | 200 |  |
| POST | `/programs/:id/exercises/copy` | practitioner, admin | 201 |  |
| POST | `/programs/:id/workouts` | practitioner, admin | 201 |  |
| PATCH | `/programs/:id/workouts` | practitioner, admin | 200 |  |
| PATCH | `/programs/:id/workouts/:workoutId` | practitioner, admin | 200 |  |
| DELETE | `/programs/:id/workouts/:workoutId` | practitioner, admin | 200 |  |

### Range of Motion

[`range-of-motion.controller.ts`](../../src/range-of-motion/range-of-motion.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/range-of-motion` | practitioner, patient | 200 |  |
| POST | `/range-of-motion` | practitioner | 201 |  |
| GET | `/range-of-motion/:id` | practitioner, patient | 200 |  |
| GET | `/range-of-motion/movements` | practitioner, patient | 200 |  |

### Records export

[`records-export.controller.ts`](../../src/records-export/records-export.controller.ts), [`public-records-export.controller.ts`](../../src/records-export/public-records-export.controller.ts), [`records-export-links.controller.ts`](../../src/records-export/records-export-links.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/records-export` | patient | 200 | limit 5 / min; returns application/pdf; `Cache-Control: no-store` |
| POST | `/records-export/download` | public | 200 | limit 5 / min; returns application/pdf; `Cache-Control: no-store` |
| GET | `/users/:id/records-export-links` | admin | 200 |  |
| POST | `/users/:id/records-export-links` | admin | 201 |  |

### Sessions

[`sessions.controller.ts`](../../src/sessions/sessions.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| POST | `/sessions` | patient | 201 |  |
| GET | `/sessions/:id` | practitioner, patient | 200 |  |
| PATCH | `/sessions/:id` | patient | 200 |  |
| POST | `/sessions/:id/complete` | patient | 200 |  |
| PATCH | `/sessions/:id/exercises/:exerciseRowId` | patient | 200 |  |
| POST | `/sessions/:id/review` | practitioner | 200 |  |
| POST | `/sessions/:id/stop` | patient | 200 |  |
| POST | `/sessions/skip` | patient | 201 |  |

### Users

[`patient-merges.controller.ts`](../../src/patient-merges/patient-merges.controller.ts), [`users.controller.ts`](../../src/users/users.controller.ts), [`mfa-admin.controller.ts`](../../src/mfa/mfa-admin.controller.ts)

| Method | Path | Who | Success | Notes |
|---|---|---|---|---|
| GET | `/patient-merges` | admin | 200 |  |
| GET | `/users` | practitioner, admin | 200 |  |
| POST | `/users` | practitioner, admin | 201 |  |
| GET | `/users/:id` | signed in | 200 |  |
| PATCH | `/users/:id` | signed in | 200 |  |
| DELETE | `/users/:id` | signed in | 200 | demo lock: no deactivation when the target is a shared demo account |
| POST | `/users/:id/avatar` | signed in | 201 | multipart upload |
| DELETE | `/users/:id/avatar` | signed in | 200 |  |
| POST | `/users/:id/merge` | admin | 200 | limit 5 / min; demo lock: no merge when the target is a shared demo account |
| POST | `/users/:id/mfa/reset` | admin | 204 | limit 5 / min; demo lock: no two-factor change when the target is a shared demo account |
| POST | `/users/:id/reactivate` | admin | 201 |  |
| POST | `/users/:id/roles` | admin | 201 |  |

<!-- END GENERATED -->
