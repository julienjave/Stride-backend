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

import * as Sentry from '@sentry/nestjs'
import type { ErrorReportingConfig } from './error-reporting-config'
import { scrubEvent } from './report-scrub'
import { referenceOf } from './request-id'

// --- THE SDK'S SETTINGS ------------------------------------------------------------------------------------

// The Sentry SDK's options for the backend (GlitchTip speaks the same
// protocol), or null when reporting is off (no SENTRY_DSN). Every choice is
// written out rather than left to a default, because the defaults change
// between releases — v11 began collecting cookies, headers, request and
// response bodies, database values and local variables unless told not to.
//
// Two locks, on purpose:
//   1. what the SDK COLLECTS (dataCollection, the integrations below) — it
//      never gathers the data at all;
//   2. what it SENDS (beforeSend: scrubEvent, an allow-list rebuild) — if a
//      future SDK collects something new anyway, it still doesn't leave.
export function errorReportingOptions(
  config: ErrorReportingConfig,
): Sentry.NodeOptions | null {
  if (!config.serverDsn) return null
  return {
    dsn: dsnText(config.serverDsn),
    environment: config.environment,
    release: config.release,

    // ERRORS only: no tracing (performance spans carry URLs and queries —
    // more to scrub, and another subject), no profiling, no logs (the logs
    // go to Better Stack — decisions §32). 0 rather than unset: unset, the
    // SDK reads SENTRY_TRACES_SAMPLE_RATE from the environment, and a
    // variable could switch tracing on behind this file's back.
    tracesSampleRate: 0,

    dataCollection: {
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
      // Source lines around each frame are OUR code, not data — what makes a
      // stack trace readable.
      frameContextLines: 5,
    },

    // The integrations, CHOSEN — `defaultIntegrations: false` turns off the
    // SDK's ~20 defaults, and this list says which come back:
    //   eventFilters                drop known noise
    //   functionToString            readable function names
    //   linkedErrors                Error.cause chains (Drizzle → Postgres)
    //   onUncaughtException         a crash is reported before the process
    //                               exits, as Node would exit anyway
    //   onUnhandledRejection        mode 'strict': report, then exit — what
    //                               Node does by default. ('warn', the SDK's
    //                               default, would KEEP the process alive after
    //                               an unhandled rejection: a behaviour change
    //                               hidden in a monitoring setting.)
    //   contextLines, nodeContext   the source lines; Node / OS versions
    // Left out: dedupe — it drops an event equal to the one before, and two
    // requests failing the same way ARE two events: the app retries a 5xx
    // twice, so the screen shows the THIRD request's reference, which must
    // find its report (found in pass 3's live check — only the first of the
    // three arrived; GlitchTip groups them into one issue anyway);
    // console, http, node-fetch (breadcrumbs of every log and
    // outgoing call — the request id ties a report to its log lines instead),
    // requestData (it reads the request from the http integration's scope,
    // which isn't installed — the filter names the route itself, `route`),
    // localVariables, modules, child processes / worker threads, process
    // sessions, Nest's tracing instrumentation.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    maxBreadcrumbs: 0,
    sendClientReports: false,

    beforeSend: (event) => scrubEvent(event),
  }
}

function dsnText(dsn: NonNullable<ErrorReportingConfig['serverDsn']>): string {
  return `${dsn.protocol}://${encodeURIComponent(dsn.publicKey)}@${dsn.host}${dsn.pathPrefix}/${dsn.projectId}`
}

// --- REPORTING ---------------------------------------------------------------------------------------------

// What an error report carries besides the error: where it happened (the
// exception filter, the socket, the message sweep), the route or event
// ("GET /auth/setup-status" — a PATH, never a query), the request's id — the
// same reference the person sees and the log lines carry — and the account
// it happened to, by id.
export interface ReportContext {
  where: 'http' | 'websocket' | 'message-notices-sweep'
  route?: string
  requestId?: string
  userId?: number
}

// The ONE way the app reports an error (the SDK's own handlers report
// crashes). With a request id comes its short form too, the `reference` tag
// — what the person read on their screen, searchable as it is. When reporting is off — no DSN, as in every test — the SDK isn't
// initialised and this does nothing.
export function reportError(error: unknown, context: ReportContext): void {
  Sentry.captureException(error, {
    tags: {
      where: context.where,
      ...(context.route ? { route: context.route } : {}),
      ...(context.requestId
        ? {
            requestId: context.requestId,
            reference: referenceOf(context.requestId),
          }
        : {}),
    },
    ...(context.userId !== undefined
      ? { user: { id: String(context.userId) } }
      : {}),
  })
}
