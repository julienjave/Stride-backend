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
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ExercisesService } from './exercises.service';
import { CreateExerciseDto } from './dto/create-exercise.dto';
import { UpdateExerciseDto } from './dto/update-exercise.dto';
import { SessionAuthGuard } from '../common/guards/session-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';


// --- CONTROLLER ---------------------------------------------------------------------------------------------

@UseGuards(SessionAuthGuard)
@Controller('exercises')
export class ExercisesController {
  constructor(private readonly exercisesService: ExercisesService) {}

  // === ROUTES ===========================================================

  // --- POST ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner')
  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateExerciseDto) {
    return this.exercisesService.create(user.id, dto)
  }


  // --- GET ROUTES ---

  @Get()
  findAll(@Query('search') search?: string) {
    return this.exercisesService.findAll(search)
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.exercisesService.findOne(id)
  }


  // --- PATCH ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() dto: UpdateExerciseDto,
  ) {
    return this.exercisesService.update(id, user, dto)
  }


  // --- DELETE ROUTES ---

  @UseGuards(RolesGuard)
  @Roles('practitioner', 'admin')
  @Delete(':id')
  archive(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.exercisesService.archive(id, user)
  }
}
