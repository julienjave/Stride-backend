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

import type { ExecutionContext } from '@nestjs/common'
import { rateLimitsEnabled, throttlerOptions } from './rate-limits'

// Each test passes its OWN environment object, so nothing here reads or
// changes the real process.env (which other spec files share).

describe('rateLimitsEnabled', () => {
  // Protected unless someone says otherwise.
  it('is on when RATE_LIMITS is absent', () => {
    expect(rateLimitsEnabled({})).toBe(true)
  })

  it("is on with 'on' and off with 'off'", () => {
    expect(rateLimitsEnabled({ RATE_LIMITS: 'on' })).toBe(true)
    expect(rateLimitsEnabled({ RATE_LIMITS: 'off' })).toBe(false)
  })

  // A typo must not silently mean either value.
  it.each(['of', 'false', 'OFF', ''])('refuses %j', (value) => {
    expect(() => rateLimitsEnabled({ RATE_LIMITS: value })).toThrow(
      `RATE_LIMITS must be one of: on, off — got "${value}".`,
    )
  })

  it("refuses 'off' in production", () => {
    expect(() =>
      rateLimitsEnabled({ RATE_LIMITS: 'off', NODE_ENV: 'production' }),
    ).toThrow(/RATE_LIMITS=off is not allowed when NODE_ENV=production/)
  })

  // The neighbours of that refusal: production stays fine with the limits
  // on, and 'off' is fine anywhere else.
  it("allows 'on' (or nothing) in production, and 'off' elsewhere", () => {
    expect(rateLimitsEnabled({ NODE_ENV: 'production' })).toBe(true)
    expect(
      rateLimitsEnabled({ RATE_LIMITS: 'on', NODE_ENV: 'production' }),
    ).toBe(true)
    expect(rateLimitsEnabled({ RATE_LIMITS: 'off', NODE_ENV: 'test' })).toBe(
      false,
    )
  })
})

describe('throttlerOptions', () => {
  // The guard calls skipIf with the request's context; ours ignores it.
  const anyRequest = {} as ExecutionContext
  const skip = (env: NodeJS.ProcessEnv) => {
    const options = throttlerOptions(env)
    if (Array.isArray(options)) throw new Error('expected the object form')
    return options.skipIf?.(anyRequest)
  }

  it('counts every request when the limits are on', () => {
    expect(skip({})).toBe(false)
    expect(skip({ RATE_LIMITS: 'on' })).toBe(false)
  })

  it('skips every request when they are off', () => {
    expect(skip({ RATE_LIMITS: 'off' })).toBe(true)
  })

  // The limit itself: 60 a minute (the e2e suite proves the guard uses it).
  it('sets the global limit to 60 requests a minute', () => {
    const options = throttlerOptions({})
    if (Array.isArray(options)) throw new Error('expected the object form')
    expect(options.throttlers).toEqual([
      { name: 'default', ttl: 60_000, limit: 60 },
    ])
  })

  // The same rules as at boot: a bad value stops the module too.
  it("refuses 'off' in production here too", () => {
    expect(() =>
      throttlerOptions({ RATE_LIMITS: 'off', NODE_ENV: 'production' }),
    ).toThrow(/not allowed when NODE_ENV=production/)
  })
})
