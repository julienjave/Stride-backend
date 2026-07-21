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


import { Pool } from 'pg'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { getDatabaseUrl } from '../config/database-url'


// The injection token
export const DRIZZLE = Symbol('DRIZZLE')

// The exact type of "a Drizzle database instance that knows about our schema"
export type DrizzleDb = NodePgDatabase<typeof schema>

export const drizzleProvider = {
  provide: DRIZZLE,
  // useFactory, rather than useClass or useValue: we need to actually COMPUTE
  // the value (build a connection pool, wrap it with Drizzle) when the app
  // starts, not just hand Nest a class to instantiate or a static value.
  useFactory: (): DrizzleDb => {
    const pool = new Pool({ connectionString: getDatabaseUrl() })
    return drizzle(pool, { schema })
  },
}