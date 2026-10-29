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
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { LegalDisclosuresService } from './legal-disclosures.service'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The patient's ACCOUNTING OF DISCLOSURES (HIPAA 164.528; decisions §25,
// pass 3): the times their record was given to someone outside the clinic
// because the law required it — My records' "Your record was shared".
// Patients only, acting AS a patient, and only their own: the route takes no
// id (the signed-in patient is the one asked about), as GET /records-export.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PATIENT)
@ApiTags('Legal disclosures')
@Controller('legal-disclosures')
export class OwnLegalDisclosuresController {
  constructor(private readonly disclosuresService: LegalDisclosuresService) {}

  // A read of the patient's own list — not logged (a patient reading what
  // the clinic did with their record is no one else's access to it).
  @Get()
  listOwn(@CurrentUser() user: CurrentUser) {
    return this.disclosuresService.listOwn(user.id)
  }
}
