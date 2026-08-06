# Stride API — Integration Reference

This is the integration reference for the Stride backend (NestJS / Drizzle /
Postgres), written for whoever is building the frontend next. It documents
everything that **`@nestjs/swagger`, live at `/api-docs`, cannot express**:
authentication mechanics, the WebSocket API, cross-cutting response
conventions, and the authorization model.

**It does not duplicate `/api-docs`.** For the exact request/response shape
of a specific REST route (query params, body fields, field-level validation
constraints), go to `/api-docs` — it's generated directly from the DTOs and
decorators, so it never drifts out of sync with the code. This reference
tells you the things Swagger has no way to show: *how you authenticate*,
*what happens over the WebSocket connection*, *what every error response
looks like*, and *who is allowed to do what*.

Everything in this document was verified directly against the source in
`src/` at the time of writing (Aug 2026) — file and line references are
included throughout so you can re-check anything against the current code.

## Contents

1. **[Authentication & Sessions](./01-authentication.md)** — session-cookie
   mechanics, the multi-role login flow, the two-step MFA flow, role
   switching, and what `401` vs `403` actually mean in this API.
2. **[WebSocket API](./02-websocket-api.md)** — the complete `MessagingGateway`
   reference: connection handshake, every client→server and server→client
   event, and a worked end-to-end example.
3. **[Response Conventions](./03-conventions.md)** — the global error shape,
   the pagination shape (and exactly which endpoints use it), and rate
   limiting.
4. **[Roles & Authorization](./04-authorization.md)** — the three roles and a
   resource-by-resource reference of who can do what, including the
   non-obvious cases.
5. **[Getting Started](./05-getting-started.md)** — a real, copy-pasteable
   walkthrough: register a clinic, log in, create a practitioner and a
   patient, create an exercise, and assign a program.

## The one-paragraph version

This API authenticates with an **httpOnly session cookie**, not a Bearer
token — there is no `Authorization` header anywhere in this system. Every
request from the frontend, REST or WebSocket, must be made with credentials
included (`fetch(..., { credentials: 'include' })`, `axios` with
`withCredentials: true`, or `io(url, { withCredentials: true })` for
Socket.IO). The backend's CORS config only trusts the exact origins listed in
`FRONTEND_URLS` (comma-separated; defaults to `http://localhost:5173` in
dev) — `credentials: true` CORS never works with a wildcard origin, so the
frontend's real origin must be in that list.
