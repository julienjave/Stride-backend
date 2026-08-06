# Authentication & Sessions

Source of truth: [`src/auth/auth.controller.ts`](../../src/auth/auth.controller.ts),
[`src/auth/auth.service.ts`](../../src/auth/auth.service.ts),
[`src/common/guards/session-auth.guard.ts`](../../src/common/guards/session-auth.guard.ts),
[`src/common/guards/roles.guard.ts`](../../src/common/guards/roles.guard.ts),
[`src/auth/strategies/session.serializer.ts`](../../src/auth/strategies/session.serializer.ts),
[`src/main.ts`](../../src/main.ts).

## This is cookie auth, not token auth

There is no `Authorization` header, no JWT, and no bearer token anywhere in
this API. Authentication is a single `httpOnly` session cookie
(`connect.sid`), issued by [`express-session`](https://www.npmjs.com/package/express-session)
and backed by a Postgres-stored session table (via `connect-pg-simple`, a
**separate** connection pool from the app's own Drizzle pool, managing its
own `session` table outside Drizzle's schema/migrations entirely).

Concretely, this means:

- **Every request must be sent with credentials included.** With `fetch`,
  that's `fetch(url, { credentials: 'include' })` on every call, not just
  login. With `axios`, set `withCredentials: true` (globally, ideally).
  Without this, the browser will not send or store the session cookie at
  all, and every authenticated request will look like a fresh, logged-out
  visitor.
- **CORS is configured with `credentials: true`** and an explicit origin
  allowlist read from `FRONTEND_URLS` (comma-separated; defaults to
  `http://localhost:5173`) — see [`src/config/allowed-origins.ts`](../../src/config/allowed-origins.ts)
  and `app.enableCors(...)` in `main.ts`. A wildcard origin (`*`) is
  incompatible with `credentials: true` per the CORS spec, so your
  frontend's real origin needs to be in that list, exactly, protocol and
  port included.
- **There is nothing to attach to a header.** Don't look for a token in the
  login response to stash in `localStorage` — there isn't one. The browser
  handles the cookie automatically once `credentials: 'include'` is set;
  your frontend code never touches it directly.
- **Cookie attributes** (`main.ts`): `httpOnly: true` always; `secure: true`
  and `sameSite: 'none'` in production (required together — browsers reject
  `SameSite=None` without `Secure`); `secure: false` and `sameSite: 'lax'` in
  development, which is why `http://localhost` works without HTTPS locally.
- **Session lifetime is a fixed 7 days from login** (`maxAge: 1000 * 60 *
  60 * 24 * 7`), not a sliding/rolling window — the cookie's expiry is not
  extended by ongoing activity (`rolling` is not enabled). After 7 days the
  cookie is simply gone and the user needs to log in again, regardless of
  how recently they were active.

## `POST` routes return `201`, not `200`

This is a genuine NestJS default worth calling out explicitly: any `@Post()`
handler without an explicit `@HttpCode(...)` decorator returns **`201
Created`**, not `200`. `register`, `register-clinic`, `login`,
`mfa/verify`, `mfa/setup`, and `switch-role` all fall into this category —
if your frontend code checks `res.status === 200` to decide whether a login
succeeded, it will incorrectly treat every successful login as a failure.
Routes that explicitly override this — `logout`, `mfa/enable`, `mfa/disable`,
`forgot-password`, `reset-password` — return `204 No Content` instead (see
below).

## Registration

Two distinct registration paths exist, and they are not interchangeable:

- **`POST /auth/register`** — public self-signup. Always creates a
  **patient** account; there is no `role` field on `RegisterDto`, so there's
  nothing for a caller to override. Rate-limited to 10 requests/min per IP.
  Body: `{ email, password, firstName, lastName, dateOfBirth }`
  (`dateOfBirth` an ISO date string). On success (`201`), the account is
  logged in immediately (no separate login call needed) and the full user
  object is returned.
- **`POST /auth/register-clinic`** — bootstraps the **very first** clinic and
  its founding admin account, together, in one transaction. This is
  deliberately a **one-time setup operation**, not an ongoing signup path:
  `AuthService.registerClinic` checks whether *any* admin account already
  exists anywhere in the system and, if so, rejects with **`403 Forbidden`**
  (`"An administrator account already exists. Ask an existing admin to
  create additional accounts."`). Once your first admin exists, this route
  is permanently closed — all further clinics are created by an existing
  admin via `POST /clinics`, and all further users via `POST /users`. Rate
  limited to 5 requests/min per IP. On success (`201`), logs the new admin
  in immediately and returns `{ ...user, roles: ['admin'], activeRole:
  'admin', clinicId }`.

## Login: single-role vs. multi-role accounts

**`POST /auth/login`** — body: `{ email, password, role? }`.

The account resolution logic (`AuthService.validateUser`, `auth.service.ts:174`)
works like this:

| Condition | Result |
|---|---|
| Email doesn't match any account, **or** password is wrong | `401 Unauthorized` — `"Invalid email or password"`. Both cases return the *identical* message; a wrong password is also logged as a `LOGIN_FAILURE` audit event against the real account, but the response never reveals which case occurred, so login can't be used to enumerate valid emails. |
| Account has exactly **one** role, and `role` was **not** supplied | Succeeds — that one role becomes `activeRole` automatically. No need to ever send `role` for a single-role account. |
| Account has **more than one** role, and `role` was **not** supplied | `400 Bad Request` — `"This account has multiple roles. Specify which one to log in as."` The frontend needs to catch this specific case and prompt the user to pick a role (or, if you already know the account is multi-role, always send `role` up front). |
| Account has more than one role, and `role` **was** supplied, but the account doesn't actually hold that role | `403 Forbidden` — `"This account does not have the \"<role>\" role"` |
| Credentials valid and role resolved successfully | See MFA branch below |

Rate limited to 5 requests/min per IP.

## The two-step MFA flow

If the resolved user has `mfaEnabled: true`, login does **not** complete in
one call — a correct password is only step one. Concretely:

1. **`POST /auth/login`** — password is verified and the role is resolved,
   exactly as above, but `req.login()` is **deliberately not called yet**.
   Instead, the server stashes `{ userId, activeRole }` under a *separate*
   session key, `req.session.mfaPending` — distinct from the key Passport
   itself uses (`req.session.passport`). This means `request.isAuthenticated()`
   still correctly returns `false` for this session; no protected route is
   reachable yet. The response body is just:
   ```json
   { "mfaRequired": true }
   ```
   Note this is **not** a `401` or any kind of error — it's a normal `201`
   response.  Watch for this shape specifically to decide whether to show an
   MFA code prompt. Also note: because a session was touched (even without
   full authentication), the server does set the `connect.sid` cookie on
   this response — the browser must retain it, since the follow-up call
   below depends on being the *same* session.

2. **`POST /auth/mfa/verify`** — body: `{ code }` (a 6-digit string). This
   route deliberately has **no `SessionAuthGuard`** — the session isn't
   authenticated yet, by design. Its own check of `req.session.mfaPending`
   is what stands in for a guard here.
   - No pending MFA state on this session → `400 Bad Request` —
     `"No pending MFA verification for this session"` (e.g. calling this
     without having called `/auth/login` first, or calling it twice).
   - Wrong/expired code → `401 Unauthorized` — `"Invalid authentication code"`.
   - Correct code → `mfaPending` is cleared, `req.login()` is now called
     with the previously-resolved user and role, and the full user object is
     returned (`201`), with the session now genuinely authenticated.

Worked example:

```
POST /auth/login
{ "email": "dr.smith@clinic.com", "password": "correct-horse-battery" }

→ 201 { "mfaRequired": true }
   (Set-Cookie: connect.sid=... — retain this)

POST /auth/mfa/verify
{ "code": "482913" }

→ 201 { "id": 42, "email": "dr.smith@clinic.com", "roles": ["practitioner"],
        "activeRole": "practitioner", "mfaEnabled": true, ... }
   (session is now authenticated; protected routes are reachable)
```

**MFA enrollment** (requires an already-authenticated session,
`SessionAuthGuard`, any role):

- **`POST /auth/mfa/setup`** — generates a new TOTP secret, overwriting any
  previous unconfirmed one. Returns `{ secret, otpauthUrl, qrCodeDataUrl }`
  (`201`). Harmless to call repeatedly — nothing takes effect until enable.
- **`POST /auth/mfa/enable`** — body `{ code }`. Verifies the code against
  the secret from the most recent `setup` call, then sets `mfaEnabled:
  true`. `204 No Content` on success. `400` if `setup` was never called
  (`"Call MFA setup before attempting to enable it"`) or if the code is
  wrong (`"Invalid authentication code"`).
- **`POST /auth/mfa/disable`** — body `{ code }`. Requires a **currently
  valid** code, not just an authenticated session — this stops someone who
  merely stole a session cookie from turning off MFA they never actually
  passed. `204` on success. `400` if MFA isn't enabled, or if the code is
  wrong.

## Switching roles on a multi-role account

**`POST /auth/switch-role`** — body: `{ role }`. Requires
`SessionAuthGuard` only. Changes which role is active for the *current*
session without a full logout/login round trip: it re-calls `req.login()`
with the requested role, which re-triggers session serialization and
overwrites the stored session data in place. If the account doesn't
actually hold the requested role → `403 Forbidden` —
`"You do not have the \"<role>\" role"`. On success, returns the full
updated user object with the new `activeRole` (`201`).

## Logout

**`POST /auth/logout`** — no guard (safe to call even with no active
session; it just no-ops the audit log in that case). Destroys the session
server-side and clears the `connect.sid` cookie via `res.clearCookie`.
Always `204 No Content`.

## Password reset

- **`POST /auth/forgot-password`** — body `{ email }`. **Always** returns
  `204 No Content`, whether or not the email matches a real account — this
  is deliberate: the response is identical either way so the endpoint can't
  be used to enumerate registered emails. Only a real match actually
  generates a reset token and sends an email. Rate limited to 5/min.
- **`POST /auth/reset-password`** — body `{ token, newPassword }`. `token`
  is the raw value emailed to the user (hashed with SHA-256 before being
  compared against what's stored — never stored or compared in plaintext).
  Tokens expire after **1 hour** and are single-use (cleared the moment
  they're redeemed). Invalid or expired → `400 Bad Request` — `"This
  password reset link is invalid or has expired"`. On success (`204`), **every
  existing session for that user is destroyed** server-side — if the reset
  was prompted by a compromised account, this closes out anyone else's
  active session, not just the browser that performed the reset. Rate
  limited to 5/min.

## `GET /auth/me`

Requires `SessionAuthGuard`. Returns whatever the current session resolves
to — the same shape produced by `SessionSerializer.deserializeUser`
(`{ ...user, roles, activeRole }`, `passwordHash`/`mfaSecret` always
stripped). This is the right endpoint to call once on app load to check "is
there a valid session, and who is it," rather than trying to infer login
state from cookie presence alone (an expired or server-revoked session still
looks like a cookie is present, client-side).

## What `401` vs `403` actually mean here

These are **not** interchangeable in this API, and the distinction is a
useful signal to build UI around:

- **`401 Unauthorized`** — thrown by `SessionAuthGuard`
  (`session-auth.guard.ts:33`) whenever `request.isAuthenticated()` is
  `false`. This means: *there is no valid, currently-logged-in session at
  all.* Causes include: no cookie sent, cookie expired (past the 7-day
  `maxAge`), session was destroyed server-side (logout, or a password
  reset elsewhere), or — importantly — **the session's `activeRole` is no
  longer among the user's actual roles.** `SessionSerializer.deserializeUser`
  (`session.serializer.ts:54`) re-checks this on *every single request*: if
  an admin revokes a role after the session was established, the very next
  request from that session gets a `401`, not a `403` — Passport
  deserialization fails outright (`done(null, false)`), so `req.user` is
  never set at all. **The correct frontend response to a `401` anywhere is
  to treat the user as logged out and send them to the login screen** —
  there's no scenario where refreshing or retrying helps.
- **`403 Forbidden`** — thrown by `RolesGuard` (`roles.guard.ts:50`) when
  the session *is* valid, but the route declares `@Roles(...)` and the
  user's current `activeRole` isn't in that list. Also thrown directly by
  individual services for finer-grained, resource-level checks beyond a
  flat role gate — e.g. a practitioner trying to modify another
  practitioner's exercise, or a patient trying to view a medical file that
  isn't theirs (see [Roles & Authorization](./04-authorization.md) for the
  full resource-by-resource breakdown). **A `403` means the user is who
  they say they are, just not allowed to do this specific thing** — the
  right UI response is usually "you don't have permission," not a redirect
  to login.

`RolesGuard` always runs after `SessionAuthGuard` on any route that has
both — authentication is checked before authorization, never the reverse.
