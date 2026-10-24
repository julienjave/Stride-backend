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

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { AdminMetricsService } from './admin-metrics.service'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The admin home's numbers (decisions §17). Admins only, like the audit
// log: the guards answer 401 without a session and 403 for any other active
// role — a practitioner+admin account must have switched to admin.
//
// A read, so no audit entry: it shows counts and the names of accounts an
// admin already reads on the users list, nothing clinical (the audit
// review's rule records others' CLINICAL reads — decisions §10, step 2).
// audit-tags.spec.ts only requires a tag on write routes.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin')
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(private readonly adminMetricsService: AdminMetricsService) {}

  @Get()
  get(@CurrentUser() user: CurrentUser) {
    return this.adminMetricsService.getMetrics(user)
  }
}
