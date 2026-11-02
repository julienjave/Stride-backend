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

import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { eq } from 'drizzle-orm'
import { demoModeEnabled } from '../config/demo-mode'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { withRlsContext } from '../database/rls-context'
import { users } from '../database/schema'
import type { AuthenticatedRequest } from '../common/decorators/current-user.decorator'
import { isDemoCardAccount } from './demo-accounts'

// --- THE SHARED ACCOUNTS ARE LOCKED IN DEMO MODE -----------------------------------------------------------
//
// Decisions §46. The demo's sign-in page publishes four accounts and their
// password. If one reviewer changes `admin@`'s password, email or two-factor
// sign-in — or deactivates Alex, or merges Pat away — every other reviewer is
// locked out until the next reset. So, in demo mode only, the routes that make
// those changes refuse when the account they'd change is one of the four.
//
// Why a GUARD, and not a check in each service: the rule is about WHICH
// ACCOUNT a request touches, decided before any of the route's own work — the
// question Nest's guards answer (RolesGuard: "may this role do this?"). One
// class, one decorator per route, read at a glance on the controller; no
// service or its specs learn that a demo exists. And it runs BEFORE the
// route's step-up: a refused request never checks a password, so it never
// counts as a failed step-up (5 in a row sign the session out — §16) and never
// spends a two-factor code.
//
// Which account: the signed-in person's own (`self` — password, email,
// two-factor) or the one in the address (`param` — `/users/:id`: deactivate,
// the admin's two-factor reset, a merge, where `:id` is the account merged
// AWAY). Identified by EMAIL, not id: a reset recreates the accounts, and ids
// are just row numbers; the addresses are what the card publishes.

export type DemoLockedChange =
  'password' | 'email' | 'two_factor' | 'deactivate' | 'merge'

type LockedAccount = 'self' | 'param'

interface DemoLock {
  change: DemoLockedChange
  account: LockedAccount
}

const DEMO_LOCK_KEY = 'demoLock'

// What the refused person reads — the frontend shows a refusal's own words
// (failureText). It says why (others sign in with it) and what to do instead.
const WHAT_CANT_HAPPEN: Record<DemoLockedChange, string> = {
  password: "its password can't be changed",
  email: "its email address can't be changed",
  two_factor: "its two-factor sign-in can't be changed",
  deactivate: "it can't be deactivated",
  merge: "it can't be merged into another account",
}

export function demoLockedMessage(change: DemoLockedChange): string {
  return (
    `This is one of the demo's shared accounts, so ${WHAT_CANT_HAPPEN[change]}: ` +
    'other reviewers sign in with it. To try this, invite yourself as a new user.'
  )
}

// --- THE DECORATOR -----------------------------------------------------------------------------------------
//
// `@DemoLocked('password')` on a route. applyDecorators() bundles two
// decorators into one: the metadata (what the guard reads) and the guard
// itself — so a route can't get one without the other. Method-level guards
// run AFTER the controller's (SessionAuthGuard), but `@UseGuards` lists on
// one method are run in an order that depends on how the decorators are
// stacked; the guard therefore never assumes a user is there (see below).
export function DemoLocked(
  change: DemoLockedChange,
  account: LockedAccount = 'self',
) {
  return applyDecorators(
    SetMetadata(DEMO_LOCK_KEY, { change, account } satisfies DemoLock),
    UseGuards(DemoLockGuard),
  )
}

// --- THE GUARD ---------------------------------------------------------------------------------------------

@Injectable()
export class DemoLockGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Outside demo mode: nothing to check, no query — a real clinic's
    // deployment pays nothing for this guard.
    if (!demoModeEnabled()) return true
    const lock = this.reflector.get<DemoLock | undefined>(
      DEMO_LOCK_KEY,
      context.getHandler(),
    )
    if (!lock) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const user = request.user
    // Not signed in: not this guard's answer — SessionAuthGuard's 401.
    if (!user) return true

    const email =
      lock.account === 'self'
        ? user.email
        : await this.emailOf(user, request.params.id)
    if (email !== null && isDemoCardAccount(email)) {
      throw new ForbiddenException(demoLockedMessage(lock.change))
    }
    return true
  }

  // The address of the account in `/users/:id`, read as the signed-in person
  // (their row security: an admin reads every account; anyone else, at most
  // the ones they may see). Not a number (ParseIntPipe answers 400 later) or no
  // such account visible (the route answers its own 404 / 403): null — the
  // route's own checks decide, as without the demo.
  private async emailOf(
    user: NonNullable<AuthenticatedRequest['user']>,
    param: unknown,
  ): Promise<string | null> {
    const id = typeof param === 'string' ? Number(param) : NaN
    if (!Number.isInteger(id) || id <= 0) return null
    const rows = await withRlsContext(this.db, user, (tx) =>
      tx.select({ email: users.email }).from(users).where(eq(users.id, id)),
    )
    return rows[0]?.email ?? null
  }
}
