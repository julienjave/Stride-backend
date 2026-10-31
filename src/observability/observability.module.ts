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

import { Module } from '@nestjs/common'
import { MonitoringController } from './monitoring.controller'

// Error reporting's one route, POST /monitoring (the browser's tunnel). The
// rest of observability is plain functions: the logger's settings
// (logger-options.ts), the SDK's start (instrument.ts, imported by main.ts)
// and reportError (error-reporting.ts).
@Module({
  controllers: [MonitoringController],
})
export class ObservabilityModule {}
