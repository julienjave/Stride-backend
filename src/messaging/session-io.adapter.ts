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

import { IoAdapter } from '@nestjs/platform-socket.io'
import { ServerOptions } from 'socket.io'
import { RequestHandler, Response, NextFunction } from 'express'


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
  constructor(
    app: unknown,
    private readonly sessionMiddleware: RequestHandler,
  ) {
    super(app as any)
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options)
    server.use((socket: any, next: NextFunction) => {
      this.sessionMiddleware(socket.request, {} as Response, next)
    })
    return server
  }
}