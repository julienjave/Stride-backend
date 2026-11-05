# Authentication & Sessions

Source of truth:
[`src/auth/`](../../src/auth/) (sign-in, sign-out, role switch, password
reset), [`src/mfa/`](../../src/mfa/) (two-factor sign-in, re-confirmation),
[`src/password-change/`](../../src/password-change/),
[`src/email-change/`](../../src/email-change/),
[`src/invitations/`](../../src/invitations/),
[`src/common/guards/`](../../src/common/guards/),
[`src/auth/strategies/session.serializer.ts`](../../src/auth/strategies/session.serializer.ts),
[`src/main.ts`](../../src/main.ts). Tests:
[`test/auth.e2e-spec.ts`](../../test/auth.e2e-spec.ts),
[`test/auth-recovery.e2e-spec.ts`](../../test/auth-recovery.e2e-spec.ts),
[`test/mfa.e2e-spec.ts`](../../test/mfa.e2e-spec.ts),
[`test/step-up-failures.e2e-spec.ts`](../../test/step-up-failures.e2e-spec.ts),
[`test/invitations.e2e-spec.ts`](../../test/invitations.e2e-spec.ts),
[`test/password-change.e2e-spec.ts`](../../test/password-change.e2e-spec.ts),
[`test/email-change.e2e-spec.ts`](../../test/email-change.e2e-spec.ts).

---

## Contents

- [This is cookie auth, not token auth](#this-is-cookie-auth-not-token-auth)
- [A Nest default worth knowing: `POST` answers `201`](#a-nest-default-worth-knowing-post-answers-201)
- [Accounts are invited, not registered](#accounts-are-invited-not-registered)
- [Login: single-role vs. multi-role accounts](#login-single-role-vs-multi-role-accounts)
- [Two-factor sign-in](#two-factor-sign-in)
- [Re-confirming before sensitive changes ("step-up")](#re-confirming-before-sensitive-changes-step-up)
- [Switching roles on a multi-role account](#switching-roles-on-a-multi-role-account)
- [Logout](#logout)
- [Passwords](#passwords)
- [Changing the email address](#changing-the-email-address)
- [`GET /auth/me`: who am I?](#get-authme-who-am-i)
- [When a session is signed out by the server](#when-a-session-is-signed-out-by-the-server)
- [`401` vs `403` vs `404`](#401-vs-403-vs-404)

---

## This is cookie auth, not token auth

There is no `Authorization` header, no JWT and no bearer token anywhere in
this API. Authentication is one `httpOnly` session cookie, `connect.sid`,
issued by [`express-session`](https://www.npmjs.com/package/express-session).
The sessions themselves live in Postgres (a `session` table managed by
`connect-pg-simple`, on a connection pool of its own).

For a frontend, that means:

- **Send every request with credentials**: `fetch(url, { credentials:
  'include' })`, or `withCredentials: true` with axios. Without it the
  browser neither stores nor sends the cookie, and every request looks like
  a signed-out visitor's.
- **CORS trusts an explicit list of origins, never a wildcard.** The API
  answers with credentials only to the origins in `FRONTEND_URLS`
  (comma-separated; [`src/config/allowed-origins.ts`](../../src/config/allowed-origins.ts)).
  The CORS rules forbid pairing credentials with `*`, so the frontend's
  exact origin (scheme, host and port) must be in the list.
- **There is nothing to store.** No response carries a token, so there's
  nothing to keep in `localStorage` (where any script on the page could read
  it). JavaScript never sees the cookie.
- **Cookie attributes**
  ([`src/config/session-cookie.ts`](../../src/config/session-cookie.ts)):
  `httpOnly` and `sameSite: 'lax'` always; `secure: true` in production, and
  `false` in development so plain `http://localhost` works. `Lax` is enough
  because the frontend and the API share one *site*: `stridecare.app` and
  `api.stridecare.app` (and, in development, `localhost:5173` and
  `localhost:3000` — a port isn't part of a site). The browser sends the
  cookie with the frontend's `fetch` calls, and never with another site's
  background requests. A frontend served from another site (Cloudflare
  Pages' `*.pages.dev` previews, say) can't keep a session with this API.
- **A session lasts 7 days from sign-in**, and isn't extended by activity
  (no `rolling` option). After that, the person signs in again.
- **A session stops working at once** when its account is deactivated or
  loses the session's active role. Every request reloads the account
  (`SessionSerializer.deserializeUser`) and treats such a session as signed
  out.

## A Nest default worth knowing: `POST` answers `201`

A `POST` route without `@HttpCode` answers `201 Created`, even when it
creates nothing: `login`, `mfa/verify` and `switch-role` all answer `201`.
A client that checks `status === 200` to detect a successful sign-in will
read every success as a failure. Check `response.ok`, or the exact status
in the [endpoint index](./06-endpoints.md).

## Accounts are invited, not registered

There is **no public sign-up**. `POST /auth/register` was removed with
invitations: a self-registered patient belonged to no clinic, so no one
could see or treat them. An account is created by someone already in Stride:

- an **admin** creates practitioners, patients and other admins;
- a **practitioner** creates patients, and joins their care team.

That's `POST /users`. The new account has **no password**: it gets an
invitation email, and the person chooses their password from its link.

### The very first account: `POST /auth/register-clinic`

Creates the first clinic and its founding admin in one transaction, then
signs the admin in (`201`, with the admin and the new `clinicId`). It's
**one-time**: once any admin exists, it answers `403` for good. Later
clinics are created with `POST /clinics`, and later accounts with
`POST /users`.

`GET /auth/setup-status` (public) tells the sign-in page which case it's
in:

```json
{ "setupComplete": true, "demo": null }
```

`demo` is `null` except on the reviewers' demo deployment (`DEMO_MODE`).
There it holds the shared demo accounts, their password, the two-factor
account's key, and the reset schedule, for the sign-in page's "For
reviewers" card. Those values are public on purpose.

### Accepting an invitation

The invitation link carries a random 256-bit token. Only its SHA-256 hash
is stored, so a leaked database can't be used to accept anyone's
invitation. The token always travels in the **body**, never in a URL the
server would log.

1. `POST /invitations/lookup` `{ token }`: `200` with what the accept page
   shows (`email`, `firstName`, `lastName`, `clinicNames`, `expiresAt`). An unknown token answers
   `404`. One that can't be used any more answers `410`, with `reason`
   `accepted`, `revoked` or `expired`.
2. `POST /invitations/accept` `{ token, password }`: `204`. The password is
   set, and the person then signs in normally.

An invitation is valid for **7 days**, and accepting it is single-use (one
conditional `UPDATE`: two tabs accepting at once can't both succeed). An
admin, or a practitioner on the patient's care team, can send a new one
(`POST /users/:id/invitations`, which closes the open one) or revoke it
(`POST /users/:id/invitations/revoke`). `GET /users/:id/invitations` shows
its state.

Until the invitation is accepted, the account can't sign in (it fails like
a wrong password) and can't ask for a password reset (that would be a way
around the invitation).

## Login: single-role vs. multi-role accounts

`POST /auth/login` `{ email, password, role? }`. The email is matched
without regard to case. The rules are in `AuthService.validateUser`:

| Case | Answer |
|---|---|
| No account with this email, a wrong password, or an account whose invitation isn't accepted yet | `401 Invalid email or password`: the same status and words for all three, so the answer doesn't reveal which. A failed attempt against a real account is audited (`LOGIN_FAILURE`). |
| The right password for a **deactivated** account | `401 This account has been deactivated`. Checked *after* the password, so someone without the password can't learn the account's state. |
| One role, no `role` sent | Signed in, in that role. |
| Several roles, no `role` sent | `400`, with `roles` listing them: `{ "message": ["This account has multiple roles. Specify which one to log in as."], "roles": ["practitioner", "patient"], … }`. Ask the person, then send the same request with `role`. |
| `role` sent, but the account doesn't hold it | `403 This account does not have the "<role>" role` |
| Two-factor sign-in is on | `201 { "mfaRequired": true }`. The session is **not** signed in yet: see below. |
| Otherwise | `201` with the signed-in user (the same shape as [`GET /auth/me`](#get-authme-who-am-i)) |

**The same answer, in the same time.** The three failures in the first
row also take as long as each other. An unknown email, or an account with
no password yet, is still checked against a dummy bcrypt hash of the same
cost ([`src/common/password-hashing.ts`](../../src/common/password-hashing.ts)),
so every refusal pays one bcrypt comparison (about 70 ms here). Until
2026-11-03 an unknown email answered at once: 6 ms against 75 ms for a
wrong password, measured on a local server. Timing a few attempts could
then tell whether an address has an account. Measured after the fix: 70 ms
against 72 ms. The remaining couple of milliseconds is the audit entry
written for a failed attempt against a real account, well inside ordinary
network jitter.

## Two-factor sign-in

If the account has two-factor sign-in on, a correct password doesn't sign
the session in. `POST /auth/login` stores a *pending* marker in the session
(`mfaPending`), separate from the one Passport checks, and answers
`{ mfaRequired: true }`. Until the second step succeeds, every guarded
route still answers `401`.

**`POST /auth/mfa/verify`** `{ code }` (no guard: the session isn't
signed in yet; the pending marker is the check):

- `code` is either the **6-digit code** from the authenticator app (TOTP,
  RFC 6238) or one of the account's **recovery codes** (`xxxxx-xxxxx`).
  Spaces around it are trimmed.
- Success: `201` with the signed-in user, in the role chosen at the
  password step.
- A wrong or already-used code: `401`, with words saying which. **No code
  works twice**: each app code is accepted once, and a recovery code is
  spent when used. The pending marker stays, so the person can type the
  next code without re-entering the password.
- No pending sign-in in this session: `400`.

Signing in with a recovery code is audited (`MFA_RECOVERY_CODE_USED`), and
the account's owner gets an email about it.

### Turning two-factor on, and off

| Step | Route | Body | Answer |
|---|---|---|---|
| 1. Start | `POST /auth/mfa/setup` | `currentPassword` | `201` with the new secret and its QR code, shown **once** |
| 2. Confirm | `POST /auth/mfa/enable` | `code`: a 6-digit code from the app, proving it holds the secret | `200` with **10 recovery codes**, shown once (only their keyed hashes are stored). Every *other* session of the account is signed out. |
| Codes left | `GET /auth/mfa/recovery-codes` | — | `200 { "remaining": 7 }` |
| New codes | `POST /auth/mfa/recovery-codes` | `currentPassword`, `code` | `201` with 10 new codes; the old ones stop working |
| Turn off | `POST /auth/mfa/disable` | `currentPassword`, `code` | `204` |

An admin can turn off someone else's two-factor sign-in, for a person who
lost their phone and their codes: `POST /users/:id/mfa/reset`. The admin
re-confirms with *their own* password, plus their own code if their
account has two-factor on. The person's sessions are signed out.

The secret is stored encrypted (AES-256-GCM, with a key held in the
server's environment, not in the database).

## Re-confirming before sensitive changes ("step-up")

A signed-in session proves someone signed in at some point, not that the
account's owner is at the keyboard now. So the changes that could hand the
account to someone else ask again:

- **the current password**, always;
- **and a second factor** (an app code or a recovery code) when the account
  has two-factor on. The field is `code` on the two-factor routes and
  `mfaCode` on the others.

The routes that ask: changing the email, changing the password, new
recovery codes, turning two-factor off, and an admin's two-factor reset.
Starting set-up asks the password alone, since two-factor is still off at
that point.

- A wrong password: `400 Your current password is not correct`. A missing,
  wrong or used second factor is also a `400`, with words saying which.
- **Five failures in a row sign the session out.** The fifth answers `401`,
  with words explaining why. The rate limit slows guessing from one
  address, but a stolen session could otherwise keep trying for hours from
  several. Each failure is audited (`STEP_UP_FAILED`). A success resets the
  count.
- A code that passed is spent even if the change then fails, so it can't be
  replayed: RFC 6238 says a validated code must not be accepted again.

## Switching roles on a multi-role account

`POST /auth/switch-role` `{ role }`: `201` with the user in the new role.
It changes the active role **of this session only**, without signing out:

- The account must hold the role (`403` otherwise).
- The switch is audited (`ROLE_SWITCHED`), because the role decides what
  data the session can read.
- The session gets a **new id** (Passport regenerates it, against session
  fixation). Its open WebSocket connections are closed, since each keeps
  the role it connected with. The client reconnects and gets a socket for
  the new role ([WebSocket API](./02-websocket-api.md#connecting)).

## Logout

`POST /auth/logout`: `204`. It destroys the session, clears the cookie,
closes the session's sockets, and audits `LOGOUT`. It has no guard: a
signed-out caller gets the same `204`.

## Passwords

### Forgot / reset

| Route | Body | Answer |
|---|---|---|
| `POST /auth/forgot-password` | `email` | **Always `204`**, whether an account matched or not. Only an **active** account that has a password gets an email. One still waiting for its invitation doesn't, and neither does a deactivated one: reactivating the account is the way back. The email is sent *after* answering, so the answer doesn't wait for the mail server (that wait used to reveal a real account: journal entry 28). |
| `POST /auth/reset-password/check` | `token` | `200 { email, expiresAt }` if the link is still usable, otherwise the reset's own `400`. The reset page asks first, so a dead link is reported before anyone types a password. |
| `POST /auth/reset-password` | `token`, `newPassword` (8–128 characters) | `204`. **Every session of the account is signed out**, since someone else may have had access. |

The reset token is random (256 bits), stored as a SHA-256 hash, valid for
**1 hour**, and single-use. A newer request replaces it. If the account is
deactivated in the meantime, the link stops working, with the same "invalid
or has expired" words as any dead link.

### Change (signed in)

`POST /auth/password` `{ currentPassword, newPassword, mfaCode? }`: `204`.
It's a step-up route (above). Every other session of the account is signed
out; this one stays signed in.

## Changing the email address

The new address must be proven before it replaces the old one, and the old
address hears about it:

| Route | Who | Answer |
|---|---|---|
| `POST /auth/email-change` `{ newEmail, currentPassword, mfaCode? }` | signed in (step-up) | `201 { pending }`. **The same answer whether the address is free or already taken**, so the route can't be used to discover accounts. The new address gets a confirmation link (or, if it's taken, an email saying so). The old address gets a notice with a cancel link. |
| `GET /auth/email-change` | signed in | `200 { pending }`: the open request, or `null` |
| `DELETE /auth/email-change` | signed in | `204`: cancels the open request |
| `POST /auth/email-change/confirm` `{ token }` | public (the link from the new inbox) | `200 { email }`. The address changes, and the account's other sessions are signed out. |
| `POST /auth/email-change/cancel` `{ token }` | public (the link from the old inbox) | `204` |

A request is valid for **24 hours**. A new request replaces the open one.

## `GET /auth/me`: who am I?

`200` with the signed-in user. It's built by the same function as every
user in every response (`UsersService.toPublic`), plus the settings only
the owner may read (`toSelf`):

- the account's own fields (`id`, `email`, names, `phone`, address fields,
  `isActive`, `mfaEnabled`…);
- `roles` (every role held) and `activeRole` (this session's);
- a profile per role: `practitionerProfile` (`licenseNumber`,
  `specialties`, `bio`), `patientProfile` (`dateOfBirth`), `adminProfile`
  (`position`);
- `avatarUrl`: a **presigned URL** the browser can load directly, valid
  for a limited time, or `null`;
- `readableFont`: the owner's "easier-to-read font" setting, sent only to
  the owner.

**Never in any response:**

- `passwordHash`;
- the two-factor secret, and the time the last code was used;
- the step-up failure count;
- the reset token's hash and expiry;
- the photo's storage key. `avatarPath` is replaced by `avatarUrl`: where a
  file lives in storage is an internal detail.

One function strips these for every route, rather than one copy per route.
Two copies of a security rule drift apart; this happened once, when login
had its own copy and leaked the reset-token fields.

## When a session is signed out by the server

| Event | Which sessions end |
|---|---|
| Logout | this one |
| Password reset (forgot-password link) | **all** of the account's |
| Password change, two-factor turned on, email change confirmed | all **but** the one making the change |
| An admin's two-factor reset, a deactivation, a patient merge | the target account's |
| Five failed step-ups in a row | the one that failed them |
| A role switch | none, but this session gets a new id and its sockets are closed |

Each time, the ended sessions' WebSocket connections are closed too.

## `401` vs `403` vs `404`

- **`401 Unauthorized`**: no signed-in session (or one that just ended). The
  frontend's answer is to go to sign-in. `SessionAuthGuard` says `You must
  be logged in to access this resource`.
- **`403 Forbidden`**: signed in, but not allowed. That's either the wrong
  *active role* for the route (`RolesGuard`: `You do not have permission to
  access this resource`), or a service rule (for example, writing to a
  conversation whose care-team link has ended).
- **`404 Not Found`**, often *instead of* `403`. Row-Level Security makes
  rows the caller has no relationship with **invisible**, not forbidden. A
  practitioner asking for a patient outside their care team gets the same
  `404` as for an id that doesn't exist. That's deliberate: a `403` would
  confirm that the record exists. [Roles & Authorization](./04-authorization.md)
  explains where each applies.
