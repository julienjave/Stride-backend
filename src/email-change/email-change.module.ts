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
import { UsersModule } from '../users/users.module'
import { EmailModule } from '../email/email.module'
import { MessagingEventsModule } from '../messaging/messaging-events.module'
import { EmailChangeController } from './email-change.controller'
import { EmailChangeService } from './email-change.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// Changing one's own sign-in email (decisions §12). The database and the
// audit log are global; the rest is imported: users (an account's roles),
// email (the four messages), messaging events (closing the sockets of the
// sessions a confirmation ends).
@Module({
  imports: [UsersModule, EmailModule, MessagingEventsModule],
  controllers: [EmailChangeController],
  providers: [EmailChangeService],
})
export class EmailChangeModule {}
