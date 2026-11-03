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

// FIRST, before Nest or any module of the app: error reporting starts here,
// so an error while the rest loads is reported too (observability/
// instrument.ts says why, and why only main.ts imports it). It loads
// dotenv itself.
import './observability/instrument'
import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { ValidationPipe } from '@nestjs/common'
import session from 'express-session'
import type { NextFunction, Request, Response } from 'express'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { getDatabaseUrl } from './config/database-url'
import { validateEnv } from './config/validate-env'
import { corsOptions } from './config/cors-options'
import { sessionCookieOptions } from './config/session-cookie'
import { getPoolConfig } from './config/pool-config'
import { survivePoolErrors } from './database/pool-errors'
import { SessionIoAdapter } from './messaging/session-io.adapter'
import { MessageNoticesService } from './messaging/message-notices.service'

// --- MAIN LOGIC ---------------------------------------------------------------------------------------------

async function bootstrap() {
  // The very first thing that runs, before even NestFactory.create() — no
  // module in this app should be constructed at all if a critical piece of
  // config is missing or insecure.
  validateEnv()

  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  // === LOGGER =================================================================

  // Swaps Nest's default console logger for pino GLOBALLY
  app.useLogger(app.get(Logger))

  // === SHUTDOWN SIGNALS =======================================================

  // Relays OS shutdown signals (SIGTERM, SIGINT)
  app.enableShutdownHooks()

  // === PROXY ==================================================================

  // Needed to allow for rate-limiting to see the real client IP, not
  // whatever's directly in front of this process. The number of hops to
  // trust is genuinely different between environments — locally, nothing
  // sits in front of the app at all; in production, it's TWO hops
  // (Cloudflare, then Caddy). Hardcoding either number would make the
  // OTHER environment wrong, so this reads from an env var instead, with
  // a default (1) that preserves prior behavior when unset.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))

  // Verified against this project's OWN real production logs, not just
  // assumed from generic documentation: Cloudflare's docs claim
  // X-Forwarded-For includes the original client IP — but captured
  // production logs showed it containing ONLY Cloudflare's own edge IP
  // (itself within Cloudflare's published ranges), while cf-connecting-ip
  // correctly carried the real visitor's IP every single time. Given this
  // specific, observed behavior in our own chain, relying on generic
  // X-Forwarded-For + trust-proxy hop-counting alone is not reliable here.
  // Overwriting X-Forwarded-For with Cloudflare's own dedicated header,
  // before anything downstream (rate limiting, logging) ever reads
  // req.ip, is the robust fix — every consumer of req.ip benefits
  // automatically, with no changes needed anywhere else in the app.
  if (process.env.NODE_ENV === 'production') {
    // Typed with Express's own types (an `any` let every access through
    // them go unchecked). `_res`: unused, but `next` is the THIRD argument
    // Express passes, so the second must be named too (the `_` says
    // "deliberately unused").
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const cfConnectingIp = req.headers['cf-connecting-ip']
      if (typeof cfConnectingIp === 'string') {
        req.headers['x-forwarded-for'] = cfConnectingIp
      }
      next()
    })
  }

  // === CORS ===================================================================

  // The allowed frontends, the session cookie, and the response headers
  // the frontend may read (the records export's file name, a 429's
  // Retry-After) — config/cors-options.ts says why each.
  app.enableCors(corsOptions())

  // === VALIDATION =============================================================

  // --- VALIDATION PIPE ---
  // Registered ONCE here, globally — applies to every route in the app
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strips any property NOT declared on the DTO
      forbidNonWhitelisted: true, // ...and rejects the request outright if it finds one
      transform: true, // converts plain incoming JSON into a real instance of the DTO class
    }),
  )

  // === AUTHENTICATION ===========================================================

  // --- SESSION ---
  // A SEPARATE pool from Drizzle's own — connect-pg-simple manages its own
  // "session" table directly with raw SQL, entirely outside Drizzle's schema/migration system.
  // survivePoolErrors: a closed idle connection (Postgres restarting) must
  // not crash the process — database/pool-errors.ts.
  const sessionPool = survivePoolErrors(
    new Pool({
      connectionString: getDatabaseUrl(),
      ...getPoolConfig('session'),
    }),
    'session',
  )
  const PgSessionStore = connectPgSimple(session)

  // Named, rather than passed inline to app.use() — this exact same
  // middleware instance is reused below for WebSocket connections too, via
  // SessionIoAdapter. One session store, one cookie, two transports.
  const sessionMiddleware = session({
    store: new PgSessionStore({
      pool: sessionPool,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    // httpOnly, Secure in production, SameSite=Lax, 7 days —
    // config/session-cookie.ts says why each (and why Lax since 2026-11-03).
    cookie: sessionCookieOptions(),
  })

  app.use(sessionMiddleware)

  // --- PASSPORT ---
  app.use(passport.initialize())
  app.use(passport.session())

  // --- WEBSOCKET ---
  // Applies sessionMiddleware to every WebSocket handshake too — without
  // this, MessagingGateway would have no way to know who's connecting at
  // all, since Socket.IO's handshake never runs through Express's normal
  // middleware chain on its own.
  app.useWebSocketAdapter(new SessionIoAdapter(app, sessionMiddleware))

  // === SWAGGER ==================================================================

  // Auto-generated from the DTOs and decorators already written throughout
  // this app — the @nestjs/swagger CLI plugin (see nest-cli.json) is what
  // makes this possible without manually adding @ApiProperty() to every
  // field of every DTO: it statically reads each class's TypeScript types
  // and class-validator decorators at BUILD time and injects the equivalent
  // Swagger metadata automatically. addCookieAuth documents that this API
  // authenticates via a session cookie, not a Bearer token — the Swagger UI
  // shows an "Authorize" button reflecting that.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Stride API')
    .setDescription('Physiotherapy exercise program management API')
    .setVersion('1.0')
    .addCookieAuth('connect.sid')
    .build()
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig)
  SwaggerModule.setup('api-docs', app, swaggerDocument)

  // === START APP ================================================================

  await app.listen(process.env.PORT ?? 3000)

  // The new-message emails' sweep (roadmap Phase 6.5): started HERE, once
  // the server serves requests — never by the module, so the e2e suites,
  // the seed and the scripts (which build the same modules) send nothing on
  // a timer. See MessageNoticesService.
  app.get(MessageNoticesService).start()
}

// `void`: says "this promise is deliberately not awaited" (the top level of
// a CommonJS module can't await). Nothing is swallowed — if bootstrap()
// rejects (a bad environment variable, the port taken), Node still reports
// the unhandled rejection and exits with code 1, exactly as before.
void bootstrap()
