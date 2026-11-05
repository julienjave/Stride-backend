# Response Conventions

The rules that hold across the whole REST API, written once here instead of
repeated for each route: how requests are validated, what every error looks
like, which lists are paged, how dates are written, how rate limiting
answers, and what gets recorded in the audit trail.

---

## Contents

- [Requests](#requests)
- [Error responses](#error-responses)
- [Dates and times](#dates-and-times)
- [Pagination](#pagination)
- [Rate limiting](#rate-limiting)
- [Audit trail](#audit-trail)

---

## Requests

Bodies are JSON, except the routes marked *multipart upload* in the
[endpoint index](./06-endpoints.md). Every body and query string goes
through one global `ValidationPipe`
([`src/main.ts`](../../src/main.ts)), with three settings that matter to a
client:

- `whitelist: true` and `forbidNonWhitelisted: true`: a field the route's
  DTO doesn't declare is an error (`400`, naming the field), not silently
  ignored. A typo in a field name fails loudly instead of being dropped.
- `transform: true`: query-string values (always strings on the wire) are
  converted to the DTO's types, so `?page=2` arrives as the number `2`. A
  value that can't be converted (`?page=two`) is a `400`.

## Error responses

Source of truth:
[`src/common/filters/http-exception.filter.ts`](../../src/common/filters/http-exception.filter.ts),
registered globally in [`src/app.module.ts`](../../src/app.module.ts) via
`APP_FILTER`. It's an `@Catch()` with no argument, so it catches everything
thrown anywhere: deliberate `HttpException`s (`NotFoundException`, a
validation failure…) and unexpected errors alike.

Every error, whatever its status, has this shape:

```json
{
  "statusCode": 404,
  "message": ["Exercise 501 not found"],
  "error": "NotFoundException",
  "timestamp": "2026-11-03T14:22:03.101Z",
  "path": "/exercises/501",
  "requestId": "3f2c7e9a-1b4d-4c6e-9a8f-0d2e5b7c1a44"
}
```

- **`message` is always an array of strings.** Most errors have exactly one
  entry: a sentence written for a person, safe to show as it is. The
  frontend does show it, so the backend's messages are part of its
  contract. A validation failure can have several entries, one per failed
  rule.
- **`requestId`** is also sent as the `X-Request-Id` header on every
  response, error or not. The same id is in the server's log line and in
  the error report sent to GlitchTip, so a person quoting it from an error
  screen leads straight to what happened. The server makes the id itself;
  an `X-Request-Id` sent by the client is ignored.
- **A `500` says nothing more than `["Internal server error"]`**, with
  `error: "InternalServerError"`. The real error (which could carry a stack
  trace or raw Postgres text naming tables and columns) goes only to the
  server log and to GlitchTip.

### Errors that carry more fields

A few refusals add fields next to `message`, so a screen can react without
parsing the sentence:

| Status | Where | Extra fields |
|---|---|---|
| `400` | `POST /auth/login`, for an account with several roles and no `role` in the body | `roles`: the roles to choose from (see [multi-role login](./01-authentication.md#login-single-role-vs-multi-role-accounts)) |
| `409` | Creating a patient who may already exist (same name and date of birth) | `reason: "possible_duplicate"`, plus what the caller may see of the existing patient. Send `allowPossibleDuplicate: true` to create anyway. |
| `410` | An invitation that can't be used any more | `reason`: `accepted`, `revoked` or `expired` |
| `410` | A records-export link that can't be used any more | `reason`: `used`, `replaced`, `locked` or `expired` |
| `400` | A records-export download with the wrong date of birth | `attemptsLeft`: how many tries remain before the link locks |

### Database refusals become the same answers

Some rules are enforced twice: by the service, and by the database itself
(CHECK constraints and triggers). Examples are "a closed program can't
change" and "one finished session a day". The database's copy catches the
rare request that races past the service's check, such as an edit that
lands while the program is being cancelled. When that happens, the filter
translates the database's refusal into the **same status and the same
words** the service would have given (`translateDatabaseRefusal`), never a
`500`. The WebSocket gateway's filter uses the same translation.

## Dates and times

Two kinds of value, never mixed:

- **A calendar date**, a day: `"2026-11-03"`, exactly `YYYY-MM-DD`. Used
  for program dates, schedules and a session's day. It has no time zone,
  because a day means the same day for everyone. Impossible dates
  (`2026-02-30`) are refused.
- **An instant**, a moment: ISO 8601 with its offset, as written by
  `toISOString()`, for example `"2026-11-03T13:22:03.101Z"`. Used for
  timestamps. Where the client sends one (the audit log's `from` and
  `before`), **the offset is required**. Without one, "midnight" would mean
  midnight in whatever zone the server or Postgres happens to use. The
  browser knows the person's time zone; the server doesn't. So the client
  sends the moments that bound the person's day, and the server compares
  instants.

Two routes also take an IANA time-zone name (`"Europe/Paris"`), for the
dates printed in a PDF: the records export and the legal-disclosure copy.

## Pagination

Source of truth:
[`src/common/dto/pagination-query.dto.ts`](../../src/common/dto/pagination-query.dto.ts).

**Pagination is not universal.** Three routes are paged:

| Route | Page size by default | Filters |
|---|---|---|
| `GET /exercises` | 20 | `search` (name), `mine` |
| `GET /admin/users` | 25 | `search`, `role`, `clinic` (an id, or `none`), `status` (`active` by default, `deactivated`, `all`), `attention` |
| `GET /audit-logs` | 20 | `action`, `entityType`, `performedBy`, `targetUserId`, `kind` (`change`, `view`, `sign_in`), `from`, `before` |

They take `page` (≥ 1, default `1`) and `limit` (1–100, a hard ceiling),
and answer:

```json
{
  "data": [ /* up to `limit` rows */ ],
  "meta": { "total": 143, "page": 2, "limit": 20, "totalPages": 8 }
}
```

`meta.total` counts every matching row, whatever the page.
`totalPages = Math.ceil(total / limit)`. A page past the last answers
`data: []` with the real `totalPages`, so a screen can offer the way back.

**Every other list answers a plain JSON array**, with no `data`/`meta`
wrapper. That includes `GET /users`, the programs, sessions, conversations
and messages.

## Rate limiting

Source of truth: [`src/config/rate-limits.ts`](../../src/config/rate-limits.ts),
applied to every route by a global `ThrottlerGuard` (`@nestjs/throttler`
6).

- **The default:** 60 requests a minute, per route and per client IP
  address.
- **Tighter limits** sit on the routes worth guessing at: sign-in,
  two-factor codes, passwords, invitations, records-export downloads
  (mostly 5 a minute). The [endpoint index](./06-endpoints.md) lists every
  route's own limit, generated from its `@Throttle` decorator. `GET /health`
  has none, so monitors can poll it freely.
- **The client's IP behind Cloudflare.** In production the server takes
  the visitor's address from Cloudflare's `CF-Connecting-IP` header
  ([`src/main.ts`](../../src/main.ts)). Otherwise every visitor would share
  the limit of the Cloudflare server in front of them.

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` (seconds until the window resets, not a timestamp).
Over the limit, the answer is a `429` with a `Retry-After` header and a
sentence giving the same wait:

```json
{
  "statusCode": 429,
  "message": ["Too many attempts in a short time. Try again in 42 seconds."],
  "error": "ThrottlerException",
  "timestamp": "2026-11-03T14:22:03.101Z",
  "path": "/auth/login",
  "requestId": "…"
}
```

CORS exposes `Retry-After`, `Content-Disposition` and `X-Request-Id` to the
browser, so a frontend on another origin can read them.

`RATE_LIMITS=off` switches the limits off for the end-to-end test suites,
which send far more requests than a person would. The server refuses to
start with it when `NODE_ENV=production`.

## Audit trail

Every route that can change data writes **one complete audit entry**, in
the same database transaction as the change: if the change rolls back, so
does its entry. The service writes it, because only the service knows what
the record was before and after. The route only *declares* it, with
`@AuditedByService()`.

A unit test, [`src/audit/audit-tags.spec.ts`](../../src/audit/audit-tags.spec.ts),
fails the build for any route that can change data and carries neither
`@AuditedByService()` nor `@NotAudited(reason)`. Only three routes are
`@NotAudited`, each a `POST` that only reads (marked *changes nothing* in
the endpoint index).

Entries are of three kinds (`kind` on `GET /audit-logs`):

- **`change`**: a record was created, changed, archived or deactivated.
- **`view`**: someone **read clinical data**: a program, a session, a
  medical file, range-of-motion results, messages, alerts, a records
  export. HIPAA asks for this, because who looked at a health record
  matters as much as who changed it.
- **`sign_in`**: sign-ins (successful, failed, blocked), sign-outs, role
  switches, recovery codes used, failed re-confirmations.

The log can't be edited. The `audit_logs` table's Row-Level Security has
policies for `SELECT` and `INSERT` only, so the app's database role is
refused any `UPDATE` or `DELETE` there, whatever the code asks
([`0002_audit_logs_rls.sql`](../../src/database/migrations/0002_audit_logs_rls.sql)).
Who may read it is in
[Roles & Authorization](./04-authorization.md).
