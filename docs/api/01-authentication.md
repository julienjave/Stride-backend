# Authentication & Sessions

Verified against commit `4cd2176eca1c8c6c5ec56af968c0af7cd4157666`. Source of
truth: [`src/auth/auth.controller.ts`](../../src/auth/auth.controller.ts),
[`src/auth/auth.service.ts`](../../src/auth/auth.service.ts),
[`src/common/guards/session-auth.guard.ts`](../../src/common/guards/session-auth.guard.ts),
[`src/common/guards/roles.guard.ts`](../../src/common/guards/roles.guard.ts),
[`src/auth/strategies/session.serializer.ts`](../../src/auth/strategies/session.serializer.ts),
[`src/users/users.service.ts`](../../src/users/users.service.ts),
[`src/main.ts`](../../src/main.ts).

## This is cookie auth, not token auth

There is no `Authorization` header, no JWT, and no bearer token anywhere in
this API. The whole authentication mechanism is a single `httpOnly` session
cookie named `connect.sid`, issued by
[`express-session`](https://www.npmjs.com/package/express-session) and backed
by a Postgres-stored `session` table managed by `connect-pg-simple` — a
connection pool entirely separate from Drizzle's own, with its own table
outside Drizzle's schema/migrations.

What this means concretely for a frontend:

- **Send every request with credentials included.** With `fetch`, that's
  `fetch(url, { credentials: 'include' })` on every call, not just login.
  With `axios`, set `withCredentials: true` (ideally globally). Without this,
  the browser neither stores nor sends the session cookie, and every
  "authenticated" request looks like a fresh, logged-out visitor.
- **CORS trusts an explicit origin allowlist, not a wildcard.** `main.ts`
  calls `app.enableCors({ origin: getAllowedOrigins(), credentials: true })`.
  [`getAllowedOrigins()`](../../src/config/allowed-origins.ts) reads the
  comma-separated `FRONTEND_URLS` env var (default: `http://localhost:5173`).
  Per the CORS spec, `credentials: true` can never be paired with a wildcard
  origin — your frontend's real origin (protocol, host, and port, exactly)
  must be in that list.
- **There is nothing to store in `localStorage` or attach to a header.** The
  login response carries no token. The browser manages the cookie
  transparently once `credentials: 'include'`/`withCredentials` is set;
  frontend code never reads or writes it directly.
- **Cookie attributes**, from the `session(...)` config in `main.ts`:
  `httpOnly: true` always; in production, `secure: true` and
  `sameSite: 'none'` (required together — browsers reject `SameSite=None`
  without `Secure`); in development, `secure: false` and `sameSite: 'lax'`,
  which is why plain `http://localhost` works locally without HTTPS.
- **Session lifetime is a fixed 7 days from login**
  (`maxAge: 1000 * 60 * 60 * 24 * 7`), and it is **not** a rolling window —
  `resave: false` and no `rolling` option means the expiry is set once and
  not extended by later activity. After 7 days, the cookie is simply invalid
  and the user must log in again, regardless of how recently they were
  active.

## A NestJS default worth calling out: `POST` routes return `201`

Any `@Post()` handler with no explicit `@HttpCode(...)` returns `201
Created`, not `200` — this is Nest's default, not something specific to this
API, but it trips people up. `register`, `register-clinic`, `login`,
`mfa/verify`, `mfa/setup`, and `switch-role` all return `201` on success. A
frontend checking `res.status === 200` to detect a successful login will
misread every real success as a failure. Routes that explicitly override this
— `logout`, `mfa/enable`, `mfa/disable`, `forgot-password`,
`reset-password` — return `204 No Content` instead.

## Registration

Two distinct paths exist and are not interchangeable:

- **`POST /auth/register`** — public self-signup, throttled to 10
  requests/minute per IP. Always creates a **patient** account —
  `RegisterDto` has no `role` field at all, so there is nothing for a caller
  to override. Body: `{ email, password, firstName, lastName, dateOfBirth }`
  (`dateOfBirth` an ISO date string; `password` 8–128 characters). On success
  (`201`), the new account is logged in immediately via `req.login()` — no
  separate login call is needed — and the full user object is returned.
- **`POST /auth/register-clinic`** — bootstraps the **very first** clinic and
  its founding admin account together, in one transaction, throttled to 5
  requests/minute per IP. This is a **one-time setup operation**, not an
  ongoing signup path: `AuthService.registerClinic` checks whether *any*
  admin account already exists anywhere in the system and, if so, rejects
  with `403 Forbidden` (`"An administrator account already exists. Ask an
  existing admin to create additional accounts."`). Once a first admin
  exists, this route is permanently closed for the lifetime of that database
  — every later clinic is created by an existing admin via `POST /clinics`,
  and every later user via `POST /users`. Body: `{ clinicName, clinicEmail,
  clinicPhone?, clinicWebsite?, email, password, firstName, lastName,
  position? }`. On success (`201`), the new admin is logged in immediately;
  the response is the admin's public user fields plus `roles: ['admin']`,
  `activeRole: 'admin'`, and `clinicId` (the id of the clinic just created —
  you'll need it for later steps).

## Login: single-role vs. multi-role accounts

**`POST /auth/login`** — body: `{ email, password, role? }`.

The resolution logic lives in `AuthService.validateUser`:

| Condition | Result |
|---|---|
| Email doesn't match any account, **or** password is wrong | `401 Unauthorized` — `"Invalid email or password"`. Both cases return the identical message and status, so login responses can't be used to enumerate valid emails. A wrong password against a *real* account is separately recorded as a `LOGIN_FAILURE` audit event — but the HTTP response to the caller never reveals which case occurred. |
| Account has exactly **one** role, and `role` was **not** supplied | Succeeds — that one role becomes `activeRole` automatically. Never send `role` at all for a single-role account. |
| Account has **more than one** role, and `role` was **not** supplied | `400 Bad Request` — `"This account has multiple roles. Specify which one to log in as."` The frontend must catch this specific case (or, if it already knows the account is multi-role, send `role` up front and avoid the round trip). |
| Account has more than one role, and `role` **was** supplied, but the account doesn't actually hold that role | `403 Forbidden` — `` `This account does not have the "<role>" role` `` |
| Credentials valid and role resolved | Continue to the MFA check below |

These are the exact statuses exercised in
[`test/auth.e2e-spec.ts`](../../test/auth.e2e-spec.ts) ("requires an explicit
role choice for an account with more than one role, and rejects a role it
does not hold").

## The two-step MFA flow

If the resolved account has `mfaEnabled: true`, a correct password alone does
**not** complete login — `POST /auth/login` intentionally stops short of
calling `req.login()`.

**Step 1 — `POST /auth/login`** (same request as above; body:
`{ email, password, role? }`, throttled to 5/minute per IP):

Password is verified and the role is resolved exactly as in the table above,
but instead of establishing a real session, the controller stashes
`{ userId, activeRole }` into a *separate* session key,
`req.session.mfaPending` — distinct from the key Passport itself reads
(`req.session.passport`). This means `request.isAuthenticated()` still
correctly returns `false`; no protected route is reachable with this session
yet. The response is:

```json
{ "mfaRequired": true }
```

This is a normal `201`, not an error — check specifically for this shape to
decide whether to show an MFA prompt. A session *is* touched (something was
written to it), so `express-session` does issue the `connect.sid` cookie on
this response even though the session isn't authenticated yet — the browser
must retain it, since step 2 depends on being the same session.

**Step 2 — `POST /auth/mfa/verify`** — body: `{ code }` (a 6-digit string),
throttled to 5/minute per IP. This route deliberately carries **no
`SessionAuthGuard`** — the session isn't authenticated yet, by design; its
own read of `req.session.mfaPending` stands in for a guard:

- No pending MFA state on this session (e.g. called without a prior
  `/auth/login`, or called a second time after already succeeding) →
  `400 Bad Request` — `"No pending MFA verification for this session"`.
- Wrong or expired code → `401 Unauthorized` — `"Invalid authentication
  code"`.
- Correct code → `mfaPending` is deleted from the session, `req.login()` is
  now called with the previously-resolved user and role, and the full user
  object is returned (`201`) — the session is now genuinely authenticated.

Worked example:

```
POST /auth/login
{ "email": "dr.smith@clinic.com", "password": "correct-horse-battery" }

→ 201 { "mfaRequired": true }
   Set-Cookie: connect.sid=...   (retain this cookie)

POST /auth/mfa/verify
{ "code": "482913" }

→ 201 {
    "id": 42,
    "email": "dr.smith@clinic.com",
    "firstName": "...", "lastName": "...",
    "avatarPath": null,
    "isActive": true,
    "createdAt": "2026-08-05T14:22:03.101Z",
    "mfaEnabled": true,
    "roles": ["practitioner"],
    "activeRole": "practitioner"
  }
   (session is now authenticated; protected routes are reachable)
```

**MFA enrollment** (requires an already-authenticated session —
`SessionAuthGuard`, any role):

- **`POST /auth/mfa/setup`** — no body. Generates a fresh TOTP secret
  (overwriting any previous, unconfirmed one) and returns
  `{ secret, otpauthUrl, qrCodeDataUrl }` (`201`). Calling it repeatedly is
  harmless — nothing takes effect on login until `mfa/enable` actually
  confirms a code generated from the *most recent* secret.
- **`POST /auth/mfa/enable`** — body `{ code }`, throttled to 5/minute per
  IP. Verifies `code` against the secret from the most recent `setup` call
  and, if valid, sets `mfaEnabled: true`. `204 No Content` on success.
  `400 Bad Request` if `setup` was never called (`"Call MFA setup before
  attempting to enable it"`) or the code is wrong (`"Invalid authentication
  code"`).
- **`POST /auth/mfa/disable`** — body `{ code }`, throttled to 5/minute per
  IP. Requires a currently valid TOTP code, not merely an authenticated
  session — this is deliberate, so someone who only has a stolen session
  cookie can't turn off MFA they never actually passed. `204` on success.
  `400 Bad Request` if MFA isn't currently enabled, or the code is wrong.

Both `mfa/enable` and `mfa/disable` carry the same 5-req/min `@Throttle`
override as `mfa/verify` — see [Response Conventions](./03-conventions.md)
for the complete list of throttled routes.

## Switching roles on a multi-role account

**`POST /auth/switch-role`** — body: `{ role }`. Requires `SessionAuthGuard`
only (no throttle override — subject to the global 60/min baseline). Changes
which role is active for the *current* session without a logout/login round
trip: it re-invokes `req.login()` with the requested role, which re-runs
session serialization and overwrites the stored session data in place. If the
account doesn't actually hold the requested role → `403 Forbidden` —
`` `You do not have the "<role>" role` ``. On success, returns the full,
freshly-loaded user object with the new `activeRole` (`201`).

## Logout

**`POST /auth/logout`** — no guard; safe to call with no active session (it
just skips the audit log write in that case). Destroys the session
server-side (`req.session.destroy`) and clears the `connect.sid` cookie via
`res.clearCookie('connect.sid')`. Always `204 No Content`.

## Password reset

- **`POST /auth/forgot-password`** — body `{ email }`, throttled to 5/minute
  per IP. **Always** returns `204 No Content`, whether or not the email
  matches a real account — the response is identical either way specifically
  so this endpoint cannot be used to enumerate registered emails. Only a real
  match generates a reset token (a random 32-byte value, SHA-256 hashed
  before storage) and sends an email containing the raw, unhashed token.
- **`POST /auth/reset-password`** — body `{ token, newPassword }`, throttled
  to 5/minute per IP. `token` is the raw value from the email; the server
  hashes it and compares against the stored hash — the plaintext token is
  never stored. Tokens expire **1 hour** after being issued and are
  single-use — the stored hash is cleared the moment a reset succeeds, so a
  second attempt with the same token afterward fails as invalid even within
  the hour. Invalid or expired → `400 Bad Request` — `"This password reset link is
  invalid or has expired"`. On success (`204`), **every existing session for
  that user is destroyed server-side** (`AuthService.destroyAllSessionsForUser`,
  a raw SQL delete against the `session` table) — if the reset was prompted
  by a compromised account, this immediately invalidates any other active
  session on that account, not just the one that performed the reset.

## `GET /auth/me`

Requires `SessionAuthGuard`. Returns whatever the current session resolves
to via `SessionSerializer.deserializeUser` — the full public user object plus
`roles` and `activeRole`. This is the right call to make once on app load to
determine "is there a valid session, and who is it" — an expired or
server-revoked session still leaves a cookie present client-side, so cookie
presence alone can't answer that question.

### Every field stripped before a user object reaches a response

`UsersService.toPublic()` is the single funnel every user-returning path in
this API goes through (`findOne`, `findAll`, `update`, `softDelete`,
`updateAvatar`, and — via `findOne` — `SessionSerializer.deserializeUser`,
which is what builds `req.user`/`GET /auth/me` on every request). It strips
exactly these four fields from the raw `users` row, and nothing else:

- `passwordHash`
- `mfaSecret` — the encrypted TOTP secret; never sent to a client even in
  encrypted form
- `passwordResetTokenHash`
- `passwordResetTokenExpiresAt`

Two call sites bypass `toPublic()` and do their own equivalent stripping,
because they read the user row directly rather than through
`UsersService.findOne()`: `AuthService.validateUser()` (needs the real
`passwordHash` to run `bcrypt.compare`) and `AuthService.registerClinic()`
(inserts and returns a raw row inside a transaction). Both strip the same
four fields by hand — confirmed by
[`test/auth.e2e-spec.ts`](../../test/auth.e2e-spec.ts), which asserts
`mfaSecret`, `passwordResetTokenHash`, and `passwordResetTokenExpiresAt` are
absent from the `POST /auth/mfa/verify` and `POST /auth/switch-role`
response bodies specifically (both of these also build their response by
hand from an `AuthService`/`req.login()` path, not directly through
`toPublic()`).

The resulting shape (also what `GET /auth/me` and every login/register
response return) is:

```ts
{
  id: number
  email: string
  firstName: string
  lastName: string
  avatarPath: string | null
  isActive: boolean
  createdAt: string        // ISO timestamp
  mfaEnabled: boolean
  roles: string[]           // every role the account holds
  activeRole: string         // which one is active for THIS session
}
```

## What `401` vs `403` actually mean here

These are not interchangeable, and the distinction is a reliable signal to
build frontend behavior around:

- **`401 Unauthorized`** — thrown by `SessionAuthGuard.canActivate` whenever
  `request.isAuthenticated()` is `false`. This means: *there is no valid,
  currently-logged-in session at all.* Causes include: no cookie sent, an
  expired cookie (past the 7-day `maxAge`), a session destroyed server-side
  (logout, or a password reset elsewhere), or — a case worth knowing about
  specifically — **the session's stored `activeRole` is no longer among the
  user's actual roles.** `SessionSerializer.deserializeUser` re-checks this
  on *every single request*: if an admin revokes a role after a session was
  established under it, the very next request from that session gets a
  `401`, not a `403` — Passport deserialization fails outright
  (`done(null, false)`), so `req.user` is never populated at all. The
  correct frontend response to any `401` is to treat the user as logged out
  and route to the login screen — there is no scenario where retrying or
  refreshing helps.
- **`403 Forbidden`** — thrown by `RolesGuard.canActivate` when the session
  *is* valid but the route declares `@Roles(...)` and the current
  `activeRole` isn't in that list, **or** thrown directly by a service for a
  finer-grained, resource-specific check beyond a flat role gate (e.g. a
  practitioner trying to modify another practitioner's exercise, or a
  patient trying to view a medical file entry that isn't theirs — see
  [Roles & Authorization](./04-authorization.md) for the full breakdown). A
  `403` means the user is genuinely who they say they are, just not allowed
  to do this specific thing — the right UI response is an in-context
  "you don't have permission" message, not a redirect to login.

`RolesGuard` only ever runs after `SessionAuthGuard` on a route that has
both (every controller in this app pairs them this way) — authentication is
always checked before authorization, never the reverse.
