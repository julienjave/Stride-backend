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
} from './email-transport.config'
import { LogTransport } from './transports/log.transport'
import { ResendTransport } from './transports/resend.transport'

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
    expect(() => getEmailTransportKind({ EMAIL_TRANSPORT: 'smtp' })).toThrow(
      'EMAIL_TRANSPORT must be one of: resend, log — got "smtp".',
    )
  })

  // Values are matched exactly: 'Resend' is a typo, not a synonym.
  it('is case-sensitive', () => {
    expect(() =>
      getEmailTransportKind({ EMAIL_TRANSPORT: 'Resend', RESEND_API_KEY: 'k' }),
    ).toThrow('EMAIL_TRANSPORT must be one of: resend, log — got "Resend".')
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