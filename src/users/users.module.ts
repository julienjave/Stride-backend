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
import { UsersController } from './users.controller'
import { UsersService } from './users.service'
import { StorageModule } from '../storage/storage.module'
import { CareTeamModule } from '../care-team/care-team.module'
import { InvitationsModule } from '../invitations/invitations.module'
import { MessagingEventsModule } from '../messaging/messaging-events.module'

// --- MODULE ------------------------------------------------------------------------------------------------

// InvitationsModule: create() sends each new account its first invitation.
// (InvitationsModule deliberately doesn't import UsersModule back.)
// MessagingEventsModule: deactivating an account closes its sockets
// (UsersController.remove). It imports nothing, so no cycle.
@Module({
  imports: [
    StorageModule,
    CareTeamModule,
    InvitationsModule,
    MessagingEventsModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
