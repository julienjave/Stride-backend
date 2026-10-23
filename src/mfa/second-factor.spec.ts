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
import { INVALID_MFA_CODE_MESSAGE, MFA_CODE_ALREADY_USED_MESSAGE } from './totp'
import {
  INVALID_RECOVERY_CODE_MESSAGE,
  IsSecondFactorCode,
  SECOND_FACTOR_FORMAT_MESSAGE,
  secondFactorRefusalMessage,
} from './second-factor'

// --- TESTS -------------------------------------------------------------------------------------------------

describe('IsSecondFactorCode', () => {
  class Body {
    @IsSecondFactorCode()
    code!: unknown
  }
  const check = async (code: unknown) => {
    const body = plainToInstance(Body, { code })
    const errors = (await validate(body)).flatMap((error) =>
      Object.values(error.constraints ?? {}),
    )
    return { errors, value: body.code }
  }

  it.each([['012345'], ['abcde-23456'], ['ABCDE 23456'], ['abcde23456']])(
    'accepts %p — an app code or a recovery code',
    async (code) => {
      await expect(check(code)).resolves.toMatchObject({ errors: [] })
    },
  )

  // Pasted with spaces around it: trimmed BEFORE the check, and what reaches
  // the service is the trimmed value.
  it('trims the code first', async () => {
    await expect(check('  abcde-23456 ')).resolves.toStrictEqual({
      errors: [],
      value: 'abcde-23456',
    })
    await expect(check(' 123456\n')).resolves.toStrictEqual({
      errors: [],
      value: '123456',
    })
  })

  it.each([
    ['12345'],
    ['1234567'],
    ['abcde-2345'],
    ['abcdi-23456'],
    [''],
    [123456],
    [null],
  ])('refuses %p with its own words', async (code) => {
    await expect(check(code)).resolves.toMatchObject({
      errors: [SECOND_FACTOR_FORMAT_MESSAGE],
    })
  })
})

describe('secondFactorRefusalMessage', () => {
  it('words each refusal', () => {
    expect(secondFactorRefusalMessage('wrong_code')).toBe(
      INVALID_MFA_CODE_MESSAGE,
    )
    expect(secondFactorRefusalMessage('code_already_used')).toBe(
      MFA_CODE_ALREADY_USED_MESSAGE,
    )
    expect(secondFactorRefusalMessage('wrong_recovery_code')).toBe(
      INVALID_RECOVERY_CODE_MESSAGE,
    )
  })
})
