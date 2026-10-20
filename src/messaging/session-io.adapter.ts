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

import type { INestApplicationContext } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import type { ExtendedError, Server, ServerOptions } from 'socket.io'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

// --- ADAPTER -----------------------------------------------------------------------------------------------

// Socket.IO's handshake does NOT go through Express's normal middleware
// chain by default — meaning app.use(session(...)) never runs for a socket
// connection unless something explicitly makes it. This adapter does exactly
// that: it wraps Socket.IO's own server creation, running the SAME session
// middleware instance against every socket handshake that a normal HTTP
// request already goes through. The payoff is that MessagingGateway can
// trust socket.request.session — the real session store, the real cookie,
// not a separate auth mechanism invented for sockets specifically.
export class SessionIoAdapter extends IoAdapter {
  // The Nest application (main.ts and the gateway's e2e suite pass theirs):
  // the type IoAdapter's own constructor accepts, so no cast is needed.
  constructor(
    app: INestApplicationContext,
    private readonly sessionMiddleware: RequestHandler,
  ) {
    super(app)
  }

  // Nest declares IoAdapter.createIOServer as returning `any`; the value is
  // socket.io's Server, named ONCE here so everything after it is checked
  // (an `any` made `server.use`, `socket.request` and the call below
  // unchecked — lint's no-unsafe-*).
  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server
    server.use((socket, next) => {
      // `socket.request` is Node's IncomingMessage — the object Express
      // turns into its Request for an HTTP call. express-session reads only
      // what both have (the cookie header, the URL) and sets
      // `request.session`, so
      // the handshake is handed over as a Request. The empty Response:
      // session only writes a cookie on a real response, and a handshake
      // has none to send.
      this.sessionMiddleware(
        socket.request as Request,
        {} as Response,
        toExpressNext(next),
      )
    })
    return server
  }
}

// express-session finishes by calling next() — or next(error) when the store
// failed (the database unreachable). socket.io's `next` takes an Error, and
// refuses the handshake when it gets one; Express's NextFunction may also be
// called with the strings 'route' / 'router' (routing instructions, which
// session never sends). Different types, so this bridge says what crosses:
// nothing → the handshake goes on; anything else → an Error, so a failure
// can never be mistaken for success (a non-Error value is wrapped rather
// than dropped, the original kept as its `cause`).
export function toExpressNext(
  next: (error?: ExtendedError) => void,
): NextFunction {
  return (error?: unknown) => {
    if (error === undefined) return next()
    next(
      error instanceof Error
        ? error
        : new Error('The session middleware failed', { cause: error }),
    )
  }
}
