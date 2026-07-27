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

import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { ValidationPipe } from '@nestjs/common'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { AppModule } from './app.module'
import { getDatabaseUrl } from './config/database-url'
import { SessionIoAdapter } from './messaging/session-io.adapter'


// --- MAIN LOGIC ---------------------------------------------------------------------------------------------

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule)

    // === SHUTDOWN SIGNALS =======================================================
    
    // Relays OS shutdown signals (SIGTERM, SIGINT)
    app.enableShutdownHooks()


    // === PROXY ==================================================================

    // Needed to allow for rate-limiting
    app.set('trust proxy', 1)


    // === CORS ===================================================================

    app.enableCors({
        origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
        credentials: true,
    })


    // === VALIDATION =============================================================

    // --- VALIDATION PIPE ---
    // Registered ONCE here, globally — applies to every route in the app
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,             // strips any property NOT declared on the DTO
            forbidNonWhitelisted: true,  // ...and rejects the request outright if it finds one
            transform: true,             // converts plain incoming JSON into a real instance of the DTO class
        }),
    )


    // === AUTHENTICATION ===========================================================

    // --- SESSION ---
    // A SEPARATE pool from Drizzle's own — connect-pg-simple manages its own
    // "session" table directly with raw SQL, entirely outside Drizzle's schema/migration system.
    const sessionPool = new Pool({ connectionString: getDatabaseUrl() })
    const PgSessionStore = connectPgSimple(session)
    
    // Named, rather than passed inline to app.use() — this exact same
    // middleware instance is reused below for WebSocket connections too, via
    // SessionIoAdapter. One session store, one cookie, two transports.
    const sessionMiddleware = session({
        store: new PgSessionStore({ pool: sessionPool, createTableIfMissing: true }),
        secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        },
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


    // === START APP ================================================================

    await app.listen(process.env.PORT ?? 3000)
}
bootstrap()
