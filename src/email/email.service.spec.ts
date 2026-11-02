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

import { Test } from '@nestjs/testing'
import { LOGO_DARK_CID, LOGO_LIGHT_CID } from './email-layout'
import { EMAIL_TRANSPORT, type OutgoingEmail } from './email-transport'
import {
  AUTHENTICATOR_LABEL_NOTE,
  EmailService,
  describeWhere,
} from './email.service'

// --- HELPERS -----------------------------------------------------------------------------------------------

// Branded emails (decisions §41): the HTML is drawn by email-layout.ts, with
// a style on every element. These two read it the way a person sees it —
// each paragraph's content, each link's address and words — so the tests
// in this file check WHAT an email says, whatever the styling; the layout's
// own spec checks how it looks. `s`: a paragraph may span lines.
function paragraphsOf(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gs)].map((m) => m[1])
}

function linksOf(html: string): { href: string; label: string }[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>(.*?)<\/a>/gs)].map(
    (m) => ({ href: m[1], label: m[2] }),
  )
}

describe('EmailService', () => {
  let service: EmailService
  let send: jest.Mock<Promise<void>, [OutgoingEmail]>

  // The service reads FRONTEND_URL and EMAIL_FROM on every call, so each
  // test can set them; the originals are put back afterwards so no other
  // spec file sees this file's values.
  const originalEnv = { ...process.env }

  beforeEach(async () => {
    process.env.FRONTEND_URL = 'https://app.stride.test'
    process.env.EMAIL_FROM = 'Stride <noreply@stride.test>'
    send = jest.fn<Promise<void>, [OutgoingEmail]>().mockResolvedValue()

    // Built through Nest's DI with the transport provided under its token —
    // the same wiring EmailModule does, so this also proves EmailService
    // asks for EMAIL_TRANSPORT (and not, say, a concrete class).
    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: EMAIL_TRANSPORT, useValue: { send } },
      ],
    }).compile()
    service = moduleRef.get(EmailService)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // "Change email" (decisions §12): four emails, two inboxes. What each
  // must hold — the right recipient, the right link — and what each must
  // NOT: the new address in full in the old inbox, a link in the
  // "already taken" email, anything a person typed unescaped in HTML.
  describe('the email-change emails', () => {
    it('sends the confirm link to the NEW address, in both bodies, with its validity', async () => {
      await service.sendEmailChangeConfirmation({
        to: 'new@example.com',
        firstName: 'Pat',
        rawToken: 'tok123',
        validForHours: 24,
      })

      const email = send.mock.calls[0][0]
      const link = 'https://app.stride.test/confirm-email?token=tok123'
      expect(email.to).toBe('new@example.com')
      expect(email.subject).toBe('Confirm your new email address for Stride')
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
      expect(email.text).toContain('This link expires in 24 hours.')
    })

    it('tells a taken address so, with no link and no name', async () => {
      await service.sendEmailChangeAddressTaken('taken@example.com')

      const email = send.mock.calls[0][0]
      expect(email.to).toBe('taken@example.com')
      expect(email.subject).toBe('This address already has a Stride account')
      expect(email.html).not.toContain('href')
      expect(email.text).not.toContain('http')
    })

    it('sends the OLD address the masked new one and the cancel link', async () => {
      await service.sendEmailChangeRequestedNotice({
        to: 'old@example.com',
        firstName: 'Pat',
        maskedNewEmail: 'n•••@e•••.com',
        rawCancelToken: 'cancel456',
      })

      const email = send.mock.calls[0][0]
      const link = 'https://app.stride.test/cancel-email-change?token=cancel456'
      expect(email.to).toBe('old@example.com')
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
      expect(email.text).toContain('to n•••@e•••.com.')
    })

    it('tells the OLD address the change is made, masked, with no link', async () => {
      await service.sendEmailChangedNotice({
        to: 'old@example.com',
        firstName: 'Pat',
        maskedNewEmail: 'n•••@e•••.com',
        twoFactorOn: false,
      })

      const email = send.mock.calls[0][0]
      expect(email.to).toBe('old@example.com')
      expect(email.subject).toBe('Your Stride sign-in email was changed')
      expect(email.text).toContain('now signs in with n•••@e•••.com')
      expect(email.html).not.toContain('href')
      // Without two-factor, nothing about an authenticator app.
      expect(email.text).not.toContain('authenticator')
      expect(email.html).not.toContain('authenticator')
    })

    // With two-factor on: the app keeps the old address as its label — said
    // in both bodies, between the change and the "wasn't you" line.
    it('tells an account with two-factor on that its authenticator app keeps the old address', async () => {
      await service.sendEmailChangedNotice({
        to: 'old@example.com',
        firstName: 'Pat',
        maskedNewEmail: 'n•••@e•••.com',
        twoFactorOn: true,
      })

      const email = send.mock.calls[0][0]
      expect(email.text).toBe(
        [
          'Hello Pat,',
          '',
          'Your Stride account now signs in with n•••@e•••.com, and was signed out on your other devices. This address will no longer receive emails about it.',
          '',
          AUTHENTICATOR_LABEL_NOTE,
          '',
          "If this wasn't you, contact your clinic straight away.",
        ].join('\n'),
      )
      expect(paragraphsOf(email.html)).toContain(AUTHENTICATOR_LABEL_NOTE)
      expect(email.html.indexOf(AUTHENTICATOR_LABEL_NOTE)).toBeLessThan(
        email.html.indexOf("If this wasn't you"),
      )
    })

    // A first name is typed by a person: in HTML it must stay text.
    it.each([
      [
        'confirmation',
        (name: string) =>
          service.sendEmailChangeConfirmation({
            to: 'n@x.com',
            firstName: name,
            rawToken: 't',
            validForHours: 24,
          }),
      ],
      [
        'change-requested notice',
        (name: string) =>
          service.sendEmailChangeRequestedNotice({
            to: 'o@x.com',
            firstName: name,
            maskedNewEmail: 'n•••@x•••.com',
            rawCancelToken: 't',
          }),
      ],
      [
        'email-changed notice',
        (name: string) =>
          service.sendEmailChangedNotice({
            to: 'o@x.com',
            firstName: name,
            maskedNewEmail: 'n•••@x•••.com',
            twoFactorOn: true,
          }),
      ],
    ])('escapes the first name in the %s', async (_what, sendIt) => {
      await sendIt('<b>Pat</b>')

      const email = send.mock.calls[0][0]
      expect(email.html).toContain('&lt;b&gt;Pat&lt;/b&gt;')
      expect(email.html).not.toContain('<b>Pat</b>')
    })
  })

  // "Change password" (decisions §13): one notice, to the account's own
  // address — with the forgot-password PAGE (no token: the owner asks for a
  // link there) and the name escaped.
  describe('sendPasswordChangedNotice', () => {
    it('tells the account, from EMAIL_FROM, with the forgot-password page in both bodies', async () => {
      await service.sendPasswordChangedNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe('Your Stride password was changed')
      expect(email.text).toContain(
        'your account was signed out on your other devices',
      )
      const link = 'https://app.stride.test/forgot-password'
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
      expect(email.text).not.toContain('token')
    })

    it('escapes the first name', async () => {
      await service.sendPasswordChangedNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
      })

      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).not.toContain('<b>Pat</b>')
      expect(email.text).toContain('Hello <b>Pat</b>,')
    })
  })

  describe('sendMfaEnabledNotice', () => {
    it('tells the account, from EMAIL_FROM: other devices signed out, and the clinic to contact', async () => {
      await service.sendMfaEnabledNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe(
        'Two-factor sign-in is on for your Stride account',
      )
      for (const body of [email.text, email.html]) {
        expect(body).toContain(
          'Your account was signed out on your other devices.',
        )
        expect(body).toContain('contact your clinic straight away')
      }
      // No reset link: a new password wouldn't remove someone else's second
      // factor (the comment on the method).
      expect(email.html).not.toContain('href=')
      expect(email.text).not.toContain('forgot-password')
    })

    it('escapes the first name', async () => {
      await service.sendMfaEnabledNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
      })

      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).not.toContain('<b>Pat</b>')
      expect(email.text).toContain('Hello <b>Pat</b>,')
    })
  })

  describe('sendMfaDisabledNotice', () => {
    it('tells the account, from EMAIL_FROM, with the forgot-password page in both bodies', async () => {
      await service.sendMfaDisabledNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe(
        'Two-factor sign-in is off for your Stride account',
      )
      expect(email.text).toContain('signing in now asks for your password only')
      const link = 'https://app.stride.test/forgot-password'
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
    })

    it('escapes the first name', async () => {
      await service.sendMfaDisabledNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
      })

      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).not.toContain('<b>Pat</b>')
      expect(email.text).toContain('Hello <b>Pat</b>,')
    })
  })

  describe('sendRecoveryCodeUsedNotice', () => {
    it('tells the account how many codes are left, with the forgot-password page', async () => {
      await service.sendRecoveryCodeUsedNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
        remaining: 7,
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe(
        'A recovery code was used on your Stride account',
      )
      for (const body of [email.text, email.html]) {
        expect(body).toContain('You have 7 recovery codes left.')
      }
      const link = 'https://app.stride.test/forgot-password'
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
    })

    // The count in words: one, and none (with what to do about it).
    it.each([
      [1, 'You have 1 recovery code left.'],
      [
        0,
        'You have no recovery codes left: create new ones from your profile, under Sign-in and security.',
      ],
    ])('says %p left as %p', async (remaining, words) => {
      await service.sendRecoveryCodeUsedNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
        remaining,
      })
      const email = send.mock.calls[0][0]
      expect(email.text).toContain(words)
      expect(email.html).toContain(words)
    })

    it('escapes the first name', async () => {
      await service.sendRecoveryCodeUsedNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
        remaining: 3,
      })
      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).not.toContain('<b>Pat</b>')
    })
  })

  describe('sendMfaResetNotice', () => {
    it('tells the account an admin turned it off, that it was signed out, and who to ask', async () => {
      await service.sendMfaResetNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe(
        'Two-factor sign-in was turned off for your Stride account',
      )
      for (const body of [email.text, email.html]) {
        expect(body).toContain('An administrator of your clinic turned off')
        expect(body).toContain('signed out everywhere')
        expect(body).toContain(
          "If you didn't ask for this, contact your clinic",
        )
      }
    })

    it('escapes the first name', async () => {
      await service.sendMfaResetNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
      })
      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).not.toContain('<b>Pat</b>')
    })
  })

  describe('sendPatientMergedNotice', () => {
    it('tells the surviving address its accounts were combined, where to sign in, and who to ask', async () => {
      await service.sendPatientMergedNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe('Your Stride accounts were combined')
      for (const body of [email.text, email.html]) {
        expect(body).toContain(
          'found a second Stride account in your name and combined it with this one',
        )
        expect(body).toContain('with this email address from now on')
        expect(body).toContain('https://app.stride.test/login')
        expect(body).toContain(
          'If you think this is a mistake, contact your clinic',
        )
      }
    })

    it('escapes the first name', async () => {
      await service.sendPatientMergedNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
      })
      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).not.toContain('<b>Pat</b>')
    })
  })

  // Roadmap Phase 6.5: "you have a new message" — who wrote, never what.
  describe('sendNewMessagesNotice', () => {
    it("names the one sender, links to the side's Messages, and says the text is never included", async () => {
      await service.sendNewMessagesNotice({
        to: 'pat@example.com',
        firstName: 'Pat',
        side: 'patient',
        senders: ['Alex Chen'],
      })

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('pat@example.com')
      expect(email.subject).toBe('Alex Chen sent you a message on Stride')
      expect(email.text).toBe(
        [
          'Hello Pat,',
          '',
          'Alex Chen sent you a message on Stride.',
          '',
          'Sign in to read it: https://app.stride.test/patient/messages',
          'For your privacy, messages are never included in emails.',
          '',
          'You can turn these emails off in Stride: Settings (the gear at the top), "Email me about new messages".',
        ].join('\n'),
      )
      // In the HTML, the link is the layout's button, named for what it
      // opens (no sentence around it to say "it").
      expect(linksOf(email.html)).toEqual([
        {
          href: 'https://app.stride.test/patient/messages',
          label: 'Read the message',
        },
      ])
    })

    it("lists several senders in one email, with a general subject, and the practitioner side's link", async () => {
      await service.sendNewMessagesNotice({
        to: 'alex@example.com',
        firstName: 'Alex',
        side: 'practitioner',
        senders: ['Pat Lee', 'Jo Novak', 'Robin Silva'],
      })
      const email = send.mock.calls[0][0]
      expect(email.subject).toBe('You have new messages on Stride')
      expect(email.text).toContain(
        'Pat Lee, Jo Novak and Robin Silva sent you messages on Stride.',
      )
      expect(email.text).toContain(
        'https://app.stride.test/practitioner/messages',
      )
      expect(linksOf(email.html)).toEqual([
        {
          href: 'https://app.stride.test/practitioner/messages',
          label: 'Read the messages',
        },
      ])
    })

    it('joins two senders with "and"', async () => {
      await service.sendNewMessagesNotice({
        to: 'alex@example.com',
        firstName: 'Alex',
        side: 'practitioner',
        senders: ['Pat Lee', 'Jo Novak'],
      })
      expect(send.mock.calls[0][0].text).toContain(
        'Pat Lee and Jo Novak sent you messages on Stride.',
      )
    })

    it('escapes the names in the HTML', async () => {
      await service.sendNewMessagesNotice({
        to: 'pat@example.com',
        firstName: '<b>Pat</b>',
        side: 'patient',
        senders: ['<i>Alex</i> Chen'],
      })
      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;b&gt;Pat&lt;/b&gt;,')
      expect(email.html).toContain(
        '&lt;i&gt;Alex&lt;/i&gt; Chen sent you a message',
      )
      expect(email.html).not.toContain('<i>Alex</i>')
    })
  })

  describe('sendPasswordResetEmail', () => {
    it('sends one email to the user, from EMAIL_FROM, with the reset subject', async () => {
      await service.sendPasswordResetEmail('user@example.com', 'abc123')

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('user@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe('Reset your Stride password')
    })

    // Both bodies must carry the SAME working link: HTML for most mail
    // clients, text for the rest (and for the dev console transport).
    it('puts the reset link, built from FRONTEND_URL and the raw token, in both bodies', async () => {
      await service.sendPasswordResetEmail('user@example.com', 'abc123')

      const email = send.mock.calls[0][0]
      const link = 'https://app.stride.test/reset-password?token=abc123'
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
    })

    it('falls back to the local frontend and the Resend onboarding sender when unset', async () => {
      delete process.env.FRONTEND_URL
      delete process.env.EMAIL_FROM

      await service.sendPasswordResetEmail('user@example.com', 'abc123')

      const email = send.mock.calls[0][0]
      expect(email.text).toContain(
        'http://localhost:5173/reset-password?token=abc123',
      )
      expect(email.from).toBe('Stride <onboarding@resend.dev>')
    })

    // The behaviour change from the transport split: a failed send is no
    // longer swallowed here — the caller decides what to do with it.
    it('rejects when the transport fails', async () => {
      send.mockRejectedValue(new Error('delivery failed'))

      await expect(
        service.sendPasswordResetEmail('user@example.com', 'abc123'),
      ).rejects.toThrow('delivery failed')
    })
  })

  describe('sendInvitationEmail', () => {
    const invitation = {
      to: 'jane@example.com',
      rawToken: 'tok123',
      firstName: 'Jane',
      invitedByName: 'Alice Martin',
      clinicNames: ['Clinique Sud'],
      validForDays: 7,
    }

    it('sends one email to the invited person, from EMAIL_FROM, with a fixed subject', async () => {
      await service.sendInvitationEmail(invitation)

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect(email.to).toBe('jane@example.com')
      expect(email.from).toBe('Stride <noreply@stride.test>')
      expect(email.subject).toBe("You're invited to Stride")
    })

    it('puts the accept link, the greeting, the inviter, the clinic and the validity in both bodies', async () => {
      await service.sendInvitationEmail(invitation)

      const email = send.mock.calls[0][0]
      const link = 'https://app.stride.test/accept-invitation?token=tok123'
      expect(email.html).toContain(`href="${link}"`)
      expect(email.text).toContain(link)
      for (const body of [email.html, email.text]) {
        expect(body).toContain('Hello Jane,')
        expect(body).toContain(
          'Alice Martin invited you to join Clinique Sud on Stride.',
        )
        expect(body).toContain('expires in 7 days')
      }
    })

    // Names are typed by people. In the HTML body they must arrive as text,
    // never as markup — while the plain-text body shows them as typed.
    it('escapes every name in the HTML body, and only there', async () => {
      await service.sendInvitationEmail({
        ...invitation,
        firstName: '<a href="https://evil.example">Click</a>',
        invitedByName: 'Tom & Jerry',
        clinicNames: ['<b>Bold</b> Clinic'],
      })

      const email = send.mock.calls[0][0]
      expect(email.html).not.toContain('<a href="https://evil.example">')
      expect(email.html).toContain(
        'Hello &lt;a href=&quot;https://evil.example&quot;&gt;Click&lt;/a&gt;,',
      )
      expect(email.html).toContain('Tom &amp; Jerry invited you')
      expect(email.html).toContain('&lt;b&gt;Bold&lt;/b&gt; Clinic on Stride')
      expect(email.text).toContain(
        'Hello <a href="https://evil.example">Click</a>,',
      )
    })

    it('rejects when the transport fails', async () => {
      send.mockRejectedValue(new Error('delivery failed'))

      await expect(service.sendInvitationEmail(invitation)).rejects.toThrow(
        'delivery failed',
      )
    })
  })

  // The records export's emailed link (decisions §20, pass 2). What it must
  // hold: the link, the rules of the link (once, 72 hours, 5 tries) — and,
  // only for an account that can sign in, where to download it unasked.
  // What it must NOT: the record itself, or a name in the subject.
  describe('sendRecordsExportLinkEmail', () => {
    const link = {
      to: 'pat@example.com',
      firstName: 'Pat',
      rawToken: 'tok456',
      validForHours: 72,
      dateOfBirthAttempts: 5,
      canSignIn: false,
    }
    const IN_APP =
      'You can also download a copy at any time, without asking, from My records once you sign in to Stride.'

    it('sends the download link and its rules, in both bodies', async () => {
      await service.sendRecordsExportLinkEmail(link)

      expect(send).toHaveBeenCalledTimes(1)
      const email = send.mock.calls[0][0]
      expect([email.to, email.from, email.subject]).toEqual([
        'pat@example.com',
        'Stride <noreply@stride.test>',
        'Your health record from Stride',
      ])
      const url = 'https://app.stride.test/records-download?token=tok456'
      expect(linksOf(email.html)).toEqual([
        { href: url, label: 'Download your record' },
      ])
      expect(email.text).toContain(`Download your record: ${url}`)
      for (const body of [email.html, email.text]) {
        expect(body).toContain('Hello Pat,')
        expect(body).toContain(
          "You'll be asked for your date of birth. The link works once and expires in 72 hours; after 5 wrong dates of birth it stops working.",
        )
        expect(body).toContain(
          "If you didn't ask for your record, tell your clinic.",
        )
        expect(body).not.toContain('My records')
      }
    })

    it('says where to download it unasked, to an account that can sign in', async () => {
      await service.sendRecordsExportLinkEmail({ ...link, canSignIn: true })

      const email = send.mock.calls[0][0]
      expect(paragraphsOf(email.html)).toContain(IN_APP)
      expect(email.text).toContain(
        `wrong dates of birth it stops working.\n\n${IN_APP}\n\nIf you didn't ask`,
      )
    })

    it('escapes the first name in the HTML body, and only there', async () => {
      await service.sendRecordsExportLinkEmail({
        ...link,
        firstName: '<i>Pat</i>',
      })

      const email = send.mock.calls[0][0]
      expect(email.html).toContain('Hello &lt;i&gt;Pat&lt;/i&gt;,')
      expect(email.text).toContain('Hello <i>Pat</i>,')
    })

    it('rejects when the transport fails', async () => {
      send.mockRejectedValue(new Error('delivery failed'))

      await expect(service.sendRecordsExportLinkEmail(link)).rejects.toThrow(
        'delivery failed',
      )
    })
  })

  // Every email goes through the layout (decisions §41) — and so must carry
  // the two logo images its HTML points at: a `cid:` with no matching part
  // in the message is a broken image. One call per email, so a method that
  // ever bypassed deliver() would fail here.
  describe('the branded layout', () => {
    const notice = { to: 'pat@example.com', firstName: 'Pat' }
    const sends: [string, (s: EmailService) => Promise<void>][] = [
      [
        'password reset',
        (s) => s.sendPasswordResetEmail('pat@example.com', 't'),
      ],
      [
        'invitation',
        (s) =>
          s.sendInvitationEmail({
            ...notice,
            rawToken: 't',
            invitedByName: 'Alex Chen',
            clinicNames: [],
            validForDays: 7,
          }),
      ],
      [
        'email change confirmation',
        (s) =>
          s.sendEmailChangeConfirmation({
            ...notice,
            rawToken: 't',
            validForHours: 24,
          }),
      ],
      [
        'address taken',
        (s) => s.sendEmailChangeAddressTaken('pat@example.com'),
      ],
      [
        'email change requested',
        (s) =>
          s.sendEmailChangeRequestedNotice({
            ...notice,
            maskedNewEmail: 'p***@example.com',
            rawCancelToken: 't',
          }),
      ],
      [
        'email changed',
        (s) =>
          s.sendEmailChangedNotice({
            ...notice,
            maskedNewEmail: 'p***@example.com',
            twoFactorOn: false,
          }),
      ],
      ['password changed', (s) => s.sendPasswordChangedNotice(notice)],
      ['two-factor on', (s) => s.sendMfaEnabledNotice(notice)],
      ['two-factor off', (s) => s.sendMfaDisabledNotice(notice)],
      [
        'recovery code used',
        (s) => s.sendRecoveryCodeUsedNotice({ ...notice, remaining: 3 }),
      ],
      ['two-factor reset', (s) => s.sendMfaResetNotice(notice)],
      ['accounts combined', (s) => s.sendPatientMergedNotice(notice)],
      ['step-up sign-out', (s) => s.sendStepUpSignOutNotice(notice)],
      [
        'new messages',
        (s) =>
          s.sendNewMessagesNotice({
            ...notice,
            side: 'patient',
            senders: ['Alex Chen'],
          }),
      ],
      [
        'records link',
        (s) =>
          s.sendRecordsExportLinkEmail({
            ...notice,
            rawToken: 't',
            validForHours: 72,
            dateOfBirthAttempts: 5,
            canSignIn: true,
          }),
      ],
    ]

    it('covers all fifteen emails', () => {
      expect(sends).toHaveLength(15)
    })

    it.each(sends)(
      'the %s email carries both logo images, and its subject as the title',
      async (_name, sendIt) => {
        await sendIt(service)

        const email = send.mock.calls[0][0]
        expect(email.inlineImages?.map((i) => i.contentId)).toEqual([
          LOGO_LIGHT_CID,
          LOGO_DARK_CID,
        ])
        expect(email.html).toContain(`src="cid:${LOGO_LIGHT_CID}"`)
        expect(email.html).toContain(`src="cid:${LOGO_DARK_CID}"`)
        expect(email.html).toContain(
          `<title>${email.subject.replace(/'/g, '&#39;')}</title>`,
        )
      },
    )
  })
})

describe('describeWhere', () => {
  it('names Stride alone when the account has no clinic', () => {
    expect(describeWhere([])).toBe('Stride')
  })

  it('names one clinic', () => {
    expect(describeWhere(['Clinique Sud'])).toBe('Clinique Sud on Stride')
  })

  it('joins several clinics with commas and a final "and"', () => {
    expect(describeWhere(['A', 'B'])).toBe('A and B on Stride')
    expect(describeWhere(['A', 'B', 'C'])).toBe('A, B and C on Stride')
  })
})
