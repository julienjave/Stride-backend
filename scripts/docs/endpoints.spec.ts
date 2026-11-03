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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiProduces, ApiTags } from '@nestjs/swagger'
import { SkipThrottle, Throttle, seconds } from '@nestjs/throttler'
import { SessionAuthGuard } from '../../src/common/guards/session-auth.guard'
import { RolesGuard } from '../../src/common/guards/roles.guard'
import { Roles } from '../../src/common/decorators/roles.decorator'
import { NotAudited } from '../../src/common/decorators/not-audited.decorator'
import { UserRole } from '../../src/users/dto/create-user.dto'
import { DemoLocked } from '../../src/demo/demo-lock.guard'
import {
  appRoutes,
  appTable,
  BEGIN_MARKER,
  END_MARKER,
  ENDPOINTS_DOC,
  readRoutes,
  renderEndpoints,
  wiringProblems,
  withGeneratedPart,
} from './endpoints'

const ROOT = join(__dirname, '..', '..')

// The app's routes, loaded once: jest.requireActual loads each controller
// file synchronously (Jest runs specs as CommonJS) — the same modules Nest
// would load (the way src/audit/audit-tags.spec.ts does it).
const routes = appRoutes(ROOT, (file) =>
  jest.requireActual<Record<string, unknown>>(file),
)

// --- THE DOCUMENT MATCHES THE CODE -------------------------------------------------------------------------

describe(ENDPOINTS_DOC, () => {
  // THE test of this file: the table in the document is exactly the one the
  // code produces today. A route added, removed or changed (its path, its
  // roles, its status, its limit…) without running the command fails here,
  // in `npm test` and in CI — the table can't quietly fall behind.
  it('is up to date with the controllers', () => {
    const document = readFileSync(join(ROOT, ENDPOINTS_DOC), 'utf8')
    if (withGeneratedPart(document, appTable(routes)) !== document) {
      throw new Error(
        `${ENDPOINTS_DOC} is out of date with the controllers — run: npm run docs:endpoints`,
      )
    }
  })

  // Guards against passing for nothing: if the search found no files (a
  // moved folder, a renamed suffix) the table would be empty — and up to
  // date. These are real routes of each kind, from several modules.
  it('lists the app’s real routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(140)
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'POST /auth/login',
        'GET /auth/me',
        'POST /users',
        'PATCH /users/:id',
        'GET /exercises',
        'POST /records-export/download',
        'DELETE /conversations/:id/messages/:messageId',
        'GET /health',
      ]),
    )
  })

  // The "Who" column is read from the guards; it is only true if they're
  // wired as the table assumes.
  it('finds every route’s guards wired the way the table reads them', () => {
    expect(wiringProblems(routes)).toEqual([])
  })
})

// --- READING THE METADATA ----------------------------------------------------------------------------------

// The reader on controllers made for the test: every decorator it reads,
// each in the place it can be (method or class). Without this, a wrong
// metadata key (say, after a library upgrade) would make the table silently
// drop a column's information — and the document test above would still
// pass, since it compares the table with itself.
describe('readRoutes', () => {
  @ApiTags('Fixture')
  @UseGuards(SessionAuthGuard)
  @Roles(UserRole.ADMIN) // the class's roles, overridden on one method below
  @Throttle({ default: { limit: 7, ttl: seconds(60) } })
  @Controller('fixture')
  class FixtureController {
    @UseGuards(RolesGuard)
    @Get()
    list() {}

    @UseGuards(RolesGuard)
    @Roles(UserRole.PRACTITIONER, UserRole.PATIENT)
    @Throttle({ default: { limit: 3, ttl: seconds(10) } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Delete(':id')
    remove() {}

    @DemoLocked('two_factor', 'param')
    @UseInterceptors(FileInterceptor('file'))
    @Header('Cache-Control', 'no-store')
    @ApiProduces('application/pdf')
    @NotAudited('Reads only')
    @Post('/:id//upload/')
    upload() {}

    helper() {} // not a route: no verb
  }

  @Controller('open')
  class OpenController {
    @SkipThrottle()
    @Post()
    create() {}
  }

  const read = readRoutes([
    {
      controller: FixtureController,
      file: 'src/fixture.controller.ts',
    },
    { controller: OpenController, file: 'src/open.controller.ts' },
  ])
  const byHandler = (name: string) =>
    read.find((r) => r.handler.endsWith(name))!

  it('finds the routes and nothing else', () => {
    expect(read.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /fixture',
      'DELETE /fixture/:id',
      'POST /fixture/:id/upload',
      'POST /open',
    ])
  })

  it('adds the class’s guards before the method’s', () => {
    expect(byHandler('list').guards).toEqual(['SessionAuthGuard', 'RolesGuard'])
  })

  it('takes roles, limits and status from the method first, else the class', () => {
    expect(byHandler('list')).toMatchObject({
      roles: ['admin'],
      throttle: { limit: 7, ttlMs: 60_000 },
      status: 200,
      group: 'Fixture',
    })
    expect(byHandler('remove')).toMatchObject({
      roles: ['practitioner', 'patient'],
      throttle: { limit: 3, ttlMs: 10_000 },
      status: 204,
    })
  })

  it('reads the demo lock, the upload, the headers, the type and the audit tag', () => {
    expect(byHandler('upload')).toMatchObject({
      demoLock: { change: 'two_factor', account: 'param' },
      upload: true,
      headers: [{ name: 'Cache-Control', value: 'no-store' }],
      produces: ['application/pdf'],
      notAudited: 'Reads only',
      guards: ['SessionAuthGuard', 'DemoLockGuard'],
    })
  })

  it('knows a POST without @HttpCode answers 201, and a skipped limit', () => {
    expect(byHandler('create')).toMatchObject({
      status: 201,
      throttle: 'skipped',
      guards: [],
      group: 'Open', // no @ApiTags: the class name without "Controller"
    })
  })
})

// --- THE WIRING RULES --------------------------------------------------------------------------------------

describe('wiringProblems', () => {
  @Controller('wiring')
  class WiringController {
    @Roles(UserRole.ADMIN)
    @Get('roles-unchecked')
    rolesUnchecked() {}

    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @Get('no-session')
    noSession() {}

    @UseGuards(RolesGuard, SessionAuthGuard)
    @Roles(UserRole.ADMIN)
    @Get('wrong-order')
    wrongOrder() {}

    @UseGuards(SessionAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    @Get('fine')
    fine() {}

    @Get('public')
    open() {}
  }

  it('catches unchecked roles and a RolesGuard without a session before it', () => {
    const read = readRoutes([
      {
        controller: WiringController,
        file: 'src/wiring.controller.ts',
      },
    ])
    expect(wiringProblems(read)).toEqual([
      'GET /wiring/roles-unchecked (WiringController.rolesUnchecked): @Roles(admin) but no RolesGuard',
      'GET /wiring/no-session (WiringController.noSession): RolesGuard without SessionAuthGuard before it',
      'GET /wiring/wrong-order (WiringController.wrongOrder): RolesGuard without SessionAuthGuard before it',
    ])
  })
})

// --- WRITING ------------------------------------------------------------------------------------------------

describe('renderEndpoints', () => {
  it('groups by tag and sorts by path then verb, whatever the input order', () => {
    const base = {
      handler: 'X.y',
      file: 'src/x/x.controller.ts',
      guards: ['SessionAuthGuard'],
      roles: [],
      status: 200,
      upload: false,
      headers: [],
      produces: [],
    }
    const table = renderEndpoints(
      [
        { ...base, method: 'DELETE', path: '/b', group: 'Beta' },
        { ...base, method: 'GET', path: '/b', group: 'Beta', guards: [] },
        {
          ...base,
          method: 'GET',
          path: '/a',
          group: 'Alpha',
          roles: ['admin'],
        },
      ],
      { limit: 60, ttlMs: 60_000 },
      '../..',
    )
    expect(table).toBe(
      [
        "3 routes. Rate limit when the Notes don't say otherwise: 60 / min per route and IP address.",
        '',
        '### Alpha',
        '',
        '[`x.controller.ts`](../../src/x/x.controller.ts)',
        '',
        '| Method | Path | Who | Success | Notes |',
        '|---|---|---|---|---|',
        '| GET | `/a` | admin | 200 |  |',
        '',
        '### Beta',
        '',
        '[`x.controller.ts`](../../src/x/x.controller.ts)',
        '',
        '| Method | Path | Who | Success | Notes |',
        '|---|---|---|---|---|',
        '| GET | `/b` | public | 200 |  |',
        '| DELETE | `/b` | signed in | 200 |  |',
        '',
      ].join('\n'),
    )
  })
})

describe('withGeneratedPart', () => {
  const doc = `# Title\n\nBy hand.\n\n${BEGIN_MARKER}\nold table\n${END_MARKER}\n\nAlso by hand.\n`

  it('replaces only what lies between the markers', () => {
    expect(withGeneratedPart(doc, 'new table\n')).toBe(
      `# Title\n\nBy hand.\n\n${BEGIN_MARKER}\n\nnew table\n\n${END_MARKER}\n\nAlso by hand.\n`,
    )
  })

  it("keeps a CRLF document CRLF (a Windows checkout's line endings)", () => {
    const crlf = doc.replace(/\n/g, '\r\n')
    const result = withGeneratedPart(crlf, 'line 1\nline 2\n')
    expect(result).toBe(
      `# Title\r\n\r\nBy hand.\r\n\r\n${BEGIN_MARKER}\r\n\r\nline 1\r\nline 2\r\n\r\n${END_MARKER}\r\n\r\nAlso by hand.\r\n`,
    )
    expect(withGeneratedPart(result, 'line 1\nline 2\n')).toBe(result)
  })

  it('gives the same document when run twice', () => {
    const once = withGeneratedPart(doc, 'table')
    expect(withGeneratedPart(once, 'table')).toBe(once)
  })

  it.each([
    ['no markers', '# Title\n'],
    ['only the first', `${BEGIN_MARKER}\n`],
    ['the wrong order', `${END_MARKER}\n${BEGIN_MARKER}\n`],
    [
      'two tables',
      `${BEGIN_MARKER}\n${END_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`,
    ],
  ])('refuses a document with %s, rather than guessing', (_case, broken) => {
    expect(() => withGeneratedPart(broken, 'table')).toThrow(/exactly one/)
  })
})
