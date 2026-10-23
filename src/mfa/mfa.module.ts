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
import { MfaController } from './mfa.controller'
import { MfaAdminController } from './mfa-admin.controller'
import { MfaService } from './mfa.service'
import { StepUpService } from './step-up.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// Two-factor sign-in (MFA enrolment, Phase 6). The database and the audit log
// are global; the rest is imported: email (the notices), messaging events
// (closing the sockets of the sessions "enable" and a reset end). EXPORTED:
// MfaService — AuthController's sign-in step (mfa/verify) asks it whether a
// code is good — and StepUpService, the step-up the email and password
// changes ask.
@Module({
  imports: [EmailModule, MessagingEventsModule],
  controllers: [MfaController, MfaAdminController],
  providers: [MfaService, StepUpService],
  exports: [MfaService, StepUpService],
})
export class MfaModule {}
