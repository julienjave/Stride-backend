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
import { CareTeamService } from './care-team.service'
import { CareTeamController } from './care-team.controller'
import { DirectoryController } from './directory.controller'
import { StorageModule } from '../storage/storage.module'

// --- MODULE ------------------------------------------------------------------------------------------------

// Depends on nothing but the database (global), the audit log (global) and
// storage (for avatar URLs) — deliberately NOT on UsersModule. UsersModule
// and ClinicsModule both import THIS module (UsersService delegates its
// "manages this patient?" check here; ClinicsService ends links when a
// membership is removed), so importing them back would create a circular
// dependency between modules.
@Module({
  imports: [StorageModule],
  controllers: [CareTeamController, DirectoryController],
  providers: [CareTeamService],
  exports: [CareTeamService],
})
export class CareTeamModule {}
