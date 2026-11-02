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

import { validateEnv } from './validate-env'

// The boot check — here only its newest line (decisions §32): a malformed
// error-reporting DSN stops the app, naming the setting, instead of losing
// every report without a word. The other settings are set to valid values so
// only the DSN can be the reason.
describe('validateEnv — error reporting', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    process.env = {
      ...saved,
      SESSION_SECRET: 'a'.repeat(64),
      MFA_ENCRYPTION_KEY: 'b'.repeat(64),
      POSTGRES_APP_USER: 'stride_app',
      POSTGRES_APP_PASSWORD: 'x',
      EMAIL_TRANSPORT: 'log',
      NODE_ENV: 'test',
      RATE_LIMITS: 'on',
    }
    delete process.env.SENTRY_DSN
    delete process.env.SENTRY_BROWSER_DSN
    delete process.env.DEMO_MODE
    delete process.env.DEMO_RESET_TIME
    delete process.env.DEMO_RESET_TIME_ZONE
    delete process.env.DEMO_GUIDE_URL
  })
  afterAll(() => {
    process.env = saved
  })

  it('passes with reporting off or a valid DSN', () => {
    expect(() => validateEnv()).not.toThrow()
    process.env.SENTRY_DSN = 'http://key@glitchtip:8000/1'
    expect(() => validateEnv()).not.toThrow()
  })

  it('refuses a malformed DSN at boot', () => {
    process.env.SENTRY_BROWSER_DSN = 'http://key@glitchtip:8000/web'
    expect(() => validateEnv()).toThrow(
      new Error("SENTRY_BROWSER_DSN must end with the project's numeric id"),
    )
  })
})

// Demo mode (decisions §46): a malformed switch or text stops the app at
// start, naming the setting — not the first sign-in page that reads it.
describe('validateEnv — demo mode', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    process.env = {
      ...saved,
      SESSION_SECRET: 'a'.repeat(64),
      MFA_ENCRYPTION_KEY: 'b'.repeat(64),
      POSTGRES_APP_USER: 'stride_app',
      POSTGRES_APP_PASSWORD: 'x',
      EMAIL_TRANSPORT: 'log',
      NODE_ENV: 'test',
      RATE_LIMITS: 'on',
    }
    delete process.env.SENTRY_DSN
    delete process.env.SENTRY_BROWSER_DSN
    delete process.env.DEMO_MODE
    delete process.env.DEMO_RESET_TIME
    delete process.env.DEMO_RESET_TIME_ZONE
    delete process.env.DEMO_GUIDE_URL
  })
  afterAll(() => {
    process.env = saved
  })

  it('passes with demo mode absent, or on with valid texts', () => {
    expect(() => validateEnv()).not.toThrow()
    process.env.DEMO_MODE = 'on'
    process.env.DEMO_GUIDE_URL = 'https://example.com/guide'
    expect(() => validateEnv()).not.toThrow()
  })

  it('refuses a malformed switch at boot', () => {
    process.env.DEMO_MODE = 'true'
    expect(() => validateEnv()).toThrow(/DEMO_MODE must be one of: on, off/)
  })

  it('refuses a reset time without its zone at boot', () => {
    process.env.DEMO_RESET_TIME = '04:00'
    expect(() => validateEnv()).toThrow(/go together/)
  })

  it('refuses a guide address that is not https at boot', () => {
    process.env.DEMO_GUIDE_URL = 'javascript:alert(1)'
    expect(() => validateEnv()).toThrow(/DEMO_GUIDE_URL must be an https/)
  })
})
