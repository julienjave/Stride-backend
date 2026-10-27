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
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { RecordsExportLinksService } from './records-export-links.service'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// A patient's emailed records links, under /users/:id/records-export-links
// — a sub-resource of the account, like /users/:id/invitations (decisions
// §20, pass 2). ADMINS only: sending a health record out is the clinic's
// act, and a practitioner already reads the record in the app.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Records export')
@Controller('users')
export class RecordsExportLinksController {
  constructor(private readonly linksService: RecordsExportLinksService) {}

  // Every link sent to this patient, newest first: whether the last one went
  // out, was used, or ran out of tries.
  @Get(':id/records-export-links')
  list(
    @Param('id', ParseIntPipe) patientId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.linksService.list(patientId, currentUser)
  }

  // Emails a new link (replacing the open one, if any). 201: a link is
  // created every time. Audited by the service (RECORDS_EXPORT_LINK_SENT,
  // in the sending transaction).
  @AuditedByService()
  @Post(':id/records-export-links')
  send(
    @Param('id', ParseIntPipe) patientId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.linksService.send(patientId, currentUser)
  }
}
