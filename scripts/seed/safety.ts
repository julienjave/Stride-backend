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

// Whether the seed may run against this database — decided BEFORE anything
// is written. A pure function of four facts (the script gathers them), so
// every rule can be unit-tested without a database.

export interface SeedTarget {
  nodeEnv: string | undefined
  database: string
  // Rows in `users` right now.
  existingUsers: number
  // Was --reset passed?
  reset: boolean
}

// null = go ahead; otherwise, why not (printed as is, then exit 1).
export function refuseSeed(target: SeedTarget): string | null {
  // Demo accounts with a published password must never reach a real
  // deployment — and --reset there would delete everyone.
  if (target.nodeEnv === 'production') {
    return 'Refusing to seed: NODE_ENV=production. The seed creates accounts with a published password, and --reset deletes every user.'
  }

  // stride_test belongs to the e2e suites, which empty it at will; seeding
  // it would only make their counts lie. Any *_test database is left alone.
  if (target.database.endsWith('_test')) {
    return `Refusing to seed "${target.database}": databases ending in _test belong to the e2e tests. Seed the development database (POSTGRES_DB in .env).`
  }

  // Never mix demo accounts into a database someone is already using —
  // and never delete it without being asked.
  if (target.existingUsers > 0 && !target.reset) {
    return `Refusing to seed: "${target.database}" already has ${target.existingUsers} user(s). Run with --reset to delete them first (the exercise library is kept): npm run seed:dev -- --reset`
  }

  return null
}