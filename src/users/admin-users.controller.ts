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
import { UsersService } from './users.service'
import { ListUsersQueryDto } from './dto/list-users-query.dto'
import { UserRole } from './dto/create-user.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The Users page's list (Phase 6.5, decided with the person 2026-10-29):
// search, role, clinic, account status and the admin home's "needs
// attention" groups, 25 accounts a page.
//
// Its own route rather than a paged GET /users: that route keeps answering
// the WHOLE list to the screens that pick from every account (the audit
// log's person filters, the merge page, the merged-account notice) and to a
// practitioner as "my patients" — changing its shape would have broken them.
//
// Admins only (the guards: 401 without a session, 403 for any other active
// role — a practitioner + admin account must have switched). A read of
// account data, not clinical data, so no audit entry (the audit review's
// rule, decisions §10); audit-tags.spec.ts only requires tags on writes.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list(@CurrentUser() user: CurrentUser, @Query() query: ListUsersQueryDto) {
    return this.usersService.findPage(query, user)
  }
}
