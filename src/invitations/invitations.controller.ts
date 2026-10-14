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
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { InvitationsService } from './invitations.service'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// An account's invitations, under /users/:id/invitations — a sub-resource
// of a user, like /users/:id/care-team, with its own controller so the
// whole feature lives in src/invitations/.
//
// Only admins and practitioners ever manage invitations, so RolesGuard
// turns everyone else away at the door; the finer rule ("an admin, or this
// patient's care team") needs data and lives in InvitationsService.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
@ApiTags('Invitations')
@Controller('users')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  // Every invitation sent to this account, newest first. A list rather
  // than "the current one": no special "none" response, and the history
  // (sent by whom, replaced when) comes for free.
  @Get(':id/invitations')
  list(
    @Param('id', ParseIntPipe) userId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.invitationsService.listForUser(userId, currentUser)
  }

  // Sends an invitation: the first one, or a new one replacing the open
  // one ("resend") — the same act from the caller's point of view. 201:
  // a new invitation is created every time.
  @Post(':id/invitations')
  send(
    @Param('id', ParseIntPipe) userId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.invitationsService.send(userId, currentUser)
  }

  // A POST to ".../revoke", not a DELETE: nothing is deleted — the
  // invitation is closed and stays in the history (same reasoning as
  // POST /users/:id/care-team/:practitionerId/end). 200: it returns the
  // revoked invitation, and creates nothing.
  @Post(':id/invitations/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('id', ParseIntPipe) userId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.invitationsService.revoke(userId, currentUser)
  }
}
