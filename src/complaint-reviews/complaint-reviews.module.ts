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
import { ComplaintReviewsController } from './complaint-reviews.controller'
import { ComplaintReviewsService } from './complaint-reviews.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// The complaint review (decisions §25, pass 2): the admin's side. Its copies
// come from the records export's generator (RecordsExportModule exports
// it); DRIZZLE and AuditService are global. The care team's notice is the
// alerts module's (ComplaintReviewNoticesService) — the "For review" list
// is theirs.
@Module({
  imports: [RecordsExportModule],
  controllers: [ComplaintReviewsController],
  providers: [ComplaintReviewsService],
})
export class ComplaintReviewsModule {}
