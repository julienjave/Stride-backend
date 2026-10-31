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

import { parseDsn } from './dsn'
import {
  EnvelopeError,
  parseEnvelope,
  rewriteBrowserEnvelope,
  serializeEnvelope,
  UnknownProjectError,
} from './envelope'

// Sentry's envelope format, and what the tunnel makes of a browser's
// (decisions §32).

const DSN_TEXT = 'http://browserkey@glitchtip:8000/2'
const DSN = parseDsn(DSN_TEXT, 'SENTRY_BROWSER_DSN')

function lines(...parts: unknown[]): Buffer {
  return Buffer.from(
    parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join('\n'),
  )
}

describe('parseEnvelope', () => {
  it('reads the header and each item, with or without a length', () => {
    // "é" is ONE character and TWO bytes: a length counts bytes.
    const binary = 'é\nx'
    const body = Buffer.concat([
      lines({ event_id: 'e1' }, { type: 'event' }, { message: 'a' }, ''),
      Buffer.from(
        `${JSON.stringify({ type: 'attachment', length: Buffer.byteLength(binary) })}\n`,
      ),
      Buffer.from(binary),
      Buffer.from('\n'),
      lines({ type: 'session' }, { sid: 's' }),
    ])
    const { header, items } = parseEnvelope(body)
    expect(header).toStrictEqual({ event_id: 'e1' })
    expect(
      items.map((item) => [item.header.type, item.payload.toString('utf8')]),
    ).toStrictEqual([
      ['event', '{"message":"a"}'],
      ['attachment', binary],
      ['session', '{"sid":"s"}'],
    ])
  })

  it('takes an item without a payload as empty, and skips blank lines', () => {
    const { items } = parseEnvelope(lines({}, '', { type: 'event' }))
    expect(items).toHaveLength(1)
    expect(items[0].payload).toHaveLength(0)
  })

  it.each([
    ['nothing', Buffer.alloc(0), 'An envelope needs a header'],
    [
      'a header that is not JSON',
      Buffer.from('hello'),
      "The envelope header isn't JSON",
    ],
    [
      'a header that is an array',
      Buffer.from('[1]'),
      "The envelope header isn't a JSON object",
    ],
    [
      'an item header that is not JSON',
      lines({}, 'nope'),
      "An item header isn't JSON",
    ],
    [
      'a length past the end',
      lines({}, { type: 'event', length: 99 }, 'short'),
      "An item's length doesn't match the envelope",
    ],
    [
      'a negative length',
      lines({}, { type: 'event', length: -1 }, 'x'),
      "An item's length doesn't match the envelope",
    ],
  ])('refuses %s', (_what, body, message) => {
    expect(() => parseEnvelope(body)).toThrow(new EnvelopeError(message))
  })
})

describe('serializeEnvelope', () => {
  it('writes each item with its length in bytes, readable back', () => {
    const body = serializeEnvelope({ event_id: 'e1' }, [
      { type: 'event', payload: '{"message":"é"}' },
    ])
    expect(body.toString('utf8')).toBe(
      '{"event_id":"e1"}\n{"type":"event","length":16}\n{"message":"é"}\n',
    )
    expect(parseEnvelope(body).items[0].payload.toString('utf8')).toBe(
      '{"message":"é"}',
    )
  })
})

describe('rewriteBrowserEnvelope', () => {
  const event = {
    event_id: 'e1',
    message: 'Failed for jane@example.com',
    user: { id: '999', email: 'jane@example.com', ip_address: '203.0.113.7' },
    request: {
      url: 'http://localhost:5173/admin/users?search=Jane',
      headers: { Referer: 'x' },
    },
    breadcrumbs: [{ category: 'ui.click', message: "button 'Open Pat Lee'" }],
    extra: { note: 'knee' },
  }
  const header = {
    event_id: 'e1',
    sent_at: '2031-03-04T10:00:00.000Z',
    dsn: DSN_TEXT,
    sdk: { name: 'sentry.javascript.react', version: '11.7.0' },
    trace: { user_segment: 'Jane' },
  }

  it("keeps the error events only, scrubbed, with the session's user", () => {
    const body = lines(
      header,
      { type: 'event' },
      event,
      { type: 'session' },
      { sid: 's' },
      { type: 'client_report' },
      {},
    )
    const out = rewriteBrowserEnvelope(body, DSN, 42)!
    const { header: outHeader, items } = parseEnvelope(out)
    expect(outHeader).toStrictEqual({
      event_id: 'e1',
      sent_at: '2031-03-04T10:00:00.000Z',
      dsn: DSN_TEXT,
    })
    expect(items.map((item) => item.header.type)).toStrictEqual(['event'])
    expect(JSON.parse(items[0].payload.toString('utf8'))).toStrictEqual({
      event_id: 'e1',
      message: 'Failed for [email]',
      user: { id: '42' },
      request: { url: 'http://localhost:5173/admin/users' },
      breadcrumbs: [],
    })
    expect(out.toString('utf8')).not.toMatch(
      /Jane|jane|knee|Pat Lee|203\.0|999/,
    )
  })

  it('has no user when nobody is signed in — whatever the page claims', () => {
    const out = rewriteBrowserEnvelope(
      lines(header, { type: 'event' }, event),
      DSN,
      null,
    )!
    expect(
      JSON.parse(parseEnvelope(out).items[0].payload.toString('utf8')),
    ).not.toHaveProperty('user')
  })

  it('answers null when no error event is left', () => {
    expect(
      rewriteBrowserEnvelope(
        lines(header, { type: 'session' }, { sid: 's' }),
        DSN,
        null,
      ),
    ).toBeNull()
  })

  it.each([
    ['another key', { ...header, dsn: 'http://otherkey@glitchtip:8000/2' }],
    [
      'another project',
      { ...header, dsn: 'http://browserkey@glitchtip:8000/1' },
    ],
    ['another server', { ...header, dsn: 'http://browserkey@sentry.io/2' }],
    ['no dsn', { event_id: 'e1' }],
    ['a dsn that is not one', { ...header, dsn: 'nonsense' }],
  ])('refuses %s', (_what, otherHeader) => {
    expect(() =>
      rewriteBrowserEnvelope(
        lines(otherHeader, { type: 'event' }, event),
        DSN,
        null,
      ),
    ).toThrow(UnknownProjectError)
  })

  it('refuses an event that is not a JSON object', () => {
    expect(() =>
      rewriteBrowserEnvelope(
        lines(header, { type: 'event' }, '"text"'),
        DSN,
        null,
      ),
    ).toThrow(new EnvelopeError("An event isn't a JSON object"))
  })
})
