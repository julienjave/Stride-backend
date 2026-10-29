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
import type { AuditEntry } from './audit.service'

// A stand-in for a Drizzle connection or transaction: insert(table) →
// values(row), recording what was inserted where.
function fakeDb() {
  const values = jest.fn().mockResolvedValue(undefined)
  const insert = jest.fn(() => ({ values }))
  return { db: { insert } as unknown as DrizzleDb, insert, values }
}

describe('AuditService.logInTransaction', () => {
  const entry: AuditEntry = {
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

describe('AuditService.logReads', () => {
  // A practitioner (7) reading two patients' data, and an admin's own read
  // (9 reading 9 — e.g. an account that is also a patient).
  const read = (performedBy: number, targetUserId: number): AuditEntry => ({
    performedBy,
    action: 'PROGRAMS_VIEWED',
    targetUserId,
    entityType: 'assigned-programs',
    details: { programIds: [targetUserId * 10] },
  })

  // ONE statement for every entry: all of them are written, or none.
  it('writes every entry in one insert, on its own connection', async () => {
    const own = fakeDb()
    const service = new AuditService(own.db)

    await service.logReads([read(7, 20), read(7, 21)])

    expect(own.insert).toHaveBeenCalledTimes(1)
    expect(own.insert).toHaveBeenCalledWith(auditLogs)
    expect(own.values).toHaveBeenCalledWith([read(7, 20), read(7, 21)])
  })

  // "Others' reads only" (decided 2026-10-21): the patient reading their
  // own data is not recorded — decided here, for every caller.
  it("drops a read of the reader's own data", async () => {
    const own = fakeDb()
    const service = new AuditService(own.db)

    await service.logReads([read(9, 9), read(9, 20)])

    expect(own.values).toHaveBeenCalledWith([read(9, 20)])
  })

  // An insert of zero rows is an SQL error in Drizzle — and there is
  // nothing to record anyway (an empty list, or only one's own data).
  it('writes nothing when nothing is left to record', async () => {
    const own = fakeDb()
    const service = new AuditService(own.db)

    await service.logReads([])
    await service.logReads([read(9, 9)])

    expect(own.insert).not.toHaveBeenCalled()
  })

  // The caller awaits it before answering: a failed insert must fail the
  // request, so the data is never served without its trace.
  it('lets a failed insert reach the caller', async () => {
    const own = fakeDb()
    own.values.mockRejectedValueOnce(new Error('insert failed'))
    const service = new AuditService(own.db)

    await expect(service.logReads([read(7, 20)])).rejects.toThrow(
      'insert failed',
    )
  })
})

describe('AuditService.actions', () => {
  // The screen's action filter: every action, by name, with its kind — no
  // database involved.
  it('lists every action with its kind, sorted by name', () => {
    const own = fakeDb()
    const service = new AuditService(own.db)

    const list = service.actions()

    expect(list).toHaveLength(115)
    expect(list.map((item) => item.action)).toEqual(
      list.map((item) => item.action).sort(),
    )
    expect(list.at(-1)).toStrictEqual({
      action: 'USER_UPDATED',
      kind: 'change',
    })
    expect(list).toContainEqual({ action: 'SESSION_VIEWED', kind: 'view' })
    expect(list).toContainEqual({ action: 'LOGIN_FAILURE', kind: 'sign_in' })
    expect(own.insert).not.toHaveBeenCalled()
  })
})
