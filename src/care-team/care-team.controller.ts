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

import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { CareTeamService } from './care-team.service'
import { AddCareTeamMemberDto } from './dto/add-care-team-member.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// A patient's care team, under /users/:id/care-team — the same "sub-resource
// of a user" shape as /users/:id/avatar. It has its own controller (NestJS
// allows several controllers to share a path prefix) so the whole feature
// lives in src/care-team/.
//
// The controller only reads the request; every permission rule is in
// CareTeamService, because each one depends on data (shared clinics, the
// link itself) that a route decorator can't see. RolesGuard only filters
// out roles that can never act here.
@UseGuards(SessionAuthGuard)
@ApiTags('Care team')
@Controller('users')
export class CareTeamController {
  constructor(private readonly careTeamService: CareTeamService) {}

  // Admin, the patient themselves, or a practitioner sharing a clinic with
  // them. ?includeEnded=true adds the ended links (the history).
  @Get(':id/care-team')
  list(
    @Param('id', ParseIntPipe) patientId: number,
    @CurrentUser() currentUser: CurrentUser,
    @Query('includeEnded') includeEnded?: string,
  ) {
    // Raw string comparison, deliberately — see UsersController.findAll
    // for why (Boolean('false') is true in JavaScript).
    return this.careTeamService.listForPatient(
      patientId,
      currentUser,
      includeEnded === 'true',
    )
  }

  // "Join care team" (empty body) or "add a colleague" (practitionerId).
  // Who could be added to this patient's care team ("Add a colleague" /
  // the admin's "Add someone"). No clash with GET `:id/care-team` above:
  // routes are matched on the WHOLE path, and this one has a segment more.
  @Get(':id/care-team/candidates')
  candidates(
    @Param('id', ParseIntPipe) patientId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.careTeamService.listCandidates(patientId, currentUser)
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Post(':id/care-team')
  add(
    @Param('id', ParseIntPipe) patientId: number,
    @Body() dto: AddCareTeamMemberDto,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.careTeamService.addMember(patientId, dto, currentUser)
  }

  // Ends a membership. A POST to ".../end", not a DELETE: nothing is
  // deleted — the link gets an end date and stays in the history.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Post(':id/care-team/:practitionerId/end')
  end(
    @Param('id', ParseIntPipe) patientId: number,
    @Param('practitionerId', ParseIntPipe) practitionerId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.careTeamService.endMembership(
      patientId,
      practitionerId,
      currentUser,
    )
  }
}
