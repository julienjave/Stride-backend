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
import { AdminMetricsController } from './admin-metrics.controller'
import { AdminMetricsService } from './admin-metrics.service'

// --- MODULE ------------------------------------------------------------------------------------------------

// No imports: the service needs only the database (DrizzleModule is
// global) and a plain SQL function from the care-team module
// (clinicalAccess) — a function, not a provider, so CareTeamModule doesn't
// have to be imported for it.
@Module({
  controllers: [AdminMetricsController],
  providers: [AdminMetricsService],
})
export class AdminMetricsModule {}
