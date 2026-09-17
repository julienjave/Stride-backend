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

import { Injectable } from '@nestjs/common'
import { PassportSerializer } from '@nestjs/passport'
import { UsersService } from '../../users/users.service'
import { UserRole } from '../../users/dto/create-user.dto'

// --- MAIN LOGIC --------------------------------------------------------------------------------------------

interface SessionData {
  id: number
  activeRole: UserRole
}

@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly usersService: UsersService) {
    super()
  }

  // Decides what actually gets STORED inside the session (in Postgres):
  // Stores {id, activeRole} instead of a bare id — the session needs to
  // remember not just WHO is logged in, but WHICH of their roles is active
  // for this particular session.
  serializeUser(
    user: { id: number; activeRole: UserRole },
    done: (err: Error | null, data?: SessionData) => void,
  ) {
    done(null, { id: user.id, activeRole: user.activeRole })
  }

  // Runs on EVERY subsequent request carrying a valid session cookie.
  // Reloads the full user (with their current roles) fresh on every request.
  // Two independent reasons this can fail, both using the same mechanism:
  // an account deactivated (isActive: false) since login, or the stored
  // activeRole no longer among their actual roles (revoked by an admin
  // sometime after this session's login). Either way, done(null, false)
  // tells Passport deserialization failed: req.user stays unset,
  // isAuthenticated() returns false, exactly as if they'd been logged out.
  // This is what makes deactivation AND mid-session role revocation both
  // take effect immediately, without needing to separately delete the
  // session record itself — the very next request just fails here instead.
  async deserializeUser(
    sessionData: SessionData,
    done: (err: Error | null, user?: unknown) => void,
  ) {
    try {
      const user = await this.usersService.findOne(sessionData.id)
      if (!user.isActive) {
        return done(null, false)
      }
      if (!user.roles.includes(sessionData.activeRole)) {
        return done(null, false)
      }
      done(null, { ...user, activeRole: sessionData.activeRole })
    } catch (err) {
      done(err as Error)
    }
  }
}