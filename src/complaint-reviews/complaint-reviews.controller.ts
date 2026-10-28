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
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
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
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { UserRole } from '../users/dto/create-user.dto'
import {
  DEFAULT_TIME_ZONE,
  ExportRecordsQueryDto,
} from '../records-export/dto/export-records-query.dto'
import { pdfFile } from '../records-export/pdf-file'
import { ComplaintReviewsService } from './complaint-reviews.service'
import { OpenComplaintReviewDto } from './dto/open-complaint-review.dto'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// A patient's complaint reviews, under /users/:id/complaint-reviews — a
// sub-resource of the account, like the emailed links (decisions §25, pass
// 2). ADMINS only: handling a complaint is the clinic's operations; the care
// team already reads the record in the app.
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Complaint reviews')
@Controller('users')
export class ComplaintReviewsController {
  constructor(private readonly reviewsService: ComplaintReviewsService) {}

  // Every review of this patient's record, newest first.
  @Get(':id/complaint-reviews')
  list(
    @Param('id', ParseIntPipe) patientId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.reviewsService.list(patientId, currentUser)
  }

  // Opens a review (201: one is created every time). Audited by the service
  // (COMPLAINT_REVIEW_OPENED, in the same transaction).
  @AuditedByService()
  @Post(':id/complaint-reviews')
  open(
    @Param('id', ParseIntPipe) patientId: number,
    @Body() dto: OpenComplaintReviewDto,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.reviewsService.open(patientId, dto, currentUser)
  }

  // Ends one early. 200, not Nest's default 201 for a POST: nothing is
  // created — an existing review changes.
  @AuditedByService()
  @HttpCode(HttpStatus.OK)
  @Post(':id/complaint-reviews/:reviewId/end')
  end(
    @Param('id', ParseIntPipe) patientId: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.reviewsService.end(patientId, reviewId, currentUser)
  }

  // A review copy, as a file — the patient's own download's rules: a GET (a
  // read; RECORDS_EXPORTED is written by the service, in the read's
  // transaction), `no-store` (no browser or proxy keeps a health record),
  // and 5 a minute (each request reads the whole record and draws a PDF).
  // `timeZone`: the admin's browser's, for the document's moments.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Header('Cache-Control', 'no-store')
  @ApiProduces('application/pdf')
  @Get(':id/complaint-reviews/:reviewId/copy')
  async copy(
    @Param('id', ParseIntPipe) patientId: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @Query() query: ExportRecordsQueryDto,
    @CurrentUser() currentUser: CurrentUser,
  ): Promise<StreamableFile> {
    return pdfFile(
      await this.reviewsService.copy(
        patientId,
        reviewId,
        query.timeZone ?? DEFAULT_TIME_ZONE,
        currentUser,
      ),
    )
  }
}
