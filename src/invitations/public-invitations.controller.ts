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

import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle, seconds } from '@nestjs/throttler'
import { InvitationsService } from './invitations.service'
import { InvitationTokenDto } from './dto/invitation-token.dto'
import { AcceptInvitationDto } from './dto/accept-invitation.dto'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { NotAudited } from '../common/decorators/not-audited.decorator'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The accept page's two calls. PUBLIC — no SessionAuthGuard — because
// their caller has no account to sign in with yet: the token from the
// email is their only credential, checked by InvitationsService and, in the
// database, by the invitations policies' token branch (migration 0021).
//
// Both are POSTs with the token in the body, even the lookup, which only
// reads: a token in the URL would be written into the request logs (see
// InvitationTokenDto).
@ApiTags('Invitations')
@Controller('invitations')
export class PublicInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  // The page loads this once, so a modest limit; 200, not the default 201
  // for a POST — nothing is created.
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @NotAudited(
    'Only reads an invitation, to show the accept page; nothing changes',
  )
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  lookup(@Body() dto: InvitationTokenDto) {
    return this.invitationsService.lookup(dto.token)
  }

  // Same limit as reset-password: every call runs bcrypt (deliberately
  // slow), so the limit protects the server's CPU as much as anything. 204,
  // like reset-password: the next step is the sign-in page, and there's
  // nothing to return. Audited by the service (INVITATION_ACCEPTED, in the
  // accepting transaction).
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Post('accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  async accept(@Body() dto: AcceptInvitationDto) {
    await this.invitationsService.accept(dto.token, dto.password)
  }
}
