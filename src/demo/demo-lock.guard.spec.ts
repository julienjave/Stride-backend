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

import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { DrizzleDb } from '../database/drizzle.provider'
import { DemoLocked, DemoLockGuard, demoLockedMessage } from './demo-lock.guard'

// The guard with a REAL Reflector reading the metadata of real decorated
// methods (so the decorator and the guard are tested together), and a fake
// database: `db.transaction(cb)` runs cb with a `tx` whose select chain
// answers the rows each test chooses. DEMO_MODE is set on process.env for
// each test and removed after.

class Routes {
  @DemoLocked('password')
  changePassword() {}

  @DemoLocked('deactivate', 'param')
  deactivate() {}

  notLocked() {}
}

function fakeDb(rows: { email: string }[]) {
  const where = jest.fn().mockResolvedValue(rows)
  const tx = {
    // withRlsContext sets the RLS context with execute() first.
    execute: jest.fn().mockResolvedValue(undefined),
    select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
  }
  const transaction = jest.fn((cb: (t: typeof tx) => unknown) => cb(tx))
  return { db: { transaction } as unknown as DrizzleDb, transaction, where }
}

function contextFor(
  handler: () => void,
  request: { user?: object; params?: Record<string, string> },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ params: {}, ...request }) }),
  } as unknown as ExecutionContext
}

// Each route's handler, as Nest hands it to a guard (getHandler): read from
// the class's property descriptor — the decorators' metadata is attached
// there — rather than `new Routes().changePassword`, which lint rightly calls
// an unbound method.
function handler(name: keyof Routes): () => void {
  return Object.getOwnPropertyDescriptor(Routes.prototype, name)!
    .value as () => void
}
const routes = {
  changePassword: handler('changePassword'),
  deactivate: handler('deactivate'),
  notLocked: handler('notLocked'),
}
const pat = { id: 3, email: 'pat@stride.test', activeRole: 'patient' }
const robin = { id: 4, email: 'robin@stride.test', activeRole: 'patient' }
const admin = { id: 1, email: 'admin@stride.test', activeRole: 'admin' }

describe('DemoLockGuard', () => {
  const before = process.env.DEMO_MODE
  afterEach(() => {
    if (before === undefined) delete process.env.DEMO_MODE
    else process.env.DEMO_MODE = before
  })

  function guardWith(rows: { email: string }[] = []) {
    const fake = fakeDb(rows)
    return { guard: new DemoLockGuard(new Reflector(), fake.db), ...fake }
  }

  // Outside demo mode the guard is free: no refusal and NO query, even for a
  // card account on a locked route.
  it('lets everything through outside demo mode, without reading anything', async () => {
    delete process.env.DEMO_MODE
    const { guard, transaction } = guardWith([{ email: 'pat@stride.test' }])
    await expect(
      guard.canActivate(contextFor(routes.changePassword, { user: pat })),
    ).resolves.toBe(true)
    await expect(
      guard.canActivate(
        contextFor(routes.deactivate, { user: admin, params: { id: '3' } }),
      ),
    ).resolves.toBe(true)
    expect(transaction).not.toHaveBeenCalled()
  })

  describe('in demo mode', () => {
    beforeEach(() => {
      process.env.DEMO_MODE = 'on'
    })

    it("refuses a card account's own change, with the sentence for that change", async () => {
      const { guard, transaction } = guardWith()
      await expect(
        guard.canActivate(contextFor(routes.changePassword, { user: pat })),
      ).rejects.toThrow(new ForbiddenException(demoLockedMessage('password')))
      // `self`: the signed-in user's own address — nothing to read.
      expect(transaction).not.toHaveBeenCalled()
    })

    it('lets any other account change itself', async () => {
      const { guard } = guardWith()
      await expect(
        guard.canActivate(contextFor(routes.changePassword, { user: robin })),
      ).resolves.toBe(true)
    })

    // `param`: the account in /users/:id, read as the signed-in person.
    it('refuses a change to the card account named in the address', async () => {
      const { guard, where } = guardWith([{ email: 'pat@stride.test' }])
      await expect(
        guard.canActivate(
          contextFor(routes.deactivate, { user: admin, params: { id: '3' } }),
        ),
      ).rejects.toThrow(new ForbiddenException(demoLockedMessage('deactivate')))
      expect(where).toHaveBeenCalledTimes(1)
    })

    // The ADMIN is a card account too — but `param` looks at the account in
    // the address, not at who asks: an admin may deactivate anyone else.
    it('lets a card account change another, unlocked account', async () => {
      const { guard } = guardWith([{ email: 'robin@stride.test' }])
      await expect(
        guard.canActivate(
          contextFor(routes.deactivate, { user: admin, params: { id: '4' } }),
        ),
      ).resolves.toBe(true)
    })

    // Not a number, or an account the asker can't see: the route's own
    // checks answer (400 from ParseIntPipe, its 404 / 403) — as without demo.
    it.each(['abc', '0', '-2', '1.5'])(
      'leaves %j in the address to the route, without reading',
      async (id) => {
        const { guard, transaction } = guardWith([{ email: 'pat@stride.test' }])
        await expect(
          guard.canActivate(
            contextFor(routes.deactivate, { user: admin, params: { id } }),
          ),
        ).resolves.toBe(true)
        expect(transaction).not.toHaveBeenCalled()
      },
    )

    it('leaves an account it cannot see to the route', async () => {
      const { guard } = guardWith([])
      await expect(
        guard.canActivate(
          contextFor(routes.deactivate, { user: admin, params: { id: '99' } }),
        ),
      ).resolves.toBe(true)
    })

    // Not signed in: SessionAuthGuard's 401, not this guard's 403.
    it('lets a request with no user through to the session guard', async () => {
      const { guard } = guardWith()
      await expect(
        guard.canActivate(contextFor(routes.changePassword, {})),
      ).resolves.toBe(true)
    })

    it('lets a route without @DemoLocked through', async () => {
      const { guard } = guardWith()
      await expect(
        guard.canActivate(contextFor(routes.notLocked, { user: pat })),
      ).resolves.toBe(true)
    })
  })
})

describe('demoLockedMessage', () => {
  it('says what is refused, why, and what to do instead', () => {
    expect(demoLockedMessage('email')).toBe(
      "This is one of the demo's shared accounts, so its email address can't be changed: " +
        'other reviewers sign in with it. To try this, invite yourself as a new user.',
    )
    expect(demoLockedMessage('merge')).toContain(
      "it can't be merged into another account",
    )
  })
})
