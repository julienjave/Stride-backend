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

import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-local'
import { Request } from 'express'
import { AuthService } from '../auth.service'


// --- MAIN LOGIC --------------------------------------------------------------------------------------------

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    // passReqToCallback: true is what makes the full Express `req` available
    // as validate()'s first argument below — without it, Passport only ever
    // hands the strategy the two fields it was configured to extract
    // (email/password), with no way to also read an optional "role" field
    // from the same request body.
    super({ usernameField: 'email', passReqToCallback: true })
  }

  // Passport calls this automatically when LocalAuthGuard is triggered
  async validate(req: Request, email: string, password: string) {
    const requestedRole = req.body.role as string | undefined
    const user = await this.authService.validateUser(email, password, requestedRole)
    if (!user) {
      throw new UnauthorizedException('Invalid email or password')
    }
    return user
  }
}