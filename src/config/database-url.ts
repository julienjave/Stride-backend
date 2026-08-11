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

export function getDatabaseUrl(): string {
  const {
    POSTGRES_HOST = 'localhost',
    POSTGRES_PORT = '5432',
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
  } = process.env

  const missing = [
    !POSTGRES_USER && 'POSTGRES_USER',
    !POSTGRES_PASSWORD && 'POSTGRES_PASSWORD',
    !POSTGRES_DB && 'POSTGRES_DB',
  ].filter(Boolean)

  if (missing.length > 0) {
    throw new Error(
      `Missing required Postgres environment variables: ${missing.join(', ')}`,
    )
  }

  return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`
}

// Same shape as getDatabaseUrl(), but for the restricted, non-superuser,
// non-table-owning role (stride_app) that the app's own runtime queries
// connect as — RLS policies have no effect at all on a superuser or table
// owner connection, so this is the connection every real policy will
// eventually depend on. Everything that genuinely needs owner/superuser
// rights (drizzle-kit migrations, the session pool, this role's own setup
// script) stays on getDatabaseUrl() and is unaffected by this function.
export function getAppDatabaseUrl(): string {
  const {
    POSTGRES_HOST = 'localhost',
    POSTGRES_PORT = '5432',
    POSTGRES_APP_USER,
    POSTGRES_APP_PASSWORD,
    POSTGRES_DB,
  } = process.env

  const missing = [
    !POSTGRES_APP_USER && 'POSTGRES_APP_USER',
    !POSTGRES_APP_PASSWORD && 'POSTGRES_APP_PASSWORD',
    !POSTGRES_DB && 'POSTGRES_DB',
  ].filter(Boolean)

  if (missing.length > 0) {
    throw new Error(
      `Missing required Postgres environment variables: ${missing.join(', ')}`,
    )
  }

  return `postgresql://${POSTGRES_APP_USER}:${POSTGRES_APP_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`
}
