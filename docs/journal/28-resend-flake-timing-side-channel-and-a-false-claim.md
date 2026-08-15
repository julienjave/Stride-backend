# A flaky test, a real timing side-channel, and a claim that was never true

This document covers a chain of four connected findings, not a planned
piece of work — worth naming that plainly up front. It started as a
one-line fix while Pass 1 of the RLS roadmap was already in flight, and
each step led directly to discovering the next. None of it was on the
roadmap; all of it turned out to matter.

## It started as a flake

`auth.e2e-spec.ts`'s MFA-flow test — the one exercising a full two-step
login — was timing out intermittently, specifically on the
`forgot-password` call inside it. Confirmed directly against the file
before touching anything: it's the only forgot-password test that
registers a *known* account, which means `AuthService.forgotPassword()`
falls through to a real, awaited round-trip to Resend's live API — every
other forgot-password test uses an unknown email, which returns before
any network call happens at all. Measured directly: ~6–13ms for the
unknown-account path, ~430–480ms for the known-account one.

Doc 17 had already identified the correct fix for exactly this situation
and deliberately deferred it at the time — registering the test account
as `delivered@resend.dev`, Resend's own dedicated always-succeeds test
address. Implemented now, alongside a second, independent safety net (a
per-test Jest timeout bump, touching only that one test). Verified with 8
isolated runs and instrumented real response times, not just a clean pass
count: the address change did essentially all the real work — the
timeout bump was never once exercised across any run. Worth stating
precisely, since it's easy to credit a combined fix evenly when it isn't:
the sandbox-restricted address was the actual bug; the timeout bump is
just cheap insurance for a live network call having a bad day.

## What the flake's own diagnostics revealed

The measurement that fixed the flake also happened to quantify something
real and previously undocumented: `forgotPassword()`'s response time
depended entirely on whether the target account actually existed — a
~40–70x gap, squarely at network-round-trip scale. Doc 17 built this
endpoint specifically so a nonexistent account and a genuine account are
*indistinguishable in the response body*. Response **timing** was never
part of that guarantee, and it turned out to be a far easier signal to
read than the body ever was — no need to parse anything, a stopwatch
sufficed.

The fix: make only the email-send call fire-and-forget, matching the
pattern doc 10 already established for the audit interceptor, applied
here to one specific call instead of every mutating request. Token
generation, hashing, the database `UPDATE`, and the audit log write all
stayed exactly as awaited as they already were — confirmed directly
against the current source before changing anything, not assumed from
description. Verified for the failure mode a fire-and-forget change
actually risks (an unhandled promise rejection) two separate ways: a real
e2e run against a deliberately invalid Resend API key (confirming
`EmailService`'s existing error-value handling still catches it and logs
server-side, per doc 17's original design), and a standalone script
forcing a genuine promise rejection rather than a value-based failure, to
confirm the new `.catch()` actually handles the case
`EmailService`'s internal check wouldn't.

**Honestly reported, not rounded down**: the gap is reduced, not
eliminated. Re-measured after the fix: ~26–39ms known vs. ~3–13ms unknown
— roughly an order of magnitude smaller, not zero. The remainder is real,
expected synchronous work an unknown-account request never reaches
(hashing, a roles lookup, the RLS-wrapped `UPDATE` itself) — a
network-latency-scale oracle closed; a small, harder-to-exploit residual
left open and named as such, the same "state the tradeoff, don't imply a
guarantee that isn't true" discipline applied everywhere else in this
project.

## A claim that turned out to have never been true

Confirming the audit log write's timing hadn't shifted meant checking for
an existing test covering it — doc 17 describes one directly, in detail:
*"A new test was added specifically to close this... verifying success
via a direct database read of the resulting `PASSWORD_RESET_REQUESTED`
audit entry."* No such test exists anywhere in the current codebase.

Investigated with the same standard as doc 25's log-rotation finding, not
assumed either direction: a full pickaxe search
(`git log --all -S "PASSWORD_RESET_REQUESTED"`) across every commit on
every ref, the complete history of `test/auth.e2e-spec.ts` specifically,
a rename-follow check (ruling out the content hiding under an earlier
filename), and a dangling-commit check (`git fsck`, ruling out something
git itself had garbage-collected). Conclusive: the string appears in
exactly two commits — the one that introduced the audit action in
`AuthService` itself, and the one that added doc 17's own prose describing
the test. No commit, on any branch, ever touched a test file with it.
There is no "added, then removed" story to tell — it was simply never
committed, from the start.

**Worth being precise about how this differs from the doc 01/23
precedent**, not treating the two as identical: doc 01 described a
*plan* that was accurate when written and later diverged from reality —
a forecast, honestly wrong in hindsight. Doc 17 describes a specific
*completed action*, in the past tense, as something that had already
happened. Git history says it hadn't, not once. Following the same
editorial policy regardless — doc 17 is deliberately left unedited, this
document is where the gap is named — but the two situations aren't quite
the same shape, and it would be a little dishonest to imply otherwise by
treating this correction as a routine repeat of the last one.

## Closing the actual gap, not just the historical question

The real test was added — genuinely useful now regardless of the history
question, since it locks down the exact behavior this document's fire-
and-forget change was careful to leave unchanged. Writing it surfaced one
more small, real finding: no existing e2e spec does a direct database-
table read for its assertions at all (every one of them, including
`audit.e2e-spec.ts`, asserts through the real HTTP `/audit-logs` route
instead) — the "existing pattern" an earlier prompt in this same arc
assumed existed didn't. Building it properly meant discovering
`audit_logs` carries its own `FORCE ROW LEVEL SECURITY` policy requiring
an admin context (0002 in the RLS migration series) that none of the
suite's existing `current_database()` safety checks had ever exercised —
resolved by wrapping the new test's read in `withRlsContext()` as the
suite's already-bootstrapped founding admin, the same mechanism the real
`/audit-logs` route itself relies on. The assertion checks a real
timestamp window against the actual request's start/end time, not just
row existence. Verified in isolation seven times before trusting it, then
against the full suite: 98/98 e2e passing (97 before this addition).

## Current status

All four pieces — the Resend address fix, the fire-and-forget change, the
new regression test, and this write-up — are verified against real,
repeated evidence: instrumented timing across multiple runs, both
unhandled-rejection failure modes tested directly, and a full clean suite
run. Committed as `[commit hash — to be filled in once committed]`.
