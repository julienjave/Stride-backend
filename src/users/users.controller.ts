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
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { FileInterceptor } from '@nestjs/platform-express'
import { UsersService } from './users.service'
import { MessagingEvents } from '../messaging/messaging-events'
import { CreateUserDto, UserRole } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { GrantRoleDto } from './dto/grant-role.dto'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { AuditedByService } from '../common/decorators/audited-by-service.decorator'
import { imageUploadOptions } from '../common/config/image-upload.config'
import { DemoLocked } from '../demo/demo-lock.guard'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Every write here is @AuditedByService() (the audit review, Phase 6): its
// service method writes ONE complete entry — USER_CREATED, _ROLE_GRANTED,
// _UPDATED, _AVATAR_CHANGED / _REMOVED, _DEACTIVATED, _REACTIVATED — in the
// change's own transaction.
@UseGuards(SessionAuthGuard)
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    // Deactivating an account closes its messaging sockets (remove, below).
    private readonly messagingEvents: MessagingEvents,
  ) {}

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @AuditedByService()
  @Post()
  create(@CurrentUser() currentUser: CurrentUser, @Body() dto: CreateUserDto) {
    return this.usersService.create(dto, currentUser)
  }

  // Admin-only: grants an existing user an ADDITIONAL role
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/roles')
  grantRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GrantRoleDto,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.usersService.grantRole(id, dto, currentUser)
  }

  // @UseInterceptors(FileInterceptor('file', ...)) parses a multipart/form-data
  // body, extracts the single part named "file", validates/buffers it per
  // imageUploadOptions, and makes the result available via @UploadedFile()
  // below — the file-upload equivalent of @Body() + a DTO for JSON routes.
  @AuditedByService()
  @Post(':id/avatar')
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  uploadAvatar(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    const isSelf = currentUser.id === id
    const isAdmin = currentUser.activeRole === UserRole.ADMIN
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException('You can only update your own avatar')
    }
    if (!file) {
      throw new BadRequestException('No file uploaded')
    }
    return this.usersService.updateAvatar(id, file, currentUser)
  }

  // --- GET ROUTES ---

  // Admin: every account. Practitioner: their own patients (their care
  // teams). Both: active accounts only, unless ?includeInactive=true.
  // Patient: no blanket listing at all.
  @UseGuards(RolesGuard)
  @Roles(UserRole.PRACTITIONER, UserRole.ADMIN)
  @Get()
  findAll(
    @CurrentUser() currentUser: CurrentUser,
    @Query('includeInactive') includeInactive?: string,
  ) {
    // (The admin home's "needs attention" groups moved to GET /admin/users
    // with the Users page's other filters — admin-users.controller.ts. This
    // route stays the WHOLE list: the audit log's person filters, the merge
    // page's picker and the merged-account notice read every account.)
    if (currentUser.activeRole === UserRole.ADMIN) {
      // Raw string comparison, deliberately — NOT class-transformer's
      // @Type(() => Boolean), which has a real gotcha here: Boolean(
      // 'false') is true in JavaScript (any non-empty string is truthy),
      // so that decorator would silently treat ?includeInactive=false the
      // same as ?includeInactive=true. Comparing the raw string against
      // the one value that should enable it sidesteps that entirely.
      return this.usersService.findAll(includeInactive === 'true')
    }
    // A practitioner's ?includeInactive=true (decisions §22) adds their
    // DEACTIVATED patients — still only patients whose care team they're
    // on: the flag widens the account filter, never whose patients.
    return this.usersService.findPatientsForPractitioner(
      currentUser.id,
      includeInactive === 'true',
    )
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    const isSelf = currentUser.id === id
    const isAdmin = currentUser.activeRole === UserRole.ADMIN
    const isManagingPractitioner =
      currentUser.activeRole === UserRole.PRACTITIONER &&
      (await this.usersService.isPatientManagedBy(id, currentUser.id))
    if (!isSelf && !isAdmin && !isManagingPractitioner) {
      throw new ForbiddenException('You can only view your own profile')
    }
    return this.usersService.findOne(id)
  }

  // --- PATCH ROUTES ---

  @AuditedByService()
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: CurrentUser,
    @Body() dto: UpdateUserDto,
  ) {
    const isSelf = currentUser.id === id
    const isAdmin = currentUser.activeRole === UserRole.ADMIN
    const isManagingPractitioner =
      currentUser.activeRole === UserRole.PRACTITIONER &&
      (await this.usersService.isPatientManagedBy(id, currentUser.id))

    if (!isSelf && !isAdmin && !isManagingPractitioner) {
      throw new ForbiddenException(
        'You do not have permission to update this profile',
      )
    }
    return this.usersService.update(id, dto, currentUser)
  }

  // Removes the user's avatar (back to initials). Same rule as
  // uploadAvatar above — the user themselves or an admin, nobody else —
  // so whoever can set a photo can also take it down, and a managing
  // practitioner can do neither.
  //
  // Declared as its own path (/users/:id/avatar) rather than a flag on
  // DELETE /users/:id, which already means "deactivate this account" —
  // two very different actions should never share a route. Express matches
  // the full path, so DELETE /users/5 and DELETE /users/5/avatar can't be
  // confused for each other.
  @AuditedByService()
  @Delete(':id/avatar')
  removeAvatar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    const isSelf = currentUser.id === id
    const isAdmin = currentUser.activeRole === UserRole.ADMIN
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException('You can only remove your own avatar')
    }
    return this.usersService.removeAvatar(id, currentUser)
  }

  // Self (any role deactivating their own account), a practitioner
  // deactivating one of their own patients, or an admin acting on anyone.
  @AuditedByService()
  // The demo's shared accounts are refused (decisions §46).
  @DemoLocked('deactivate', 'param')
  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    const isSelf = currentUser.id === id
    const isAdmin = currentUser.activeRole === UserRole.ADMIN
    const isManagingPractitioner =
      currentUser.activeRole === UserRole.PRACTITIONER &&
      (await this.usersService.isPatientManagedBy(id, currentUser.id))

    if (!isSelf && !isAdmin && !isManagingPractitioner) {
      throw new ForbiddenException(
        'You do not have permission to deactivate this account',
      )
    }
    const { user, endedSessionIds } = await this.usersService.softDelete(
      id,
      currentUser,
    )
    // The deactivation ended the account's sessions; their sockets too, or a
    // deactivated person's open tab would keep receiving messages (a socket
    // is checked once, at its handshake) — as logout does for one session.
    for (const sessionId of endedSessionIds) {
      this.messagingEvents.disconnectSession(sessionId)
    }
    return user
  }

  // Admin-only, deliberately — no self-service or managing-practitioner
  // path, unlike deactivate above. See UsersService.reactivate()'s own
  // comment for why: restoring access to a potentially PHI-adjacent
  // account is treated more conservatively than removing it.
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @AuditedByService()
  @Post(':id/reactivate')
  reactivate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() currentUser: CurrentUser,
  ) {
    return this.usersService.reactivate(id, currentUser)
  }
}
