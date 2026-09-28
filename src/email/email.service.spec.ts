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
import { EmailService } from './email.service'

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
})