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

import type { ErrorEvent } from '@sentry/nestjs'
import { scrubBreadcrumb, scrubEvent } from './report-scrub'

// What an error report may hold (decisions §32). The events below carry
// everything an SDK can put in one — the planted personal data is what must
// NOT come out.

const PLANTED = [
  'jane@example.com',
  'Jane',
  'knee still hurts',
  'search=',
  'connect.sid',
  '203.0.113.7',
  'Mozilla',
  'secret-local',
  'Open Pat Lee',
  'lodash',
  'stride-api-7f9c',
]

function backendEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: 'e1',
    timestamp: 1_900_000_000,
    platform: 'node',
    level: 'error',
    release: 'abc123',
    environment: 'production',
    server_name: 'stride-api-7f9c',
    sdk: {
      name: 'sentry.javascript.nestjs',
      version: '11.7.0',
      integrations: ['Http'],
    },
    transaction: 'GET /admin/users?search=Jane',
    message: 'Failed for jane@example.com',
    exception: {
      values: [
        {
          type: 'Error',
          value: 'refused',
          mechanism: {
            type: 'generic',
            handled: true,
            data: { secret: 'jane@example.com' },
          },
          stacktrace: {
            frames: [
              {
                filename: '/app/dist/users/users.service.js',
                function: 'UsersService.update',
                lineno: 10,
                colno: 5,
                in_app: true,
                pre_context: ['  const a = 1'],
                context_line: '  throw new Error(x)',
                post_context: ['}'],
                vars: {
                  note: 'knee still hurts',
                  email: 'jane@example.com',
                  token: 'secret-local',
                },
              },
            ],
          },
        },
        {
          type: 'DrizzleQueryError',
          value:
            'Failed query: update "users" set "note" = $1\nparams: knee still hurts,Jane',
        },
      ],
    },
    request: {
      method: 'PATCH',
      url: 'http://localhost:3000/admin/users?search=Jane',
      query_string: 'search=Jane',
      headers: { cookie: 'connect.sid=s%3Aabc', 'user-agent': 'Mozilla/5.0' },
      cookies: { 'connect.sid': 'abc' },
      data: { note: 'knee still hurts' },
      env: { REMOTE_ADDR: '203.0.113.7' },
    },
    user: {
      id: 7,
      email: 'jane@example.com',
      username: 'Jane',
      ip_address: '203.0.113.7',
    },
    tags: {
      requestId: 'r-1',
      where: 'http',
      route: 'GET /admin/users?search=Jane',
      patient: 'Jane',
    },
    extra: { body: 'knee still hurts' },
    modules: { lodash: '4.17.21' },
    contexts: {
      runtime: {
        name: 'node',
        version: 'v24.14.1',
        raw_description: 'jane@example.com',
      },
      os: { name: 'Linux', version: '6.1', kernel_version: 'stride-api-7f9c' },
      trace: {
        trace_id: 't1',
        span_id: 's1',
        data: { 'url.query': 'search=Jane' },
      },
      app: { app_memory: 1, free_memory: 'Jane' } as never,
      culture: { timezone: 'Europe/Paris', locale: 'Jane' },
    },
    fingerprint: ['{{ default }}'],
  }
}

describe('scrubEvent', () => {
  it('keeps where and why, and rebuilds everything else from an allow-list', () => {
    expect(scrubEvent(backendEvent())).toStrictEqual({
      event_id: 'e1',
      timestamp: 1_900_000_000,
      platform: 'node',
      level: 'error',
      release: 'abc123',
      environment: 'production',
      fingerprint: ['{{ default }}'],
      sdk: { name: 'sentry.javascript.nestjs', version: '11.7.0' },
      message: 'Failed for [email]',
      transaction: 'GET /admin/users',
      exception: {
        values: [
          {
            type: 'Error',
            value: 'refused',
            mechanism: { type: 'generic', handled: true },
            stacktrace: {
              frames: [
                {
                  filename: '/app/dist/users/users.service.js',
                  function: 'UsersService.update',
                  lineno: 10,
                  colno: 5,
                  in_app: true,
                  pre_context: ['  const a = 1'],
                  context_line: '  throw new Error(x)',
                  post_context: ['}'],
                },
              ],
            },
          },
          {
            type: 'DrizzleQueryError',
            value:
              'Failed query: update "users" set "note" = $1\nparams: [redacted]',
          },
        ],
      },
      request: { method: 'PATCH', url: 'http://localhost:3000/admin/users' },
      user: { id: '7' },
      tags: { requestId: 'r-1', where: 'http', route: 'GET /admin/users' },
      contexts: {
        runtime: { name: 'node', version: 'v24.14.1' },
        os: { name: 'Linux', version: '6.1' },
        trace: { trace_id: 't1', span_id: 's1' },
      },
    })
  })

  it('lets none of the planted data through', () => {
    const sent = JSON.stringify(scrubEvent(backendEvent()))
    for (const planted of PLANTED) expect(sent).not.toContain(planted)
  })

  // The browser's reports carry the user of the SESSION (POST /monitoring
  // passes it), never the one the page claims — and none when signed out.
  it("replaces the event's user with the given one, or none", () => {
    expect(scrubEvent(backendEvent(), { userId: 42 }).user).toStrictEqual({
      id: '42',
    })
    expect(scrubEvent(backendEvent(), { userId: null }).user).toBeUndefined()
  })

  it('has no user when the event names none, or an empty one', () => {
    const event = backendEvent()
    delete event.user
    expect(scrubEvent(event).user).toBeUndefined()
    expect(scrubEvent({ ...event, user: { id: '' } }).user).toBeUndefined()
  })

  it('keeps a logentry message, scrubbed, and an event type', () => {
    const scrubbed = scrubEvent({
      logentry: { message: 'to jane@example.com', params: ['Jane'] },
      type: 'feedback',
    } as unknown as ErrorEvent)
    expect(scrubbed).toStrictEqual({
      logentry: { message: 'to [email]' },
      type: 'feedback',
    })
  })

  // The trail before the error goes through scrubBreadcrumb, one by one.
  it('scrubs every breadcrumb, dropping clicks and console lines', () => {
    const scrubbed = scrubEvent({
      breadcrumbs: [
        { category: 'ui.click', message: "button 'Open Pat Lee'" },
        { category: 'console', message: 'jane@example.com' },
        { category: 'navigation', data: { from: '/a?search=Jane', to: '/b' } },
      ],
    } as ErrorEvent)
    expect(scrubbed.breadcrumbs).toStrictEqual([
      { category: 'navigation', data: { from: '/a', to: '/b' } },
    ])
  })

  it('cuts an overlong text', () => {
    const scrubbed = scrubEvent({ message: 'x'.repeat(5_000) } as ErrorEvent)
    expect(scrubbed.message).toHaveLength(1_000)
  })

  // A browser frame's file is the page's script, by URL.
  it("keeps a frame file's path only", () => {
    const scrubbed = scrubEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: 'https://app.stride/assets/x.js?v=jane@example.com',
                  abs_path: 'https://app.stride/assets/x.js#Jane',
                },
              ],
            },
          },
        ],
      },
    } as ErrorEvent)
    expect(
      scrubbed.exception?.values?.[0].stacktrace?.frames?.[0],
    ).toStrictEqual({
      filename: 'https://app.stride/assets/x.js',
      abs_path: 'https://app.stride/assets/x.js',
    })
  })

  it('keeps the browser context, the last 50 breadcrumbs, and no empty sections', () => {
    const scrubbed = scrubEvent({
      contexts: { browser: { name: 'Chrome', version: '155', brand: 'Jane' } },
      breadcrumbs: Array.from({ length: 60 }, (_, i) => ({
        category: 'sentry.event',
        message: `m${i}`,
      })),
      tags: { other: 'x' },
    } as unknown as ErrorEvent)
    expect(scrubbed.contexts).toStrictEqual({
      browser: { name: 'Chrome', version: '155' },
    })
    expect(scrubbed.breadcrumbs).toHaveLength(50)
    expect(scrubbed.breadcrumbs?.[0].message).toBe('m10')
    expect(scrubbed).not.toHaveProperty('tags')
  })
})

describe('scrubBreadcrumb', () => {
  it('drops console lines and clicks or typing (their text is what is on screen)', () => {
    expect(
      scrubBreadcrumb({ category: 'console', message: 'jane@example.com' }),
    ).toBeNull()
    expect(
      scrubBreadcrumb({
        category: 'ui.click',
        message: "button 'Open Pat Lee'",
      }),
    ).toBeNull()
    expect(
      scrubBreadcrumb({ category: 'ui.input', message: 'input.name' }),
    ).toBeNull()
  })

  it('keeps a navigation as two paths', () => {
    expect(
      scrubBreadcrumb({
        category: 'navigation',
        timestamp: 1,
        data: {
          from: '/admin/users?search=Jane',
          to: '/admin/users/7#notes',
          extra: 'Jane',
        },
      }),
    ).toStrictEqual({
      category: 'navigation',
      timestamp: 1,
      data: { from: '/admin/users', to: '/admin/users/7' },
    })
  })

  it.each(['fetch', 'xhr', 'http'])(
    'keeps a %s as method, path and status',
    (category) => {
      expect(
        scrubBreadcrumb({
          type: 'http',
          category,
          level: 'error',
          data: {
            method: 'GET',
            url: 'http://localhost:3000/directory/patients?search=Jane',
            status_code: 500,
            request_body_size: 10,
            response: 'Jane',
          },
        }),
      ).toStrictEqual({
        type: 'http',
        category,
        level: 'error',
        data: {
          method: 'GET',
          url: 'http://localhost:3000/directory/patients',
          status_code: 500,
        },
      })
    },
  )

  it('keeps any other kind without its data, its message scrubbed', () => {
    expect(
      scrubBreadcrumb({
        category: 'auth',
        message: 'signed in as jane@example.com',
        data: { email: 'jane@example.com' },
      }),
    ).toStrictEqual({ category: 'auth', message: 'signed in as [email]' })
    expect(scrubBreadcrumb({ category: 'auth', data: { x: 1 } })).toStrictEqual(
      { category: 'auth' },
    )
  })

  it('ignores values of the wrong type in kept fields', () => {
    expect(
      scrubBreadcrumb({
        category: 'fetch',
        data: { method: 1, url: {}, status_code: '500' },
      }),
    ).toStrictEqual({ category: 'fetch', data: {} })
  })
})
