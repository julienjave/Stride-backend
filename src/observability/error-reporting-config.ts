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

import { type Dsn, parseDsn } from './dsn'

// --- CONFIG ------------------------------------------------------------------------------------------------

// The error-reporting settings, read in ONE place (decisions §32):
//
//   SENTRY_DSN           the backend's own project. Unset = reporting OFF —
//                        the default for development, the e2e suites and
//                        the scripts: nothing is sent anywhere unless a DSN
//                        is set on purpose.
//   SENTRY_BROWSER_DSN   the frontend's project, for POST /monitoring (the
//                        browser's reports pass through us). Unset = the
//                        route answers 404.
//   SENTRY_ENVIRONMENT   a label on each report ("production", "staging");
//                        defaults to NODE_ENV, then "development".
//   SENTRY_RELEASE       optional: the deployed version (a git commit), so a
//                        report says which code it came from.
//
// Called by validateEnv() at boot, AND by instrument.ts before it (the SDK
// starts before anything else is loaded) — a malformed DSN throws in both,
// naming the setting.
export interface ErrorReportingConfig {
  serverDsn: Dsn | null
  browserDsn: Dsn | null
  environment: string
  release: string | undefined
}

export function errorReportingConfig(
  env: NodeJS.ProcessEnv = process.env,
): ErrorReportingConfig {
  return {
    serverDsn: optionalDsn(env.SENTRY_DSN, 'SENTRY_DSN'),
    browserDsn: optionalDsn(env.SENTRY_BROWSER_DSN, 'SENTRY_BROWSER_DSN'),
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    release: env.SENTRY_RELEASE || undefined,
  }
}

// Empty and unset mean the same: off. (`.env` files often keep a key with
// no value.)
function optionalDsn(value: string | undefined, setting: string): Dsn | null {
  const text = value?.trim()
  return text ? parseDsn(text, setting) : null
}
