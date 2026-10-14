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

import { Logger } from '@nestjs/common'
import type { EmailTransport, OutgoingEmail } from '../email-transport'

// --- TRANSPORT ---------------------------------------------------------------------------------------------

// Local development delivery: nothing leaves the machine. The email's
// plain-text body is printed to the backend's console, which is where the
// developer copies a reset or invitation link from. No API key, no network,
// no Resend sandbox restrictions on who can receive mail.
//
// NEVER allowed in production, and refused there at boot
// (getEmailTransportKind() in email-transport.config.ts): these emails
// carry live secrets — a reset link IS a password reset — and production
// logs are read by far more people and systems than a developer's own
// terminal. A reset link sitting in a log store would let anyone with log
// access take over the account.
export class LogTransport implements EmailTransport {
  private readonly logger = new Logger(LogTransport.name)

  // Not `async`: there is nothing to wait for, and an async method with no
  // `await` inside trips the require-await lint rule. The interface still
  // gets the Promise it expects, already resolved.
  send(email: OutgoingEmail): Promise<void> {
    this.logger.log(
      [
        `Email (not sent — EMAIL_TRANSPORT=log)`,
        `  To:      ${email.to}`,
        `  Subject: ${email.subject}`,
        '',
        email.text,
      ].join('\n'),
    )
    return Promise.resolve()
  }
}
