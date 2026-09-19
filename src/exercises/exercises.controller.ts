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
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { FilesInterceptor } from "@nestjs/platform-express";
import { ExercisesService } from "./exercises.service";
import { CreateExerciseDto } from "./dto/create-exercise.dto";
import { UpdateExerciseDto } from "./dto/update-exercise.dto";
import { RemoveImageDto } from "./dto/remove-image.dto";
import { ReorderImagesDto } from "./dto/reorder-images.dto";
import { FindExercisesQueryDto } from "./dto/find-exercises-query.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { imageUploadOptions } from "../common/config/image-upload.config";
import { UserRole } from "../users/dto/create-user.dto";

// --- CONTROLLER ---------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@ApiTags("Exercises")
@Controller("exercises")
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  // === ROUTES ===========================================================

  // --- POST ROUTES ---

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER)
  @Post()
  create(@CurrentUser() user: CurrentUser, @Body() dto: CreateExerciseDto) {
    return this.exercisesService.create(user, dto);
  }

  // FilesInterceptor (plural) — the only real difference from the single-file
  // avatar/logo routes: up to 5 files under the field name "files" in one
  // request, delivered as an array via @UploadedFiles().
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Post(":id/images")
  @UseInterceptors(FilesInterceptor("files", 5, imageUploadOptions))
  uploadImages(
    @Param("id", ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: CurrentUser,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException("No files uploaded");
    }
    return this.exercisesService.addImages(id, user, files);
  }

  // --- GET ROUTES ---

  // A SINGLE @Query() binding to one combined DTO — not @Query('search')
  // plus a separate pagination DTO. ValidationPipe's whitelist option
  // validates the WHOLE query object handed to @Query(); splitting it
  // across two decorators would make the DTO see "search" as an
  // undeclared property and reject the request outright.
  @Get()
  findAll(
    @Query() query: FindExercisesQueryDto,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.exercisesService.findAll(query, currentUser.id);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.exercisesService.findOneForDisplay(id);
  }

  // --- PATCH ROUTES ---

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
    @Body() dto: UpdateExerciseDto,
  ) {
    return this.exercisesService.update(id, user, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Patch(":id/images")
  reorderImages(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ReorderImagesDto,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.exercisesService.reorderImages(id, user, dto.order);
  }

  // --- DELETE ROUTES ---

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Delete(":id")
  archive(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.exercisesService.archive(id, user);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Delete(":id/images")
  removeImage(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RemoveImageDto,
    @CurrentUser() user: CurrentUser,
  ) {
    return this.exercisesService.removeImage(id, user, dto.objectKey);
  }
}