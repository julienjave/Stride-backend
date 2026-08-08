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
import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { UserRole } from '../../users/dto/create-user.dto'

// --- TYPES ---------------------------------------------------------------------------------------------------
// The exact shape Passport attaches to req.user on every authenticated
// request (HTTP) or socket.data.user (WebSocket) — traced from
// SessionSerializer.deserializeUser(), which reloads the user fresh via
// UsersService.findOne() on every request and merges in the session's
// activeRole. Matches UsersService.findOne()'s return shape (every users
// column except passwordHash, which toPublic() strips, plus roles) with
// activeRole added on top.
export interface CurrentUser {
  id: number
  email: string
  firstName: string
  lastName: string
  avatarPath: string | null
  isActive: boolean
  createdAt: Date
  passwordResetTokenHash: string | null
  passwordResetTokenExpiresAt: Date | null
  mfaSecret: string | null
  mfaEnabled: boolean
  roles: string[]
  activeRole: UserRole
}

// For code that reads req.user OUTSIDE this decorator — interceptors and
// guards, which only get the raw ExecutionContext, not @CurrentUser()'s own
// param-decoration machinery. `user` is optional here (unlike CurrentUser
// above): a global NestJS interceptor runs on every request, authenticated
// or not, and Express's own Request.user is only ever populated post-login.
//
// Deliberately NOT a global `declare module 'express' { interface User
// extends CurrentUser {} }` augmentation: req.login() in auth.controller.ts
// is called with a couple of shapes that are legitimately narrower than
// CurrentUser — most notably AuthService.validateUser()'s result, which
// intentionally omits mfaSecret so a pending/unconfirmed MFA secret never
// rides along in a plain login response body. Augmenting Express.User
// globally would force CurrentUser's full shape onto that write path too
// and either break it or require loosening CurrentUser everywhere just to
// accommodate one deliberately-narrower call site. Scoping the fix to
// read-only request typing avoids that collision entirely.
export type AuthenticatedRequest = Request & { user?: CurrentUser }

// --- DECORATOR ---------------------------------------------------------------------------------------------
// A custom parameter decorator — lets a controller method write
// @CurrentUser() user instead of manually reaching into the raw request for
// req.user every time.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUser => {
    const request = ctx.switchToHttp().getRequest<{ user: CurrentUser }>()
    return request.user
  },
)
