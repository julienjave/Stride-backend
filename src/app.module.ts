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

import { Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core'
import { ThrottlerModule, ThrottlerGuard, seconds } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { DrizzleModule } from './database/drizzle.module'
import { StorageModule } from './storage/storage.module'
import { UsersModule } from './users/users.module'
import { AuthModule } from './auth/auth.module'
import { ExercisesModule } from './exercises/exercises.module'
import { ClinicsModule } from './clinics/clinics.module'
import { ProgramsModule } from './programs/programs.module'
import { AssignedProgramsModule } from './assigned-programs/assigned-programs.module'
import { SessionsModule } from './sessions/sessions.module'
import { MessagingModule } from './messaging/messaging.module'
import { AuditModule } from './audit/audit.module'
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor'
import { HttpExceptionFilter } from './common/filters/http-exception.filter'
import { MedicalFilesModule } from './medical-files/medical-files.module'
import { HealthModule } from './health/health.module'

// --- MODULE ------------------------------------------------------------------------------------------------

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // pino-pretty is only for LOCAL readability — in production, real
        // JSON output is what a log aggregator (or `docker logs` piped
        // into one) actually needs to search/filter on.
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty' },
        // Explicit, not optional: an unredacted HTTP request logger would
        // otherwise happily log a raw session cookie (a live, usable
        // credential) or a plaintext password on every login/register
        // request. This is the same "never let sensitive fields leak"
        // discipline applied everywhere else in this app (passwordHash and
        // mfaSecret both stripped before any response), extended to logs.
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
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: seconds(60),
        limit: 60, // baseline: 60 requests/minute per IP, across the whole API
      },
    ]),
    DrizzleModule,
    StorageModule,
    UsersModule,
    AuthModule,
    ExercisesModule,
    ClinicsModule,
    ProgramsModule,
    AssignedProgramsModule,
    SessionsModule,
    MessagingModule,
    AuditModule,
    MedicalFilesModule,
    HealthModule,
  ],
  providers: [
    // Applying ThrottlerGuard globally here — every route in the app gets the
    // baseline limit automatically, no controller has to remember to add it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
