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

import { AuditService } from './audit.service'
import { auditLogs } from '../database/schema'
import type { DrizzleDb } from '../database/drizzle.provider'

// A stand-in for a Drizzle connection or transaction: insert(table) →
// values(row), recording what was inserted where.
function fakeDb() {
  const values = jest.fn().mockResolvedValue(undefined)
  const insert = jest.fn(() => ({ values }))
  return { db: { insert } as unknown as DrizzleDb, insert, values }
}

describe('AuditService.logInTransaction', () => {
  const entry = {
    performedBy: 7,
    action: 'ASSIGNED_PROGRAM_SCHEDULE_SET',
    targetUserId: 20,
    entityType: 'assigned-programs',
    entityId: 12,
    details: { effectiveFrom: '2026-10-12' },
  }

  // The whole point: through the transaction it's given, NOT the service's
  // own connection — otherwise the entry wouldn't roll back with the change.
  it("writes through the caller's transaction, never its own connection", async () => {
    const own = fakeDb()
    const tx = fakeDb()
    const service = new AuditService(own.db)

    await service.logInTransaction(tx.db, entry)

    expect(tx.insert).toHaveBeenCalledWith(auditLogs)
    expect(tx.values).toHaveBeenCalledWith(entry)
    expect(own.insert).not.toHaveBeenCalled()
  })

  // A failed insert must fail the caller (and so roll back the change),
  // not be swallowed like the interceptor's fire-and-forget log.
  it('lets a failed insert reach the caller', async () => {
    const tx = fakeDb()
    tx.values.mockRejectedValueOnce(new Error('insert failed'))
    const service = new AuditService(fakeDb().db)

    await expect(service.logInTransaction(tx.db, entry)).rejects.toThrow(
      'insert failed',
    )
  })
})
