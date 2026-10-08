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

import { createTransport } from 'nodemailer'
import { Resend } from 'resend'
import type { EmailTransport } from './email-transport'
import { LogTransport } from './transports/log.transport'
import { ResendTransport } from './transports/resend.transport'
import { SmtpTransport } from './transports/smtp.transport'

// --- TYPES -------------------------------------------------------------------------------------------------

// Every value EMAIL_TRANSPORT may take. `as const` keeps the array's
// entries as literal types ('resend' | 'log' | 'smtp') instead of widening
// them to `string`, so the type below is derived from the array: one list
// to extend, and TypeScript follows (see the factory's exhaustiveness
// check, which is what flagged the missing 'smtp' branch).
//
// No in-memory kind here on purpose: the e2e tests' outbox is swapped in
// with overrideProvider(EMAIL_TRANSPORT), never selected by configuration,
// so no environment variable can ever route real users' mail into an array.
export const EMAIL_TRANSPORT_KINDS = ['resend', 'log', 'smtp'] as const
export type EmailTransportKind = (typeof EMAIL_TRANSPORT_KINDS)[number]

// The SMTP settings, read and checked from SMTP_* variables. The shape
// nodemailer's createTransport() expects for these fields, so it's passed
// through as is.
export interface SmtpConfig {
  host: string
  port: number
  // true = TLS from the very first byte ("implicit TLS", port 465).
  // false = start in plain text; nodemailer still switches to TLS
  // (STARTTLS) when the server offers it. Mailpit doesn't by default.
  secure: boolean
  // Absent = no login. Mailpit accepts mail without one.
  auth?: { user: string; pass: string }
}

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
        '"resend" (real delivery), "smtp" (an SMTP server — Mailpit in ' +
        'local development) or "log" (print emails to the console, local ' +
        'development only).',
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

  // Checked at boot like everything above, rather than when the first
  // email is sent: a typo'd port should stop the app now, not fail an
  // invitation an hour later.
  if (kind === 'smtp') {
    getSmtpConfig(env)
  }

  return kind
}

// Reads and checks the SMTP_* variables (only consulted for
// EMAIL_TRANSPORT=smtp). Used both for validation (above) and by the
// factory, so the two can't disagree. Every message names the variable,
// since that's what the person has to fix.
export function getSmtpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig {
  const host = env.SMTP_HOST
  if (!host) {
    throw new Error(
      'Missing required environment variable: SMTP_HOST (required when ' +
        'EMAIL_TRANSPORT=smtp). For Mailpit from docker-compose.yml: 127.0.0.1.',
    )
  }

  // A port is a whole number from 1 to 65535. Number('') is 0 and
  // Number('25abc') is NaN, so the regex first insists on digits only —
  // parseInt('25abc') would quietly give 25.
  const rawPort = env.SMTP_PORT
  if (!rawPort) {
    throw new Error(
      'Missing required environment variable: SMTP_PORT (required when ' +
        'EMAIL_TRANSPORT=smtp). For Mailpit from docker-compose.yml: 1025.',
    )
  }
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error(
      `SMTP_PORT must be a whole number from 1 to 65535 — got "${rawPort}".`,
    )
  }

  // Optional, but only these two spellings: anything else ("yes", "1",
  // "TRUE") is far more likely a mistake than a choice, and guessing
  // wrong here means sending mail unencrypted.
  // Empty counts as unset, as everywhere else here: `SMTP_SECURE=` with
  // nothing after it is how a .env file leaves a value out.
  const rawSecure = env.SMTP_SECURE
  if (rawSecure && rawSecure !== 'true' && rawSecure !== 'false') {
    throw new Error(
      `SMTP_SECURE must be "true" or "false" — got "${rawSecure}".`,
    )
  }
  const secure = rawSecure === 'true'

  // Both or neither: a user with no password (or the reverse) can only be
  // a half-finished configuration.
  const user = env.SMTP_USER
  const pass = env.SMTP_PASS
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error(
      'SMTP_USER and SMTP_PASS must be set together (or both left out, for a ' +
        'server that needs no login, like Mailpit).',
    )
  }

  return {
    host,
    port,
    secure,
    ...(user && pass ? { auth: { user, pass } } : {}),
  }
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
    case 'smtp':
      // createTransport() doesn't connect yet: it opens a connection per
      // email, when sendMail() is called. Its default timeouts are long
      // (2 minutes to connect, 10 for a silent socket) — and POST /users
      // waits for the invitation email before answering — so they're
      // shortened: an unreachable server fails within seconds, and the
      // account is created with emailSent: false, ready to be resent.
      return new SmtpTransport(
        createTransport({
          ...getSmtpConfig(env),
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        }),
      )
    default: {
      // Exhaustiveness check. If every case above is handled, `kind` has
      // type `never` here and this line compiles. Add a kind to
      // EMAIL_TRANSPORT_KINDS without a matching case, and `kind` becomes
      // that kind here: the assignment fails to compile, pointing straight
      // at the missing branch — which is exactly what happened when 'smtp'
      // was added (TS2322: Type '"smtp"' is not assignable to type 'never').
      const unhandled: never = kind
      throw new Error(`Unhandled EMAIL_TRANSPORT: ${String(unhandled)}`)
    }
  }
}