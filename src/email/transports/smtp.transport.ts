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
import type { Transporter } from 'nodemailer'
import { errorMessage } from '../../common/error-message'
import type { EmailTransport, OutgoingEmail } from '../email-transport'

// --- TYPES -------------------------------------------------------------------------------------------------

// The one method of nodemailer's Transporter this class calls. Taking a
// Pick instead of the whole Transporter is what lets the spec pass a small
// stand-in (`{ sendMail: jest.fn() }`) — same seam as ResendTransport's
// ResendEmailsClient. createEmailTransport() passes the real one.
export type SmtpMailer = Pick<Transporter, 'sendMail'>

// --- TRANSPORT ---------------------------------------------------------------------------------------------

// Delivers email over SMTP — the protocol every mail server speaks. Used
// in local development against Mailpit (docker-compose.yml), a fake mail
// server that accepts everything and shows it in a web inbox at
// http://localhost:8025 instead of delivering it. The same class could
// talk to a real provider's SMTP endpoint (Resend has one) — only the
// SMTP_* settings would change.
//
// Unlike Resend's SDK (which RESOLVES with an error object — see
// ResendTransport), nodemailer's sendMail() REJECTS on failure: server
// unreachable, connection refused, address rejected… So this class has
// no error to translate; it only says which step failed.
//
// Never the recipient's address, in a log line OR an error message (decisions
// §32: the logs leave the server, and an error's message ends up in one —
// the callers log `errorMessage(error)` with the account's id).
export class SmtpTransport implements EmailTransport {
  private readonly logger = new Logger(SmtpTransport.name)

  constructor(private readonly mailer: SmtpMailer) {}

  async send(email: OutgoingEmail): Promise<void> {
    try {
      // nodemailer turns this into a MIME message with two alternative
      // parts (text and HTML) — mail clients show the richest one they
      // can — and speaks the SMTP conversation to deliver it.
      const info = await this.mailer.sendMail({
        from: email.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })
      // messageId: the Message-ID header the message was sent with — the
      // same id the receiving server and Mailpit show, so a log line can be
      // matched to the email. Logged WITHOUT the body (it holds live links)
      // and without the address (the id finds it in the mail server's own
      // records, which may hold it).
      this.logger.log(`Email sent (SMTP message id: ${info.messageId})`)
    } catch (error) {
      // The reason goes INTO the message, so whoever logs this error's
      // message shows why ("connect ECONNREFUSED 127.0.0.1:1025": Mailpit
      // isn't running) — see errorMessage(). `cause` still keeps the
      // original error (with nodemailer's `code`) attached, for anything
      // that reads it.
      throw new Error(`SMTP delivery failed: ${errorMessage(error)}`, {
        cause: error,
      })
    }
  }
}
