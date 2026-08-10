# Stride API — Integration Reference

This is the integration reference for the Stride backend (NestJS / Drizzle /
Postgres), written for whoever builds the frontend next. It covers
everything **`@nestjs/swagger`, live at `/api-docs`, cannot express**:
authentication mechanics, the WebSocket API, cross-cutting response
conventions, the authorization model, and a real integration walkthrough.

**It does not duplicate `/api-docs`.** For the exact request/response shape
of a specific REST route — query parameters, body fields, field-level
validation constraints — go to `/api-docs`. It's generated directly from the
DTOs and decorators in `src/`, so it cannot drift out of sync with the code
the way a hand-written route reference can. This document exists for
everything Swagger has no mechanism to show: *how authentication actually
works*, *what happens over the WebSocket connection*, *what every error
response looks like*, and *who is allowed to do what*.

## Verified against

**Commit `4cd2176eca1c8c6c5ec56af968c0af7cd4157666`.** Every concrete claim
in this document set — status codes, payload shapes, event names, stripped
fields, throttled routes — was re-derived directly from the source files it
cites (or from an `*.e2e-spec.ts`/`*.spec.ts` test's own assertions, where
one exists) at that commit, not carried over from an earlier version of this
documentation. If the backend has moved on since, run `git log --oneline
4cd2176eca1c8c6c5ec56af968c0af7cd4157666..HEAD -- src/` to see what's
changed underneath this document, and treat anything it touches as
unverified until re-checked.

## Contents

1. **[Authentication & Sessions](./01-authentication.md)** — session-cookie
   mechanics, the multi-role login flow, the two-step MFA flow, role
   switching, exactly what gets stripped from a user object, and what `401`
   vs `403` actually mean in this API.
2. **[WebSocket API](./02-websocket-api.md)** — the complete `MessagingGateway`
   reference: how the handshake authenticates and can be rejected, every
   client→server and server→client event with its real authorization check,
   how thrown errors reach the client, and a worked end-to-end example.
3. **[Response Conventions](./03-conventions.md)** — the global error shape,
   exactly which endpoints use the `{ data, meta }` pagination shape (it's
   not universal), and the complete current list of rate-limited routes.
4. **[Roles & Authorization](./04-authorization.md)** — the three roles and
   a resource-by-resource table of who can do what, including the
   non-obvious cases (e.g. admins can edit exercises but not create them).
5. **[Getting Started](./05-getting-started.md)** — a real, copy-pasteable
   walkthrough: register a clinic, create a practitioner and a patient,
   create an exercise, and assign a program — every request body checked
   against the actual DTO validation rules.

## The one-paragraph version

This API authenticates with an `httpOnly` session cookie
(`connect.sid`), not a Bearer token — there is no `Authorization` header
anywhere in this system. Every request from the frontend, REST or
WebSocket, must be made with credentials included
(`fetch(..., { credentials: 'include' })`, `axios` with
`withCredentials: true`, or `io(url, { withCredentials: true })` for
Socket.IO). CORS only trusts the exact origins listed in the `FRONTEND_URLS`
env var (comma-separated; defaults to `http://localhost:5173` in dev) —
`credentials: true` CORS can never work with a wildcard origin, so the
frontend's real origin must be in that list, exactly.

## A note on scope

Every claim in this document set is either read directly from the
implementation at the commit above, or confirmed against a passing
`*.e2e-spec.ts`/`*.spec.ts` assertion where one exists for that behavior —
never carried over from an earlier draft of this documentation and never
inferred from what a "typical" API in this domain might do. Nothing here
describes intended or planned behavior; if something isn't implemented, the
relevant section says so rather than describing it as if it existed.
