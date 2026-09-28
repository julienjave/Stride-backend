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

import { Resend } from 'resend'
import type { EmailTransport } from './email-transport'
import { LogTransport } from './transports/log.transport'
import { ResendTransport } from './transports/resend.transport'

// --- TYPES -------------------------------------------------------------------------------------------------

// Every value EMAIL_TRANSPORT may take. `as const` keeps the array's
// entries as literal types ('resend' | 'log') instead of widening them to
// `string`, so the type below is derived from the array: one list to
// extend when the SMTP transport arrives, and TypeScript follows.
//
// No in-memory kind here on purpose: the e2e tests' outbox is swapped in
// with overrideProvider(EMAIL_TRANSPORT), never selected by configuration,
// so no environment variable can ever route real users' mail into an array.
export const EMAIL_TRANSPORT_KINDS = ['resend', 'log'] as const
export type EmailTransportKind = (typeof EMAIL_TRANSPORT_KINDS)[number]

// --- VALIDATION --------------------------------------------------------------------------------------------

// The single place the email configuration rules live. Called twice:
// by validateEnv() at the very start of bootstrap(), so a bad value stops
// the app before anything is built, and by createEmailTransport() below,
// because the e2e tests build the app WITHOUT main.ts (and so without
// validateEnv()) — the rules still have to hold there.
//
// `env` defaults to process.env; the spec passes plain objects instead, so
// it never has to modify (and then restore) the real process environment.
export function getEmailTransportKind(
  env: NodeJS.ProcessEnv = process.env,
): EmailTransportKind {
  const value = env.EMAIL_TRANSPORT

  // Required, with no default. A silent default would have to be either
  // 'resend' (a fresh dev checkout then tries to email real people) or
  // 'log' (a production server with a forgotten variable then sends
  // nothing, and nobody notices until a user complains). Failing at boot
  // with a clear message is better than either.
  if (!value) {
    throw new Error(
      'Missing required environment variable: EMAIL_TRANSPORT. Set it to ' +
        '"resend" (real delivery) or "log" (print emails to the console, ' +
        'local development only).',
    )
  }

  // A type guard: `includes` on a readonly tuple of literals only accepts
  // those literals, so the plain string is widened for the check, and a
  // passing check narrows `value` to EmailTransportKind for the rest of
  // the function.
  if (!(EMAIL_TRANSPORT_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `EMAIL_TRANSPORT must be one of: ${EMAIL_TRANSPORT_KINDS.join(', ')} ` +
        `— got "${value}".`,
    )
  }
  const kind = value as EmailTransportKind

  // See LogTransport's comment: its output contains live reset and
  // invitation links, which must never end up in production logs.
  if (kind === 'log' && env.NODE_ENV === 'production') {
    throw new Error(
      'EMAIL_TRANSPORT=log is not allowed when NODE_ENV=production: it writes ' +
        'password reset and invitation links into the logs, where anyone ' +
        'with log access could use them. Use EMAIL_TRANSPORT=resend.',
    )
  }

  // Moved here from validateEnv(): the key is now only required when
  // Resend is the transport actually in use. A developer on
  // EMAIL_TRANSPORT=log no longer needs a Resend account at all.
  if (kind === 'resend' && !env.RESEND_API_KEY) {
    throw new Error(
      'Missing required environment variable: RESEND_API_KEY (required when ' +
        'EMAIL_TRANSPORT=resend). Set a real API key from your Resend dashboard.',
    )
  }

  return kind
}

// --- FACTORY -----------------------------------------------------------------------------------------------

// What EmailModule's provider runs (useFactory) to decide which transport
// Nest injects wherever EMAIL_TRANSPORT is asked for. Runs once, when the
// module is built — the choice is fixed for the life of the process.
export function createEmailTransport(
  env: NodeJS.ProcessEnv = process.env,
): EmailTransport {
  const kind = getEmailTransportKind(env)

  switch (kind) {
    case 'resend':
      // The Resend client is only constructed when Resend is chosen — its
      // constructor throws without an API key, which a 'log' setup
      // legitimately doesn't have.
      return new ResendTransport(new Resend(env.RESEND_API_KEY))
    case 'log':
      return new LogTransport()
    default: {
      // Exhaustiveness check. If every case above is handled, `kind` has
      // type `never` here and this line compiles. Add 'smtp' to
      // EMAIL_TRANSPORT_KINDS without a matching case, and `kind` becomes
      // 'smtp' here: the assignment fails to compile, pointing straight at
      // the missing branch.
      const unhandled: never = kind
      throw new Error(`Unhandled EMAIL_TRANSPORT: ${String(unhandled)}`)
    }
  }
}