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
// Two optional texts for the card, set beside the droplet's cron and the
// repository's address so each lives in one place:
//   - DEMO_RESET_SCHEDULE: when the data is reset, in words ("every night at
//     03:00, Paris time"). Free text, at most 120 characters.
//   - DEMO_GUIDE_URL: the reviewers' guide (docs/dev-test-accounts.md on
//     GitHub, once the repositories are public). An https:// address — the
//     card turns it into a link, so nothing else (a `javascript:` URL) may
//     get in.

export const DEMO_MODE_VALUES = ['on', 'off'] as const

const RESET_SCHEDULE_MAX_LENGTH = 120

export function demoModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DEMO_MODE ?? 'off'
  if (!(DEMO_MODE_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `DEMO_MODE must be one of: ${DEMO_MODE_VALUES.join(', ')} — got "${value}".`,
    )
  }
  return value === 'on'
}

export interface DemoTexts {
  resetSchedule: string | null
  guideUrl: string | null
}

// The two texts, checked. An empty value counts as absent (a line left as
// `DEMO_GUIDE_URL=` in .env).
export function demoTexts(env: NodeJS.ProcessEnv = process.env): DemoTexts {
  const resetSchedule = env.DEMO_RESET_SCHEDULE?.trim() || null
  if (resetSchedule && resetSchedule.length > RESET_SCHEDULE_MAX_LENGTH) {
    throw new Error(
      `DEMO_RESET_SCHEDULE must be at most ${RESET_SCHEDULE_MAX_LENGTH} characters — it is shown on the sign-in page.`,
    )
  }
  const guideUrl = env.DEMO_GUIDE_URL?.trim() || null
  if (guideUrl && !isHttpsUrl(guideUrl)) {
    throw new Error(
      `DEMO_GUIDE_URL must be an https:// address — got "${guideUrl}".`,
    )
  }
  return { resetSchedule, guideUrl }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
