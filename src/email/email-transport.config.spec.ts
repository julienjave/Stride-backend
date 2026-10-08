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

import {
  createEmailTransport,
  getEmailTransportKind,
  getSmtpConfig,
} from './email-transport.config'
import { LogTransport } from './transports/log.transport'
import { ResendTransport } from './transports/resend.transport'
import { SmtpTransport } from './transports/smtp.transport'

// The smallest valid SMTP setup: Mailpit from docker-compose.yml, by IP
// address (see .env.example for why not "localhost").
const MAILPIT = { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' }

// Each rule is checked by its exact error message, not just "it throws":
// several rules throw a plain Error, so a test expecting only a throw
// would still pass if a DIFFERENT rule were the one firing.
describe('getEmailTransportKind', () => {
  it('accepts resend when an API key is set', () => {
    expect(
      getEmailTransportKind({
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_key',
      }),
    ).toBe('resend')
  })

  it('accepts log outside production, with no Resend key at all', () => {
    expect(getEmailTransportKind({ EMAIL_TRANSPORT: 'log' })).toBe('log')
    expect(
      getEmailTransportKind({
        EMAIL_TRANSPORT: 'log',
        NODE_ENV: 'development',
      }),
    ).toBe('log')
  })

  // The parity case for the production rule below: resend in production
  // must stay allowed, or "refuse log in production" could be implemented
  // as "refuse everything in production" and still pass.
  it('accepts resend in production', () => {
    expect(
      getEmailTransportKind({
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_key',
        NODE_ENV: 'production',
      }),
    ).toBe('resend')
  })

  it('refuses a missing EMAIL_TRANSPORT', () => {
    expect(() => getEmailTransportKind({})).toThrow(
      'Missing required environment variable: EMAIL_TRANSPORT.',
    )
  })

  it('refuses an empty EMAIL_TRANSPORT the same way as a missing one', () => {
    expect(() => getEmailTransportKind({ EMAIL_TRANSPORT: '' })).toThrow(
      'Missing required environment variable: EMAIL_TRANSPORT.',
    )
  })

  it('refuses an unknown value, naming the allowed ones', () => {
    expect(() =>
      getEmailTransportKind({ EMAIL_TRANSPORT: 'sendgrid' }),
    ).toThrow(
      'EMAIL_TRANSPORT must be one of: resend, log, smtp — got "sendgrid".',
    )
  })

  // Values are matched exactly: 'Resend' is a typo, not a synonym.
  it('is case-sensitive', () => {
    expect(() =>
      getEmailTransportKind({ EMAIL_TRANSPORT: 'Resend', RESEND_API_KEY: 'k' }),
    ).toThrow(
      'EMAIL_TRANSPORT must be one of: resend, log, smtp — got "Resend".',
    )
  })

  it('refuses log in production', () => {
    expect(() =>
      getEmailTransportKind({ EMAIL_TRANSPORT: 'log', NODE_ENV: 'production' }),
    ).toThrow('EMAIL_TRANSPORT=log is not allowed when NODE_ENV=production')
  })

  it('refuses resend without an API key', () => {
    expect(() => getEmailTransportKind({ EMAIL_TRANSPORT: 'resend' })).toThrow(
      'Missing required environment variable: RESEND_API_KEY (required when EMAIL_TRANSPORT=resend).',
    )
  })

  it('accepts smtp with a host and a port, and needs no Resend key', () => {
    expect(getEmailTransportKind({ EMAIL_TRANSPORT: 'smtp', ...MAILPIT })).toBe(
      'smtp',
    )
  })

  // SMTP is a real delivery protocol (Resend itself offers it), so unlike
  // log it isn't refused in production.
  it('accepts smtp in production', () => {
    expect(
      getEmailTransportKind({
        EMAIL_TRANSPORT: 'smtp',
        NODE_ENV: 'production',
        ...MAILPIT,
      }),
    ).toBe('smtp')
  })

  // At boot, not at the first email: the SMTP settings are part of the
  // check. (Each rule itself is tested on getSmtpConfig below.)
  it('refuses smtp with incomplete SMTP settings', () => {
    expect(() => getEmailTransportKind({ EMAIL_TRANSPORT: 'smtp' })).toThrow(
      'Missing required environment variable: SMTP_HOST',
    )
  })
})

describe('getSmtpConfig', () => {
  it('reads host and port, with no TLS from the start and no login by default', () => {
    // toStrictEqual, not toEqual: toEqual treats a key holding undefined
    // as if it were absent, so it couldn't tell `{ …, auth: undefined }`
    // from no `auth` key at all. With no login there's no key.
    expect(getSmtpConfig(MAILPIT)).toStrictEqual({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
    })
  })

  it('refuses a missing SMTP_HOST', () => {
    expect(() => getSmtpConfig({ SMTP_PORT: '1025' })).toThrow(
      'Missing required environment variable: SMTP_HOST (required when EMAIL_TRANSPORT=smtp).',
    )
  })

  it('refuses a missing or empty SMTP_PORT', () => {
    const message =
      'Missing required environment variable: SMTP_PORT (required when EMAIL_TRANSPORT=smtp).'
    expect(() => getSmtpConfig({ SMTP_HOST: '127.0.0.1' })).toThrow(message)
    expect(() =>
      getSmtpConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '' }),
    ).toThrow(message)
  })

  it.each(['25abc', '-25', '10.5', ' 25', '0', '65536'])(
    'refuses SMTP_PORT=%j',
    (port) => {
      expect(() =>
        getSmtpConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: port }),
      ).toThrow(
        `SMTP_PORT must be a whole number from 1 to 65535 — got "${port}".`,
      )
    },
  )

  // The two edges of the range, so neither bound can drift by one.
  it.each([
    ['1', 1],
    ['65535', 65535],
  ])('accepts SMTP_PORT=%j', (port, expected) => {
    expect(
      getSmtpConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: port }).port,
    ).toBe(expected)
  })

  it('reads SMTP_SECURE=true and SMTP_SECURE=false', () => {
    expect(getSmtpConfig({ ...MAILPIT, SMTP_SECURE: 'true' }).secure).toBe(true)
    expect(getSmtpConfig({ ...MAILPIT, SMTP_SECURE: 'false' }).secure).toBe(
      false,
    )
  })

  it('treats an empty SMTP_SECURE as unset (false)', () => {
    expect(getSmtpConfig({ ...MAILPIT, SMTP_SECURE: '' }).secure).toBe(false)
  })

  it.each(['TRUE', '1', 'yes'])('refuses SMTP_SECURE=%j', (value) => {
    expect(() => getSmtpConfig({ ...MAILPIT, SMTP_SECURE: value })).toThrow(
      `SMTP_SECURE must be "true" or "false" — got "${value}".`,
    )
  })

  it('passes a login on when both SMTP_USER and SMTP_PASS are set', () => {
    expect(
      getSmtpConfig({ ...MAILPIT, SMTP_USER: 'stride', SMTP_PASS: 's3cret' }),
    ).toEqual({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      auth: { user: 'stride', pass: 's3cret' },
    })
  })

  it.each([{ SMTP_USER: 'stride' }, { SMTP_PASS: 's3cret' }])(
    'refuses half a login (%j)',
    (half) => {
      expect(() => getSmtpConfig({ ...MAILPIT, ...half })).toThrow(
        'SMTP_USER and SMTP_PASS must be set together',
      )
    },
  )
})

describe('createEmailTransport', () => {
  it('builds a ResendTransport for resend', () => {
    expect(
      createEmailTransport({
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_key',
      }),
    ).toBeInstanceOf(ResendTransport)
  })

  it('builds an SmtpTransport for smtp', () => {
    expect(
      createEmailTransport({ EMAIL_TRANSPORT: 'smtp', ...MAILPIT }),
    ).toBeInstanceOf(SmtpTransport)
  })

  it('builds a LogTransport for log', () => {
    expect(createEmailTransport({ EMAIL_TRANSPORT: 'log' })).toBeInstanceOf(
      LogTransport,
    )
  })

  // The factory is what runs in the e2e tests, where validateEnv() never
  // does — so it must apply the same rules itself, not trust they were
  // already checked.
  it('applies the same rules as getEmailTransportKind', () => {
    expect(() =>
      createEmailTransport({ EMAIL_TRANSPORT: 'log', NODE_ENV: 'production' }),
    ).toThrow('EMAIL_TRANSPORT=log is not allowed when NODE_ENV=production')
  })
})