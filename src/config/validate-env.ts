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

import { getEmailTransportKind } from '../email/email-transport.config'
import { rateLimitsEnabled } from './rate-limits'
import { demoModeEnabled, demoTexts } from './demo-mode'
import { errorReportingConfig } from '../observability/error-reporting-config'
import { storagePublicEndpoint } from './storage-urls'

// Called as the very first thing bootstrap() does, before NestFactory.create()
// even runs — nothing about this app should construct a single module if a
// critical piece of config is missing or still set to a known-insecure
// placeholder. Same "fail loudly, immediately, at boot" principle as
// getDatabaseUrl()'s own validation, applied here to session security
// specifically, since this was the one place the app previously had a
// SILENT fallback: `process.env.SESSION_SECRET ?? 'dev-secret-change-me'`
// meant a real deployment missing this variable would run — insecurely —
// with zero indication anything was wrong.
export function validateEnv(): void {
  const secret = process.env.SESSION_SECRET

  if (!secret) {
    throw new Error(
      'Missing required environment variable: SESSION_SECRET. Sessions must ' +
        'never be signed with a missing or hardcoded secret — set a long, ' +
        'random string in .env before starting the app.',
    )
  }

  if (secret === 'replace-with-a-long-random-string') {
    throw new Error(
      'SESSION_SECRET is still set to the placeholder value from .env.example. ' +
        'Generate a real random secret (e.g. `openssl rand -hex 32`) before starting the app.',
    )
  }

  // Email delivery: EMAIL_TRANSPORT must be set and valid, 'log' is refused
  // in production, and RESEND_API_KEY is required only when Resend is the
  // transport in use. The rules live in getEmailTransportKind() rather
  // than here, because the e2e tests build the app without main.ts (so
  // without this function) and EmailModule's factory has to apply the
  // same rules there. Called here too so a bad value still stops the app
  // at boot, before any module is built — same principle as everything
  // else in this function.
  getEmailTransportKind()

  // Rate limits: RATE_LIMITS must be 'on' (or absent) or 'off', and 'off' is
  // refused in production. The rules live in config/rate-limits.ts, called
  // here so a bad value stops the app at boot, and by the throttler's
  // factory for the e2e tests (built without main.ts) — the same split as
  // the email transport above.
  rateLimitsEnabled()

  // SENTRY_DSN / SENTRY_BROWSER_DSN, when set, must be real DSNs — a typo
  // would otherwise lose every report without a word. (Unset = reporting
  // off: fine.)
  errorReportingConfig()
  // Demo mode (decisions §46): the switch and its two texts, refused at start
  // when malformed rather than on the first sign-in page that reads them.
  demoModeEnabled()
  demoTexts()

  // Storage's public address (config/storage-urls.ts): required in
  // production — without it every presigned photo URL would name
  // `storage:9000`, which no browser can reach — and, when set, an origin
  // (https:// in production). StorageService reads it through the same
  // function when it's built.
  storagePublicEndpoint()

  // Same reasoning, applied to MFA secret encryption — validated for both
  // presence AND correct shape (64 hex characters = 32 bytes = AES-256's
  // required key length), since a key of the wrong length would otherwise
  // fail confusingly deep inside crypto.createCipheriv, not here.
  const mfaKey = process.env.MFA_ENCRYPTION_KEY
  if (!mfaKey) {
    throw new Error(
      'Missing required environment variable: MFA_ENCRYPTION_KEY. Set a 64-character ' +
        'hex string (e.g. `openssl rand -hex 32`) before starting the app.',
    )
  }
  if (!/^[0-9a-f]{64}$/i.test(mfaKey)) {
    throw new Error(
      'MFA_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes, for AES-256). ' +
        'Generate one with `openssl rand -hex 32`.',
    )
  }

  // The app's own runtime queries connect as this restricted role, not the
  // Postgres superuser — required so RLS policies (added in a later step)
  // will actually have any effect. Missing here should fail loudly at boot,
  // same as every other required secret above, rather than surfacing as a
  // confusing connection error deep inside drizzle.provider.ts.
  if (!process.env.POSTGRES_APP_USER) {
    throw new Error(
      'Missing required environment variable: POSTGRES_APP_USER. Run ' +
        '`npm run db:create-app-role` to create the restricted stride_app ' +
        'role, then set this to its name.',
    )
  }
  if (!process.env.POSTGRES_APP_PASSWORD) {
    throw new Error(
      'Missing required environment variable: POSTGRES_APP_PASSWORD. Set a ' +
        'long, random string (e.g. `openssl rand -hex 24`) before starting the app.',
    )
  }
}
