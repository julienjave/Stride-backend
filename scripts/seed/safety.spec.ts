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

import { refuseSeed, type SeedTarget } from './safety'

const devDatabase: SeedTarget = {
  nodeEnv: 'development',
  database: 'stride',
  existingUsers: 0,
  reset: false,
}

describe('refuseSeed', () => {
  it('allows an empty development database', () => {
    expect(refuseSeed(devDatabase)).toBeNull()
    expect(refuseSeed({ ...devDatabase, nodeEnv: undefined })).toBeNull()
  })

  it('allows a database with users when --reset is given', () => {
    expect(
      refuseSeed({ ...devDatabase, existingUsers: 12, reset: true }),
    ).toBeNull()
  })

  it('refuses a database with users without --reset, saying how to reset', () => {
    expect(refuseSeed({ ...devDatabase, existingUsers: 12 })).toBe(
      'Refusing to seed: "stride" already has 12 user(s). Run with --reset to delete them first (the exercise library is kept): npm run seed:dev -- --reset',
    )
  })

  // The boundary: ONE existing user is already someone else's database.
  it('refuses even a single existing user without --reset', () => {
    expect(refuseSeed({ ...devDatabase, existingUsers: 1 })).toContain(
      'already has 1 user(s). Run with --reset',
    )
  })

  // Even empty, even with --reset: the rule doesn't depend on the data.
  it('refuses production, whatever else is true', () => {
    expect(
      refuseSeed({ ...devDatabase, nodeEnv: 'production', reset: true }),
    ).toBe(
      'Refusing to seed: NODE_ENV=production. The seed creates accounts with a published password, and --reset deletes every user.',
    )
  })

  it('refuses any database ending in _test, even with --reset', () => {
    expect(
      refuseSeed({ ...devDatabase, database: 'stride_test', reset: true }),
    ).toBe(
      'Refusing to seed "stride_test": databases ending in _test belong to the e2e tests. Seed the development database (POSTGRES_DB in .env).',
    )
  })

  it('allows a name that only CONTAINS "_test"', () => {
    expect(
      refuseSeed({ ...devDatabase, database: 'stride_testing_ground' }),
    ).toBeNull()
  })
})