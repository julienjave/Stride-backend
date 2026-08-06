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
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from '../decorators/roles.decorator'

// --- GUARD -------------------------------------------------------------------------------------------------

// AUTHORIZATION check: given an already-authenticated user (SessionAuthGuard
// runs first), are they allowed to do THIS specific thing?
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Reads whatever @Roles(...) declared on the specific route handler, or —
    // if absent there — on the whole controller. getAllAndOverride checks
    // both, with the handler's own metadata taking precedence.
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )

    // No @Roles() at all on this route = open to any authenticated user.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true
    }

    const { user } = context.switchToHttp().getRequest()
    if (!requiredRoles.includes(user.activeRole)) {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      )
    }
    return true
  }
}
