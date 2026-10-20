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

// --- MODULE ------------------------------------------------------------------------------------------------

// StorageModule: the conversation list signs the other person's photo URL.
// MessagingEventsModule: the service emits, the gateway attaches its server
// (one shared instance — messaging-events.module.ts).
@Module({
  imports: [UsersModule, StorageModule, MessagingEventsModule],
  controllers: [MessagingController],
  providers: [MessagingService, MessagingGateway],
  exports: [MessagingService],
})
export class MessagingModule {}
