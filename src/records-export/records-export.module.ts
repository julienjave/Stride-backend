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
import { RecordsExportController } from './records-export.controller'
import { RecordsExportService } from './records-export.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// The records export (decisions §20). DRIZZLE and AuditService come from
// global modules, like the medical files'; the medical file's query is a
// plain function (loadMedicalFileEntries), so no module import is needed
// for it.
@Module({
  controllers: [RecordsExportController],
  providers: [RecordsExportService],
})
export class RecordsExportModule {}
