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

import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { getDatabaseUrl } from '../config/database-url'
import { getPoolConfig } from '../config/pool-config'

export const DRIZZLE = Symbol('DRIZZLE')
// A separate token for the raw pool — exists specifically so something can
// hold a reference to it for cleanup, which the DRIZZLE token alone never
// exposed (drizzle(pool, {schema}) wraps the pool, it doesn't expose it).
export const PG_POOL = Symbol('PG_POOL')

export type DrizzleDb = NodePgDatabase<typeof schema>

export const pgPoolProvider = {
  provide: PG_POOL,
  useFactory: (): Pool =>
    new Pool({ connectionString: getDatabaseUrl(), ...getPoolConfig('app') }),
}

export const drizzleProvider = {
  provide: DRIZZLE,
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
  inject: [PG_POOL],
}

// A small dedicated class, purely to hook into Nest's shutdown lifecycle —
// plain factory providers (like the two above) can't implement lifecycle
// interfaces themselves, since they're not classes. This is what actually
// closes the pool when app.close() runs (in a test's afterAll, or in
// production when app.enableShutdownHooks() relays a real SIGTERM).
@Injectable()
export class DrizzlePoolCloser implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy() {
    await this.pool.end()
  }
}
