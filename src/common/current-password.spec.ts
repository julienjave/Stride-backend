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

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import * as bcrypt from 'bcrypt'
import { IsCurrentPassword, isCurrentPassword } from './current-password'

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

describe('IsCurrentPassword', () => {
  class Body {
    @IsCurrentPassword()
    currentPassword!: unknown
  }
  const errorsFor = async (currentPassword: unknown) =>
    (await validate(plainToInstance(Body, { currentPassword }))).flatMap(
      (error) => Object.keys(error.constraints ?? {}),
    )

  // The limits of signing in: at least one character, at most 128.
  it('accepts 1 to 128 characters', async () => {
    await expect(errorsFor('x')).resolves.toStrictEqual([])
    await expect(errorsFor('x'.repeat(128))).resolves.toStrictEqual([])
  })

  it('refuses an empty string, 129 characters, and a non-string', async () => {
    await expect(errorsFor('')).resolves.toStrictEqual(['minLength'])
    await expect(errorsFor('x'.repeat(129))).resolves.toStrictEqual([
      'maxLength',
    ])
    await expect(errorsFor(12345678)).resolves.toContain('isString')
  })
})
