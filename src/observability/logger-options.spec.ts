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

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { DrizzleQueryError } from 'drizzle-orm'
import pinoHttp from 'pino-http'
import request from 'supertest'
import { pinoHttpOptions } from './logger-options'

// The request logger's settings, run for real: a pino-http logger built from
// pinoHttpOptions() — what LoggerModule builds in the app — writing into an
// array instead of stdout, in front of a plain Node server. Requests carry
// everything a real one can (a search in the URL, a cookie, a referer, a
// browser's user agent, an id the client made up), and the test reads back
// every line that was written (decisions §32).

interface Line {
  level: number
  msg: string
  reqId?: string
  req?: unknown
  res?: unknown
  userId?: number
  err?: unknown
  [key: string]: unknown
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('pinoHttpOptions', () => {
  let server: Server
  const lines: Line[] = []

  beforeAll(() => {
    // No pino-pretty worker: the lines are JSON, written to the array.
    const logger = pinoHttp(
      { ...pinoHttpOptions(), transport: undefined },
      { write: (line: string) => lines.push(JSON.parse(line) as Line) },
    )
    server = createServer((req, res) => {
      // As passport would leave it for a signed-in request.
      ;(req as IncomingMessage & { user?: { id: number } }).user = { id: 5 }
      logger(req, res, () => {
        if (req.url?.startsWith('/fail')) {
          req.log.error(
            {
              err: new DrizzleQueryError(
                'insert into "messages" ("body") values ($1)',
                ['My knee still hurts — jane@example.com'],
                Object.assign(new Error('refused'), {
                  code: '23514',
                  detail: 'Failing row contains (My knee still hurts).',
                }),
              ),
            },
            'Unhandled exception on POST /fail',
          )
          res.statusCode = 500
          res.end()
          return
        }
        req.log.info('looking up jane@example.com')
        res.end('ok')
      })
    })
  })

  afterAll(() => server.close())
  beforeEach(() => {
    lines.length = 0
  })

  // The "request completed" line is written when the answer finishes, which
  // can be a moment after the client has it.
  async function send(path: string) {
    const response = await request(server)
      .get(path)
      .set('Cookie', 'connect.sid=s%3Alive-session')
      .set('Referer', 'http://localhost:5173/admin/users?search=Jane')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) TestBrowser/1')
      .set('X-Request-Id', 'chosen-by-the-client')
    await new Promise((resolve) => setImmediate(resolve))
    return response
  }

  it('gives the request a random id, in the header and on every line', async () => {
    const response = await send('/admin/users?search=Jane%20Doe')
    const id = response.headers['x-request-id']
    expect(id).toMatch(UUID)
    expect(lines).toHaveLength(2)
    // The line logged DURING the request: only the id (quietReqLogger).
    expect(lines[0].reqId).toBe(id)
    expect(lines[0].req).toBeUndefined()
    // The request's own line: the id, inside `req`.
    expect(lines[1].msg).toBe('request completed')
    expect(lines[1].req).toStrictEqual({
      id,
      method: 'GET',
      url: '/admin/users',
    })
  })

  it('makes a new id for each request', async () => {
    const first = await send('/a')
    const second = await send('/a')
    expect(first.headers['x-request-id']).not.toBe(
      second.headers['x-request-id'],
    )
  })

  // The request line: which request, who (by id), and the status — nothing
  // else pino would write by default (headers, IP, port, query).
  it('writes the path, the user id and the status — no headers, no IP', async () => {
    await send('/admin/users?search=Jane%20Doe')
    const completed = lines[1]
    expect(completed.res).toStrictEqual({ statusCode: 200 })
    expect(completed.userId).toBe(5)
    const written = JSON.stringify(lines)
    for (const leak of [
      'Jane',
      'search',
      'live-session',
      'localhost:5173',
      'TestBrowser',
      'chosen-by-the-client',
      '127.0.0.1',
      '::1',
      'remoteAddress',
    ]) {
      expect(written).not.toContain(leak)
    }
  })

  // The hook: an address in a message becomes "[email]".
  it('takes email addresses out of every message', async () => {
    await send('/a')
    expect(lines[0].msg).toBe('looking up [email]')
  })

  // An error line goes through the allow-list: no query values, no
  // Postgres `detail` — and a failed request's line says 500.
  it("writes an error without what was written, and the request's 500", async () => {
    const response = await send('/fail?patient=Jane')
    const [errorLine, completed] = lines
    expect(errorLine.reqId).toBe(response.headers['x-request-id'])
    expect(errorLine.err).toMatchObject({
      type: 'DrizzleQueryError',
      message:
        'Failed query: insert into "messages" ("body") values ($1)\nparams: [redacted]',
      cause: { type: 'Error', message: 'refused', code: '23514' },
    })
    expect(completed.res).toStrictEqual({ statusCode: 500 })
    const written = JSON.stringify(lines)
    expect(written).not.toContain('knee')
    expect(written).not.toContain('jane')
    expect(written).not.toContain('detail')
  })
})
