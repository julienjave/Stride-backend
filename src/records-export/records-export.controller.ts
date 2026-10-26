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
  Header,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common'
import { ApiProduces, ApiTags } from '@nestjs/swagger'
import { seconds, Throttle } from '@nestjs/throttler'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import { RecordsExportService } from './records-export.service'
import {
  DEFAULT_TIME_ZONE,
  ExportRecordsQueryDto,
} from './dto/export-records-query.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The records export (decisions §20). Pass 1: a patient downloads their own
// record. Patients only — acting AS a patient: a practitioner reads the file
// in the app, and an admin never sees its content (decisions §16).
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.PATIENT)
@ApiTags('Records export')
@Controller('records-export')
export class RecordsExportController {
  constructor(private readonly recordsExportService: RecordsExportService) {}

  // A READ, so a GET — and no @AuditedByService tag (that marks writes):
  // the service writes RECORDS_EXPORTED itself, in the read's transaction,
  // as the medical files' reads do.
  //
  // The answer is a FILE, not JSON:
  //   - StreamableFile: Nest sends the bytes as they are, with the type and
  //     the disposition given here, instead of serialising a value;
  //   - `attachment; filename=…`: the browser saves it under that name
  //     rather than trying to show it in the tab;
  //   - `Cache-Control: no-store`: no browser or proxy keeps a copy of a
  //     health record on disk after the download.
  //
  // 5 a minute, like the password routes: each request reads the whole
  // record and draws a PDF — far heavier than an ordinary read, and a
  // patient needs one copy, not sixty.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Header('Cache-Control', 'no-store')
  @ApiProduces('application/pdf')
  @Get()
  async exportOwnRecord(
    @CurrentUser() user: CurrentUser,
    @Query() query: ExportRecordsQueryDto,
  ): Promise<StreamableFile> {
    const { pdf, fileName } = await this.recordsExportService.exportOwnRecord(
      user.id,
      query.timeZone ?? DEFAULT_TIME_ZONE,
    )
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${fileName}"`,
      length: pdf.length,
    })
  }
}
