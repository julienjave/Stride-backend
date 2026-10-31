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

import { Readable } from 'node:stream'
import {
  BadGatewayException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common'
import type { Request } from 'express'
import { MonitoringController, readBody } from './monitoring.controller'

// The tunnel's two cases the e2e suite can't easily reach: reporting OFF
// (no SENTRY_BROWSER_DSN when the app is built) and GlitchTip UNREACHABLE.
// The rest — forwarding, scrubbing, every refusal — is
// test/monitoring.e2e-spec.ts, through the real app.

const DSN = 'http://browserkey@glitchtip:8000/2'

function controllerWith(dsn: string | undefined) {
  const previous = process.env.SENTRY_BROWSER_DSN
  if (dsn === undefined) delete process.env.SENTRY_BROWSER_DSN
  else process.env.SENTRY_BROWSER_DSN = dsn
  try {
    return new MonitoringController()
  } finally {
    if (previous === undefined) delete process.env.SENTRY_BROWSER_DSN
    else process.env.SENTRY_BROWSER_DSN = previous
  }
}

function envelopeRequest(): Request {
  const body = [
    JSON.stringify({ dsn: DSN }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({ message: 'm' }),
  ].join('\n')
  return Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { 'content-type': 'text/plain' },
  }) as unknown as Request
}

describe('MonitoringController', () => {
  afterEach(() => jest.restoreAllMocks())

  it('answers 404 when the browser has no project (reporting off)', async () => {
    await expect(
      controllerWith(undefined).receive(envelopeRequest()),
    ).rejects.toThrow(
      new NotFoundException('Error reporting is not set up on this server'),
    )
  })

  // GlitchTip down (a restart): a 502, and a warning that names the reason —
  // never the report.
  it('answers 502 when GlitchTip is unreachable, logging why', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connect ECONNREFUSED 172.18.0.5:8000'))
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    await expect(
      controllerWith(DSN).receive(envelopeRequest()),
    ).rejects.toThrow(
      new BadGatewayException('The report could not be passed on'),
    )
    expect(warned.mock.calls).toStrictEqual([
      [
        'Could not pass a browser error report on: connect ECONNREFUSED 172.18.0.5:8000',
      ],
    ])
  })

  it('logs the status GlitchTip refused with', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 429 }))
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    await expect(
      controllerWith(DSN).receive(envelopeRequest()),
    ).rejects.toThrow(BadGatewayException)
    expect(warned.mock.calls).toStrictEqual([
      ['GlitchTip refused a browser error report: 429'],
    ])
  })
})

describe('readBody', () => {
  it('joins the chunks, strings included', async () => {
    const body = await readBody(Readable.from([Buffer.from('ab'), 'cé']), 10)
    expect(body.toString('utf8')).toBe('abcé')
  })

  // The limit counts BYTES as they arrive: exactly at it passes, one over
  // stops — before the rest is read.
  it('refuses one byte over the limit', async () => {
    await expect(
      readBody(Readable.from([Buffer.alloc(4), Buffer.alloc(1)]), 5),
    ).resolves.toHaveLength(5)
    await expect(
      readBody(Readable.from([Buffer.alloc(4), Buffer.alloc(2)]), 5),
    ).rejects.toThrow(
      new PayloadTooLargeException('An error report can be at most 5 bytes'),
    )
  })
})
