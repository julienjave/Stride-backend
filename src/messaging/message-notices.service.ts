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
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { EmailService } from '../email/email.service'
import { errorMessage } from '../common/error-message'
import { reportError } from '../observability/error-reporting'
import {
  NOTICE_DELAY_MINUTES,
  groupNotices,
  type ClaimedNoticeRow,
} from './message-rules'

// How often the sweep looks. Every minute: a notice then goes out between
// 15 and 16 minutes after the message — a minute's precision is plenty for
// "you have a message waiting".
export const NOTICE_SWEEP_INTERVAL_MS = 60_000

// --- SERVICE -----------------------------------------------------------------------------------------------

// The new-message emails (roadmap Phase 6.5, decided with the person
// 2026-10-29): someone who isn't in the app learns that a message waits —
// WITHOUT its text (an email is not a secure channel for clinical content:
// it says who wrote and links to Stride, which shows it after sign-in).
//
// The rules, all kept by the database's claim_message_notices() (0075):
//   - a message unread for NOTICE_DELAY_MINUTES (15 — the delete window);
//   - ONE email per conversation until the person reads it — a thread with
//     ten new messages is one email, and nothing more until it's opened;
//   - only to an active account with the setting on;
//   - each due notice claimed ONCE, even with several backend instances.
// This class only runs that query on a timer, groups the rows (one email per
// person and side per sweep) and sends.
//
// A plain setInterval, not a scheduling package: one job, every minute, in
// the process that serves the API — @nestjs/schedule would add a dependency
// to do the same thing. What a package would also give (cron syntax,
// several jobs) isn't needed. The claim's SKIP LOCKED makes several
// instances safe without a distributed lock.
//
// STARTED BY main.ts, after the server listens — not by the module itself:
// the e2e suites, the seed and every script build the same modules, and
// none of them should send emails on a timer. They call sweep() directly.
@Injectable()
export class MessageNoticesService implements OnApplicationShutdown {
  private readonly logger = new Logger(MessageNoticesService.name)
  private timer: ReturnType<typeof setInterval> | null = null
  // A sweep still running when the next tick comes (a slow mail server)
  // is not doubled: the tick is skipped. (The claim would keep two sweeps
  // from sending the same notice anyway; this keeps them from piling up.)
  private running = false

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly emailService: EmailService,
  ) {}

  start(intervalMs = NOTICE_SWEEP_INTERVAL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), intervalMs)
    // unref(): the timer alone doesn't keep Node alive — shutting the app
    // down never waits for "the next minute".
    this.timer.unref()
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.sweep()
    } catch (error: unknown) {
      // A failed sweep (the database briefly unreachable) must not stop the
      // timer or crash the server: logged, and the next minute tries again.
      this.logger.error({ err: error }, 'The new-message email sweep failed')
      // Reported too: nobody is looking at a page when a background job
      // fails, so nothing else would surface it (decisions §32).
      reportError(error, { where: 'message-notices-sweep' })
    } finally {
      this.running = false
    }
  }

  // One sweep: claim what's due, then send — AFTER the claim's statement
  // has committed (it runs on its own, outside any transaction of ours),
  // never inside it: an email is a network call. Returns how many emails
  // were sent, for the tests and the log.
  //
  // At most once: a notice whose email fails is logged and not retried (the
  // claim already marked it) — see 0075. The message is still there.
  async sweep(): Promise<number> {
    const { rows } = await this.db.execute<ClaimedNoticeRow>(
      sql`SELECT * FROM claim_message_notices(${NOTICE_DELAY_MINUTES})`,
    )
    let sent = 0
    for (const notice of groupNotices(rows)) {
      try {
        await this.emailService.sendNewMessagesNotice(notice)
        sent++
      } catch (error) {
        // Never the address in the log line: the account id says who.
        this.logger.warn(
          `Could not send a new-message email to user ${notice.recipientId}: ${errorMessage(error)}`,
        )
      }
    }
    if (sent > 0) this.logger.log(`Sent ${sent} new-message email(s)`)
    return sent
  }
}
