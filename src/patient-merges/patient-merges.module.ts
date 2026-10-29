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

import { Module } from '@nestjs/common'
import { EmailModule } from '../email/email.module'
import { MessagingEventsModule } from '../messaging/messaging-events.module'
import { MfaModule } from '../mfa/mfa.module'
import {
  PatientMergesController,
  PatientMergesListController,
} from './patient-merges.controller'
import { PatientMergesService } from './patient-merges.service'

// Merging duplicate patient accounts (decisions §27). StepUpService comes
// from MfaModule (the admin's password and code); AuditService and the
// database are global.
@Module({
  imports: [EmailModule, MessagingEventsModule, MfaModule],
  controllers: [PatientMergesController, PatientMergesListController],
  providers: [PatientMergesService],
})
export class PatientMergesModule {}
