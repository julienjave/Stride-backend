# Password reset, MFA, and a library that changed underneath the build

This document covers the two remaining deferred security features from
`AuthModule`'s original build — and an architectural decision MFA forced,
plus a real, live encounter with a breaking third-party API change.

## Password reset

Standard token-based flow, with each design choice made deliberately rather
than defaulted:

- **A cryptographically random 256-bit token** (`crypto.randomBytes`), hashed
  with SHA-256 before storage — not bcrypt. Bcrypt's deliberate slowness
  defends against brute-forcing a low-entropy, human-chosen value; a random
  token already has 2²⁵⁶ possibilities, infeasible regardless of hash speed.
  Using bcrypt here would cost real CPU for no additional security.
- **No user enumeration** — `forgotPassword()` returns identically whether
  the email matches a real account or not, and only generates a token/sends
  an email on a genuine match.
- **Single-use, overwritable** — stored directly on `users`
  (`passwordResetTokenHash`/`Expires At`), not a separate table. Only one
  active reset token per account ever makes sense; a new request invalidates
  any previous one, and a successful reset clears both columns entirely.
- **Every existing session is destroyed on a successful reset** — via raw
  SQL against the `session` table (`connect-pg-simple`'s own table, entirely
  outside Drizzle's schema and migrations, reached through `db.execute(sql\`...\`)`
  rather than the typed query builder). This matters concretely: if an
  account needed resetting because someone else had access to it, leaving
  their session alive afterward would defeat the point of resetting it.

**A deliberate infrastructure decision, stated rather than silently made**:
actual email delivery is a small `EmailService` abstraction whose only
current implementation logs the reset link to the console. Real provider
integration (Resend, SendGrid, SES) needs a verified sending domain and a
live frontend to redirect to — neither exists yet, so integrating one now
wouldn't be genuinely testable. This mirrors the same "swap the provider,
not the code" principle behind the S3-compatible storage design; `EmailService`
is the one place a real implementation would need to replace.

## MFA, and the architectural decision it forced

TOTP (Google Authenticator-compatible), via `otplib` and QR codes via
`qrcode`. The design decision worth recording in detail: **`LocalStrategy`
and `LocalAuthGuard` were retired entirely**, replaced with `login()` as an
explicit controller method calling `AuthService.validateUser()` directly.

The reason: Passport's strategy model is single-shot — succeed, and
`LocalAuthGuard`'s overridden `canActivate()` immediately calls `logIn()`.
MFA needs a genuine intermediate state (password correct, session
deliberately *not* yet authenticated, pending a second code), which that
model has no clean way to express. Rather than force an awkward workaround
onto a pattern that didn't fit, the pattern was replaced — recognizing that
a design choice correct at the time (and specifically debugged into working
correctly, in the session-persistence investigation a while back) no longer
fit a new requirement, the same reasoning behind the earlier multi-role
redesign. Nothing about Passport's *session* machinery
(`req.login()`/`req.isAuthenticated()`/`SessionSerializer`) changed —
`register()`, `registerClinic()`, and `switchRole()` were already calling
`req.login()` manually, proving the pattern worked without any strategy at
all, before MFA ever needed it.

The pending state itself lives in a **separate session key**
(`req.session.mfaPending`), deliberately distinct from
`req.session.passport` (the only key Passport's own `req.isAuthenticated()`
actually checks) — a session can prove "password was correct" without
Passport considering it authenticated at all. The same cookie carries
through to the follow-up `/auth/mfa/verify` call, exactly like every other
two-request flow tested with curl's `-b`/`-c` cookie jar throughout this
project.

**A genuine positive side effect**: `login()`'s `role` field, previously
read directly off `req.body` inside `LocalStrategy` (bypassing
`ValidationPipe` entirely, since guards run before pipes), now goes through
normal `@Body()` binding and gets properly validated like every other field
— a real correctness improvement that fell out of the refactor, not
something deliberately targeted.

**A known, stated scope limitation**: the TOTP secret is stored in plain
text, not encrypted at rest. Unlike `passwordHash` (one-way, useless even
with full database read access), a TOTP secret must remain genuinely
readable to verify codes — anyone with raw database access could compute
valid codes for any MFA-enabled account. Production would need
application-level encryption of that column with a key held separately from
the database itself (e.g. a KMS).

## `otplib`'s API rewrite, encountered live

While integrating `otplib`, its singleton `authenticator` export (the API
used in earlier planning) turned out not to exist at all in the version
actually installed — the package had undergone a major, very recent rewrite,
replacing the singleton with an instantiated `OTP` class, and converting
several previously-synchronous methods (`generate`, `verify`) to `async`,
with `verify()` now returning a `{ valid, ... }` result object instead of a
plain boolean. Every call site (`setupMfa`, `enableMfa`, `disableMfa`,
`verifyMfaCode`) needed updating to match.

This is the same category of lesson as MinIO's discontinuation from earlier
in the project, at smaller scale: a chosen dependency's public API is not
guaranteed stable between when it's planned and when it's actually
installed, especially for a library under active development. Worth a
standing habit noted directly, not just observed once: pinning exact
dependency versions (rather than a loose semver range that npm will happily
satisfy with a later major release) is a real, non-hypothetical safeguard
for fast-moving libraries, not excess caution.
