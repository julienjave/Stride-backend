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

// The four emails of a change of sign-in address ("Change email", decisions
// §12), gathered by EmailChangeService. The NEW address is never written in
// full to the OLD inbox — EmailChangeService passes it masked
// (email-change/mask-email.ts), the person's choice.
export interface EmailChangeConfirmationEmail {
  // The NEW address: the link proves it receives mail.
  to: string
  firstName: string
  rawToken: string
  validForHours: number
}

export interface EmailChangeNoticeEmail {
  // The OLD address — the account's sign-in until the change is confirmed.
  to: string
  firstName: string
  maskedNewEmail: string
}

export interface EmailChangedNoticeEmail extends EmailChangeNoticeEmail {
  // Two-factor sign-in is on: the notice says what the authenticator app
  // will keep showing.
  twoFactorOn: boolean
}

export interface EmailChangeRequestedNoticeEmail extends EmailChangeNoticeEmail {
  // The cancel link's token: the old inbox may stop the change.
  rawCancelToken: string
}

// The notice after a password change from the profile (decisions §13),
// gathered by PasswordChangeService.
export interface PasswordChangedNoticeEmail {
  // The account's sign-in address — the inbox a reset link would go to.
  to: string
  firstName: string
}

// Two-factor sign-in turned on or off (MFA enrolment, Phase 6): a notice to
// the account's own inbox, like the password change's. Also the admin
// reset's notice.
export interface MfaNoticeEmail {
  to: string
  firstName: string
}

// A recovery code was used (pass 2): how many are left, so the person knows
// when to ask for new ones.
export interface RecoveryCodeUsedNoticeEmail {
  to: string
  firstName: string
  remaining: number
}

// The records export's emailed link (decisions §20, pass 2), gathered by
// RecordsExportLinksService.
export interface RecordsExportLinkEmail {
  // The address on file — the only place a copy of the record may be sent.
  to: string
  firstName: string
  rawToken: string
  validForHours: number
  dateOfBirthAttempts: number
  // The account can sign in (active, with a password): the email also says
  // where to download a copy in the app, any time, without asking.
  canSignIn: boolean
}

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// What an account with two-factor sign-in on is told after an email change:
// the authenticator app keeps the old address as its label. Exported: the
// frontend's Two-factor page says the same (twoFactorRules.ts there).
export const AUTHENTICATOR_LABEL_NOTE =
  'Your authenticator app may still show your old email address next to Stride: apps keep the name they were given when you set them up. Your codes keep working. To see the new address there, turn two-factor sign-in off and on again from your profile.'

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

  // To the NEW address: the link that makes the change. Rejects if the
  // transport couldn't send (EmailChangeService logs it — fire-and-forget,
  // like the reset email, so a taken address and a free one take the same
  // time to answer).
  async sendEmailChangeConfirmation(
    email: EmailChangeConfirmationEmail,
  ): Promise<void> {
    const confirmUrl = `${frontendUrl()}/confirm-email?token=${email.rawToken}`
    const validity = `${email.validForHours} hours`
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Confirm your new email address for Stride',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>You asked to use this address to sign in to Stride.</p>
             <p><a href="${escapeHtml(confirmUrl)}">Confirm this address</a> — this link expires in ${validity}. Until then, your account keeps its current address.</p>
             <p>If you didn't ask for this, you can ignore this email: nothing changes.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'You asked to use this address to sign in to Stride.',
        '',
        `Confirm this address: ${confirmUrl}`,
        `This link expires in ${validity}. Until then, your account keeps its current address.`,
        '',
        "If you didn't ask for this, you can ignore this email: nothing changes.",
      ].join('\n'),
    })
  }

  // To the NEW address when it already belongs to an account (decisions
  // §12, "reveal nothing"): the person asking is told "check your inbox"
  // either way, and only whoever reads THIS inbox learns the address is
  // taken. No name, no link — the email says nothing about either account.
  async sendEmailChangeAddressTaken(to: string): Promise<void> {
    await this.transport.send({
      from: senderAddress(),
      to,
      subject: 'This address already has a Stride account',
      html: `<p>Someone asked to use this address to sign in to Stride, but it already belongs to a Stride account, so it can't be used for another one.</p>
             <p>If it was you, sign in with this address instead — or use "Forgot your password?" on the sign-in page.</p>
             <p>If it wasn't you, you can ignore this email: nothing changes.</p>`,
      text: [
        "Someone asked to use this address to sign in to Stride, but it already belongs to a Stride account, so it can't be used for another one.",
        '',
        'If it was you, sign in with this address instead — or use "Forgot your password?" on the sign-in page.',
        '',
        "If it wasn't you, you can ignore this email: nothing changes.",
      ].join('\n'),
    })
  }

  // To the OLD address when a change is asked for: what is about to happen,
  // and the link that stops it. The address the change goes to is masked.
  async sendEmailChangeRequestedNotice(
    email: EmailChangeRequestedNoticeEmail,
  ): Promise<void> {
    const cancelUrl = `${frontendUrl()}/cancel-email-change?token=${email.rawCancelToken}`
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'A change of your Stride sign-in email was requested',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>Someone signed in to your Stride account asked to change its sign-in email to ${escapeHtml(email.maskedNewEmail)}. Nothing changes until that address confirms it.</p>
             <p>If this wasn't you, <a href="${escapeHtml(cancelUrl)}">cancel the change</a>, then reset your password from the sign-in page — someone may know it.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        `Someone signed in to your Stride account asked to change its sign-in email to ${email.maskedNewEmail}. Nothing changes until that address confirms it.`,
        '',
        `If this wasn't you, cancel the change: ${cancelUrl}`,
        'Then reset your password from the sign-in page — someone may know it.',
      ].join('\n'),
    })
  }

  // To the OLD address once the change is made: the last email it receives
  // about this account. With two-factor sign-in on, one more paragraph: an
  // authenticator app names the account by the label in the QR code it
  // scanned — the email at the time — and never reads it again, so it keeps
  // showing the OLD address (decided with the person 2026-10-29: say so,
  // rather than label accounts by something else). The codes don't depend on
  // the label: nothing stops working.
  async sendEmailChangedNotice(email: EmailChangedNoticeEmail): Promise<void> {
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Your Stride sign-in email was changed',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>Your Stride account now signs in with ${escapeHtml(email.maskedNewEmail)}, and was signed out on your other devices. This address will no longer receive emails about it.</p>${
               email.twoFactorOn
                 ? `\n             <p>${AUTHENTICATOR_LABEL_NOTE}</p>`
                 : ''
             }
             <p>If this wasn't you, contact your clinic straight away.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        `Your Stride account now signs in with ${email.maskedNewEmail}, and was signed out on your other devices. This address will no longer receive emails about it.`,
        ...(email.twoFactorOn ? ['', AUTHENTICATOR_LABEL_NOTE] : []),
        '',
        "If this wasn't you, contact your clinic straight away.",
      ].join('\n'),
    })
  }

  // To the account after its password was changed from the profile: if it
  // wasn't the owner, someone knew the old password and is now the only one
  // who knows the new one — and has signed the owner's other devices out. This
  // inbox is still the account's, so "Forgot your password?" is the way back
  // (it also cancels anything that person may have started — a pending email
  // change). No link with a token: the forgot-password PAGE, where the owner
  // asks for one.
  async sendPasswordChangedNotice(
    email: PasswordChangedNoticeEmail,
  ): Promise<void> {
    const forgotUrl = `${frontendUrl()}/forgot-password`
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Your Stride password was changed',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>The password of your Stride account was just changed, and your account was signed out on your other devices.</p>
             <p>If this was you, there is nothing else to do. If it wasn't, <a href="${escapeHtml(forgotUrl)}">reset your password</a> straight away, then tell your clinic.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'The password of your Stride account was just changed, and your account was signed out on your other devices.',
        '',
        "If this was you, there is nothing else to do. If it wasn't, reset your password straight away, then tell your clinic:",
        forgotUrl,
      ].join('\n'),
    })
  }

  // Two-factor sign-in was turned ON. Who would do that without the owner?
  // Someone with a stolen session AND the password (the step-up asks it):
  // with their own phone as the second factor, the owner can no longer sign
  // in. So the advice is the clinic — an admin can turn it off for them —
  // not a reset link: a new password doesn't remove someone else's second
  // factor.
  async sendMfaEnabledNotice(email: MfaNoticeEmail): Promise<void> {
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Two-factor sign-in is on for your Stride account',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>Two-factor sign-in was just turned on for your Stride account: signing in now asks for a code from your authenticator app. Your account was signed out on your other devices.</p>
             <p>If this was you, there is nothing else to do. If it wasn't, contact your clinic straight away.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'Two-factor sign-in was just turned on for your Stride account: signing in now asks for a code from your authenticator app. Your account was signed out on your other devices.',
        '',
        "If this was you, there is nothing else to do. If it wasn't, contact your clinic straight away.",
      ].join('\n'),
    })
  }

  // Two-factor sign-in was turned OFF — which needs the password AND a code,
  // so someone who isn't the owner had both: change the password first (the
  // reset page, as for the password notice), then tell the clinic.
  async sendMfaDisabledNotice(email: MfaNoticeEmail): Promise<void> {
    const forgotUrl = `${frontendUrl()}/forgot-password`
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Two-factor sign-in is off for your Stride account',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>Two-factor sign-in was just turned off for your Stride account: signing in now asks for your password only.</p>
             <p>If this was you, there is nothing else to do. If it wasn't, <a href="${escapeHtml(forgotUrl)}">reset your password</a> straight away, then tell your clinic.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'Two-factor sign-in was just turned off for your Stride account: signing in now asks for your password only.',
        '',
        "If this was you, there is nothing else to do. If it wasn't, reset your password straight away, then tell your clinic:",
        forgotUrl,
      ].join('\n'),
    })
  }

  // A recovery code was used — to sign in, or to confirm a change. The codes
  // are a second factor on paper: if someone else found them, this is how
  // the owner hears of it. "None left" says what to do about it.
  async sendRecoveryCodeUsedNotice(
    email: RecoveryCodeUsedNoticeEmail,
  ): Promise<void> {
    const forgotUrl = `${frontendUrl()}/forgot-password`
    const left =
      email.remaining === 0
        ? 'You have no recovery codes left: create new ones from your profile, under Sign-in and security.'
        : email.remaining === 1
          ? 'You have 1 recovery code left.'
          : `You have ${email.remaining} recovery codes left.`
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'A recovery code was used on your Stride account',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>One of your two-factor recovery codes was just used on your Stride account. ${escapeHtml(left)}</p>
             <p>If this was you, there is nothing else to do. If it wasn't, <a href="${escapeHtml(forgotUrl)}">reset your password</a> straight away, then contact your clinic.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        `One of your two-factor recovery codes was just used on your Stride account. ${left}`,
        '',
        "If this was you, there is nothing else to do. If it wasn't, reset your password straight away, then contact your clinic:",
        forgotUrl,
      ].join('\n'),
    })
  }

  // An admin turned two-factor sign-in OFF for this account (the person
  // lost both the phone and the codes, or the clinic suspects someone else
  // put their own phone on it). Every session was ended: signing in again
  // asks the password only — and the profile can set MFA up again.
  async sendMfaResetNotice(email: MfaNoticeEmail): Promise<void> {
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Two-factor sign-in was turned off for your Stride account',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>An administrator of your clinic turned off two-factor sign-in for your Stride account, and your account was signed out everywhere. Signing in now asks for your password only; you can set two-factor sign-in up again from your profile.</p>
             <p>If you didn't ask for this, contact your clinic straight away.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'An administrator of your clinic turned off two-factor sign-in for your Stride account, and your account was signed out everywhere. Signing in now asks for your password only; you can set two-factor sign-in up again from your profile.',
        '',
        "If you didn't ask for this, contact your clinic straight away.",
      ].join('\n'),
    })
  }

  // A session of this account was signed out after 5 failed step-ups in a
  // row (decisions §16, privacy and security pass 2): someone signed in as
  // this account kept getting the current password — or the two-factor code
  // — wrong while trying to change something (the email, the password,
  // two-factor sign-in). The owner mistyping is the likely case, and nothing
  // was changed; but a stolen session guessing the password looks exactly
  // like this, and the owner is the one who can tell. A password reset ends
  // EVERY session, the thief's included (AuthService.resetPassword).
  async sendStepUpSignOutNotice(email: MfaNoticeEmail): Promise<void> {
    const forgotUrl = `${frontendUrl()}/forgot-password`
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Your Stride account was signed out on one device',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>Someone signed in to your Stride account entered a wrong password or code 5 times in a row while confirming a change, so that device was signed out. Nothing was changed.</p>
             <p>If this was you, sign in again. If it wasn't, <a href="${escapeHtml(forgotUrl)}">reset your password</a> straight away — it signs your account out everywhere — then tell your clinic.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'Someone signed in to your Stride account entered a wrong password or code 5 times in a row while confirming a change, so that device was signed out. Nothing was changed.',
        '',
        "If this was you, sign in again. If it wasn't, reset your password straight away — it signs your account out everywhere — then tell your clinic:",
        forgotUrl,
      ].join('\n'),
    })
  }

  // The link to a copy of the patient's record. The record itself is never
  // in the email (an inbox is not a safe place for a health record, and a
  // forwarded email takes everything with it): the link leads to a page
  // that asks for the date of birth first. The subject names no one, like
  // every subject here.
  async sendRecordsExportLinkEmail(
    email: RecordsExportLinkEmail,
  ): Promise<void> {
    const downloadUrl = `${frontendUrl()}/records-download?token=${email.rawToken}`
    const validity = `${email.validForHours} hours`
    const inApp =
      'You can also download a copy at any time, without asking, from My records once you sign in to Stride.'
    await this.transport.send({
      from: senderAddress(),
      to: email.to,
      subject: 'Your health record from Stride',
      html: `<p>Hello ${escapeHtml(email.firstName)},</p>
             <p>Your clinic sent you a link to download a copy of your health record: your medical file, your exercise programs and your sessions.</p>
             <p><a href="${escapeHtml(downloadUrl)}">Download your record</a>. You'll be asked for your date of birth. The link works once and expires in ${validity}; after ${email.dateOfBirthAttempts} wrong dates of birth it stops working.</p>
             ${email.canSignIn ? `<p>${inApp}</p>` : ''}
             <p>If you didn't ask for your record, tell your clinic.</p>`,
      text: [
        `Hello ${email.firstName},`,
        '',
        'Your clinic sent you a link to download a copy of your health record: your medical file, your exercise programs and your sessions.',
        '',
        `Download your record: ${downloadUrl}`,
        `You'll be asked for your date of birth. The link works once and expires in ${validity}; after ${email.dateOfBirthAttempts} wrong dates of birth it stops working.`,
        ...(email.canSignIn ? ['', inApp] : []),
        '',
        "If you didn't ask for your record, tell your clinic.",
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
