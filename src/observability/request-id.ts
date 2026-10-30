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

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

// --- REQUEST IDS -------------------------------------------------------------------------------------------

// One id per request, made HERE (decisions §32): every log line of the
// request carries it (pino-http binds it as `reqId`), the answer carries it
// (this header, and `requestId` in an error's body), and so will the error
// reports (pass 2 and 3). A person who quotes "Reference 7f3a…" from an error
// screen leads straight to the error in GlitchTip and to every log line of
// that request in Better Stack.
//
// - RANDOM (a v4 UUID, 122 random bits), not pino-http's default counter
//   (1, 2, 3… — restarting at 1 on every boot, and the same numbers on two
//   instances): an id must mean ONE request, ever.
// - Made by the SERVER only. An `X-Request-Id` the client sends is ignored:
//   trusting it would let anyone choose what their requests are called in
//   our logs — collide with another request's id, or write text into them.
export const REQUEST_ID_HEADER = 'X-Request-Id'

// The request's id, made once: the first caller — pino-http's middleware, for
// any request that reaches it — chooses it and puts it in the answer's
// header; every later caller gets the same one. The exception filter calls
// this too: an error raised BEFORE the logger's middleware ran (a body that
// isn't valid JSON is refused by the body parser, which runs first) still
// gets an id, in its header, body and log line.
//
// `req.id` is where pino-http keeps it (its type declares `id` on Node's
// IncomingMessage). Only a string we made counts: nothing else in the app
// writes `req.id`.
export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const existing = requestIdOf(req)
  if (existing) return existing
  const id = randomUUID()
  req.id = id
  // A header can't be added once the answer has started (Node throws
  // ERR_HTTP_HEADERS_SENT); the id is still logged.
  if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, id)
  return id
}

export function requestIdOf(req: IncomingMessage): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined
}
