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

import { demoModeEnabled, demoTexts } from './demo-mode'
import { demoInfo } from '../demo/demo-info'
import {
  DEMO_CARD_ACCOUNTS,
  DEMO_MFA_SECRET,
  DEMO_PASSWORD,
  isDemoCardAccount,
} from '../demo/demo-accounts'

// Each test passes its OWN environment object, so nothing here reads or
// changes the real process.env (which other spec files share).

describe('demoModeEnabled', () => {
  // The safe value is "nothing published": a clinic that forgets the
  // variable must not show shared passwords on its sign-in page.
  it('is off when DEMO_MODE is absent', () => {
    expect(demoModeEnabled({})).toBe(false)
  })

  it("is on with 'on' and off with 'off'", () => {
    expect(demoModeEnabled({ DEMO_MODE: 'on' })).toBe(true)
    expect(demoModeEnabled({ DEMO_MODE: 'off' })).toBe(false)
  })

  // The demo IS a production deployment — unlike RATE_LIMITS=off.
  it("allows 'on' in production", () => {
    expect(demoModeEnabled({ DEMO_MODE: 'on', NODE_ENV: 'production' })).toBe(
      true,
    )
  })

  it.each(['true', 'yes', 'ON', ''])('refuses %j', (value) => {
    expect(() => demoModeEnabled({ DEMO_MODE: value })).toThrow(
      `DEMO_MODE must be one of: on, off — got "${value}".`,
    )
  })
})

describe('demoTexts', () => {
  it('reads the reset time and zone and the guide, trimmed', () => {
    expect(
      demoTexts({
        DEMO_RESET_TIME: ' 04:00 ',
        DEMO_RESET_TIME_ZONE: ' America/Toronto',
        DEMO_GUIDE_URL:
          ' https://github.com/x/stride/blob/main/docs/demo-accounts.md',
      }),
    ).toEqual({
      reset: { time: '04:00', timeZone: 'America/Toronto' },
      guideUrl: 'https://github.com/x/stride/blob/main/docs/demo-accounts.md',
    })
  })

  // A line left as `DEMO_GUIDE_URL=` in .env means "none".
  it('reads absent or empty values as none', () => {
    expect(demoTexts({})).toEqual({ reset: null, guideUrl: null })
    expect(
      demoTexts({
        DEMO_RESET_TIME: '  ',
        DEMO_RESET_TIME_ZONE: '',
        DEMO_GUIDE_URL: '',
      }),
    ).toEqual({ reset: null, guideUrl: null })
  })

  // A time with no zone can't be placed on anyone's clock — nor a zone alone.
  it.each([
    { DEMO_RESET_TIME: '04:00' },
    { DEMO_RESET_TIME_ZONE: 'America/Toronto' },
  ])('refuses one of the pair without the other: %j', (env) => {
    expect(() => demoTexts(env)).toThrow(
      'DEMO_RESET_TIME and DEMO_RESET_TIME_ZONE go together',
    )
  })

  it.each(['00:00', '04:00', '09:30', '23:59'])(
    'takes the 24-hour time %s',
    (time) => {
      expect(
        demoTexts({ DEMO_RESET_TIME: time, DEMO_RESET_TIME_ZONE: 'UTC' }).reset,
      ).toEqual({ time, timeZone: 'UTC' })
    },
  )

  it.each(['4:00', '24:00', '04:60', '4am', '04:00:00', '0400'])(
    'refuses the time %j',
    (time) => {
      expect(() =>
        demoTexts({ DEMO_RESET_TIME: time, DEMO_RESET_TIME_ZONE: 'UTC' }),
      ).toThrow(
        `DEMO_RESET_TIME must be a 24-hour time, HH:MM (e.g. 04:00) — got "${time}".`,
      )
    },
  )

  // An offset isn't a place: it can't follow the zone's clock changes.
  it.each(['Eastern', 'America/Nowhere', '-05:00', 'EST5EDT x'])(
    'refuses the zone %j',
    (zone) => {
      expect(() =>
        demoTexts({ DEMO_RESET_TIME: '04:00', DEMO_RESET_TIME_ZONE: zone }),
      ).toThrow(
        `DEMO_RESET_TIME_ZONE must be an IANA time zone (e.g. America/Toronto) — got "${zone}".`,
      )
    },
  )

  // The card turns the guide into a link: only https:// may get in — never a
  // `javascript:` address, nor plain http.
  it.each([
    'javascript:alert(1)',
    'http://github.com/x',
    'github.com/x',
    'not a url',
  ])('refuses the guide address %j', (value) => {
    expect(() => demoTexts({ DEMO_GUIDE_URL: value })).toThrow(
      `DEMO_GUIDE_URL must be an https:// address — got "${value}".`,
    )
  })
})

describe('demoInfo (the card, on GET /auth/setup-status)', () => {
  it('is null outside demo mode — nothing published', () => {
    expect(demoInfo({})).toBeNull()
    expect(
      demoInfo({ DEMO_MODE: 'off', DEMO_GUIDE_URL: 'https://x.org' }),
    ).toBeNull()
  })

  it('in demo mode: the four accounts, the password, the two-factor key and the texts', () => {
    expect(
      demoInfo({
        DEMO_MODE: 'on',
        DEMO_RESET_TIME: '04:00',
        DEMO_RESET_TIME_ZONE: 'America/Toronto',
      }),
    ).toEqual({
      accounts: [
        { email: 'admin@stride.test', role: 'admin', twoFactor: false },
        { email: 'alex@stride.test', role: 'practitioner', twoFactor: false },
        { email: 'pat@stride.test', role: 'patient', twoFactor: false },
        { email: 'casey@stride.test', role: 'patient', twoFactor: true },
      ],
      password: DEMO_PASSWORD,
      twoFactorKey: DEMO_MFA_SECRET,
      reset: { time: '04:00', timeZone: 'America/Toronto' },
      guideUrl: null,
    })
  })
})

describe('isDemoCardAccount', () => {
  it('is true for exactly the card accounts', () => {
    for (const { email } of DEMO_CARD_ACCOUNTS) {
      expect(isDemoCardAccount(email)).toBe(true)
    }
    // Seeded, but not on the card: not locked.
    expect(isDemoCardAccount('sam@stride.test')).toBe(false)
    expect(isDemoCardAccount('morgan@stride.test')).toBe(false)
    // An address CONTAINING a card address is another address.
    expect(isDemoCardAccount('xadmin@stride.test')).toBe(false)
  })
})
