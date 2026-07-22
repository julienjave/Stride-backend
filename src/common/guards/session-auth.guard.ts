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
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'


// --- MAIN LOGIC --------------------------------------------------------------------------------------------
// AUTHENTICATION check: "is there a valid, currently logged-in session at all?"
// Deliberately separate from RolesGuard's AUTHORIZATION check.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    // isAuthenticated() is attached to the request by Passport's session
    // middleware (registered in main.ts) — true only if deserializeUser
    // successfully loaded a real user for this request's session cookie.
    if (!request.isAuthenticated()) {
      throw new UnauthorizedException('You must be logged in to access this resource')
    }
    return true
  }
}