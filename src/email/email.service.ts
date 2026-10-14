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

import { Inject, Injectable } from '@nestjs/common'
import { EMAIL_TRANSPORT, type EmailTransport } from './email-transport'
import { escapeHtml } from './escape-html'

// --- TYPES -------------------------------------------------------------------------------------------------

// Everything an invitation email says, gathered by InvitationsService.
export interface InvitationEmail {
  to: string
  rawToken: string
  // The invited person's first name, for the greeting.
  firstName: string
  // Who sent it, as it should read ("Dr Alice Martin" → "Alice Martin").
  invitedByName: string
  // The account's clinics, to say WHERE they're invited; may be empty
  // (an admin account belongs to no clinic until one is added).
  clinicNames: string[]
  // How long the link lasts, written into the email. Passed in rather
  // than imported from the invitations code, so this module doesn't depend
  // on the module that depends on it.
  validForDays: number
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// Decides WHAT each email says — subject, HTML and plain-text bodies, the
// link inside — and hands the finished email to whichever transport
// EmailModule chose (see email-transport.ts). Nothing in here knows
// whether the email goes to Resend, the console, or a test's outbox.
@Injectable()
export class EmailService {
  // @Inject(EMAIL_TRANSPORT) is needed because the parameter's type is an
  // interface, which doesn't exist at runtime — Nest can't infer what to
  // inject from it the way it does for a class-typed parameter, so the
  // token names it explicitly.
  constructor(
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
  ) {}

  // Rejects if the transport couldn't send. It used to log and swallow a
  // Resend error itself; now the caller decides (forgotPassword() logs it
  // and moves on, fire-and-forget — see the comment there).
  async sendPasswordResetEmail(
    toEmail: string,
    rawToken: string,
  ): Promise<void> {
    const resetUrl = `${frontendUrl()}/reset-password?token=${rawToken}`

    await this.transport.send({
      from: senderAddress(),
      to: toEmail,
      subject: 'Reset your Stride password',
      html: `<p>Someone requested a password reset for this account.</p>
             <p><a href="${resetUrl}">Reset your password</a> — this link expires in 1 hour.</p>
             <p>If you didn't request this, you can safely ignore this email.</p>`,
      text: [
        'Someone requested a password reset for this account.',
        '',
        `Reset your password: ${resetUrl}`,
        'This link expires in 1 hour.',
        '',
        "If you didn't request this, you can safely ignore this email.",
      ].join('\n'),
    })
  }

  // Rejects if the transport couldn't send; InvitationsService reports that
  // to whoever sent the invitation (emailSent: false) instead of failing
  // the request — the account and the invitation exist either way.
  async sendInvitationEmail(invitation: InvitationEmail): Promise<void> {
    const acceptUrl = `${frontendUrl()}/accept-invitation?token=${invitation.rawToken}`
    const where = describeWhere(invitation.clinicNames)
    const validity = `${invitation.validForDays} days`

    await this.transport.send({
      from: senderAddress(),
      to: invitation.to,
      // A fixed subject, with no names in it: a mail header is not HTML,
      // and keeping user-typed text out of headers removes a whole class
      // of problems (line breaks, encodings) rather than handling each.
      subject: "You're invited to Stride",
      // Every value a person typed goes through escapeHtml() — see its
      // comment. The URL too: it's built from FRONTEND_URL, configuration
      // rather than user input, but it sits inside an attribute and
      // escaping it costs nothing.
      html: `<p>Hello ${escapeHtml(invitation.firstName)},</p>
             <p>${escapeHtml(invitation.invitedByName)} invited you to join ${escapeHtml(where)}.</p>
             <p><a href="${escapeHtml(acceptUrl)}">Choose your password</a> to activate your account — this link expires in ${validity}.</p>
             <p>If it has expired, ask your clinic to send you a new one. If you weren't expecting this invitation, you can ignore this email.</p>`,
      // The text body needs no escaping: plain text is never interpreted.
      text: [
        `Hello ${invitation.firstName},`,
        '',
        `${invitation.invitedByName} invited you to join ${where}.`,
        '',
        `Choose your password to activate your account: ${acceptUrl}`,
        `This link expires in ${validity}.`,
        '',
        'If it has expired, ask your clinic to send you a new one.',
        "If you weren't expecting this invitation, you can ignore this email.",
      ].join('\n'),
    })
  }
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// Read on every call rather than once at startup, same as before the
// transport split — and what lets the spec set these per test.
function frontendUrl(): string {
  return process.env.FRONTEND_URL ?? 'http://localhost:5173'
}

function senderAddress(): string {
  return process.env.EMAIL_FROM ?? 'Stride <onboarding@resend.dev>'
}

// "Stride", "Clinique Sud on Stride", "Clinique Sud and Clinique Nord on
// Stride", "A, B and C on Stride". Exported for its spec.
export function describeWhere(clinicNames: string[]): string {
  if (clinicNames.length === 0) return 'Stride'
  if (clinicNames.length === 1) return `${clinicNames[0]} on Stride`
  const allButLast = clinicNames.slice(0, -1).join(', ')
  return `${allButLast} and ${clinicNames[clinicNames.length - 1]} on Stride`
}
