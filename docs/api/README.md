# Stride API — Integration Reference

The integration reference for the Stride backend (NestJS, Drizzle,
PostgreSQL), written for whoever builds a client against it. The project's
own frontend is one such client. It covers what the Swagger UI (generated
from the DTOs, served at `/api-docs`) can't show: how sign-in and sessions
work, the WebSocket API, the conventions every route follows, who may do
what, and a walkthrough you can run.

**For a route's exact request and response body** (fields, types,
validation limits), use `/api-docs`. It's generated from the code, so it
can't drift. **For the list of routes**, use the
[endpoint index](./06-endpoints.md), generated from the code the same way
and checked by a unit test.

## Contents

1. **[Authentication & Sessions](./01-authentication.md)**: the session
   cookie; invitations instead of sign-up; single- and multi-role sign-in;
   two-factor sign-in and recovery codes; re-confirmation before sensitive
   changes; password and email changes; when the server signs a session
   out; `401` vs `403` vs `404`.
2. **[WebSocket API](./02-websocket-api.md)**: connecting with the same
   cookie; the per-person rooms; `sendMessage` and `deleteMessage` with
   their acknowledgements; the four events the server pushes; when the
   server closes a socket.
3. **[Response Conventions](./03-conventions.md)**: validation, the one
   error shape (and the errors with extra fields), request ids, dates and
   instants, the three paged lists, rate limits, and the audit trail.
4. **[Roles & Authorization](./04-authorization.md)**: the three roles, the
   three layers of checks (guards, services, Row-Level Security), and who
   may do what, resource by resource.
5. **[Getting Started](./05-getting-started.md)**: from an empty database
   to a patient seeing their program, in eight `curl` steps, every answer
   from a real run.
6. **[Endpoint Index](./06-endpoints.md)**: all routes, with who may call
   each, its success status, and what's special about it. Generated.

## The one-paragraph version

The API authenticates with an `httpOnly` session cookie (`connect.sid`), not
a bearer token: there is no `Authorization` header anywhere. Every request,
REST or WebSocket, must be sent with credentials (`fetch(…, { credentials:
'include' })`, axios's `withCredentials: true`, or `io(url, {
withCredentials: true })`). CORS answers only the exact origins listed in
`FRONTEND_URLS`, because credentials can never be combined with a wildcard
origin. Accounts are created by invitation; there is no sign-up. Errors
always have the same shape, with `message` an array of sentences written to
be shown to a person. Rows a caller has no relationship with answer `404`,
not `403`, because the database's Row-Level Security makes them invisible.

## How this reference is kept true

- **Read from the code, checked against tests.** Each document names its
  source files and the test files that pin the behaviour it describes.
  Nothing here describes planned behaviour; where something isn't built,
  the document says so.
- **Generated where it can be.** The endpoint index is produced from the
  controllers' decorators (`npm run docs:endpoints`), and a unit test fails
  when it falls behind.
- **Run where it can be.** The getting-started walkthrough was run end to
  end against a fresh local backend, and its answers are copied from that
  run.
- **Measured where it matters.** The claim that sign-in takes the same
  time whether or not an email has an account is backed by before-and-after
  timings, in
  [Authentication](./01-authentication.md#login-single-role-vs-multi-role-accounts).
