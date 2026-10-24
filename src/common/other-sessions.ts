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

import { sql } from 'drizzle-orm'
import type { DrizzleDb } from '../database/drizzle.provider'

// --- FUNCTION ----------------------------------------------------------------------------------------------

// "Signed out on your other devices": deletes every session of the account
// except the one making the request, and answers with the ids it deleted.
// Two changes do this (the person's choices): changing the password
// (decisions §13) and turning two-factor sign-in on — after either, a
// session opened under the old rules must not stay open.
//
// Raw SQL: the session table belongs to connect-pg-simple, outside Drizzle's
// schema; each row's `sess` is the JSON the SessionSerializer wrote, and the
// account's id sits at passport.user.id (see AuthService.
// destroyAllSessionsForUser). Called in the caller's TRANSACTION: if the
// change fails, the sessions stay as they were. The ids come back so the
// caller can close those sessions' sockets AFTER the commit
// (MessagingEvents.disconnectSession) — a socket is authenticated once, at
// its handshake, and would otherwise keep receiving messages.
export async function endOtherSessions(
  tx: DrizzleDb,
  userId: number,
  keptSessionId: string,
): Promise<string[]> {
  const ended = await tx.execute<{ sid: string }>(
    sql`DELETE FROM session
           WHERE (sess::jsonb)->'passport'->'user'->>'id' = ${String(userId)}
             AND sid <> ${keptSessionId}
       RETURNING sid`,
  )
  return ended.rows.map((row) => row.sid)
}

// Every session of the account — for an admin's reset of someone ELSE's
// two-factor sign-in (decisions §14): the admin's own session isn't the
// account's, so there is nothing to keep (passing it to endOtherSessions
// would be a condition that can never match). The same SQL otherwise, in the
// caller's transaction, the ids answered for their sockets.
export async function endAllSessions(
  tx: DrizzleDb,
  userId: number,
): Promise<string[]> {
  const ended = await tx.execute<{ sid: string }>(
    sql`DELETE FROM session
           WHERE (sess::jsonb)->'passport'->'user'->>'id' = ${String(userId)}
       RETURNING sid`,
  )
  return ended.rows.map((row) => row.sid)
}

// ONE session — the one making the request — for the step-up's sign-out
// after 5 failures in a row (decisions §16, mfa/step-up.service.ts): only
// the session that failed ends; the account's other devices stay signed in
// (if they belong to the owner, nothing they did was wrong). In the caller's
// transaction, with the counter's reset and the audit entry; the id is the
// caller's own, to close its sockets after the commit.
//
// Deleting the store's row IS signing out: every request reads its session
// from this table (connect-pg-simple), so the next one carrying the cookie
// finds nothing and is answered 401. express-session won't write the row
// back at the end of THIS request: with `resave: false` it saves only a
// session the request MODIFIED, and a step-up modifies none (an unmodified
// one is only "touched" — an UPDATE of its expiry, which finds no row).
export async function endSession(
  tx: DrizzleDb,
  sessionId: string,
): Promise<void> {
  await tx.execute(sql`DELETE FROM session WHERE sid = ${sessionId}`)
}
