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
import { APP_GUARD, APP_FILTER } from '@nestjs/core'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { DrizzleModule } from './database/drizzle.module'
import { StorageModule } from './storage/storage.module'
import { UsersModule } from './users/users.module'
import { CareTeamModule } from './care-team/care-team.module'
import { InvitationsModule } from './invitations/invitations.module'
import { AuthModule } from './auth/auth.module'
import { EmailChangeModule } from './email-change/email-change.module'
import { PasswordChangeModule } from './password-change/password-change.module'
import { ExercisesModule } from './exercises/exercises.module'
import { ClinicsModule } from './clinics/clinics.module'
import { ProgramsModule } from './programs/programs.module'
import { AssignedProgramsModule } from './assigned-programs/assigned-programs.module'
import { SessionsModule } from './sessions/sessions.module'
import { AlertsModule } from './alerts/alerts.module'
import { MessagingModule } from './messaging/messaging.module'
import { AuditModule } from './audit/audit.module'
import { HttpExceptionFilter } from './common/filters/http-exception.filter'
import { MedicalFilesModule } from './medical-files/medical-files.module'
import { HealthModule } from './health/health.module'
import { throttlerOptions } from './config/rate-limits'

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
    // The limits (60 a minute per route and IP) and the RATE_LIMITS switch
    // live in config/rate-limits.ts. forRootAsync: the factory runs when the
    // module is BUILT, so an e2e file that sets RATE_LIMITS first decides.
    ThrottlerModule.forRootAsync({ useFactory: () => throttlerOptions() }),
    DrizzleModule,
    StorageModule,
    UsersModule,
    CareTeamModule,
    InvitationsModule,
    AuthModule,
    EmailChangeModule,
    PasswordChangeModule,
    ExercisesModule,
    ClinicsModule,
    ProgramsModule,
    AssignedProgramsModule,
    SessionsModule,
    AlertsModule,
    MessagingModule,
    AuditModule,
    MedicalFilesModule,
    HealthModule,
  ],
  providers: [
    // Applying ThrottlerGuard globally here — every route in the app gets the
    // baseline limit automatically, no controller has to remember to add it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // No global audit interceptor any more (removed by the audit review,
    // slice 1c — decisions §10): every route that changes data is tagged
    // @AuditedByService() and its service writes ONE complete entry in the
    // change's own transaction; a mutating route that changes nothing is
    // tagged @NotAudited(reason). src/audit/audit-tags.spec.ts fails if a
    // route has neither.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
