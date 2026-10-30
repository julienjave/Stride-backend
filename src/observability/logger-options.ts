/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Options } from 'pino-http'
import { pathOnly, scrubText, serializeError } from './log-scrub'
import { assignRequestId } from './request-id'

// --- TYPES -------------------------------------------------------------------------------------------------

// What pino-http hands a request serializer: Node's request already mapped
// by pino's standard serializer (pino-http wraps ours around it) — the
// fields below, plus headers, remoteAddress and remotePort, which we drop.
interface MappedRequest {
  id: unknown
  method: string
  url: string
  raw: IncomingMessage
}

interface MappedResponse {
  statusCode: number
}

// A request line as it may be logged: the three things that say WHICH
// request it was. Everything else pino would write by default goes:
// - headers — `cookie` is a live credential; `referer` is the page the
//   person was on, query string included (the users list keeps its search in
//   the address: `…/admin/users?search=Jane`); `user-agent` adds nothing a
//   request id doesn't;
// - remoteAddress / remotePort — an IP address is one of HIPAA's 18
//   identifiers; Stride's audit log stores none, so this was the only place
//   one was kept;
// - query / params — the query is the search terms (pathOnly drops it from
//   the URL too); params repeat the path.
export interface LoggedRequest {
  id: unknown
  method: string
  url: string
}

// --- OPTIONS -----------------------------------------------------------------------------------------------

// The request logger's settings — read by LoggerModule.forRoot in
// app.module.ts. A function, so a test can build a real pino-http logger
// from the SAME settings (logger-options.spec.ts writes requests through it
// and reads the lines back).
export function pinoHttpOptions(): Options {
  return {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    // pino-pretty is only for LOCAL readability — in production, real
    // JSON output is what a log aggregator (or `docker logs` piped into one)
    // actually needs to search and filter on.
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty' },

    // The request id (request-id.ts): random, made by the server, put in the
    // answer's X-Request-Id header as it's made.
    genReqId: (req: IncomingMessage, res: ServerResponse) =>
      assignRequestId(req, res),

    // Every line logged DURING a request (a service's warning, the exception
    // filter's error) carries only `reqId` — not the whole request again on
    // each line. The request's own "request completed" line still has `req`
    // and `res` (below), so one search for the id finds all of them.
    quietReqLogger: true,

    // Who made the request, by id (not by name or email — the rule above).
    // The session and passport middlewares run before this one (main.ts
    // registers them first), so a signed-in request's user is known here.
    customProps: (req: IncomingMessage) => {
      const user = (req as IncomingMessage & { user?: { id?: unknown } }).user
      return typeof user?.id === 'number' ? { userId: user.id } : {}
    },

    serializers: {
      req: (req: MappedRequest): LoggedRequest => ({
        id: req.id,
        method: req.method,
        url: pathOnly(req.url),
      }),
      res: (res: MappedResponse) => ({ statusCode: res.statusCode }),
      // Every `{ err: … }` a line carries — the exception filters', the
      // message sweep's, pino-http's own for a failed request — goes through
      // the allow-list (log-scrub.ts): no Drizzle params, no Postgres
      // `detail`, emails and input values taken out of the texts.
      //
      // pino-http wraps an err serializer the way it wraps the req one: ours
      // is handed pino's OWN serialization of the error (every enumerable
      // property copied, Drizzle's `params` included — exactly what must not
      // go out), with the original error kept on its `raw` getter. So the
      // allow-list works on `raw`, never on pino's copy. Something thrown
      // that isn't an Error comes through unwrapped (no `raw`).
      err: (wrapped: unknown) =>
        serializeError(
          wrapped instanceof Object && 'raw' in wrapped ? wrapped.raw : wrapped,
        ),
    },

    // The last net, for the MESSAGE of every line: an email address in a
    // log message — ours, or one a library wrote into an error message we
    // pass on (an SMTP server's "550 <jane@…>: recipient rejected") —
    // becomes "[email]". The call sites already log user ids instead
    // (logging-convention.spec.ts keeps it that way); this catches what they
    // can't see. pino calls this hook with the arguments of every log call,
    // before formatting them.
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg: unknown) =>
          typeof arg === 'string' ? scrubText(arg) : arg,
        ) as Parameters<typeof method>
        method.apply(this, scrubbed)
      },
    },

    // Kept as a second line of defence: the serializers above already leave
    // headers and bodies out of request lines, but a future line that logs
    // a request object some other way still has these hidden.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.newPassword',
      ],
      censor: '[REDACTED]',
    },
  }
}
