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
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerModule, ThrottlerGuard, seconds } from '@nestjs/throttler'
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


// --- MODULE ------------------------------------------------------------------------------------------------

@Module({
  imports: [
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
  ],
  providers: [
    // Applying ThrottlerGuard globally here — every route in the app gets the
    // baseline limit automatically, no controller has to remember to add it.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})

export class AppModule {}