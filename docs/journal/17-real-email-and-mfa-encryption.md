# From placeholders to real security features: email delivery and MFA encryption

This document covers upgrading two deliberately deferred scope decisions —
`EmailService`'s console-log stand-in, and `mfaSecret`'s plaintext
storage — into real implementations, prompted by revisiting both decisions
explicitly rather than letting "accepted as a demo limitation" go
unexamined once building toward a real deployment made them worth
reconsidering.

## Real email delivery via Resend

`EmailService`'s internal implementation changed; nothing about its public
interface did — every other file in the app still calls
`sendPasswordResetEmail()` exactly as before, the actual payoff of having
built it as a swappable abstraction in the first place. The SDK's current
shape was verified directly against Resend's own docs, GitHub, and npm
listing (all current within days) rather than assumed, given how many
library-API surprises this project has already hit.

One specific, non-obvious detail shaped the implementation: **Resend
returns send failures as a value (`{ error }`), never throws them.** This
mattered for a reason specific to this app's own design, not a generic
"handle your errors" concern — if a failed send were allowed to propagate
as a thrown exception, `forgotPassword()` would return a `500` on that
path, while a genuinely nonexistent email still correctly returns `204`.
That difference in status code would itself leak exactly the
account-existence signal the whole no-enumeration design exists to hide. A
send failure is logged, for operator visibility, but deliberately never
allowed to change the response the caller receives — a send failure and a
nonexistent email must remain indistinguishable from outside, the same as
they always were.

`RESEND_API_KEY` was added to `validateEnv()`'s boot-time checks, following
the same "fail loudly, immediately, at boot" principle already established
for `SESSION_SECRET` — a missing key would otherwise only surface the first
time someone actually requested a password reset, as a confusing runtime
failure deep inside a service, rather than a clear error before the app
ever starts serving traffic.

### A real, non-obvious testing constraint discovered afterward

Resend's unverified-sandbox mode restricts delivery to only the email
address the Resend account itself was signed up with — confirmed directly
rather than assumed, since guessing wrong here would have just produced
another confusing "nothing happened" result. This ruled out an initially
proposed e2e test addition: registering a test account with a random,
timestamped email address and asserting a real send occurred would only
ever work for whoever's personal Resend account happened to be configured
at the time — genuinely non-portable to a teammate, a future CI
environment, or even the same person using a different account later. The
decision was made explicitly *not* to commit that version, rather than
accept reduced portability for a small coverage gain — the real fix,
identified but deliberately deferred rather than implemented immediately,
is registering the test account with `delivered@resend.dev`, one of
Resend's own dedicated test addresses built for exactly this situation
(always succeeds, no account-specific restriction, documented in Resend's
own official examples).

## MFA secret encryption at rest

`mfaSecret` moved from plaintext to AES-256-GCM, encrypted and decrypted
via Node's built-in `crypto` module — no new dependency needed. Worth
stating the actual distinction from `passwordHash` precisely, since the two
can look similar without being equivalent: `passwordHash` is one-way
(bcrypt) — unrecoverable even with full database read access. A TOTP secret
cannot use one-way hashing at all, since it must remain genuinely readable
to compute and verify codes — the real risk this closes is that anyone
gaining database read access alone (a leaked backup, an over-permissioned
read replica, a narrow SQL-injection-class bug) could otherwise compute
valid codes for any MFA-enabled account indefinitely, quietly defeating the
entire point of a second factor at the exact moment a first-factor leak
makes it matter most.

Deliberately authenticated encryption (GCM, not a plain cipher mode) — a
tampered or corrupted ciphertext fails loudly on decryption (an exception)
rather than silently producing garbage that would fail TOTP verification in
a confusing, hard-to-diagnose way instead.

A real, explicitly named limitation, not a silently accepted one: this
protects against database-only compromise, not full server compromise,
since the decryption key lives in that same server's environment
(`MFA_ENCRYPTION_KEY`). A genuine production deployment handling real
patient data should hold that key in a real secrets manager or KMS (AWS
KMS, HashiCorp Vault) — separate infrastructure from both the database and
the application server — rather than a plain environment variable. Accepted
here deliberately, given this deployment's actual stakes (a demo, no real
patient data), with the path to the fully-correct answer stated explicitly
rather than left implicit.

### A mistake caught immediately, worth naming directly rather than glossing over

While wiring decryption into `verifyMfaCode()`, a `str_replace` edit
accidentally dropped the method's own `return` statement — the exact same
class of slip as the `validateUser()` incident much earlier in the
project. Caught by re-viewing the file immediately after the edit rather
than trusting it had landed correctly, and fixed in the same turn before
being presented. Worth recording again, this far into the project: the
"verify, don't assume" discipline isn't a one-time lesson from early
mistakes, it's a habit that still catches real slips this late, and is
worth applying with the same rigor regardless of how much of the project
has already been built correctly.

## Confirming test impact precisely, rather than assuming either direction

Both changes turned out to require zero test-file changes, for two
different, specific reasons worth distinguishing rather than lumping
together as "nothing broke." The `trust proxy` and session cookie changes
live entirely inside `main.ts`'s `bootstrap()` function, which e2e tests
never call at all (they construct `AppModule` and their own session
middleware directly) — not evidence the change was safe, but evidence that
code path was never actually exercised by e2e tests to begin with, a real
gap worth naming rather than a clean bill of health. The MFA encryption
change, by contrast, genuinely was exercised and genuinely didn't need
updating — `setupMfa()` was specifically designed so the value returned to
a caller stays plaintext (necessary, since that's what populates the QR
code), with only the stored copy encrypted, so a test that only ever
interacts with the public API surface (as `auth.e2e-spec.ts` does) observes
no difference at all.

Reviewing the actual `auth.e2e-spec.ts` file directly (rather than
reasoning about it hypothetically) also surfaced a real, pre-existing
coverage gap unrelated to either change: its `forgot-password` test used
two email addresses, neither of which was ever an actually-registered
account — meaning the test had never exercised the "real account, real
send attempted" path at all, before or after the Resend integration. A new
test was added specifically to close this — registering a genuine account,
triggering a real reset against it, and verifying success via a direct
database read of the resulting `PASSWORD_RESET_REQUESTED` audit entry,
deliberately not by checking actual email delivery (which would require
live network access and a real inbox from the test runner for no
additional verification value beyond what the audit log already confirms).
