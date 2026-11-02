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
import type { Resend } from 'resend'
import type { EmailTransport, OutgoingEmail } from '../email-transport'
import { hasReservedDomain } from '../reserved-domains'

// --- TYPES -------------------------------------------------------------------------------------------------

// The one slice of the Resend SDK this transport touches. Taking this
// narrow shape in the constructor (instead of building `new Resend(key)`
// here) is what makes the class unit-testable: the spec passes a stub with
// a jest.fn() `send`, no network, no API key, no module mocking.
export type ResendEmailsClient = Pick<Resend, 'emails'>

// --- TRANSPORT ---------------------------------------------------------------------------------------------

// Production delivery, through Resend's HTTP API. This is the sending code
// that used to live inside EmailService.sendPasswordResetEmail(), moved
// here unchanged in substance — with one deliberate difference: a Resend
// error now REJECTS instead of being logged and swallowed (see
// EmailTransport's comment on why callers decide that).
export class ResendTransport implements EmailTransport {
  private readonly logger = new Logger(ResendTransport.name)

  constructor(private readonly client: ResendEmailsClient) {}

  async send(email: OutgoingEmail): Promise<void> {
    // An address that can never exist (reserved-domains.ts) is refused HERE,
    // before Resend: it would only come back as a bounce, which counts
    // against the sending domain (the reviewers' demo — decisions §46).
    // Rejected like any failed send: an invitation then shows "couldn't be
    // sent", which is the truth; a notice is logged and skipped, as always.
    // Without the address (decisions §32): the caller logs the account's id.
    if (hasReservedDomain(email.to)) {
      throw new Error(
        "Not sent: the address's domain is reserved for examples and tests (RFC 2606) and can never receive email",
      )
    }
    // Resend's SDK doesn't throw on an API-level failure (invalid
    // recipient, bad key, rate limit…) — it RESOLVES with `{ data: null,
    // error }`. Forgetting to check `error` would make every failed send
    // look like a success. Only a network-level failure makes the call
    // itself reject, and that rejection passes straight through.
    const { data, error } = await this.client.emails.send({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      // Inline images (the logo — decisions §41): Resend sends an
      // attachment as INLINE when it has a `contentId`, which the HTML then
      // references as `cid:<contentId>`. A Buffer is accepted as is (the
      // SDK base64-encodes it for the JSON request).
      attachments: (email.inlineImages ?? []).map((image) => ({
        contentId: image.contentId,
        filename: image.filename,
        contentType: image.contentType,
        content: image.content,
      })),
    })

    if (error) {
      // Turned into a real exception so this transport keeps the
      // interface's promise: resolve means accepted, reject means not.
      // Without the address (decisions §32): the caller logs this message
      // with the account's id.
      throw new Error(
        `Resend rejected the email: ${error.name} — ${error.message}`,
      )
    }

    // Resend's email id is what ties this log line to the delivery status
    // in Resend's dashboard, if a recipient says they never got it — so the
    // address itself needn't be in the log (decisions §32).
    this.logger.log(`Email sent (Resend id: ${data?.id})`)
  }
}
