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
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { getDatabaseUrl } from './config/database-url'
import { validateEnv } from './config/validate-env'
import { getAllowedOrigins } from './config/allowed-origins'
import { getPoolConfig } from './config/pool-config'
import { SessionIoAdapter } from './messaging/session-io.adapter'


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

    // Needed to allow for rate-limiting
    app.set('trust proxy', 1)


    // === CORS ===================================================================

    app.enableCors({
        origin: getAllowedOrigins(),
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
    const sessionPool = new Pool({ connectionString: getDatabaseUrl(), ...getPoolConfig('session') })
    const PgSessionStore = connectPgSimple(session)
    
    // Named, rather than passed inline to app.use() — this exact same
    // middleware instance is reused below for WebSocket connections too, via
    // SessionIoAdapter. One session store, one cookie, two transports.
    const sessionMiddleware = session({
        store: new PgSessionStore({ pool: sessionPool, createTableIfMissing: true }),
        secret: process.env.SESSION_SECRET!,
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
}
bootstrap()
