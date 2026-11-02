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
import { type EmailContent, link, renderEmail } from './email-layout'
import { EMAIL_TRANSPORT, type EmailTransport } from './email-transport'
import { markup } from './safe-html'

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

// New messages wait for this person (roadmap Phase 6.5): who wrote, and in
// which of their roles (the link goes to that side's Messages). The shape of
// MessageNotice (messaging/message-rules.ts), restated here so the email
// module depends on no messaging type.
export interface NewMessagesNoticeEmail {
  to: string
  firstName: string
  side: 'practitioner' | 'patient'
  senders: string[]
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
//
// HOW each email LOOKS is email-layout.ts's job (branded emails, decisions
// §41): a method here gives the layout its paragraphs — built with markup``,
// which escapes every value a person typed (safe-html.ts) — and, when the
// email exists to send someone somewhere, its main link as the button.
// A link that is only an escape hatch ("if this wasn't you, reset your
// password") stays a link in its sentence: a large teal "Reset your
// password" on a routine notice would invite people to reset for nothing.
//
// The plain-text bodies are unchanged by the layout: they are what an app
// set to plain text shows, and what the e2e tests follow links from.
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
    const subject = 'Reset your Stride password'

    await this.deliver(
      toEmail,
      subject,
      {
        intro: [markup`Someone requested a password reset for this account.`],
        action: { label: 'Reset your password', url: resetUrl },
        outro: [
          markup`This link expires in 1 hour.`,
          markup`If you didn't request this, you can safely ignore this email.`,
        ],
      },
      [
        'Someone requested a password reset for this account.',
        '',
        `Reset your password: ${resetUrl}`,
        'This link expires in 1 hour.',
        '',
        "If you didn't request this, you can safely ignore this email.",
      ],
    )
  }

  // Rejects if the transport couldn't send; InvitationsService reports that
  // to whoever sent the invitation (emailSent: false) instead of failing
  // the request — the account and the invitation exist either way.
  async sendInvitationEmail(invitation: InvitationEmail): Promise<void> {
    const acceptUrl = `${frontendUrl()}/accept-invitation?token=${invitation.rawToken}`
    const where = describeWhere(invitation.clinicNames)
    const validity = `${invitation.validForDays} days`

    await this.deliver(
      invitation.to,
      // A fixed subject, with no names in it: a mail header is not HTML,
      // and keeping user-typed text out of headers removes a whole class
      // of problems (line breaks, encodings) rather than handling each.
      "You're invited to Stride",
      {
        // Every value a person typed (the names, the clinics) is escaped by
        // markup`` — see safe-html.ts. The URL too, by the layout: it's built
        // from FRONTEND_URL, configuration rather than user input, but it
        // sits inside an attribute and escaping it costs nothing.
        intro: [
          markup`Hello ${invitation.firstName},`,
          markup`${invitation.invitedByName} invited you to join ${where}. Choose your password to activate your account.`,
        ],
        action: { label: 'Choose your password', url: acceptUrl },
        outro: [
          markup`This link expires in ${validity}. If it has expired, ask your clinic to send you a new one.`,
          markup`If you weren't expecting this invitation, you can ignore this email.`,
        ],
      },
      // The text body needs no escaping: plain text is never interpreted.
      [
        `Hello ${invitation.firstName},`,
        '',
        `${invitation.invitedByName} invited you to join ${where}.`,
        '',
        `Choose your password to activate your account: ${acceptUrl}`,
        `This link expires in ${validity}.`,
        '',
        'If it has expired, ask your clinic to send you a new one.',
        "If you weren't expecting this invitation, you can ignore this email.",
      ],
    )
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
    await this.deliver(
      email.to,
      'Confirm your new email address for Stride',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`You asked to use this address to sign in to Stride.`,
        ],
        action: { label: 'Confirm this address', url: confirmUrl },
        outro: [
          markup`This link expires in ${validity}. Until then, your account keeps its current address.`,
          markup`If you didn't ask for this, you can ignore this email: nothing changes.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'You asked to use this address to sign in to Stride.',
        '',
        `Confirm this address: ${confirmUrl}`,
        `This link expires in ${validity}. Until then, your account keeps its current address.`,
        '',
        "If you didn't ask for this, you can ignore this email: nothing changes.",
      ],
    )
  }

  // To the NEW address when it already belongs to an account (decisions
  // §12, "reveal nothing"): the person asking is told "check your inbox"
  // either way, and only whoever reads THIS inbox learns the address is
  // taken. No name, no link — the email says nothing about either account.
  async sendEmailChangeAddressTaken(to: string): Promise<void> {
    await this.deliver(
      to,
      'This address already has a Stride account',
      {
        intro: [
          markup`Someone asked to use this address to sign in to Stride, but it already belongs to a Stride account, so it can't be used for another one.`,
          markup`If it was you, sign in with this address instead — or use "Forgot your password?" on the sign-in page.`,
          markup`If it wasn't you, you can ignore this email: nothing changes.`,
        ],
      },
      [
        "Someone asked to use this address to sign in to Stride, but it already belongs to a Stride account, so it can't be used for another one.",
        '',
        'If it was you, sign in with this address instead — or use "Forgot your password?" on the sign-in page.',
        '',
        "If it wasn't you, you can ignore this email: nothing changes.",
      ],
    )
  }

  // To the OLD address when a change is asked for: what is about to happen,
  // and the link that stops it. The address the change goes to is masked.
  // The cancel link stays in its sentence: it is for "this wasn't you" only.
  async sendEmailChangeRequestedNotice(
    email: EmailChangeRequestedNoticeEmail,
  ): Promise<void> {
    const cancelUrl = `${frontendUrl()}/cancel-email-change?token=${email.rawCancelToken}`
    await this.deliver(
      email.to,
      'A change of your Stride sign-in email was requested',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Someone signed in to your Stride account asked to change its sign-in email to ${email.maskedNewEmail}. Nothing changes until that address confirms it.`,
          markup`If this wasn't you, ${link(cancelUrl, 'cancel the change')}, then reset your password from the sign-in page — someone may know it.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        `Someone signed in to your Stride account asked to change its sign-in email to ${email.maskedNewEmail}. Nothing changes until that address confirms it.`,
        '',
        `If this wasn't you, cancel the change: ${cancelUrl}`,
        'Then reset your password from the sign-in page — someone may know it.',
      ],
    )
  }

  // To the OLD address once the change is made: the last email it receives
  // about this account. With two-factor sign-in on, one more paragraph: an
  // authenticator app names the account by the label in the QR code it
  // scanned — the email at the time — and never reads it again, so it keeps
  // showing the OLD address (decided with the person 2026-10-29: say so,
  // rather than label accounts by something else). The codes don't depend on
  // the label: nothing stops working.
  async sendEmailChangedNotice(email: EmailChangedNoticeEmail): Promise<void> {
    await this.deliver(
      email.to,
      'Your Stride sign-in email was changed',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Your Stride account now signs in with ${email.maskedNewEmail}, and was signed out on your other devices. This address will no longer receive emails about it.`,
          ...(email.twoFactorOn ? [markup`${AUTHENTICATOR_LABEL_NOTE}`] : []),
          markup`If this wasn't you, contact your clinic straight away.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        `Your Stride account now signs in with ${email.maskedNewEmail}, and was signed out on your other devices. This address will no longer receive emails about it.`,
        ...(email.twoFactorOn ? ['', AUTHENTICATOR_LABEL_NOTE] : []),
        '',
        "If this wasn't you, contact your clinic straight away.",
      ],
    )
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
    await this.deliver(
      email.to,
      'Your Stride password was changed',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`The password of your Stride account was just changed, and your account was signed out on your other devices.`,
          markup`If this was you, there is nothing else to do. If it wasn't, ${link(forgotUrl, 'reset your password')} straight away, then tell your clinic.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'The password of your Stride account was just changed, and your account was signed out on your other devices.',
        '',
        "If this was you, there is nothing else to do. If it wasn't, reset your password straight away, then tell your clinic:",
        forgotUrl,
      ],
    )
  }

  // Two-factor sign-in was turned ON. Who would do that without the owner?
  // Someone with a stolen session AND the password (the step-up asks it):
  // with their own phone as the second factor, the owner can no longer sign
  // in. So the advice is the clinic — an admin can turn it off for them —
  // not a reset link: a new password doesn't remove someone else's second
  // factor.
  async sendMfaEnabledNotice(email: MfaNoticeEmail): Promise<void> {
    await this.deliver(
      email.to,
      'Two-factor sign-in is on for your Stride account',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Two-factor sign-in was just turned on for your Stride account: signing in now asks for a code from your authenticator app. Your account was signed out on your other devices.`,
          markup`If this was you, there is nothing else to do. If it wasn't, contact your clinic straight away.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'Two-factor sign-in was just turned on for your Stride account: signing in now asks for a code from your authenticator app. Your account was signed out on your other devices.',
        '',
        "If this was you, there is nothing else to do. If it wasn't, contact your clinic straight away.",
      ],
    )
  }

  // Two-factor sign-in was turned OFF — which needs the password AND a code,
  // so someone who isn't the owner had both: change the password first (the
  // reset page, as for the password notice), then tell the clinic.
  async sendMfaDisabledNotice(email: MfaNoticeEmail): Promise<void> {
    const forgotUrl = `${frontendUrl()}/forgot-password`
    await this.deliver(
      email.to,
      'Two-factor sign-in is off for your Stride account',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Two-factor sign-in was just turned off for your Stride account: signing in now asks for your password only.`,
          markup`If this was you, there is nothing else to do. If it wasn't, ${link(forgotUrl, 'reset your password')} straight away, then tell your clinic.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'Two-factor sign-in was just turned off for your Stride account: signing in now asks for your password only.',
        '',
        "If this was you, there is nothing else to do. If it wasn't, reset your password straight away, then tell your clinic:",
        forgotUrl,
      ],
    )
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
    await this.deliver(
      email.to,
      'A recovery code was used on your Stride account',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`One of your two-factor recovery codes was just used on your Stride account. ${left}`,
          markup`If this was you, there is nothing else to do. If it wasn't, ${link(forgotUrl, 'reset your password')} straight away, then contact your clinic.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        `One of your two-factor recovery codes was just used on your Stride account. ${left}`,
        '',
        "If this was you, there is nothing else to do. If it wasn't, reset your password straight away, then contact your clinic:",
        forgotUrl,
      ],
    )
  }

  // An admin turned two-factor sign-in OFF for this account (the person
  // lost both the phone and the codes, or the clinic suspects someone else
  // put their own phone on it). Every session was ended: signing in again
  // asks the password only — and the profile can set MFA up again.
  async sendMfaResetNotice(email: MfaNoticeEmail): Promise<void> {
    await this.deliver(
      email.to,
      'Two-factor sign-in was turned off for your Stride account',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`An administrator of your clinic turned off two-factor sign-in for your Stride account, and your account was signed out everywhere. Signing in now asks for your password only; you can set two-factor sign-in up again from your profile.`,
          markup`If you didn't ask for this, contact your clinic straight away.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'An administrator of your clinic turned off two-factor sign-in for your Stride account, and your account was signed out everywhere. Signing in now asks for your password only; you can set two-factor sign-in up again from your profile.',
        '',
        "If you didn't ask for this, contact your clinic straight away.",
      ],
    )
  }

  // Two accounts of this patient were merged into this one (decisions §27,
  // pass 3 — the person chose to tell the patient). Sent to the SURVIVING
  // address only. Deliberately silent about the other account: if an admin
  // ever merged two DIFFERENT people by mistake, naming the other address
  // would hand one stranger's email to another. Nothing clinical either — an
  // email is not a secure channel (the messages notice's rule): it says what
  // happened, where to sign in, and who to ask.
  async sendPatientMergedNotice(email: MfaNoticeEmail): Promise<void> {
    const signInUrl = `${frontendUrl()}/login`
    await this.deliver(
      email.to,
      'Your Stride accounts were combined',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Your clinic found a second Stride account in your name and combined it with this one, so your programs, sessions, messages and records are now all in one place.`,
          markup`Sign in with this email address from now on. The other account can no longer be used.`,
        ],
        action: { label: 'Sign in', url: signInUrl },
        outro: [
          markup`If you think this is a mistake, contact your clinic straight away.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'Your clinic found a second Stride account in your name and combined it with this one, so your programs, sessions, messages and records are now all in one place.',
        '',
        `Sign in with this email address from now on: ${signInUrl}`,
        'The other account can no longer be used.',
        '',
        'If you think this is a mistake, contact your clinic straight away.',
      ],
    )
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
    await this.deliver(
      email.to,
      'Your Stride account was signed out on one device',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Someone signed in to your Stride account entered a wrong password or code 5 times in a row while confirming a change, so that device was signed out. Nothing was changed.`,
          markup`If this was you, sign in again. If it wasn't, ${link(forgotUrl, 'reset your password')} straight away — it signs your account out everywhere — then tell your clinic.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'Someone signed in to your Stride account entered a wrong password or code 5 times in a row while confirming a change, so that device was signed out. Nothing was changed.',
        '',
        "If this was you, sign in again. If it wasn't, reset your password straight away — it signs your account out everywhere — then tell your clinic:",
        forgotUrl,
      ],
    )
  }

  // "Alex Chen sent you a message on Stride" (roadmap Phase 6.5) — WHO
  // wrote, never WHAT: an email can be read by whoever sees the inbox, and
  // passes through servers Stride doesn't control; the message itself is
  // clinical content and stays behind the sign-in. The email says so, so
  // nobody wonders where the text went. The name is in it (the person's
  // choice, 2026-10-29): "a practitioner wrote" would make every email look
  // the same, and the recipient already knows who treats them.
  async sendNewMessagesNotice(email: NewMessagesNoticeEmail): Promise<void> {
    const messagesUrl = `${frontendUrl()}/${email.side}/messages`
    const who = namesInWords(email.senders)
    const one = email.senders.length === 1
    const sentence = one
      ? `${who} sent you a message on Stride.`
      : `${who} sent you messages on Stride.`
    await this.deliver(
      email.to,
      newMessagesSubject(email.senders),
      {
        intro: [markup`Hello ${email.firstName},`, markup`${sentence}`],
        // The button's label: what it opens. (The text part says "Sign in to
        // read it" — a sentence ending in its link; a button has no sentence
        // around it, so it names its destination instead.)
        action: {
          label: one ? 'Read the message' : 'Read the messages',
          url: messagesUrl,
        },
        outro: [
          markup`For your privacy, messages are never included in emails.`,
          markup`${NEW_MESSAGES_SETTING_HINT}`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        sentence,
        '',
        `Sign in to read it: ${messagesUrl}`,
        'For your privacy, messages are never included in emails.',
        '',
        NEW_MESSAGES_SETTING_HINT,
      ],
    )
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
    await this.deliver(
      email.to,
      'Your health record from Stride',
      {
        intro: [
          markup`Hello ${email.firstName},`,
          markup`Your clinic sent you a link to download a copy of your health record: your medical file, your exercise programs and your sessions.`,
        ],
        action: { label: 'Download your record', url: downloadUrl },
        outro: [
          markup`You'll be asked for your date of birth. The link works once and expires in ${validity}; after ${email.dateOfBirthAttempts} wrong dates of birth it stops working.`,
          ...(email.canSignIn ? [markup`${inApp}`] : []),
          markup`If you didn't ask for your record, tell your clinic.`,
        ],
      },
      [
        `Hello ${email.firstName},`,
        '',
        'Your clinic sent you a link to download a copy of your health record: your medical file, your exercise programs and your sessions.',
        '',
        `Download your record: ${downloadUrl}`,
        `You'll be asked for your date of birth. The link works once and expires in ${validity}; after ${email.dateOfBirthAttempts} wrong dates of birth it stops working.`,
        ...(email.canSignIn ? ['', inApp] : []),
        '',
        "If you didn't ask for your record, tell your clinic.",
      ],
    )
  }

  // The one place an email is assembled and sent: the layout draws the HTML
  // (and returns the logo images it refers to), the text lines are joined,
  // and both go to the transport together. Every method above ends here, so
  // none of them can forget the images — an HTML body whose `cid:` points at
  // nothing shows a broken image.
  private async deliver(
    to: string,
    subject: string,
    content: Omit<EmailContent, 'title'>,
    textLines: readonly string[],
  ): Promise<void> {
    const { html: htmlBody, inlineImages } = renderEmail({
      ...content,
      title: subject,
    })
    await this.transport.send({
      from: senderAddress(),
      to,
      subject,
      html: htmlBody,
      text: textLines.join('\n'),
      inlineImages,
    })
  }
}

// --- NEW-MESSAGE NOTICES (roadmap Phase 6.5) ------------------------------------------------------------------

// The other half of the setting's promise: where to turn these off.
export const NEW_MESSAGES_SETTING_HINT =
  'You can turn these emails off in Stride: Settings (the gear at the top), "Email me about new messages".'

export function newMessagesSubject(senders: readonly string[]): string {
  return senders.length === 1
    ? `${senders[0]} sent you a message on Stride`
    : 'You have new messages on Stride'
}

// "Pat Lee", "Pat Lee and Jo Novak", "A, B and C".
function namesInWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
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
