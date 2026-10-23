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

import * as bcrypt from 'bcrypt'
import { isCurrentPassword } from './current-password'

// --- TESTS -------------------------------------------------------------------------------------------------

describe('isCurrentPassword', () => {
  // A real hash (cost 4: the rule is the same, the test is fast).
  let hash: string
  beforeAll(async () => {
    hash = await bcrypt.hash('password123', 4)
  })

  it('accepts the password the hash was made from', async () => {
    await expect(isCurrentPassword(hash, 'password123')).resolves.toBe(true)
  })

  it('refuses any other password, even one differing only in case or a space', async () => {
    await expect(isCurrentPassword(hash, 'Password123')).resolves.toBe(false)
    await expect(isCurrentPassword(hash, 'password123 ')).resolves.toBe(false)
  })

  // bcrypt.compare(given, null) would THROW (a 500); an account without a
  // password has no current password to match.
  it('refuses for an account without a password, without throwing', async () => {
    await expect(isCurrentPassword(null, '')).resolves.toBe(false)
    await expect(isCurrentPassword(null, 'password123')).resolves.toBe(false)
  })
})
