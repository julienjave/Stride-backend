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
import { RecordsExportModule } from '../records-export/records-export.module'
import { LegalDisclosuresController } from './legal-disclosures.controller'
import { OwnLegalDisclosuresController } from './own-legal-disclosures.controller'
import { LegalDisclosuresService } from './legal-disclosures.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// The legal disclosure (decisions §25, pass 3): the admin's side
// (LegalDisclosuresController) and the patient's accounting
// (OwnLegalDisclosuresController). Its copy comes from the records export's
// generator (RecordsExportModule exports it); DRIZZLE and AuditService are
// global. The care team's notice is the alerts module's
// (LegalDisclosureNoticesService) — the "For review" list is theirs.
@Module({
  imports: [RecordsExportModule],
  controllers: [LegalDisclosuresController, OwnLegalDisclosuresController],
  providers: [LegalDisclosuresService],
})
export class LegalDisclosuresModule {}
