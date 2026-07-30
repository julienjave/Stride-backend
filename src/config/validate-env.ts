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
}