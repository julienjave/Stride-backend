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
import { AlertsController } from './alerts.controller'
import { AlertsService } from './alerts.service'
import { ComplaintReviewNoticesService } from './complaint-review-notices.service'
import { LegalDisclosureNoticesService } from './legal-disclosure-notices.service'
import { PatientMergeNoticesService } from './patient-merge-notices.service'
import { CareTeamModule } from '../care-team/care-team.module'
import { StorageModule } from '../storage/storage.module'

// --- MODULE ------------------------------------------------------------------------------------------------

// Depends on the care team (whose patients are "mine") and storage (the
// patients' photos); the database and the audit log are global. The
// schedule module and the summary's reads are plain functions, imported
// directly — no Nest provider to share.
@Module({
  imports: [CareTeamModule, StorageModule],
  controllers: [AlertsController],
  providers: [
    AlertsService,
    ComplaintReviewNoticesService,
    LegalDisclosureNoticesService,
    PatientMergeNoticesService,
  ],
})
export class AlertsModule {}
