# Response Conventions

These apply across the whole REST API. Documented once here rather than
repeated on every route.

## Error responses

Source of truth: [`src/common/filters/http-exception.filter.ts`](../../src/common/filters/http-exception.filter.ts),
registered globally in [`src/app.module.ts`](../../src/app.module.ts) via
`APP_FILTER`. `@Catch()` with no argument — this catches literally every
exception thrown anywhere in the app, both deliberate ones (`NotFoundException`,
`ForbiddenException`, validation failures, etc.) and genuinely unexpected
ones.

Every error response, regardless of status code, has this exact shape:

```json
{
  "statusCode": 404,
  "message": "Exercise 501 not found",
  "error": "NotFoundException",
  "timestamp": "2026-08-05T14:22:03.101Z",
  "path": "/exercises/501"
}
```

A client can rely on `statusCode`, `error`, `timestamp`, and `path` being
present on **every** error, of every kind, everywhere in this API.

Notes on `message`:

- For a deliberately-thrown Nest `HttpException` (the overwhelming majority
  of errors you'll encounter — `400`s from validation, `403`s from
  authorization, `404`s from a missing resource), `message` is the real,
  human-readable reason and is safe to show directly to a user.
- For a `class-validator` validation failure specifically (`400 Bad
  Request` from the global `ValidationPipe`), `message` is an **array of
  strings**, one per failed constraint, not a single string — e.g.
  `["email must be an email", "password must be longer than or equal to 8 characters"]`.
  Handle both the string and array shape of `message` in your error UI.
- For anything that is **not** a deliberate `HttpException` — a genuine bug,
  an unhandled database error, etc. — `message` is always replaced with the
  literal string `"Internal server error"`, and `statusCode` is `500`. The
  real underlying error (which could otherwise leak a stack trace, a file
  path, or raw Postgres error text naming real column/table names) is only
  ever logged server-side, never returned to the client. Don't expect any
  more diagnostic detail than that generic message on a `500`.

## Pagination

Source of truth: [`src/common/dto/pagination-query.dto.ts`](../../src/common/dto/pagination-query.dto.ts).

**Pagination is not universal.** Only endpoints whose query DTO explicitly
extends `PaginationQueryDto` use it. As of this writing, that is exactly two
endpoints:

| Endpoint | Query DTO |
|---|---|
| `GET /exercises` | `FindExercisesQueryDto` (adds `search`) |
| `GET /audit-logs` | `FindAuditLogsQueryDto` (adds `action`, `entityType`, `performedBy`) |

Every other list endpoint in this API (`GET /users`, `GET /clinics`, `GET
/programs`, `GET /assigned-programs`, `GET /sessions`, `GET /medical-files`,
`GET /conversations`, `GET /conversations/:id/messages`, `GET
/clinics/:id/members`) returns a **plain JSON array**, unpaginated, with no
`data`/`meta` wrapper. Don't assume the wrapper shape below applies just
because a route returns a list — check the specific route against this
table (or against `/api-docs`, which will show the query parameters a route
actually accepts).

For the two paginated endpoints, query parameters:

- `page` — integer, ≥ 1, defaults to `1`.
- `limit` — integer, 1–100 inclusive (hard ceiling — you cannot request more
  than 100 rows per page), defaults to `20`.

Response shape:

```json
{
  "data": [ /* up to `limit` rows */ ],
  "meta": {
    "total": 143,
    "page": 2,
    "limit": 20,
    "totalPages": 8
  }
}
```

`meta.total` is a full count of matching rows (independent of `page`), and
`meta.totalPages = Math.ceil(total / limit)` — use it to know whether a
"next page" exists.

## Rate limiting

Source of truth: [`src/app.module.ts`](../../src/app.module.ts)
(`ThrottlerModule`, applied globally via `APP_GUARD`), plus per-route
`@Throttle(...)` overrides in `auth.controller.ts`. Backed by
`@nestjs/throttler` v6.

**Baseline (applies to every route by default):** 60 requests per 60
seconds, tracked per client IP.

**Tighter, route-specific overrides**, all in `AuthController`:

| Route | Limit |
|---|---|
| `POST /auth/register` | 10 / 60s |
| `POST /auth/register-clinic` | 5 / 60s |
| `POST /auth/login` | 5 / 60s |
| `POST /auth/mfa/verify` | 5 / 60s |
| `POST /auth/forgot-password` | 5 / 60s |
| `POST /auth/reset-password` | 5 / 60s |

`GET /health` is explicitly exempt from rate limiting entirely
(`@SkipThrottle()`), since it exists for load balancers/monitoring to poll
frequently.

**On every response** (whether or not the request was throttled), the
following headers are set:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 34
```

(`X-RateLimit-Reset` is seconds until the current window resets — not a
timestamp.)

**When the limit is exceeded**, the response is `429 Too Many Requests`,
with an additional `Retry-After` header (seconds until you may retry), and
a body in the exact same global error shape described above:

```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests",
  "error": "ThrottlerException",
  "timestamp": "2026-08-05T14:22:03.101Z",
  "path": "/auth/login"
}
```

A well-behaved client should read `Retry-After` (or `X-RateLimit-Reset`) on
a `429` and back off accordingly rather than retrying immediately.
