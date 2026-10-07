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
import { InvitationsService } from './invitations.service'
import { InvitationsController } from './invitations.controller'
import { PublicInvitationsController } from './public-invitations.controller'
import { CareTeamModule } from '../care-team/care-team.module'
import { EmailModule } from '../email/email.module'

// --- MODULE ------------------------------------------------------------------------------------------------

// Depends on the database and the audit log (both global), email, and the
// care team (for "is this practitioner on the patient's care team?") —
// deliberately NOT on UsersModule: the next step makes UsersService create
// an account's first invitation, so UsersModule will import THIS module,
// and importing it back would be a circular dependency.
@Module({
  imports: [CareTeamModule, EmailModule],
  controllers: [InvitationsController, PublicInvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}