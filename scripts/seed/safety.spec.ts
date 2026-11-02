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
  demoMode: false,
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
  it('refuses production without demo mode, whatever else is true', () => {
    expect(
      refuseSeed({ ...devDatabase, nodeEnv: 'production', reset: true }),
    ).toBe(
      "Refusing to seed: NODE_ENV=production without DEMO_MODE=on. The seed creates accounts with a published password, and --reset deletes every user — only the reviewers' demo deployment may do that.",
    )
  })

  // The reviewers' demo (decisions §46): its nightly reset runs this seed in
  // production — first install (empty) and every night after (--reset).
  it('allows production in demo mode, empty or with --reset', () => {
    const demo = { ...devDatabase, nodeEnv: 'production', demoMode: true }
    expect(refuseSeed(demo)).toBeNull()
    expect(refuseSeed({ ...demo, existingUsers: 40, reset: true })).toBeNull()
  })

  // Demo mode lifts the production rule ONLY: the other two still hold.
  it('still refuses, in demo mode, a database with users without --reset, and a _test database', () => {
    const demo = { ...devDatabase, nodeEnv: 'production', demoMode: true }
    expect(refuseSeed({ ...demo, existingUsers: 3 })).toContain(
      'already has 3 user(s)',
    )
    expect(
      refuseSeed({ ...demo, database: 'stride_test', reset: true }),
    ).toContain('belong to the e2e tests')
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