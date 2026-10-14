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
import { CareTeamService } from './care-team.service'
import { DirectoryQueryDto } from './dto/directory-query.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The clinic directory: DIRECTORY-level access (design decisions §3) — a
// practitioner finds any patient of their clinics, to identify them and join
// their care team. Practitioners only: admins already list everyone at
// GET /users, and patients have no business browsing other patients.
//
// At /directory/patients rather than /users/directory: UsersController
// already has GET /users/:id, and a fixed segment ("directory") next to a
// parameter (":id") only works if the routes are declared in the right
// order — a fragile arrangement, and here a request for /users/directory
// would reach ParseIntPipe and fail as "id must be a number".
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PRACTITIONER)
@ApiTags('Care team')
@Controller('directory')
export class DirectoryController {
  constructor(private readonly careTeamService: CareTeamService) {}

  @Get('patients')
  searchPatients(
    @CurrentUser() currentUser: CurrentUser,
    @Query() query: DirectoryQueryDto,
  ) {
    return this.careTeamService.searchDirectory(currentUser.id, query.search)
  }
}
