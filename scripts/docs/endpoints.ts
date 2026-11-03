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

// The endpoint index's logic (decided 2026-11-03, documentation stage 1):
// every REST route, read from the code, written as the table in
// docs/api/06-endpoints.md. The command is scripts/docs-endpoints.ts; the
// test that fails when the table falls behind the code is endpoints.spec.ts.
//
// HOW the routes are found — the way src/audit/audit-tags.spec.ts finds them:
// from the metadata Nest itself reads when it builds the router, not from the
// source text. Every decorator on a controller is a function that stores a
// value on the class or the method (Reflect.defineMetadata): @Controller('x')
// stores the path, @Post(':id') the verb and path, @UseGuards(...) the guard
// classes, @HttpCode(204) the status, @Throttle(...) the limit. Reading those
// values back gives what Nest will actually do — a comment or a typo in the
// source can't make the table lie.
//
// WHAT the table says per route: the verb and path, who may call it at the
// guard level (public / any signed-in user / a role list), the success
// status, and what's special (its own rate limit, a demo lock, an upload, a
// PDF, no caching, "changes nothing"). WHAT it doesn't: the service-level
// rules (a practitioner only sees their own patients, …) — those live in
// the code of each service and are explained in 04-authorization.md.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RequestMethod } from '@nestjs/common'
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants'
// The throttler's metadata keys aren't in its public index — a deep import
// (the package has no "exports" map to forbid it). If an upgrade renames
// them, the fixture test in endpoints.spec.ts fails rather than the table
// silently losing every limit.
import {
  THROTTLER_LIMIT,
  THROTTLER_SKIP,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants'
import { DECORATORS as SWAGGER } from '@nestjs/swagger'
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator'
import { NOT_AUDITED_KEY } from '../../src/common/decorators/not-audited.decorator'
import { DEMO_LOCK_KEY, type DemoLock } from '../../src/demo/demo-lock.guard'
import { throttlerOptions } from '../../src/config/rate-limits'

// --- TYPES -------------------------------------------------------------------------------------------------

export type AnyClass = new (...args: never[]) => object

// One controller class and the file it came from (for the table's link).
export interface LoadedController {
  controller: AnyClass
  file: string // relative to the repo root, forward slashes
}

export interface Route {
  method: string // 'GET', 'POST', …
  path: string // '/users/:id'
  group: string // the controller's @ApiTags — Swagger's grouping, reused
  handler: string // 'UsersController.update'
  file: string
  guards: string[] // guard class names, in the order Nest runs them
  roles: string[] // [] = no @Roles: any signed-in user
  status: number
  // Its own limit, when it has one: { limit, ttlMs }; 'skipped' for
  // @SkipThrottle(); undefined = the global default.
  throttle?: { limit: number; ttlMs: number } | 'skipped'
  demoLock?: DemoLock
  upload: boolean
  headers: { name: string; value: string }[]
  produces: string[] // @ApiProduces: 'application/pdf'
  notAudited?: string // @NotAudited's reason
}

// --- FINDING THE CONTROLLERS -------------------------------------------------------------------------------

// Every *.controller.ts under `dir`, recursively, sorted (a stable order
// whatever the file system's listing order).
export function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return controllerFiles(path)
      return entry.name.endsWith('.controller.ts') ? [path] : []
    })
    .sort()
}

// The controller classes a loaded module exports: the values carrying Nest's
// controller watermark (set by @Controller). `load` is how the caller turns
// a path into a module — `require` in the command, `jest.requireActual` in
// the test — so this file loads nothing itself.
export function controllersIn(
  files: string[],
  rootDir: string,
  load: (file: string) => Record<string, unknown>,
): LoadedController[] {
  return files.flatMap((file) =>
    Object.values(load(file))
      .filter(
        (value): value is AnyClass =>
          typeof value === 'function' &&
          Reflect.getMetadata(CONTROLLER_WATERMARK, value) === true,
      )
      .map((controller) => ({
        controller,
        file: relative(rootDir, file).replace(/\\/g, '/'),
      })),
  )
}

// --- READING THE ROUTES ------------------------------------------------------------------------------------

// The throttler stores its settings per named throttler: the key is
// 'THROTTLER:LIMIT' + the name. The app has one, named 'default'
// (src/config/rate-limits.ts).
const THROTTLER_NAME = 'default'

// Path pieces joined without empty or doubled slashes: @Post() alone stores
// '/', and 'users' + '/' must read '/users'.
function joinPath(...parts: string[]): string {
  return (
    '/' +
    parts
      .flatMap((part) => part.split('/'))
      .filter(Boolean)
      .join('/')
  )
}

export function readRoutes(controllers: LoadedController[]): Route[] {
  const routes: Route[] = []
  for (const { controller, file } of controllers) {
    const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '')
    const tags = (Reflect.getMetadata(SWAGGER.API_TAGS, controller) ??
      []) as string[]
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
      []) as AnyClass[]
    const proto = controller.prototype as Record<string, unknown>

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const handler = Object.getOwnPropertyDescriptor(proto, name)?.value as
        object | undefined
      if (typeof handler !== 'function') continue
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined
      if (verb === undefined) continue // a helper method, not a route

      // On the method first, else on the class — the order Nest's
      // Reflector.getAllAndOverride uses (RolesGuard, ThrottlerGuard).
      const read = <T>(key: string): T | undefined =>
        (Reflect.getMetadata(key, handler) ??
          Reflect.getMetadata(key, controller)) as T | undefined

      // Guards ADD UP instead: the class's run first, then the method's.
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
        []) as AnyClass[]

      const limit = read<number>(THROTTLER_LIMIT + THROTTLER_NAME)
      const ttl = read<number>(THROTTLER_TTL + THROTTLER_NAME)
      const skipped = read<boolean>(THROTTLER_SKIP + THROTTLER_NAME) === true

      const method = RequestMethod[verb]
      routes.push({
        method,
        path: joinPath(
          prefix,
          String(Reflect.getMetadata(PATH_METADATA, handler) ?? ''),
        ),
        group: tags[0] ?? controller.name.replace(/Controller$/, ''),
        handler: `${controller.name}.${name}`,
        file,
        guards: [...classGuards, ...methodGuards].map((guard) => guard.name),
        roles: read<string[]>(ROLES_KEY) ?? [],
        // Nest's own default when no @HttpCode: 201 for POST, 200 otherwise.
        status:
          read<number>(HTTP_CODE_METADATA) ?? (method === 'POST' ? 201 : 200),
        throttle: skipped
          ? 'skipped'
          : limit !== undefined && ttl !== undefined
            ? { limit, ttlMs: ttl }
            : undefined,
        demoLock: read<DemoLock>(DEMO_LOCK_KEY),
        // FileInterceptor / FilesInterceptor are the only interceptors on
        // routes (multer, for multipart uploads).
        upload:
          (
            (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) ??
              []) as unknown[]
          ).length > 0,
        headers: (Reflect.getMetadata(HEADERS_METADATA, handler) ?? []) as {
          name: string
          value: string
        }[],
        produces: (read<string[]>(SWAGGER.API_PRODUCES) ?? []).filter(
          (type) => type !== 'application/json',
        ),
        notAudited: read<string>(NOT_AUDITED_KEY),
      })
    }
  }
  return routes
}

// --- THE RULES THE TABLE RELIES ON -------------------------------------------------------------------------

// "Who" is read from the guards, so the guards must be wired the way the
// table assumes. Each of these would be a real hole, not a cosmetic one:
//   - @Roles without RolesGuard: the roles are declared and never checked —
//     the route is open to every signed-in user (or everyone).
//   - RolesGuard without SessionAuthGuard BEFORE it: RolesGuard assumes a
//     signed-in user (src/common/guards/roles.guard.ts) and would crash on
//     req.user being undefined — a 500 instead of a 401.
export function wiringProblems(routes: Route[]): string[] {
  return routes.flatMap((route) => {
    const where = `${route.method} ${route.path} (${route.handler})`
    const session = route.guards.indexOf('SessionAuthGuard')
    const roles = route.guards.indexOf('RolesGuard')
    const problems: string[] = []
    if (route.roles.length > 0 && roles === -1) {
      problems.push(
        `${where}: @Roles(${route.roles.join(', ')}) but no RolesGuard`,
      )
    }
    if (roles !== -1 && (session === -1 || session > roles)) {
      problems.push(`${where}: RolesGuard without SessionAuthGuard before it`)
    }
    return problems
  })
}

// --- WRITING THE TABLE -------------------------------------------------------------------------------------

const VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// What a demo lock refuses, in words (the lock's own names are code:
// 'two_factor'). A Record over the type, so a new kind of lock fails to
// compile here until it has its words.
const LOCKED_CHANGE: Record<DemoLock['change'], string> = {
  password: 'password change',
  email: 'email change',
  two_factor: 'two-factor change',
  deactivate: 'deactivation',
  merge: 'merge',
}

function who(route: Route): string {
  if (!route.guards.includes('SessionAuthGuard')) return 'public'
  if (route.roles.length === 0) return 'signed in'
  return route.roles.join(', ')
}

function perMinute({ limit, ttlMs }: { limit: number; ttlMs: number }): string {
  return ttlMs === 60_000 ? `${limit} / min` : `${limit} / ${ttlMs / 1000} s`
}

function notes(route: Route): string {
  const parts: string[] = []
  if (route.throttle === 'skipped') parts.push('no rate limit')
  else if (route.throttle) parts.push(`limit ${perMinute(route.throttle)}`)
  if (route.demoLock) {
    const when =
      route.demoLock.account === 'self'
        ? 'signed in as a shared demo account'
        : 'the target is a shared demo account'
    parts.push(
      `demo lock: no ${LOCKED_CHANGE[route.demoLock.change]} when ${when}`,
    )
  }
  if (route.upload) parts.push('multipart upload')
  for (const type of route.produces) parts.push(`returns ${type}`)
  for (const { name, value } of route.headers)
    parts.push(`\`${name}: ${value}\``)
  if (route.notAudited !== undefined)
    parts.push('changes nothing (not audited)')
  return parts.join('; ')
}

// The table, grouped by Swagger tag (alphabetically), each group sorted by
// path then verb — so the output depends on the routes alone, never on the
// order files or methods happened to be read in. `docsDir` is the folder
// holding the document, for the relative links to each controller.
export function renderEndpoints(
  routes: Route[],
  defaultLimit: { limit: number; ttlMs: number },
  docsDir: string,
): string {
  const groups = new Map<string, Route[]>()
  for (const route of routes) {
    groups.set(route.group, [...(groups.get(route.group) ?? []), route])
  }
  const lines: string[] = [
    `${routes.length} routes. Rate limit when the Notes don't say otherwise: ` +
      `${perMinute(defaultLimit)} per route and IP address.`,
    '',
  ]
  for (const group of [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, 'en'),
  )) {
    const sorted = groups
      .get(group)!
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path, 'en') ||
          VERB_ORDER.indexOf(a.method) - VERB_ORDER.indexOf(b.method),
      )
    const files = [...new Set(sorted.map((route) => route.file))]
    lines.push(`### ${group}`, '')
    lines.push(
      files
        .map((file) => `[\`${file.split('/').pop()}\`](${docsDir}/${file})`)
        .join(', '),
      '',
    )
    lines.push('| Method | Path | Who | Success | Notes |')
    lines.push('|---|---|---|---|---|')
    for (const route of sorted) {
      lines.push(
        `| ${route.method} | \`${route.path}\` | ${who(route)} | ${route.status} | ${notes(route)} |`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

// --- THE WHOLE APP ----------------------------------------------------------------------------------------

// Where the table lives, relative to the repo root — and the way back from
// there to the root, for the links to each controller.
export const ENDPOINTS_DOC = 'docs/api/06-endpoints.md'
const DOC_TO_ROOT = '../..'

// The app's limit for a route without its own @Throttle, read from the
// throttler's real settings (as if RATE_LIMITS were on, its default), so the
// table's sentence about it can't disagree with src/config/rate-limits.ts.
export function defaultLimit(): { limit: number; ttlMs: number } {
  const options = throttlerOptions({ RATE_LIMITS: 'on' })
  const throttlers = Array.isArray(options) ? options : options.throttlers
  const found = throttlers.find((t) => (t.name ?? 'default') === THROTTLER_NAME)
  if (
    !found ||
    typeof found.limit !== 'number' ||
    typeof found.ttl !== 'number'
  ) {
    throw new Error(
      `No numeric '${THROTTLER_NAME}' throttler in throttlerOptions()`,
    )
  }
  return { limit: found.limit, ttlMs: found.ttl }
}

// Every route of the app (the controllers under src/), and the table for
// them. Used by the command (to write the table) and by the test (to check
// it) — one function, so the two can never build different tables.
export function appRoutes(
  rootDir: string,
  load: (file: string) => Record<string, unknown>,
): Route[] {
  return readRoutes(
    controllersIn(controllerFiles(join(rootDir, 'src')), rootDir, load),
  )
}

export function appTable(routes: Route[]): string {
  return renderEndpoints(routes, defaultLimit(), DOC_TO_ROOT)
}

// --- THE GENERATED PART OF THE DOCUMENT --------------------------------------------------------------------

// The table lives between these two lines; everything outside them is
// written by hand and left alone.
export const BEGIN_MARKER =
  '<!-- BEGIN GENERATED: npm run docs:endpoints — do not edit by hand -->'
export const END_MARKER = '<!-- END GENERATED -->'

// The document with its generated part replaced by `table`. Refuses a
// document without exactly one pair of markers, in order — rather than
// guessing where the table goes and overwriting text written by hand.
export function withGeneratedPart(document: string, table: string): string {
  const begin = document.indexOf(BEGIN_MARKER)
  const end = document.indexOf(END_MARKER)
  if (
    begin === -1 ||
    end === -1 ||
    end < begin ||
    document.indexOf(BEGIN_MARKER, begin + 1) !== -1 ||
    document.indexOf(END_MARKER, end + 1) !== -1
  ) {
    throw new Error(
      `The document needs exactly one "${BEGIN_MARKER}" line followed by one "${END_MARKER}" line.`,
    )
  }
  // The document's own line endings, for the part written here too: a
  // checkout on Windows can turn the file's \n into \r\n (git's autocrlf),
  // and a table inserted with \n would make the file mixed — and never equal
  // to what the test expects, though nothing changed.
  const eol = document.includes('\r\n') ? '\r\n' : '\n'
  return (
    document.slice(0, begin + BEGIN_MARKER.length) +
    eol +
    eol +
    table.trimEnd().replace(/\r?\n/g, eol) +
    eol +
    eol +
    document.slice(end)
  )
}
