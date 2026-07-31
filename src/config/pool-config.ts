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


// Centralizes Postgres connection pool sizing — used by BOTH the main
// Drizzle pool (drizzle.provider.ts) and the session-store pool (main.ts),
// so the two can be tuned independently but through one consistent,
// documented mechanism, rather than each silently inheriting pg's own
// unconfigured defaults (max: 10, and critically, NO connection timeout at
// all — meaning a fully exhausted pool would hang requests indefinitely
// rather than failing fast with a clear error).
//
// Defaults here match what pg's own defaults WERE for `max`, deliberately —
// this changes nothing about current behavior by default. What changes is
// that the value is now explicit and independently tunable per deployment,
// rather than invisible.
export function getPoolConfig(role: 'app' | 'session') {
  const maxEnvVar = role === 'app' ? 'DATABASE_POOL_MAX' : 'SESSION_POOL_MAX'
  // The main app pool serves every regular query; the session pool only
  // ever does simple, fast lookups on deserializeUser — a smaller default
  // is reasonable there, though both are fully overridable per deployment.
  const defaultMax = role === 'app' ? 10 : 5

  return {
    max: Number(process.env[maxEnvVar] ?? defaultMax),
    // pg's own default is 0 — no timeout, wait forever. 5 seconds is a
    // deliberate, fast-failing alternative: if the pool is genuinely
    // exhausted, callers get a clear error quickly, rather than a hung
    // request with no indication anything is wrong.
    connectionTimeoutMillis: Number(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ?? 5000),
  }
}