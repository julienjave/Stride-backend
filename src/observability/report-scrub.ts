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

import type { Breadcrumb, Event, Exception, StackFrame } from '@sentry/nestjs'
import { pathOnly, scrubText } from './log-scrub'

// --- THE RULE ----------------------------------------------------------------------------------------------

// What an error report may hold (decisions §32 — the rule the logs follow
// too): nothing that names or locates a patient. A report is BUILT AGAIN from
// an allow-list of fields — never "the SDK's event minus a few keys": SDKs add
// fields with every release (v11 started collecting cookies, headers, bodies
// and database values BY DEFAULT), and a list of what may go out can't be
// widened by an upgrade.
//
// The same function serves both doors:
//   - the backend's own reports, as the SDK's `beforeSend` (error-reporting.ts);
//   - the browser's reports, in POST /monitoring, BEFORE they are forwarded —
//     the browser's code could be old, modified or simply wrong; the server
//     is the one place the rule can be enforced.
//
// Kept, per part of the report:
//   identity     event_id, timestamp, platform, level, release, environment,
//                sdk (name + version), fingerprint, debug_meta (source maps)
//   the error    exception values: type, value (scrubbed), mechanism, stack
//                frames — file, function, line, column, in_app and the
//                SOURCE lines around it (our code, not data) — never `vars`
//                (local variables: the values a function was working on)
//   message      scrubbed
//   transaction  the route ("GET /users/:id"), scrubbed, path only
//   request      method + PATH (no query, headers, cookies, body, IP)
//   user         { id } only — and for the browser's reports, the id of the
//                SESSION that sent it, not one the page claims
//   tags         requestId, where and route (scrubbed, path only), nothing
//                else
//   contexts     runtime / os / browser name + version, the trace ids
//   breadcrumbs  see scrubBreadcrumb
// Dropped: extra, modules, server_name, request headers / cookies / data /
// query_string / env, user email / username / ip_address, every other context.

const KEPT_TAGS = ['requestId', 'where', 'route'] as const
const KEPT_CONTEXTS = ['runtime', 'os', 'browser'] as const
const MAX_TEXT = 1_000
const MAX_BREADCRUMBS = 50

export interface ScrubOptions {
  // Who the report is about, if anyone. The browser's: the signed-in
  // session's account (POST /monitoring passes it); the backend's: what the
  // SDK was told (`user.id` from reportError).
  userId?: string | number | null
}

export function scrubEvent<T extends Event>(
  event: T,
  options: ScrubOptions = {},
): T {
  const scrubbed: Event = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    fingerprint: event.fingerprint?.map((part) => text(part)),
    debug_meta: event.debug_meta,
  }
  if (event.sdk) {
    scrubbed.sdk = { name: event.sdk.name, version: event.sdk.version }
  }
  if (event.message) scrubbed.message = text(event.message)
  if (event.logentry?.message) {
    scrubbed.logentry = { message: text(event.logentry.message) }
  }
  if (event.transaction)
    scrubbed.transaction = text(pathOnly(event.transaction))
  if (event.exception?.values) {
    scrubbed.exception = { values: event.exception.values.map(scrubException) }
  }
  if (event.request) {
    scrubbed.request = {
      method: event.request.method,
      url: event.request.url ? pathOnly(event.request.url) : undefined,
    }
  }
  const userId = 'userId' in options ? options.userId : event.user?.id
  if (userId !== undefined && userId !== null && userId !== '') {
    scrubbed.user = { id: String(userId) }
  }
  const tags = keptTags(event.tags)
  if (tags) scrubbed.tags = tags
  const contexts = keptContexts(event.contexts)
  if (contexts) scrubbed.contexts = contexts
  if (event.breadcrumbs) {
    scrubbed.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((crumb): crumb is Breadcrumb => crumb !== null)
      .slice(-MAX_BREADCRUMBS)
  }
  // `type` says what kind of event this is (undefined = an error); kept so
  // the SDK's own typing (ErrorEvent) holds.
  if (event.type !== undefined) scrubbed.type = event.type
  return withoutUndefined(scrubbed) as T
}

function scrubException(exception: Exception): Exception {
  return withoutUndefined({
    type: exception.type ? text(exception.type) : undefined,
    value: exception.value ? text(exception.value) : undefined,
    module: exception.module,
    mechanism: exception.mechanism
      ? { type: exception.mechanism.type, handled: exception.mechanism.handled }
      : undefined,
    stacktrace: exception.stacktrace?.frames
      ? { frames: exception.stacktrace.frames.map(scrubFrame) }
      : undefined,
  })
}

function scrubFrame(frame: StackFrame): StackFrame {
  return withoutUndefined({
    filename: frame.filename ? pathOnly(frame.filename) : undefined,
    abs_path: frame.abs_path ? pathOnly(frame.abs_path) : undefined,
    module: frame.module,
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
    pre_context: frame.pre_context,
    context_line: frame.context_line,
    post_context: frame.post_context,
  })
}

// --- BREADCRUMBS -------------------------------------------------------------------------------------------

// The trail of what happened before an error. Some kinds can't be kept at all:
//   - console: every console.log of the page — anything at all;
//   - ui.click / ui.input: the element's selector and TEXT ("button 'Open Pat
//     Lee'") — names on screen.
// Navigation keeps its two PATHS; a fetch / xhr keeps method, path and
// status (no query, no body); anything else keeps its category, level, time
// and a scrubbed message — never its `data`.
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  const category = crumb.category ?? ''
  if (category === 'console' || category.startsWith('ui.')) return null
  const base: Breadcrumb = withoutUndefined({
    type: crumb.type,
    category: crumb.category,
    level: crumb.level,
    timestamp: crumb.timestamp,
  })
  const data = crumb.data ?? {}
  if (category === 'navigation') {
    return {
      ...base,
      data: withoutUndefined({
        from: urlData(data.from),
        to: urlData(data.to),
      }),
    }
  }
  if (category === 'fetch' || category === 'xhr' || category === 'http') {
    return {
      ...base,
      data: withoutUndefined({
        method: typeof data.method === 'string' ? data.method : undefined,
        url: urlData(data.url),
        status_code:
          typeof data.status_code === 'number' ? data.status_code : undefined,
      }),
    }
  }
  return crumb.message ? { ...base, message: text(crumb.message) } : base
}

// --- HELPERS -----------------------------------------------------------------------------------------------

function text(value: string): string {
  return scrubText(value).slice(0, MAX_TEXT)
}

function urlData(value: unknown): string | undefined {
  return typeof value === 'string' ? pathOnly(value) : undefined
}

function keptTags(tags: Event['tags']): Event['tags'] | undefined {
  if (!tags) return undefined
  const kept: NonNullable<Event['tags']> = {}
  for (const key of KEPT_TAGS) {
    const value = tags[key]
    // pathOnly too: a route is "GET /users/7" — a query must never ride
    // along, whoever wrote the tag (the browser's included).
    if (value !== undefined && value !== null) {
      kept[key] = text(pathOnly(String(value)))
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function keptContexts(
  contexts: Event['contexts'],
): Event['contexts'] | undefined {
  if (!contexts) return undefined
  const kept: NonNullable<Event['contexts']> = {}
  for (const key of KEPT_CONTEXTS) {
    const context = contexts[key] as
      { name?: unknown; version?: unknown } | undefined
    if (context) {
      kept[key] = withoutUndefined({
        name: typeof context.name === 'string' ? context.name : undefined,
        version:
          typeof context.version === 'string' ? context.version : undefined,
      })
    }
  }
  const trace = contexts.trace as
    { trace_id?: unknown; span_id?: unknown } | undefined
  if (trace && typeof trace.trace_id === 'string') {
    kept.trace = withoutUndefined({
      trace_id: trace.trace_id,
      span_id: typeof trace.span_id === 'string' ? trace.span_id : undefined,
    }) as NonNullable<Event['contexts']>['trace']
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

// JSON drops `undefined` anyway; removing the keys keeps the object equal to
// what is sent, so a test can compare with toStrictEqual.
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}
