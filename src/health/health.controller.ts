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

import { Controller, Get } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
} from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import { DrizzleHealthIndicator } from './drizzle-health.indicator'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// Deliberately NO SessionAuthGuard here — health checks exist specifically
// for monitoring systems and load balancers to poll without credentials.
// @SkipThrottle() exempts this from the global rate limiter too: a
// monitoring system polling every few seconds isn't the kind of traffic
// pattern rate limiting exists to catch.
@SkipThrottle()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DrizzleHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.isHealthy('database'),
      // 300MB heap threshold — an arbitrary but reasonable starting point
      // for a small API; worth tuning based on real observed usage once deployed.
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
    ])
  }
}
