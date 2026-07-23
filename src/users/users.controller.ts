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
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { UsersService } from './users.service'
import { CreateUserDto, UserRole } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'


// --- CONTROLLER --------------------------------------------------------------------------------------------

@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @UseGuards(RolesGuard)
    @Roles('practitioner', 'admin')
    @Post()
    create(@CurrentUser() currentUser: any, @Body() dto: CreateUserDto) {
        return this.usersService.create(dto, currentUser)
    }

    // Admin: every account. Practitioner: their own patients (clinic-scoped).
    // Patient: no blanket listing at all.
    @UseGuards(RolesGuard)
    @Roles('practitioner', 'admin')
    @Get()
    findAll(@CurrentUser() currentUser: any) {
        if (currentUser.role === UserRole.ADMIN) {
        return this.usersService.findAll()
        }
        return this.usersService.findPatientsForPractitioner(currentUser.id)
    }
    
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() currentUser: any) {
        const isSelf = currentUser.id === id
        const isElevated = currentUser.role === UserRole.PRACTITIONER || currentUser.role === UserRole.ADMIN
        if (!isSelf && !isElevated) {
        throw new ForbiddenException('You can only view your own profile')
        }
        return this.usersService.findOne(id)
    }
    
    // Self, admin, or a practitioner acting on one of their own (clinic-shared)
    // patients — isPatientManagedBy is the same check used by remove() below,
    // kept in the service so both routes stay consistent with one definition.
    @Patch(':id')
    async update(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() currentUser: any,
        @Body() dto: UpdateUserDto,
    ) {
        const isSelf = currentUser.id === id
        const isAdmin = currentUser.role === UserRole.ADMIN
        const isManagingPractitioner =
        currentUser.role === UserRole.PRACTITIONER &&
        (await this.usersService.isPatientManagedBy(id, currentUser.id))
    
        if (!isSelf && !isAdmin && !isManagingPractitioner) {
        throw new ForbiddenException('You do not have permission to update this profile')
        }
        return this.usersService.update(id, dto)
    }
    
    // Self (any role deactivating their own account), a practitioner
    // deactivating one of their own patients, or an admin acting on anyone.
    @Delete(':id')
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() currentUser: any) {
        const isSelf = currentUser.id === id
        const isAdmin = currentUser.role === UserRole.ADMIN
        const isManagingPractitioner =
        currentUser.role === UserRole.PRACTITIONER &&
        (await this.usersService.isPatientManagedBy(id, currentUser.id))
    
        if (!isSelf && !isAdmin && !isManagingPractitioner) {
        throw new ForbiddenException('You do not have permission to deactivate this account')
        }
        return this.usersService.softDelete(id)
    }
}