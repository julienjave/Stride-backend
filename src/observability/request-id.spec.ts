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

import type { IncomingMessage, ServerResponse } from 'node:http'
import { assignRequestId, referenceOf, requestIdOf } from './request-id'

// A v4 UUID, as randomUUID() makes them.
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function fakeExchange(
  request: Record<string, unknown> = {},
  headersSent = false,
) {
  const setHeader = jest.fn<void, [string, string]>()
  return {
    req: request as unknown as IncomingMessage,
    res: { setHeader, headersSent } as unknown as ServerResponse,
    setHeader,
  }
}

describe('assignRequestId', () => {
  it('makes a random id, keeps it on the request and puts it in the header', () => {
    const { req, res, setHeader } = fakeExchange()
    const id = assignRequestId(req, res)
    expect(id).toMatch(UUID)
    expect(req.id).toBe(id)
    expect(setHeader.mock.calls).toStrictEqual([['X-Request-Id', id]])
  })

  // The logger's middleware asks first, the exception filter later: one id.
  it('answers the same id when asked again, and sets the header once', () => {
    const { req, res, setHeader } = fakeExchange()
    const first = assignRequestId(req, res)
    expect(assignRequestId(req, res)).toBe(first)
    expect(setHeader).toHaveBeenCalledTimes(1)
  })

  it('makes a new one for every request', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => {
        const { req, res } = fakeExchange()
        return assignRequestId(req, res)
      }),
    )
    expect(ids.size).toBe(50)
  })

  // A header can't be added to an answer already on its way (Node throws).
  it("doesn't touch the header once the answer has started", () => {
    const { req, res, setHeader } = fakeExchange({}, true)
    expect(assignRequestId(req, res)).toMatch(UUID)
    expect(setHeader).not.toHaveBeenCalled()
  })

  // What the CLIENT sent never becomes the id: the header it chose is not
  // read at all (the function never looks at req.headers).
  it('ignores an X-Request-Id the client sent', () => {
    const { req, res } = fakeExchange({
      headers: { 'x-request-id': 'chosen-by-the-client' },
    })
    expect(assignRequestId(req, res)).toMatch(UUID)
  })
})

describe('requestIdOf', () => {
  it('reads a string id', () => {
    const { req } = fakeExchange({ id: 'abc' })
    expect(requestIdOf(req)).toBe('abc')
  })

  // pino-http's default counter would be a number: not one of ours.
  it('ignores anything else', () => {
    expect(requestIdOf(fakeExchange({ id: 3 }).req)).toBeUndefined()
    expect(requestIdOf(fakeExchange().req)).toBeUndefined()
  })
})

describe('referenceOf', () => {
  // What an error screen shows: the first 8 characters, the part before the
  // first dash of a UUID.
  it('is the id shortened to 8 characters', () => {
    expect(referenceOf('7f3a1c2e-9b4d-4e1f-8a2b-3c4d5e6f7a8b')).toBe('7f3a1c2e')
  })
})
