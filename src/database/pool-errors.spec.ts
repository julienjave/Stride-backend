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

import { Logger } from '@nestjs/common'
import { Pool } from 'pg'
import { survivePoolErrors } from './pool-errors'

// An idle connection closed by Postgres: an 'error' event on the pool. With
// no listener Node throws it — the process exits. (No database is needed: the
// pool connects only when asked to.)
describe('survivePoolErrors', () => {
  afterEach(() => jest.restoreAllMocks())

  it('turns the event into a warning instead of a crash', async () => {
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    const pool = survivePoolErrors(new Pool(), 'app')
    expect(() =>
      pool.emit(
        'error',
        new Error('terminating connection due to administrator command'),
      ),
    ).not.toThrow()
    expect(warned.mock.calls).toStrictEqual([
      [
        'An idle connection of the app pool was closed: terminating connection due to administrator command',
      ],
    ])
    await pool.end()
  })

  // The neighbour: what happens without it — the reason for this file.
  it('is what stands between the event and a thrown error', async () => {
    const pool = new Pool()
    expect(() => pool.emit('error', new Error('closed'))).toThrow('closed')
    await pool.end()
  })
})
