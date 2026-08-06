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

import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { AuditService } from './audit.service'
import { FindAuditLogsQueryDto } from './dto/find-audit-logs-query.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Admin-only, full stop — this is the App tracking system oversight
// capability, not something practitioners or
// patients have any access to.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('admin')
@ApiTags('Audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  // === ROUTES =============================================================

  // --- GET ROUTES ---

  @Get()
  findAll(@Query() query: FindAuditLogsQueryDto) {
    return this.auditService.findAll(query)
  }
}
