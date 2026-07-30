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

import { Inject, Injectable } from '@nestjs/common'
import { HealthIndicatorService } from '@nestjs/terminus'
import { sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'


// --- HEALTH INDICATOR --------------------------------------------------------------------------------------

// Terminus ships built-in indicators for TypeORM/Mongoose, but not Drizzle.
// A health indicator's whole job is simple: run something trivial that can
// only succeed if the real dependency is actually reachable, and report up
// or down accordingly.
@Injectable()
export class DrizzleHealthIndicator {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}
 
  async isHealthy(key: string) {
    const indicator = this.healthIndicatorService.check(key)
    try {
      await this.db.execute(sql`SELECT 1`)
      return indicator.up()
    } catch (err) {
      return indicator.down({ message: (err as Error).message })
    }
  }
}