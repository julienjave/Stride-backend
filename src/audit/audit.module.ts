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

import { Global, Module } from '@nestjs/common'
import { AuditService } from './audit.service'
import { AuditController } from './audit.controller'

// --- MODULE ------------------------------------------------------------------------------------------------

// @Global() — the same reasoning as DrizzleModule: audit logging is a
// genuinely cross-cutting concern needed by multiple otherwise-unrelated
// modules (every service that changes data writes its own entries), imported
// once here rather than every consuming module repeating
// the import.
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
