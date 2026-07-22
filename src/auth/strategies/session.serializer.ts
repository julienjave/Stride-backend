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


// --- MAIN LOGIC --------------------------------------------------------------------------------------------
@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly usersService: UsersService) {
    super()
  }

  // Decides what actually gets STORED inside the session (in Postgres):
  // just the id, never the full user object
  serializeUser(user: { id: number }, done: (err: Error | null, id?: number) => void) {
    done(null, user.id)
  }

  // Runs on EVERY subsequent request carrying a valid session cookie — reloads
  // the user fresh from the database each time. This is what makes a role
  // change or a deactivation (is_active = false) take effect immediately,
  // rather than only at the next login.
  async deserializeUser(id: number, done: (err: Error | null, user?: unknown) => void) {
    try {
      const user = await this.usersService.findOne(id)
      done(null, user)
    } catch (err) {
      done(err as Error)
    }
  }
}