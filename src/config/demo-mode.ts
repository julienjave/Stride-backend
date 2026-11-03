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

// --- DEMO MODE: THE DEPLOYMENT REVIEWERS USE ---------------------------------------------------------------
//
// Decisions §46. ONE switch for everything the reviewers' deployment does
// differently from a real clinic's: the sign-in page's "For reviewers" card
// (its accounts come from GET /auth/setup-status), the shared accounts locked
// against the changes that would lock everyone else out (demo-lock.guard.ts),
// and — pass 2 — the nightly reset.
//
// DEMO_MODE: 'off' (the default — absent means off) or 'on'.
//   - The default is OFF, the opposite of RATE_LIMITS: here the SAFE value is
//     "nothing published". A clinic that forgets the variable must never
//     publish shared passwords on its sign-in page.
//   - 'on' IS allowed in production — the demo is a production deployment
//     (NODE_ENV=production, real email, real storage). That's the difference
//     from RATE_LIMITS=off or EMAIL_TRANSPORT=log, which exist for tests.
//   - Anything else is refused, so a typo ("true", "yes") can't silently mean
//     either value.
// Like rateLimitsEnabled(), read where it's needed (validateEnv() at start,
// the guard and the route on each request), so an e2e suite can switch it
// for one file by setting process.env before its requests.
//
// Two optional settings for the card:
//   - DEMO_RESET_TIME + DEMO_RESET_TIME_ZONE: when the data is reset, as a
//     time of day (24-hour HH:MM) in an IANA zone — "04:00" in
//     "America/Toronto" (decisions §46: the reviewers are in North America,
//     4 a.m. Eastern is the quietest hour from St. John's to Vancouver). Sent
//     as DATA, not words: the card converts it into each reviewer's own time
//     ("every night at 1:00 AM your time"). Both or neither. The droplet's
//     timer (scripts/ops/stride-demo-reset.timer) must say the same time and
//     zone — docs/DEPLOYMENT.md, Part 3.
//   - DEMO_GUIDE_URL: the reviewers' guide (docs/demo-accounts.md on
//     GitHub, once the repositories are public). An https:// address — the
//     card turns it into a link, so nothing else (a `javascript:` URL) may
//     get in.

import { isTimeZone } from '../common/validators/is-time-zone'

export const DEMO_MODE_VALUES = ['on', 'off'] as const

// 24-hour clock, two digits each: 00:00 to 23:59.
const RESET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function demoModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DEMO_MODE ?? 'off'
  if (!(DEMO_MODE_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `DEMO_MODE must be one of: ${DEMO_MODE_VALUES.join(', ')} — got "${value}".`,
    )
  }
  return value === 'on'
}

export interface DemoReset {
  // "HH:MM", 24-hour, in `timeZone`.
  time: string
  // An IANA zone name ("America/Toronto").
  timeZone: string
}

export interface DemoTexts {
  reset: DemoReset | null
  guideUrl: string | null
}

// The two settings, checked. An empty value counts as absent (a line left as
// `DEMO_GUIDE_URL=` in .env).
export function demoTexts(env: NodeJS.ProcessEnv = process.env): DemoTexts {
  return { reset: demoReset(env), guideUrl: demoGuideUrl(env) }
}

function demoReset(env: NodeJS.ProcessEnv): DemoReset | null {
  const time = env.DEMO_RESET_TIME?.trim() || null
  const timeZone = env.DEMO_RESET_TIME_ZONE?.trim() || null
  if (time === null && timeZone === null) return null
  // One without the other would be a time the card can't place.
  if (time === null || timeZone === null) {
    throw new Error(
      'DEMO_RESET_TIME and DEMO_RESET_TIME_ZONE go together: set both (e.g. 04:00 and America/Toronto), or neither.',
    )
  }
  if (!RESET_TIME.test(time)) {
    throw new Error(
      `DEMO_RESET_TIME must be a 24-hour time, HH:MM (e.g. 04:00) — got "${time}".`,
    )
  }
  // The project's own check (is-time-zone.ts): what Intl can format in, and
  // never a bare offset — an offset isn't a place, so it can't follow the
  // zone's clock changes the way the timer does.
  //
  // The message quotes the setting as written (env.DEMO_RESET_TIME_ZONE), not
  // `timeZone`: isTimeZone is a TYPE GUARD (`value is string`), so where it
  // answers false TypeScript removes `string` from what `timeZone` can be —
  // and a string minus string is `never`, which lint rightly refuses to put
  // in a template.
  if (!isTimeZone(timeZone)) {
    throw new Error(
      `DEMO_RESET_TIME_ZONE must be an IANA time zone (e.g. America/Toronto) — got "${env.DEMO_RESET_TIME_ZONE}".`,
    )
  }
  return { time, timeZone }
}

function demoGuideUrl(env: NodeJS.ProcessEnv): string | null {
  const guideUrl = env.DEMO_GUIDE_URL?.trim() || null
  if (guideUrl && !isHttpsUrl(guideUrl)) {
    throw new Error(
      `DEMO_GUIDE_URL must be an https:// address — got "${guideUrl}".`,
    )
  }
  return guideUrl
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
