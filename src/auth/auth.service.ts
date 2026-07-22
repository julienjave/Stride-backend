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
import * as bcrypt from 'bcrypt'
import { UsersService } from '../users/users.service'


// --- SERVICE -----------------------------------------------------------------------------------------------
@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  // Called by LocalStrategy on every login attempt.
  // Returns the sanitized user on success, or null on failure
  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmailWithHash(email)
    if (!user) {
      return null
    }
    const passwordMatches = await bcrypt.compare(password, user.passwordHash)
    if (!passwordMatches) {
      return null
    }
    const { passwordHash, ...publicUser } = user
    return publicUser
  }
}