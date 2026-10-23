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
import { EmailModule } from '../email/email.module'
import { MessagingEventsModule } from '../messaging/messaging-events.module'
import { PasswordChangeController } from './password-change.controller'
import { PasswordChangeService } from './password-change.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// Changing one's own password (decisions §13). The database and the audit log
// are global; the rest is imported: email (the notice), messaging events
// (closing the sockets of the sessions a change ends).
@Module({
  imports: [EmailModule, MessagingEventsModule],
  controllers: [PasswordChangeController],
  providers: [PasswordChangeService],
})
export class PasswordChangeModule {}
