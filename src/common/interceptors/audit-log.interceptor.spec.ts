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

import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, of } from 'rxjs'
import type { AuditService } from '../../audit/audit.service'
import { AuditLogInterceptor } from './audit-log.interceptor'
import { AuditedByService } from '../decorators/audited-by-service.decorator'
import { NotAudited } from '../decorators/not-audited.decorator'

// An interceptor wraps a route handler: Nest gives it the request (inside
// an ExecutionContext) and the handler (a CallHandler whose handle()
// returns the response as an Observable). Both are replaced here by the
// smallest objects that answer the calls the interceptor makes.
//
// getHandler / getClass are what the Reflector reads route metadata from:
// the route's method and its controller class. A plain function and class
// stand in for them; a test decorates them to tag a route.
function untaggedHandler() {}
class UntaggedController {}

function contextFor(
  request: object,
  handler: () => void = untaggedHandler,
  controller: new () => object = UntaggedController,
) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext
}

function handlerReturning(response: unknown): CallHandler {
  return { handle: () => of(response) }
}

const admin = { id: 1 }

describe('AuditLogInterceptor', () => {
  let auditService: { log: jest.Mock }
  let interceptor: AuditLogInterceptor

  beforeEach(() => {
    auditService = { log: jest.fn().mockResolvedValue(undefined) }
    // A REAL Reflector: what's tested is that the interceptor reads the
    // metadata @AuditedByService() really writes.
    interceptor = new AuditLogInterceptor(
      auditService as unknown as AuditService,
      new Reflector(),
    )
  })

  afterEach(() => jest.restoreAllMocks())

  // lastValueFrom() subscribes and waits for the response — without a
  // subscriber, an Observable runs nothing, so tap() would never fire.
  async function run(
    request: object,
    response: unknown = { id: 5 },
    handler?: () => void,
    controller?: new () => object,
  ) {
    return lastValueFrom(
      interceptor.intercept(
        contextFor(request, handler, controller),
        handlerReturning(response),
      ),
    )
  }

  it('records a mutating request: who, what, and which entity', async () => {
    await run({
      method: 'POST',
      originalUrl: '/clinics',
      params: {},
      user: admin,
    })

    expect(auditService.log).toHaveBeenCalledWith({
      performedBy: 1,
      action: 'POST /clinics',
      entityType: 'clinics',
      entityId: 5,
    })
  })

  it('records nothing for a read', async () => {
    await run({
      method: 'GET',
      originalUrl: '/clinics',
      params: {},
      user: admin,
    })

    expect(auditService.log).not.toHaveBeenCalled()
  })

  // A route whose service writes its own, detailed entry (in the change's
  // transaction): a generic one beside it would be a vague duplicate.
  it('records nothing for a route tagged @AuditedByService()', async () => {
    // A decorator is just a function applied to its target: this is what
    // `@AuditedByService()` above a method does.
    function taggedHandler() {}
    AuditedByService()(taggedHandler)

    await run(
      {
        method: 'POST',
        originalUrl: '/assigned-programs/12/schedules',
        params: { id: '12' },
        user: admin,
      },
      { id: 12 },
      taggedHandler,
    )

    expect(auditService.log).not.toHaveBeenCalled()
  })

  // getAllAndOverride also looks at the controller: tagging a whole class
  // covers every route in it.
  it('records nothing when the whole controller is tagged', async () => {
    class TaggedController {}
    AuditedByService()(TaggedController)

    await run(
      {
        method: 'PATCH',
        originalUrl: '/assigned-programs/12',
        params: { id: '12' },
        user: admin,
      },
      { id: 12 },
      untaggedHandler,
      TaggedController,
    )

    expect(auditService.log).not.toHaveBeenCalled()
  })

  // A POST that changes nothing says so with @NotAudited(reason): nothing to
  // record (the audit review, slice 1b — the reset-link check).
  it('records nothing for a route tagged @NotAudited(reason)', async () => {
    function checkHandler() {}
    NotAudited('Only checks a token; nothing changes')(checkHandler)

    await run(
      {
        method: 'POST',
        originalUrl: '/auth/reset-password/check',
        params: {},
        user: admin,
      },
      { email: 'a@example.com' },
      checkHandler,
    )

    expect(auditService.log).not.toHaveBeenCalled()
  })

  // The URL prefix that used to exempt every /auth route is gone: an /auth
  // route WITHOUT a tag is recorded like any other — so a new auth route
  // can't slip by unrecorded just because of where it lives.
  it('records an untagged /auth route like any other mutating request', async () => {
    await run(
      {
        method: 'POST',
        originalUrl: '/auth/some-new-route',
        params: {},
        user: admin,
      },
      null,
    )

    expect(auditService.log).toHaveBeenCalledWith({
      performedBy: 1,
      action: 'POST /auth/some-new-route',
      entityType: 'auth',
      entityId: undefined,
    })
  })

  // Audit writes are fire-and-forget: a failure must not fail the request
  // (the response still arrives), and the log line must say why.
  it('still answers, and logs the reason, when the audit write fails', async () => {
    auditService.log.mockRejectedValue(new Error('connection terminated'))
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)

    await expect(
      run({
        method: 'PATCH',
        originalUrl: '/clinics/5',
        params: { id: '5' },
        user: admin,
      }),
    ).resolves.toEqual({ id: 5 })
    // The .catch() runs after the response went out (fire-and-forget).
    await new Promise((resolve) => setImmediate(resolve))

    expect(errorLog).toHaveBeenCalledWith(
      'Failed to write audit log for PATCH /clinics/5: connection terminated',
    )
  })
})
