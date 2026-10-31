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
import type { Pool } from 'pg'
import { errorMessage } from '../common/error-message'

// A connection pool keeps a few connections OPEN between requests. When
// Postgres closes one of those idle connections — Postgres restarting, a
// `docker compose restart db`, a managed database's maintenance — node-
// postgres emits an 'error' EVENT on the pool. An EventEmitter's 'error' with
// no listener is thrown as an uncaught exception: the whole API process
// exited, every open socket with it (found 2026-10-30 by the error tracker's
// first live check — decisions §32: stopping the database reported a
// "fatal" crash, not 500s).
//
// With a listener, the pool simply drops that dead connection and opens a new
// one at the next query. Requests made while the database is really down fail
// on their own (a 500, reported with its request id) and the server recovers
// when it's back. Logged as a warning — the database going away is worth a
// line, not a crash.
export function survivePoolErrors(pool: Pool, name: string): Pool {
  const logger = new Logger('DatabasePool')
  pool.on('error', (error: Error) => {
    logger.warn(
      `An idle connection of the ${name} pool was closed: ${errorMessage(error)}`,
    )
  })
  return pool
}
