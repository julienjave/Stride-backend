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

import { Logger } from '@nestjs/common'
import type { OutgoingEmail } from '../email-transport'
import { SmtpTransport, type SmtpMailer } from './smtp.transport'

const email: OutgoingEmail = {
  from: 'Stride <noreply@stride.test>',
  to: 'someone@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
}

// A stand-in for nodemailer's Transporter: only sendMail, as a jest.fn().
// The cast is needed because the real sendMail is overloaded (callback and
// promise forms) and returns a richer info object than these tests need.
function stubMailer(sendMail: jest.Mock) {
  return { sendMail } as unknown as SmtpMailer
}

describe('SmtpTransport', () => {
  it('passes every field of the email through to nodemailer', async () => {
    const sendMail = jest
      .fn()
      .mockResolvedValue({ messageId: '<m1@stride.test>' })

    await new SmtpTransport(stubMailer(sendMail)).send(email)

    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(sendMail).toHaveBeenCalledWith({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    })
  })

  // What the success line says: the message id — the address never
  // (decisions §32: the logs leave the server).
  it('logs the message id, not the address', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined)
    const sendMail = jest
      .fn()
      .mockResolvedValue({ messageId: '<m1@stride.test>' })

    await new SmtpTransport(stubMailer(sendMail)).send(email)

    expect(logged.mock.calls).toStrictEqual([
      ['Email sent (SMTP message id: <m1@stride.test>)'],
    ])
    logged.mockRestore()
  })

  it('resolves when the server accepts the email', async () => {
    const sendMail = jest
      .fn()
      .mockResolvedValue({ messageId: '<m1@stride.test>' })

    await expect(
      new SmtpTransport(stubMailer(sendMail)).send(email),
    ).resolves.toBe(undefined)
  })

  // The case a caller relies on: a failure must REJECT (EmailService's
  // callers turn that into emailSent: false, or a logged error), and say
  // why — the reason is what tells a developer that Mailpit isn't running.
  // Not the address: the callers log this message, with the account's id
  // (decisions §32). The WHOLE message is compared (toThrow with a string
  // only asks for part of it).
  it('rejects when delivery fails, with the reason but not the recipient, and keeps the original error', async () => {
    const original = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:1025'),
      {
        code: 'ECONNECTION',
      },
    )
    const sendMail = jest.fn().mockRejectedValue(original)

    const failure = new SmtpTransport(stubMailer(sendMail)).send(email)

    await expect(failure).rejects.toHaveProperty(
      'message',
      'SMTP delivery failed: connect ECONNREFUSED 127.0.0.1:1025',
    )
    await expect(failure).rejects.toMatchObject({ cause: original })
  })

  it('describes a non-Error rejection too', async () => {
    const sendMail = jest.fn().mockRejectedValue('greeting never received')

    await expect(
      new SmtpTransport(stubMailer(sendMail)).send(email),
    ).rejects.toHaveProperty(
      'message',
      'SMTP delivery failed: greeting never received',
    )
  })
})
