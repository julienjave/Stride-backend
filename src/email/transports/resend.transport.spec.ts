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
import { ResendTransport, type ResendEmailsClient } from './resend.transport'

const email: OutgoingEmail = {
  from: 'Stride <noreply@stride.test>',
  // Not @example.com: a reserved domain is refused before Resend (below).
  to: 'someone@clinic.org',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
}

// A stand-in for the Resend SDK: only `emails.send`, as a jest.fn() whose
// resolved value each test chooses. The cast is needed because the real
// `emails` object has many more methods (get, list, cancel…) this
// transport never calls.
function stubClient(result: unknown) {
  const send = jest.fn().mockResolvedValue(result)
  const client = { emails: { send } } as unknown as ResendEmailsClient
  return { client, send }
}

describe('ResendTransport', () => {
  it('passes every field of the email through to Resend', async () => {
    const { client, send } = stubClient({ data: { id: 'em_1' }, error: null })

    await new ResendTransport(client).send(email)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: [],
    })
  })

  // Branded emails (decisions §41): Resend sends an attachment INLINE when
  // it has a `contentId` — the name the HTML's `cid:` points at.
  it('passes inline images as attachments with their content id', async () => {
    const { client, send } = stubClient({ data: { id: 'em_1' }, error: null })
    const content = Buffer.from('png bytes')

    await new ResendTransport(client).send({
      ...email,
      inlineImages: [
        {
          contentId: 'stride-logo-light',
          filename: 'stride.png',
          contentType: 'image/png',
          content,
        },
      ],
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            contentId: 'stride-logo-light',
            filename: 'stride.png',
            contentType: 'image/png',
            content,
          },
        ],
      }),
    )
  })

  // The success line: Resend's id, never the address (decisions §32).
  it("logs Resend's id, not the address", async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined)
    const { client } = stubClient({ data: { id: 'em_1' }, error: null })

    await new ResendTransport(client).send(email)

    expect(logged.mock.calls).toStrictEqual([['Email sent (Resend id: em_1)']])
    logged.mockRestore()
  })

  it('resolves when Resend accepts the email', async () => {
    const { client } = stubClient({ data: { id: 'em_1' }, error: null })

    await expect(new ResendTransport(client).send(email)).resolves.toBe(
      undefined,
    )
  })

  // The case this class exists to get right: Resend's SDK RESOLVES with an
  // error object instead of throwing. Treating that as success would make
  // every rejected email look delivered. The reason, not the recipient: the
  // caller logs this message with the account's id (decisions §32).
  it('rejects when Resend returns an error, with the reason but not the recipient', async () => {
    const { client } = stubClient({
      data: null,
      error: {
        name: 'validation_error',
        message: 'Invalid `to` field.',
        statusCode: 422,
      },
    })

    await expect(new ResendTransport(client).send(email)).rejects.toThrow(
      new Error(
        'Resend rejected the email: validation_error — Invalid `to` field.',
      ),
    )
  })

  // Decisions §46: an address that can never receive mail would only bounce,
  // and bounces hurt the sending domain. Refused before any request.
  it.each([
    'pat@stride.test',
    'someone@example.com',
    'a@mail.example.org',
    'x@host.invalid',
  ])('refuses %s without asking Resend', async (to) => {
    const { client, send } = stubClient({ data: { id: 'em_1' }, error: null })

    await expect(
      new ResendTransport(client).send({ ...email, to }),
    ).rejects.toThrow(/reserved for examples and tests/)
    expect(send).not.toHaveBeenCalled()
  })

  it('lets a network-level failure reject unchanged', async () => {
    const send = jest.fn().mockRejectedValue(new Error('socket hang up'))
    const client = { emails: { send } } as unknown as ResendEmailsClient

    await expect(new ResendTransport(client).send(email)).rejects.toThrow(
      'socket hang up',
    )
  })
})
