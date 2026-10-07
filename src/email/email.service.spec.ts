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
import { EMAIL_TRANSPORT, type OutgoingEmail } from './email-transport'
import { EmailService, describeWhere } from './email.service'

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