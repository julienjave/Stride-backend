# Audit logging: a hybrid design, and a real schema constraint

This document covers `AuditModule` — the piece deferred all the way back when
`AuthModule` was first built, and the last module needed to close out the
technical safeguards this backend has been built around from the start.

## A hybrid design: one global interceptor, plus explicit calls where nuance matters

Most mutations share a simple, generic shape: an authenticated user did
something to a resource. A single global `AuditLogInterceptor`
(`APP_INTERCEPTOR`, the same registration pattern already used for
`ThrottlerGuard`) handles this case for every `POST`/`PATCH`/`PUT`/`DELETE`
request across the app, deriving `entityType` from the URL's first path
segment and `entityId` from the response body's `id` field — a heuristic
that works cleanly specifically *because* of an earlier decision: every
mutating route in this app already returns the full affected row (the
204→200 change made for soft-delete routes a while back), so there's
reliably an `id` to read.

Authentication events don't fit that generic shape, for a concrete reason:
a login attempt has no `req.user` yet — establishing who's logged in is
exactly what's being attempted — and distinguishing "wrong password" from
"no such account" requires context only `AuthService` itself has. Rather
than stretch the generic interceptor to handle this, `/auth/*` routes are
explicitly excluded from it, and `AuthService` calls `AuditService.log()`
directly for `REGISTER`, `REGISTER_CLINIC`, `LOGIN_SUCCESS`, `LOGIN_FAILURE`,
and `LOGOUT` — each with far more precise detail than a generic request
observer could ever infer.

## A real, unresolved-by-design constraint: `performedBy` is `NOT NULL`

This surfaced a genuine tension worth recording rather than quietly
resolving: a failed login attempt against an email that matches **no real
account** cannot be logged at all under the current schema — `performedBy`
references `users.id` and is `NOT NULL`, and there is no valid id to
attribute a wholly anonymous attempt to. The resolution: only failed logins
against a real, matched account are logged (`LOGIN_FAILURE`, attributed to
that account) — which still captures the most security-relevant case
(repeated failed attempts against one known target, the same signal the
login rate limiter partially defends against from a different angle) without
requiring a schema change. Attempts against nonexistent accounts are simply
not represented in the audit trail. This is a deliberate, documented scope
limitation, not an oversight — worth stating plainly rather than leaving
implicit, since it's exactly the kind of tradeoff a real security review
would ask about directly.

## Fire-and-forget writes, and why that's an accepted tradeoff here

The interceptor's audit write is not awaited as part of the request/response
cycle — it's dispatched, with a caught-and-logged failure path, but the
actual HTTP response returns without waiting for it to complete. This is a
deliberate choice: awaiting it would add latency to every single mutating
request in the app for the sake of a secondary concern, and a rare failure
to write an audit row should never become a user-facing error on an
otherwise-successful action. The real tradeoff being accepted is eventual
consistency for the audit trail rather than strict transactional coupling to
the action it describes — reasonable for this application's stakes, and
worth being explicit is a real choice rather than an accidental gap.

## A TypeScript inference issue worth recognizing as a pattern

`AuthService.registerClinic()`'s transaction return value was, after
`await`, still typed as `Promise<{...}>` rather than the resolved object —
despite the `await` being genuinely present and correct at runtime. This
traces to a known category of TypeScript limitation: a generic method's
return type, inferred from a callback whose return value is built through
object spread, can occasionally fail to fully resolve through the generic
inference chain. The fix was not to restructure the code until inference
"worked" by accident, but to remove the ambiguity entirely — an explicit
named interface for the transaction's result shape, annotated on both the
callback's return type and the receiving variable. When a generic function's
inferred type does something surprising, an explicit type annotation is
generally more robust than continuing to fight inference.
