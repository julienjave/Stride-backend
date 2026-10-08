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
import { lastValueFrom, of } from 'rxjs'
import type { AuditService } from '../../audit/audit.service'
import { AuditLogInterceptor } from './audit-log.interceptor'

// An interceptor wraps a route handler: Nest gives it the request (inside
// an ExecutionContext) and the handler (a CallHandler whose handle()
// returns the response as an Observable). Both are replaced here by the
// smallest objects that answer the calls the interceptor makes.
function contextFor(request: object) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
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
    interceptor = new AuditLogInterceptor(
      auditService as unknown as AuditService,
    )
  })

  afterEach(() => jest.restoreAllMocks())

  // lastValueFrom() subscribes and waits for the response — without a
  // subscriber, an Observable runs nothing, so tap() would never fire.
  async function run(request: object, response: unknown = { id: 5 }) {
    return lastValueFrom(
      interceptor.intercept(contextFor(request), handlerReturning(response)),
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