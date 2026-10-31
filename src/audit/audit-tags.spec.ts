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

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Controller, Get, Post, RequestMethod } from '@nestjs/common'
import {
  CONTROLLER_WATERMARK,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants'
import {
  AUDITED_BY_SERVICE_KEY,
  AuditedByService,
} from '../common/decorators/audited-by-service.decorator'
import {
  NOT_AUDITED_KEY,
  NotAudited,
} from '../common/decorators/not-audited.decorator'

// --- THE RULE ----------------------------------------------------------------------------------------------

// Every route that can change data says how it is audited (the audit review,
// Phase 6 — decisions §10): @AuditedByService() — its service writes ONE
// complete entry in the change's own transaction — or @NotAudited(reason) —
// it changes nothing. This test replaces the global interceptor that used to
// write a generic "METHOD /url" entry for routes nobody had thought about: a
// new route with neither tag now fails the build instead of being recorded
// vaguely (or not at all).
//
// HOW it finds the routes — from the same metadata Nest itself reads when it
// builds the router. @Controller('users') marks the class (a "watermark") and
// stores its path; @Post(':id') stores the HTTP verb and the path on the
// method. So: load every *.controller.ts under src/, keep the exported
// classes carrying the watermark, and read each prototype method's verb.

// Verbs that only read. Everything else — POST, PUT, PATCH, DELETE, and also
// ALL or anything exotic — is treated as able to change data: the safe side.
const READ_ONLY = new Set<RequestMethod>([
  RequestMethod.GET,
  RequestMethod.HEAD,
  RequestMethod.OPTIONS,
])

interface Route {
  route: string // e.g. "POST /users/:id/roles"
  audited: boolean
  notAuditedReason: unknown
}

type AnyClass = new (...args: never[]) => object

// The mutating routes of the given controller classes.
function mutatingRoutes(controllers: AnyClass[]): Route[] {
  const routes: Route[] = []
  for (const controller of controllers) {
    const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '')
    const proto = controller.prototype as Record<string, unknown>
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const handler = Object.getOwnPropertyDescriptor(proto, name)?.value as
        object | undefined
      if (typeof handler !== 'function') continue
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined
      // Not a route (a helper method), or a route that only reads.
      if (verb === undefined || READ_ONLY.has(verb)) continue
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '')
      // A tag on the method, or on the whole class — the same places
      // Reflector.getAllAndOverride looks.
      const tag = (key: string): unknown =>
        Reflect.getMetadata(key, handler) ??
        Reflect.getMetadata(key, controller)
      routes.push({
        // Segments joined without empty pieces: @Post() alone is stored as
        // the path "/", and "users" + "/" must read "/users".
        route: `${RequestMethod[verb]} /${[prefix, path]
          .flatMap((part) => part.split('/'))
          .filter(Boolean)
          .join('/')}`,
        audited: tag(AUDITED_BY_SERVICE_KEY) === true,
        notAuditedReason: tag(NOT_AUDITED_KEY),
      })
    }
  }
  return routes
}

// The problems with a set of routes: neither tag, an empty reason, or both
// tags at once (a route can't be both).
function problems(routes: Route[]): string[] {
  return routes.flatMap(({ route, audited, notAuditedReason }) => {
    const notAudited = notAuditedReason !== undefined
    if (audited && notAudited) return [`${route}: both tags`]
    if (!audited && !notAudited) return [`${route}: no audit tag`]
    if (
      notAudited &&
      (typeof notAuditedReason !== 'string' || notAuditedReason.trim() === '')
    ) {
      return [`${route}: @NotAudited without a reason`]
    }
    return []
  })
}

// Every *.controller.ts file under src/, recursively.
function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return controllerFiles(path)
    return entry.name.endsWith('.controller.ts') ? [path] : []
  })
}

// The app's controller classes: every exported class carrying Nest's
// controller watermark, from every controller file. jest.requireActual loads
// a file synchronously (Jest runs specs as CommonJS, where a dynamic
// import() isn't available) — the same module Nest would load.
function appControllers(): AnyClass[] {
  return controllerFiles(join(__dirname, '..')).flatMap((file) =>
    Object.values(jest.requireActual<Record<string, unknown>>(file)).filter(
      (value): value is AnyClass =>
        typeof value === 'function' &&
        Reflect.getMetadata(CONTROLLER_WATERMARK, value) === true,
    ),
  )
}

// --- TESTS -------------------------------------------------------------------------------------------------

describe('audit tags on every route that can change data', () => {
  it('finds no mutating route without exactly one audit tag', () => {
    const routes = mutatingRoutes(appControllers())

    // Guards against passing for nothing: if the search found no files (a
    // moved folder, a renamed suffix) every check below would be vacuous.
    // These are real routes of each kind, from several modules.
    expect(routes.length).toBeGreaterThanOrEqual(80)
    expect(routes.map((r) => r.route)).toEqual(
      expect.arrayContaining([
        'POST /users',
        'PATCH /users/:id',
        'DELETE /clinics/:id/members/:userId',
        'POST /auth/login',
        'POST /auth/reset-password/check',
        'PATCH /programs/:id/workouts',
        'POST /medical-files',
        'DELETE /conversations/:id/messages/:messageId',
      ]),
    )

    expect(problems(routes)).toEqual([])
  })

  // The routes that say "this changes nothing" are listed here, so a
  // reviewer sees them in one place. (POST /monitoring, decisions §32: it
  // passes a browser's error report on to GlitchTip.)
  it('lists the routes that change nothing, each with its reason', () => {
    const routes = mutatingRoutes(appControllers())
    expect(
      routes
        .filter((r) => r.notAuditedReason !== undefined)
        .map((r) => r.route)
        .sort(),
    ).toEqual([
      'POST /auth/reset-password/check',
      'POST /invitations/lookup',
      'POST /monitoring',
    ])
  })

  // The checker itself, on controllers made for the test: it must SEE an
  // untagged route, a reasonless @NotAudited, a double tag — and accept a
  // class-level tag and ignore reads. Without this, a bug in the finder
  // (say, reading the wrong metadata key) would make the test above pass for
  // every route, tagged or not.
  it('catches every kind of problem on controllers made for the test', () => {
    @Controller('fixture')
    class FixtureController {
      @Get('read')
      read() {}
      @Post('untagged')
      untagged() {}
      @NotAudited('')
      @Post('no-reason')
      noReason() {}
      @AuditedByService()
      @NotAudited('Reads only')
      @Post('both')
      both() {}
      @AuditedByService()
      @Post('fine')
      fine() {}
      @NotAudited('Reads only')
      @Post('fine-too')
      fineToo() {}
    }
    @AuditedByService()
    @Controller('tagged-class')
    class TaggedClassController {
      @Post()
      create() {}
    }

    const routes = mutatingRoutes([FixtureController, TaggedClassController])

    expect(routes.map((r) => r.route)).toEqual([
      'POST /fixture/untagged',
      'POST /fixture/no-reason',
      'POST /fixture/both',
      'POST /fixture/fine',
      'POST /fixture/fine-too',
      'POST /tagged-class',
    ])
    expect(problems(routes)).toEqual([
      'POST /fixture/untagged: no audit tag',
      'POST /fixture/no-reason: @NotAudited without a reason',
      'POST /fixture/both: both tags',
    ])
  })
})
