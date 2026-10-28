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
import type { ThrottlerLimitDetail } from '@nestjs/throttler'
import {
  rateLimitsEnabled,
  throttlerOptions,
  tooManyAttemptsMessage,
} from './rate-limits'

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

  // The 429's words come from the wait the guard has just put in
  // Retry-After (timeToBlockExpire). The fixture gives the OTHER clock beside
  // it, timeToExpire (when the counting window ends), a different value: code
  // reading the wrong field would say "12 seconds" and fail here.
  it('words the refusal with the wait the guard puts in Retry-After', () => {
    const options = throttlerOptions({})
    if (Array.isArray(options)) throw new Error('expected the object form')
    const detail: ThrottlerLimitDetail = {
      limit: 5,
      ttl: 60_000,
      key: 'a-key',
      tracker: '127.0.0.1',
      totalHits: 6,
      timeToExpire: 12,
      isBlocked: true,
      timeToBlockExpire: 37,
    }
    if (typeof options.errorMessage !== 'function') {
      throw new Error('expected errorMessage to be a function')
    }
    expect(options.errorMessage(anyRequest, detail)).toBe(
      'Too many attempts in a short time. Try again in 37 seconds.',
    )
  })
})

describe('tooManyAttemptsMessage', () => {
  it('says how many seconds to wait', () => {
    expect(tooManyAttemptsMessage(37)).toBe(
      'Too many attempts in a short time. Try again in 37 seconds.',
    )
    // The whole first minute of a block (the guard's longest wait here).
    expect(tooManyAttemptsMessage(60)).toBe(
      'Too many attempts in a short time. Try again in 60 seconds.',
    )
  })

  // One second, not "1 seconds" — and 2 is already plural (the boundary).
  it('says "1 second" for a single second', () => {
    expect(tooManyAttemptsMessage(1)).toBe(
      'Too many attempts in a short time. Try again in 1 second.',
    )
    expect(tooManyAttemptsMessage(2)).toBe(
      'Too many attempts in a short time. Try again in 2 seconds.',
    )
  })

  // No usable number (a storage of our own one day, say): words instead of
  // "Try again in NaN seconds" or "in 0 seconds".
  it.each([0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'says "wait a minute" without a usable number (%p)',
    (value) => {
      expect(tooManyAttemptsMessage(value)).toBe(
        'Too many attempts in a short time. Wait a minute, then try again.',
      )
    },
  )
})
