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

import { errorReportingConfig } from './error-reporting-config'

// The settings, read in one place (decisions §32).
describe('errorReportingConfig', () => {
  it('is off with nothing set, labelled development', () => {
    expect(errorReportingConfig({})).toStrictEqual({
      serverDsn: null,
      browserDsn: null,
      environment: 'development',
      release: undefined,
    })
  })

  it('treats an empty value as unset', () => {
    const config = errorReportingConfig({
      SENTRY_DSN: '  ',
      SENTRY_BROWSER_DSN: '',
      SENTRY_RELEASE: '',
    })
    expect(config.serverDsn).toBeNull()
    expect(config.browserDsn).toBeNull()
    expect(config.release).toBeUndefined()
  })

  it('reads both DSNs, the environment and the release', () => {
    const config = errorReportingConfig({
      SENTRY_DSN: 'http://server@glitchtip:8000/1',
      SENTRY_BROWSER_DSN: 'http://browser@glitchtip:8000/2',
      SENTRY_ENVIRONMENT: 'staging',
      SENTRY_RELEASE: 'abc123',
      NODE_ENV: 'production',
    })
    expect(config.serverDsn?.publicKey).toBe('server')
    expect(config.browserDsn?.projectId).toBe('2')
    expect(config.environment).toBe('staging')
    expect(config.release).toBe('abc123')
  })

  it('falls back to NODE_ENV for the environment', () => {
    expect(errorReportingConfig({ NODE_ENV: 'production' }).environment).toBe(
      'production',
    )
  })

  // A typo stops the boot, naming the setting.
  it('throws for a malformed DSN, naming which', () => {
    expect(() =>
      errorReportingConfig({ SENTRY_BROWSER_DSN: 'glitchtip/2' }),
    ).toThrow('SENTRY_BROWSER_DSN is not a valid URL')
  })
})
