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

import type {
  EmailTransport,
  OutgoingEmail,
} from '../../src/email/email-transport'

// The seed creates every account the real way — UsersService.create,
// which emails an invitation — but most of those invitations are accepted
// straight away by the seed itself. Sending them all would fill Mailpit
// with a dozen emails for accounts that are already set up.
//
// So the seed installs this transport (in place of the configured one,
// through Nest's overrideProvider) and switches its mode around each
// account:
//   capture — keep the email here instead of sending it. The seed reads
//             the token from its link and accepts the invitation, like the
//             person would; for the app it was sent (email_sent_at is set).
//   deliver — hand it to the REAL transport (Mailpit with
//             EMAIL_TRANSPORT=smtp): the pending invitation a reviewer opens.
//             Except in the reviewers' demo (production, decisions §46):
//             there the real transport is Resend and the address is a
//             @stride.test one that can't exist — the email is KEPT, as in
//             capture (for the app it was sent; the invitation is pending).
//   fail    — reject, like an unreachable mail server: produces the
//             "couldn't be sent" state through the app's own code path.
export type SeedEmailMode = 'capture' | 'deliver' | 'fail'

export class SeedEmailTransport implements EmailTransport {
  mode: SeedEmailMode = 'capture'
  readonly captured: OutgoingEmail[] = []

  // `deliverForReal` false: 'deliver' keeps the email (the demo's reset).
  constructor(
    private readonly real: EmailTransport,
    private readonly deliverForReal = true,
  ) {}

  send(email: OutgoingEmail): Promise<void> {
    switch (this.mode) {
      case 'capture':
        this.captured.push(email)
        return Promise.resolve()
      case 'deliver':
        if (!this.deliverForReal) {
          this.captured.push(email)
          return Promise.resolve()
        }
        return this.real.send(email)
      case 'fail':
        return Promise.reject(
          new Error(
            `Seed: delivery to ${email.to} fails on purpose (email-failed state)`,
          ),
        )
    }
  }

  // The raw invitation token from the last captured email to `address`,
  // read from its accept link (…/accept-invitation?token=<64 hex>).
  invitationTokenFor(address: string): string {
    const email = this.captured.filter((e) => e.to === address).at(-1)
    if (!email) {
      throw new Error(`Seed: no captured email to ${address}`)
    }
    const match = /\/accept-invitation\?token=([0-9a-f]{64})/.exec(email.text)
    if (!match) {
      throw new Error(`Seed: the email to ${address} has no invitation link`)
    }
    return match[1]
  }
}