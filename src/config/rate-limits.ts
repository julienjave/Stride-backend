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

import { seconds, type ThrottlerModuleOptions } from '@nestjs/throttler'

// --- RATE LIMITS: ON, OR OFF FOR THE E2E TESTS -------------------------------------------------------------
//
// The throttler (decided 2026-10-15, after Phase 4 step 1b) protects the API
// from brute force and floods: 60 requests a minute per route and IP for
// every route, 5 for the login and password routes (@Throttle on
// AuthController). The e2e suites send far more than a person would — one
// file assigns some 25 programs — and had to share fixtures and count their
// logins to stay under the limits. So the limits can be switched OFF, for
// the e2e tests only (test/support/e2e-env.ts sets it before every file),
// and one suite, test/rate-limits.e2e-spec.ts, switches them back ON to
// prove they work.
//
// RATE_LIMITS: 'on' (the default — absent means on) or 'off'.
//   - The default is ON: a deployment that forgets the variable is
//     protected. Turning protection off must be said out loud.
//   - 'off' is REFUSED when NODE_ENV=production — the same rule as
//     EMAIL_TRANSPORT=log: a setting meant for tests must never be able to
//     disable brute-force protection on the real server.
//   - Anything else is refused: a typo ("of", "false") must not silently
//     mean either value.
// Like getEmailTransportKind(), the rules live in ONE function called by
// both validateEnv() (main.ts: the app refuses to start) and the module's
// factory (app.module.ts: the e2e tests build the app without main.ts, so
// the factory applies the same rules there).

export const RATE_LIMITS_VALUES = ['on', 'off'] as const

export function rateLimitsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.RATE_LIMITS ?? 'on'
  if (!(RATE_LIMITS_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `RATE_LIMITS must be one of: ${RATE_LIMITS_VALUES.join(', ')} — got "${value}".`,
    )
  }
  if (value === 'off' && env.NODE_ENV === 'production') {
    throw new Error(
      'RATE_LIMITS=off is not allowed when NODE_ENV=production: it disables ' +
        'the protection against password guessing and request floods. It ' +
        'exists for the e2e tests only.',
    )
  }
  return value === 'on'
}

// --- THE REFUSAL, IN PLAIN WORDS ---------------------------------------------------------------------------
//
// What a 429 says (decided 2026-10-27). The library's own message is
// 'ThrottlerException: Too Many Requests' — a class name, not a sentence —
// and the app's screens show the server's words for a refusal
// (HttpExceptionFilter passes a deliberate HttpException's message through
// unchanged). So a sign-in, a password form or a save refused by the limit
// read "ThrottlerException: Too Many Requests". Writing the sentence HERE,
// once, gives every screen and every other client the same plain words — the
// backend's messages are part of its contract, written for people.
//
// The wait is the guard's own number: how long until this address may send
// to this route again, in whole seconds — the value it also puts in the
// Retry-After header, so the words and the header can never disagree.
// "Attempts", not "requests": it reads right for a sign-in, a code and a
// save alike, and says nothing about how the server counts.
export function tooManyAttemptsMessage(secondsToWait: number): string {
  const opening = 'Too many attempts in a short time.'
  // The library always gives a whole number of at least 1 while a client is
  // blocked; a storage of our own one day might not. Without a usable
  // number, say how long in words rather than "Try again in NaN seconds".
  if (!Number.isInteger(secondsToWait) || secondsToWait < 1) {
    return `${opening} Wait a minute, then try again.`
  }
  const wait = secondsToWait === 1 ? '1 second' : `${secondsToWait} seconds`
  return `${opening} Try again in ${wait}.`
}

// The throttler's options, built when the module is created (forRootAsync's
// factory) — not when app.module.ts is imported, so a test that sets
// RATE_LIMITS before building its app is the one that decides.
//   - `throttlers`: the global limit every route gets. Routes with
//     @Throttle (the auth routes) override its numbers for themselves.
//   - `skipIf`: asked by the guard on EVERY request, before any counting, for
//     every throttler — the global one and @Throttle's overrides alike (a
//     route's @SkipThrottle() is a separate, per-route switch). Returning
//     true lets the request through uncounted.
//   - `errorMessage`: the words of the 429 (above). The guard calls it with
//     the request's context and the limit's details at the moment it refuses;
//     `timeToBlockExpire` is the wait it has just written into Retry-After
//     (`timeToExpire`, beside it, is when the COUNTING window ends — a
//     different clock). Only the object form of these options carries it;
//     an array of throttlers would fall back to the library's text.
export function throttlerOptions(
  env: NodeJS.ProcessEnv = process.env,
): ThrottlerModuleOptions {
  const enabled = rateLimitsEnabled(env)
  return {
    throttlers: [
      {
        name: 'default',
        ttl: seconds(60),
        limit: 60, // baseline: 60 requests/minute per IP, for each route
      },
    ],
    skipIf: () => !enabled,
    errorMessage: (_context, detail) =>
      tooManyAttemptsMessage(detail.timeToBlockExpire),
  }
}
