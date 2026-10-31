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

import {
  createDatabaseStatement,
  maintenanceDatabaseUrl,
} from './create-database'

describe('createDatabaseStatement', () => {
  it('creates the named database', () => {
    expect(createDatabaseStatement('stride_e2e')).toBe(
      'CREATE DATABASE stride_e2e',
    )
  })

  it('refuses a missing name', () => {
    expect(() => createDatabaseStatement(undefined)).toThrow(
      'Missing required environment variable: POSTGRES_DB',
    )
  })

  // The name goes into the SQL text: anything that could close the
  // statement or quote an identifier is refused before it gets there.
  it.each([
    'stride-e2e',
    'Stride',
    '1stride',
    'stride; DROP DATABASE stride',
    'stride"e2e',
    '',
  ])('refuses %j', (name) => {
    expect(() => createDatabaseStatement(name)).toThrow(
      /not a valid database name|Missing/,
    )
  })
})

describe('maintenanceDatabaseUrl', () => {
  it('keeps the server and the owner, and points at postgres', () => {
    expect(
      maintenanceDatabaseUrl(
        'postgresql://owner:secret@db.local:5433/stride_e2e',
      ),
    ).toBe('postgresql://owner:secret@db.local:5433/postgres')
  })
})