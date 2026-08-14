# Application layer & authentication

This document picks up after `backend-architecture-decisions.md` and
`database-schema-design.md`, covering what was actually built on top of that
foundation: the NestJS application layer, the first full feature module, and —
the centerpiece of this phase — the authentication system.

## Project naming

The application is named **Stride** — settled on after brainstorming several
directions (clinical/professional names like *Physiq*, connection-themed names
like *CarePath*) and landing on something that evokes forward progress through
a rehab program, which is thematically what the app tracks session by session.

## Dependency injection: wiring Drizzle into NestJS

PostgreSQL access is exposed to the rest of the app through a **factory
provider** (`drizzle.provider.ts`) rather than a hand-written service class.
The provider builds a `pg` connection **pool** (not a single connection —
a running server handles concurrent requests, and a pool lets multiple
requests borrow and return connections rather than queuing behind one),
wraps it with Drizzle's schema-aware query builder, and registers the result
under a `Symbol` injection token (`DRIZZLE`), since the value being injected
is a factory's return value, not a class Nest can instantiate on its own.

`DrizzleModule` is marked `@Global()` — imported once, in `AppModule`, and
then injectable from any feature module without each one repeating the
import. This is a deliberate, narrow exception to normal explicit-import
discipline, justified because effectively every feature module in this app
needs database access.

## The module template: `UsersModule`

`UsersModule` established the five-piece pattern every subsequent feature
module follows: **DTO(s)** for validated input, a **service** holding all
real logic behind the `DRIZZLE` token, a thin **controller** translating HTTP
into service calls, a **module** tying them together, and a line in
`AppModule`'s `imports`.

A few decisions worth carrying forward into every future module:

- **Passwords are hashed with bcrypt** before ever reaching the database —
  one-way, deliberately slow to compute, so a leaked database never exposes
  usable credentials.
- **Creating a user is wrapped in a database transaction** when it involves
  more than one table (a `users` row plus a role-specific profile row) — if
  either insert failed partway, a transaction guarantees neither one
  persists, rather than leaving an orphaned user with no profile.
- **`passwordHash` is stripped from every response** via a single shared
  helper, rather than trusting each future method to remember to omit it.
- **Soft delete only.** `is_active` is set to `false` through a dedicated
  method; there is no code path that issues a real `DELETE` against `users`,
  consistent with the `RESTRICT`-by-default foreign key strategy from the
  schema design.

## Authentication system

### Why session-based, not JWT (recap)

Decided early in the stack-selection phase: this is a single first-party web
client (one frontend, one backend), the case where `httpOnly` session
cookies are simpler and more secure than hand-rolled JWTs — the cookie is
inaccessible to JavaScript (closing off a common XSS vector), and a session
can be revoked instantly server-side rather than waiting out a token's
expiry.

### How it actually works, end to end

Four pieces work together:

1. **A session store.** Sessions are persisted in PostgreSQL via
   `connect-pg-simple`, using a *separate* connection pool from Drizzle's own
   (it manages its own `session` table with raw SQL, entirely outside the
   Drizzle schema/migration system). This was a deliberate choice over the
   default in-memory store, which would lose every logged-in session on
   every server restart and can't work at all across more than one running
   instance.
2. **A Passport strategy** (`passport-local`) — runs once, only at login,
   comparing the submitted password against the stored bcrypt hash via
   `AuthService.validateUser()`.
3. **A session serializer** — decides what's actually stored in the session
   (just the user's `id`, never the full object, keeping stored sessions
   small) and reloads the full user fresh from the database on every
   subsequent request. This means a role change or deactivation takes effect
   immediately, not just at the user's next login.
4. **Guards**, which enforce what the above already established.

### The strategy/guard connection is name-based, not a direct reference

Worth documenting because it's the least obvious mechanism in the whole
system: `LocalAuthGuard` and `LocalStrategy` never reference each other in
code. `passport-local`'s `Strategy` class self-registers into Passport's
internal registry under the fixed string `'local'` the moment NestJS
constructs it (which is *why* `LocalStrategy` must be listed in
`AuthModule`'s `providers` — that's what triggers construction).
`AuthGuard('local')` independently looks up that same string at request
time. The two connect only because both reference the same string constant,
not because either file imports the other.

### Two guards, two different questions

`SessionAuthGuard` (**authentication** — "is there a valid logged-in session
at all?") and `RolesGuard` (**authorization** — "is this specific,
already-authenticated user allowed to do this particular thing?") are
deliberately separate, and used together in that order:

```typescript
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('practitioner')
@Post()
create(@CurrentUser() user: PublicUser, @Body() dto: CreateSomethingDto) { ... }
```

This ordering means an anonymous request gets a clean `401`, while an
authenticated user outside the required role gets a `403` — a meaningfully
different signal, not the same generic rejection either way.

`@CurrentUser()`, a small custom parameter decorator, is what makes
`user.id` available as a real, server-verified value inside a service —
closing a real security gap: without it, a service would have no choice but
to trust a client-supplied ID (e.g. a `?patientId=` query param), which is a
textbook IDOR (Insecure Direct Object Reference) vulnerability.

### CORS

Since the frontend will run on a different origin during development (and
potentially a different subdomain in production), `credentials: true` CORS
support was added explicitly — without it, the browser silently drops the
session cookie on cross-origin requests even if the request itself
otherwise succeeds. `origin` is set to an explicit URL (`FRONTEND_URL`), not
a wildcard, since credentialed cross-origin requests require one.

### Logout destroys the session, not just the request-local reference

`req.logout()` alone only unlinks the currently authenticated user from the
in-memory request object — it doesn't necessarily remove the underlying
session row from Postgres. Logout was implemented to additionally call
`req.session.destroy()`, so the stored row is actually deleted rather than
lingering until natural expiry, and the cookie is explicitly cleared on the
response.

### Rate limiting

`@nestjs/throttler` is applied globally (`ThrottlerGuard` as an `APP_GUARD`
provider) with a generous baseline (60 requests/minute/IP) across the whole
API, and a much stricter override specifically on `POST /auth/login` (5
attempts/minute) — the one route where a high volume of fast requests
specifically indicates password brute-forcing rather than normal usage.

**`trust proxy` is set explicitly** (`app.set('trust proxy', 1)`), in
anticipation of the Caddy reverse proxy this app will sit behind in
production. Once Caddy is in front, every request technically originates
from Caddy's own container IP; without this setting, every visitor to the
deployed app would appear to be the same IP address, and per-IP rate
limiting would be meaningless — either uselessly loose (nobody meaningfully
limited) or, worse, one abusive client exhausting a shared limit for every
real user at once. This is safe specifically *because* Caddy is a known,
fixed, single hop directly in front of the app — trusting a forwarded-IP
header is only sound when the proxy in that position is infrastructure you
control, not an arbitrary intermediary a client could spoof.

### A scoping decision worth naming explicitly: in-memory throttler storage

Rate-limit counters are currently stored in memory, inside the one running
Node process. This is correct, not a shortcut, **specifically because this
deployment runs exactly one instance** of the API on one VPS — in-memory and
Redis-backed storage behave identically from the outside when there's only
one instance to keep count. The distinction would only matter for a
horizontally-scaled deployment (multiple API instances behind a load
balancer), where separate in-memory counters per instance would let the
*real* combined limit silently exceed the intended one. A genuine clinic
deployment serving real patient traffic, needing to scale beyond a single
instance, would need to swap in Redis-backed throttler storage at that
point — a small, well-supported change, not a redesign.

## Known, deliberate gaps (not yet built)

- **Guards are not yet applied to `UsersController`'s routes** — it remains
  open, pending `RolesGuard` being wired in as each future module is built
  and access rules for each endpoint are decided route by route.
- **Audit logging is not yet wired into login/logout** — `AuditModule`
  (writing `LOGIN_SUCCESS`/`LOGIN_FAILURE` and other events to the immutable
  `audit_logs` table) is planned after the core domain modules
  (`exercises`, `programs`, `sessions`) are built.
- **Password reset and MFA are deferred.** Password reset requires a real
  infrastructure decision (an email provider) better made once the core
  product loop is demoable; MFA is a stretch goal, valuable to demonstrate
  auth sophistication but not central to the capstone's actual subject
  matter.
