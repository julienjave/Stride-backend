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

  // Email sending is now a real, working feature (Resend),
  // a missing key here would otherwise only surface the first
  // time someone actually requests a password reset, as a confusing runtime
  // failure deep inside EmailService, rather than a clear error at boot.
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      'Missing required environment variable: RESEND_API_KEY. Set a real API key ' +
        'from your Resend dashboard before starting the app.',
    )
  }

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
}
