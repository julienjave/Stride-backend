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

import type { ErrorEvent } from '@sentry/nestjs'
import { type Dsn, parseDsn, sameProject } from './dsn'
import { scrubEvent } from './report-scrub'

// --- THE FORMAT --------------------------------------------------------------------------------------------

// An ENVELOPE is how Sentry's SDKs (and so GlitchTip's ingestion) carry
// reports: newline-separated JSON, one header for the whole envelope, then
// any number of ITEMS, each an item header and a payload —
//
//   {"event_id":"9ec7…","sent_at":"…","dsn":"http://key@glitchtip:8000/2"}\n
//   {"type":"event"}\n
//   {"exception":{…},"request":{…},…}\n
//   {"type":"client_report"}\n
//   {…}
//
// An item header MAY give the payload's `length` in BYTES (binary
// attachments need it); without one, the payload runs to the next newline.
// So the parsing works on bytes (a Buffer), not on characters: "é" is one
// character and two bytes.
//
// What the tunnel (POST /monitoring) does with one, in order:
//   1. read the header, and refuse an envelope for any other project than
//      OUR frontend's (SENTRY_BROWSER_DSN) — the tunnel is not an open relay;
//   2. keep the ERROR events only ("event" items) — sessions, client reports,
//      performance data, session replays, attachments are dropped unread;
//   3. rebuild each event through scrubEvent, with the user taken from the
//      SESSION, not from what the page says;
//   4. write a new envelope of what is left (or nothing, if nothing is).

export interface EnvelopeHeader {
  event_id?: string
  sent_at?: string
  dsn?: string
  sdk?: { name?: string; version?: string }
}

export interface EnvelopeItem {
  header: { type?: string; [key: string]: unknown }
  payload: Buffer
}

export class EnvelopeError extends Error {}

export function parseEnvelope(body: Buffer): {
  header: EnvelopeHeader
  items: EnvelopeItem[]
} {
  let position = 0
  // The next line, without its newline; null at the end.
  const nextLine = (): Buffer | null => {
    if (position >= body.length) return null
    const end = body.indexOf(0x0a, position)
    const line = body.subarray(position, end === -1 ? body.length : end)
    position = end === -1 ? body.length : end + 1
    return line
  }
  const headerLine = nextLine()
  if (!headerLine) throw new EnvelopeError('An envelope needs a header')
  const header = parseJsonObject(
    headerLine,
    'The envelope header',
  ) as EnvelopeHeader

  const items: EnvelopeItem[] = []
  for (;;) {
    const itemHeaderLine = nextLine()
    if (itemHeaderLine === null) break
    if (itemHeaderLine.length === 0) continue // a trailing newline
    const itemHeader = parseJsonObject(itemHeaderLine, 'An item header')
    let payload: Buffer
    if (typeof itemHeader.length === 'number') {
      const length = itemHeader.length
      if (
        !Number.isInteger(length) ||
        length < 0 ||
        position + length > body.length
      ) {
        throw new EnvelopeError("An item's length doesn't match the envelope")
      }
      payload = body.subarray(position, position + length)
      position += length
      if (body[position] === 0x0a) position += 1
    } else {
      payload = nextLine() ?? Buffer.alloc(0)
    }
    items.push({ header: itemHeader, payload })
  }
  return { header, items }
}

export function serializeEnvelope(
  header: EnvelopeHeader,
  items: { type: string; payload: string }[],
): Buffer {
  const parts: Buffer[] = [Buffer.from(`${JSON.stringify(header)}\n`)]
  for (const item of items) {
    const payload = Buffer.from(item.payload)
    parts.push(
      Buffer.from(
        `${JSON.stringify({ type: item.type, length: payload.length })}\n`,
      ),
      payload,
      Buffer.from('\n'),
    )
  }
  return Buffer.concat(parts)
}

// --- THE TUNNEL'S REWRITE ----------------------------------------------------------------------------------

export class UnknownProjectError extends Error {}

// The envelope to forward, or null when no error event is left. Throws
// EnvelopeError for something that isn't an envelope, UnknownProjectError
// for another project's.
export function rewriteBrowserEnvelope(
  body: Buffer,
  expected: Dsn,
  userId: number | null,
): Buffer | null {
  const { header, items } = parseEnvelope(body)
  let dsn: Dsn
  try {
    dsn = parseDsn(String(header.dsn ?? ''), 'The envelope dsn')
  } catch {
    throw new UnknownProjectError('The envelope names no project')
  }
  if (!sameProject(dsn, expected)) {
    throw new UnknownProjectError('The envelope is for another project')
  }

  const events = items
    .filter((item) => item.header.type === 'event')
    .map((item) => {
      // Typed as the SDK's event to read it; every field is checked or
      // copied by name in scrubEvent, never trusted as a whole.
      const event = parseJsonObject(
        item.payload,
        'An event',
      ) as unknown as ErrorEvent
      return JSON.stringify(scrubEvent(event, { userId }))
    })
  if (events.length === 0) return null

  // A new header from known fields only: the SDK's own (`trace`, with the
  // page's user segment and more) is not carried over.
  const rebuilt: EnvelopeHeader = {
    event_id: typeof header.event_id === 'string' ? header.event_id : undefined,
    sent_at: typeof header.sent_at === 'string' ? header.sent_at : undefined,
    dsn: header.dsn,
  }
  return serializeEnvelope(
    JSON.parse(JSON.stringify(rebuilt)) as EnvelopeHeader,
    events.map((payload) => ({ type: 'event', payload })),
  )
}

// --- HELPERS -----------------------------------------------------------------------------------------------

function parseJsonObject(bytes: Buffer, what: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new EnvelopeError(`${what} isn't JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnvelopeError(`${what} isn't a JSON object`)
  }
  return value as Record<string, unknown>
}
