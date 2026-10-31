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

import * as Sentry from '@sentry/nestjs'
import { DrizzleQueryError } from 'drizzle-orm'
import { errorReportingConfig } from './error-reporting-config'
import { errorReportingOptions, reportError } from './error-reporting'
import { scrubEvent } from './report-scrub'

// The SDK's settings (decisions §32), and the whole pipeline run for real:
// the actual Sentry SDK, started with those settings and a TRANSPORT that
// keeps envelopes in memory instead of sending them — what would reach
// GlitchTip, byte for byte.

const config = errorReportingConfig({
  SENTRY_DSN: 'http://serverkey@glitchtip:8000/1',
  SENTRY_ENVIRONMENT: 'test',
  SENTRY_RELEASE: 'abc123',
})

describe('errorReportingOptions', () => {
  it('is null — reporting off — without a DSN', () => {
    expect(errorReportingOptions(errorReportingConfig({}))).toBeNull()
  })

  it('names the project, environment and release, and turns tracing off', () => {
    const options = errorReportingOptions(config)
    expect(options).toMatchObject({
      dsn: 'http://serverkey@glitchtip:8000/1',
      environment: 'test',
      release: 'abc123',
      tracesSampleRate: 0,
      defaultIntegrations: false,
      maxBreadcrumbs: 0,
      sendClientReports: false,
    })
  })

  // SDK v11 collects all of these by default; every one is switched off
  // (frameContextLines: our source lines, not data).
  it('collects nothing about the request, the user or the data', () => {
    expect(errorReportingOptions(config)?.dataCollection).toStrictEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      frameContextLines: 5,
    })
  })

  it('uses exactly the chosen integrations', () => {
    const names = (
      errorReportingOptions(config)?.integrations as { name: string }[]
    ).map((integration) => integration.name)
    expect(names).toStrictEqual([
      'EventFilters',
      'FunctionToString',
      'LinkedErrors',
      'OnUncaughtException',
      'OnUnhandledRejection',
      'ContextLines',
      'Context',
    ])
  })

  it('sends every event through scrubEvent', () => {
    const beforeSend = errorReportingOptions(config)?.beforeSend
    const event = {
      type: undefined,
      message: 'to jane@example.com',
      extra: { a: 1 },
    }
    expect(beforeSend?.(event as never, {})).toStrictEqual(
      scrubEvent(event as never),
    )
  })
})

describe('reporting, through the real SDK', () => {
  const envelopes: string[] = []

  beforeAll(() => {
    const options = errorReportingOptions(config)!
    Sentry.init({
      ...options,
      // The process-level handlers are left out HERE only: installed inside
      // Jest's worker they would take over its own crash handling.
      integrations: (options.integrations as { name: string }[]).filter(
        (integration) => !integration.name.startsWith('On'),
      ) as typeof options.integrations,
      transport: (transportOptions) =>
        Sentry.createTransport(transportOptions, (request) => {
          envelopes.push(
            typeof request.body === 'string'
              ? request.body
              : Buffer.from(request.body).toString('utf8'),
          )
          return Promise.resolve({ statusCode: 200 })
        }),
    })
  })

  afterAll(() => Sentry.close())
  beforeEach(() => {
    envelopes.length = 0
  })

  // A database failure exactly as the filter receives it: Drizzle's wrapper
  // with the VALUES in its message and `params`, Postgres's error with them
  // in `detail` — plus a local variable or two in the throwing function.
  function databaseFailure() {
    const note = 'My knee still hurts'
    const email = 'jane@example.com'
    return new DrizzleQueryError(
      'insert into "messages" ("body", "email") values ($1, $2)',
      [note, email],
      Object.assign(new Error('new row violates check constraint "x"'), {
        code: '23514',
        detail: `Failing row contains (${note}, ${email}).`,
      }),
    )
  }

  it('sends the error, tagged and with the user id, and none of its values', async () => {
    reportError(databaseFailure(), {
      where: 'http',
      route: 'POST /conversations/3/messages',
      requestId: '7f3a1c2e-9b4d-4e1f-8a2b-3c4d5e6f7a8b',
      userId: 7,
    })
    await Sentry.flush(2_000)

    expect(envelopes).toHaveLength(1)
    const [, , payload] = envelopes[0].split('\n')
    const event = JSON.parse(payload) as Sentry.ErrorEvent
    expect(event.tags).toStrictEqual({
      where: 'http',
      route: 'POST /conversations/3/messages',
      requestId: '7f3a1c2e-9b4d-4e1f-8a2b-3c4d5e6f7a8b',
      // The short form an error screen shows ("Reference: 7f3a1c2e."),
      // searchable in GlitchTip as it is.
      reference: '7f3a1c2e',
    })
    expect(event.user).toStrictEqual({ id: '7' })
    // The cause chain (linkedErrors) is there — Postgres's error first, then
    // Drizzle's wrapper, Sentry's order (both named "Error": Drizzle's class
    // doesn't set its own `name`)…
    expect(event.exception?.values?.map((value) => value.value)).toStrictEqual([
      'new row violates check constraint "x"',
      'Failed query: insert into "messages" ("body", "email") values ($1, $2)\nparams: [redacted]',
    ])
    // …and none of what was written. The SOURCE lines around each frame are
    // set aside first: they are the code that threw — here THIS file, whose
    // text holds the planted values as literals (in the app: our own code).
    const withoutSource = JSON.stringify(event, (key, value: unknown) =>
      ['pre_context', 'context_line', 'post_context'].includes(key)
        ? undefined
        : value,
    )
    expect(withoutSource).not.toMatch(/knee|jane|detail|"vars"/i)
    // Local variables: nowhere, not even in the source part.
    expect(envelopes[0]).not.toContain('"vars"')
    expect(envelopes[0]).toContain('"context_line"')
  })

  // The app retries a 5xx twice, and the screen shows the LAST request's
  // reference: each failed request must arrive as its own report, even when
  // they failed the same way (no Dedupe — pass 3's live check).
  it('sends every request that failed the same way, each with its reference', async () => {
    for (const requestId of [
      '11111111-9b4d-4e1f-8a2b-3c4d5e6f7a8b',
      '22222222-9b4d-4e1f-8a2b-3c4d5e6f7a8b',
      '33333333-9b4d-4e1f-8a2b-3c4d5e6f7a8b',
    ]) {
      reportError(databaseFailure(), { where: 'http', requestId })
    }
    await Sentry.flush(2_000)
    const references = envelopes.map(
      (envelope) =>
        (JSON.parse(envelope.split('\n')[2]) as Sentry.ErrorEvent).tags
          ?.reference,
    )
    // All three — in any order: the SDK reads each frame's source lines
    // asynchronously, so one can overtake another.
    expect(references.sort()).toStrictEqual([
      '11111111',
      '22222222',
      '33333333',
    ])
  })

  it('has no user or request id when none is given', async () => {
    reportError(new Error('the sweep failed'), {
      where: 'message-notices-sweep',
    })
    await Sentry.flush(2_000)
    const event = JSON.parse(envelopes[0].split('\n')[2]) as Sentry.ErrorEvent
    expect(event.tags).toStrictEqual({ where: 'message-notices-sweep' })
    expect(event.user).toBeUndefined()
  })

  // 'strict', not the SDK's 'warn': report as FATAL, then let the process
  // exit as Node itself would. Run with the real integration, its process
  // listener captured instead of installed, and process.exit stubbed.
  // LAST in this block: the SDK closes its client before exiting.
  it('treats an unhandled rejection as fatal, then exits', async () => {
    const integration = (
      errorReportingOptions(config)?.integrations as {
        name: string
        setup?: (client: unknown) => void
      }[]
    ).find((candidate) => candidate.name === 'OnUnhandledRejection')!
    let handler: ((reason: unknown) => void) | undefined
    jest.spyOn(process, 'on').mockImplementationOnce((_event, listener) => {
      handler = listener as (reason: unknown) => void
      return process
    })
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    integration.setup?.(Sentry.getClient())
    handler?.(new Error('nobody caught this'))
    await Sentry.flush(2_000)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const event = JSON.parse(envelopes[0].split('\n')[2]) as Sentry.ErrorEvent
    expect(event.level).toBe('fatal')
    expect(exit).toHaveBeenCalledWith(1)
    jest.restoreAllMocks()
  })
})
