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

// bcrypt's REAL compare, wrapped in a jest.fn that records its calls. An
// `import * as` namespace can't be patched with jest.spyOn (its properties
// are read-only: "Cannot redefine property"), so the module is replaced
// before anything imports it — jest.mock is hoisted above the imports — by
// a copy whose compare still does the real work.
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt')
  // An arrow with two arguments: compare has a callback overload too, and
  // passing it bare would make jest.fn take that one (returning void).
  return {
    ...actual,
    compare: jest.fn((data: string, hash: string) =>
      actual.compare(data, hash),
    ),
  }
})

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  PASSWORD_HASH_COST,
  passwordMatches,
} from './password-hashing'

// --- TESTS -------------------------------------------------------------------------------------------------

describe('password hashing', () => {
  // The dummy only equalises sign-in time if checking it costs what checking
  // a real hash costs: the same bcrypt cost. A new PASSWORD_HASH_COST needs a
  // new dummy: node -e "console.log(require('bcrypt').hashSync(require('crypto').randomBytes(32).toString('hex'), <cost>))"
  it('has a dummy hash of the same cost as real hashes', async () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(PASSWORD_HASH_COST)
    expect(bcrypt.getRounds(await hashPassword('any password'))).toBe(
      PASSWORD_HASH_COST,
    )
  })

  it('matches only a real hash of the right password', async () => {
    const hash = await hashPassword('correct horse')
    await expect(passwordMatches('correct horse', hash)).resolves.toBe(true)
    await expect(passwordMatches('wrong horse', hash)).resolves.toBe(false)
  })

  // The point of the fix: with no hash to check (no account, or an invited
  // account with no password yet), a real comparison still runs — against
  // the dummy — and the answer is still "no".
  it.each([
    ['no account', undefined],
    ['no password yet', null],
  ])(
    'runs one real comparison, and answers false, for %s',
    async (_case, missing) => {
      const compare = bcrypt.compare as unknown as jest.Mock
      compare.mockClear()
      await expect(passwordMatches('anything', missing)).resolves.toBe(false)
      expect(compare).toHaveBeenCalledTimes(1)
      expect(compare).toHaveBeenCalledWith('anything', DUMMY_PASSWORD_HASH)
    },
  )

  // And it takes about as long as a real wrong password: the same cost, so
  // the same work. A loose bound (CI machines vary); without the dummy, the
  // missing-hash case took well under a millisecond.
  it('takes about as long for a missing hash as for a wrong password', async () => {
    const real = await hashPassword('correct horse')
    const time = async (hash: string | undefined) => {
      const start = process.hrtime.bigint()
      await passwordMatches('wrong horse', hash)
      return Number(process.hrtime.bigint() - start) / 1e6
    }
    await time(real) // warm-up
    const wrong = await time(real)
    const missing = await time(undefined)
    expect(missing).toBeGreaterThan(wrong * 0.5)
  })
})
