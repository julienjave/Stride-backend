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
import { MessagingController } from './messaging.controller'
import { MessagingService } from './messaging.service'
import { MessagingGateway } from './messaging.gateway'
import { MessagingEventsModule } from './messaging-events.module'
import { UsersModule } from '../users/users.module'
import { StorageModule } from '../storage/storage.module'
import { EmailModule } from '../email/email.module'
import { MessageNoticesService } from './message-notices.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// StorageModule: the conversation list signs the other person's photo URL.
// MessagingEventsModule: the service emits, the gateway attaches its server
// (one shared instance — messaging-events.module.ts).
// EmailModule: the new-message emails (MessageNoticesService, roadmap Phase
// 6.5) — exported so main.ts can start its timer.
@Module({
  imports: [UsersModule, StorageModule, MessagingEventsModule, EmailModule],
  controllers: [MessagingController],
  providers: [MessagingService, MessagingGateway, MessageNoticesService],
  exports: [MessagingService, MessageNoticesService],
})
export class MessagingModule {}
