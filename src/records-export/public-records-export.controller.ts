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
  Header,
  HttpCode,
  HttpStatus,
  Post,
  StreamableFile,
} from '@nestjs/common'
import { ApiProduces, ApiTags } from '@nestjs/swagger'
import { seconds, Throttle } from '@nestjs/throttler'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { RecordsExportLinksService } from './records-export-links.service'
import { DEFAULT_TIME_ZONE } from './dto/export-records-query.dto'
import { DownloadRecordsDto } from './dto/download-records.dto'
import { pdfFile } from './pdf-file'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// The emailed link's page (decisions §20, pass 2). PUBLIC — no
// SessionAuthGuard: the person may be unable to sign in (that's why the
// clinic emailed them). The token and the date of birth are the
// credentials, checked by RecordsExportLinksService and, in the database,
// by the records_export_links policies and guard (migration 0062).
//
// Its own class, not a route on RecordsExportController: that one's guards
// (signed in, a patient) are set on the whole class.
@ApiTags('Records export')
@Controller('records-export')
export class PublicRecordsExportController {
  constructor(private readonly linksService: RecordsExportLinksService) {}

  // A POST, though it hands back a file: it CHANGES things (spends the
  // link, or counts a wrong date of birth), and its secrets travel in the
  // body. 200, not 201: nothing is created for the caller.
  //
  // 5 a minute, like the signed-in download and the password routes: the
  // link's own limit (5 wrong dates, ever) is the real defence against
  // guessing; this one keeps a script from drawing PDFs in a loop.
  // Audited by the service: RECORDS_EXPORTED for a copy,
  // RECORDS_EXPORT_LINK_REFUSED for a wrong date of birth.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @AuditedByService()
  @Header('Cache-Control', 'no-store')
  @ApiProduces('application/pdf')
  @Post('download')
  @HttpCode(HttpStatus.OK)
  async download(@Body() dto: DownloadRecordsDto): Promise<StreamableFile> {
    return pdfFile(
      await this.linksService.download(
        dto.token,
        dto.dateOfBirth,
        dto.timeZone ?? DEFAULT_TIME_ZONE,
      ),
    )
  }
}
