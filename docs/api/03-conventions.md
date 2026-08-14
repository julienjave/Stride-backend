# Response Conventions

Verified against commit `a3531f1c2a66c113e2fbcdd74365797e9670b949`. These
conventions apply across the whole REST API — documented once here instead
of repeated per route.

## Error responses

Source of truth:
[`src/common/filters/http-exception.filter.ts`](../../src/common/filters/http-exception.filter.ts),
registered globally in [`src/app.module.ts`](../../src/app.module.ts) via
`APP_FILTER`. `@Catch()` with no argument catches literally everything
thrown anywhere in the app — both deliberate `HttpException`s
(`NotFoundException`, `ForbiddenException`, validation failures, etc.) and
genuinely unexpected errors.

Every error response, of every status code, has this exact shape:

```json
{
  "statusCode": 404,
  "message": ["Exercise 501 not found"],
  "error": "NotFoundException",
  "timestamp": "2026-08-05T14:22:03.101Z",
  "path": "/exercises/501"
}
```

A client can rely on `statusCode`, `error`, `timestamp`, and `path` being
present on every error response in this API, without exception.

Notes on `message`:

- `message` is **always an array of strings**, one entry per issue. This
  replaces the old ambiguity where `message` was sometimes a single string
  and sometimes an array depending on the error type — error-rendering UI
  never needs to branch on the shape of `message`, only iterate it.
- For the overwhelming majority of errors — `401`/`403`s from the auth
  guards, `404`s from a missing resource, and most other deliberately-thrown
  `HttpException`s — that array has exactly one entry: the real,
  human-readable reason from the code, safe to surface directly to a user.
- For a `class-validator` validation failure specifically (a `400 Bad
  Request` produced by the global `ValidationPipe`), `message` can have
  **multiple entries**, one per failed constraint — e.g.
  `["email must be an email", "password must be longer than or equal to 8 characters"]`.
- For anything that is **not** a deliberately-thrown `HttpException` — a
  genuine bug, an unhandled database error, etc. — `message` is always
  replaced with the single-entry array `["Internal server error"]` and
  `statusCode` is `500`. The real underlying error (which could otherwise
  leak a stack trace, a file path, or raw Postgres error text naming actual
  column/table names) is only ever logged server-side via `nestjs-pino`,
  never returned to the client. Don't expect more diagnostic detail than
  that generic message on a `500`.

## Pagination

Source of truth:
[`src/common/dto/pagination-query.dto.ts`](../../src/common/dto/pagination-query.dto.ts).

**Pagination is not universal.** Only a query DTO that actually extends
`PaginationQueryDto` gets this shape. As of this commit, that is exactly two
endpoints:

| Endpoint | Query DTO | Extra filters |
|---|---|---|
| `GET /exercises` | `FindExercisesQueryDto` | `search` (matches against `name`, case-insensitive) |
| `GET /audit-logs` | `FindAuditLogsQueryDto` | `action`, `entityType`, `performedBy` |

Every other list endpoint in this API — `GET /users`, `GET /clinics`,
`GET /clinics/:id/members`, `GET /programs`, `GET /assigned-programs`,
`GET /sessions`, `GET /medical-files`, `GET /conversations`,
`GET /conversations/:id/messages` — returns a **plain JSON array**,
unpaginated, with no `data`/`meta` wrapper at all. Check the specific route
(or `/api-docs`, which shows the actual accepted query parameters) before
assuming the wrapper below applies just because a route returns a list.

For the two paginated endpoints, accepted query parameters:

- `page` — integer, ≥ 1, defaults to `1`.
- `limit` — integer, 1–100 inclusive (hard ceiling — a client cannot request
  more than 100 rows in one page), defaults to `20`.

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

`meta.total` is a full count of matching rows, independent of `page`;
`meta.totalPages = Math.ceil(total / limit)`.

## Rate limiting

Source of truth: [`src/app.module.ts`](../../src/app.module.ts)
(`ThrottlerModule.forRoot`, applied globally via `APP_GUARD`), plus every
`@Throttle(...)` override actually present in
[`src/auth/auth.controller.ts`](../../src/auth/auth.controller.ts). Backed
by `@nestjs/throttler@^6`.

**Baseline, applied to every route by default:** 60 requests per 60 seconds,
tracked per client IP (`req.ip`).

**Tighter, route-specific overrides.** `AuthController` is the *only*
controller in this codebase with any `@Throttle(...)` decorator — every
route below was individually confirmed against its source:

| Route | Limit |
|---|---|
| `POST /auth/register` | 10 / 60s |
| `POST /auth/register-clinic` | 5 / 60s |
| `POST /auth/login` | 5 / 60s |
| `POST /auth/mfa/verify` | 5 / 60s |
| `POST /auth/mfa/enable` | 5 / 60s |
| `POST /auth/mfa/disable` | 5 / 60s |
| `POST /auth/forgot-password` | 5 / 60s |
| `POST /auth/reset-password` | 5 / 60s |

`mfa/enable` and `mfa/disable` share the same tighter throttle as
`mfa/verify` — the code's own comment on those two decorators frames this as
consistency with the rest of this controller's rationale for requiring a
fresh code on sensitive MFA actions, rather than response to an identified
exploit (`otplib` here uses the default `epochTolerance: 0`, so only a
single 30-second window is ever valid at a time).

`GET /health` (`src/health/health.controller.ts`) carries `@SkipThrottle()`
and is exempt from rate limiting entirely — it exists for load balancers and
monitoring systems to poll frequently, unauthenticated.

**On every response** (throttled or not), these headers are set by
`ThrottlerGuard`:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 34
```

`X-RateLimit-Reset` is **seconds until the current window resets**, not a
timestamp.

**When a limit is exceeded**, the response is `429 Too Many Requests`, with
an additional `Retry-After` header (seconds until the client may retry), and
a body in the exact same global error shape described above:

```json
{
  "statusCode": 429,
  "message": ["ThrottlerException: Too Many Requests"],
  "error": "ThrottlerException",
  "timestamp": "2026-08-05T14:22:03.101Z",
  "path": "/auth/login"
}
```

A well-behaved client should read `Retry-After` (or `X-RateLimit-Reset`) on
a `429` and back off accordingly rather than retrying immediately.
