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
  Header,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common'
import { ApiProduces, ApiTags } from '@nestjs/swagger'
import { seconds, Throttle } from '@nestjs/throttler'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { DEFAULT_TIME_ZONE } from '../records-export/dto/export-records-query.dto'
import { pdfFile } from '../records-export/pdf-file'
import { LegalDisclosuresService } from './legal-disclosures.service'
import { MakeLegalDisclosureDto } from './dto/make-legal-disclosure.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// A patient's legal disclosures, under /users/:id/legal-disclosures — a
// sub-resource of the account, like the complaint reviews (decisions §25,
// pass 3). ADMINS only: answering an order is the clinic's business, not a
// clinician's — and the copy is made without any admin access to clinical
// tables (the service reads it as the patient).
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Legal disclosures')
@Controller('users')
export class LegalDisclosuresController {
  constructor(private readonly disclosuresService: LegalDisclosuresService) {}

  // Every disclosure of this patient's record, newest first, the order's
  // details included.
  @Get(':id/legal-disclosures')
  list(
    @Param('id', ParseIntPipe) patientId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.disclosuresService.list(patientId, currentUser)
  }

  // Records a disclosure and answers its ONE copy, as a file (201 — a
  // disclosure is created every time). Audited by the service
  // (LEGAL_DISCLOSURE_MADE and the copy's RECORDS_EXPORTED, in the same
  // transaction). The export's rules for a file: `no-store` (no browser or
  // proxy keeps a health record), 5 a minute (each request reads the record
  // and draws a PDF). The file's name carries the disclosure's number — the
  // screen reads it (CORS exposes Content-Disposition, cors-options.ts).
  @AuditedByService()
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Header('Cache-Control', 'no-store')
  @ApiProduces('application/pdf')
  @Post(':id/legal-disclosures')
  async make(
    @Param('id', ParseIntPipe) patientId: number,
    @Body() dto: MakeLegalDisclosureDto,
    @CurrentUser() currentUser: CurrentUser,
  ): Promise<StreamableFile> {
    return pdfFile(
      await this.disclosuresService.make(
        patientId,
        dto,
        dto.timeZone ?? DEFAULT_TIME_ZONE,
        currentUser,
      ),
    )
  }
}
