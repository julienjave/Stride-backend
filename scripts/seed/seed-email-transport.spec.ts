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

import type { OutgoingEmail } from '../../src/email/email-transport'
import { SeedEmailTransport } from './seed-email-transport'

const TOKEN = 'ab'.repeat(32) // 64 hex characters, like a real token

function invitation(to: string, token = TOKEN): OutgoingEmail {
  return {
    from: 'Stride <noreply@stride.test>',
    to,
    subject: "You're invited to Stride",
    html: '<p>…</p>',
    text: `Choose your password: http://localhost:5173/accept-invitation?token=${token}\nThis link expires in 7 days.`,
  }
}

describe('SeedEmailTransport', () => {
  let real: { send: jest.Mock }
  let transport: SeedEmailTransport

  beforeEach(() => {
    real = { send: jest.fn().mockResolvedValue(undefined) }
    transport = new SeedEmailTransport(real)
  })

  it('captures by default, without sending anything for real', async () => {
    await transport.send(invitation('pat@stride.test'))

    expect(transport.captured).toHaveLength(1)
    expect(real.send).not.toHaveBeenCalled()
  })

  it('hands the email to the real transport in deliver mode', async () => {
    transport.mode = 'deliver'
    const email = invitation('new.patient@stride.test')

    await transport.send(email)

    expect(real.send).toHaveBeenCalledWith(email)
    expect(transport.captured).toHaveLength(0)
  })

  // The reviewers' demo (production): nothing reaches the real transport —
  // Resend there, and @stride.test can't receive mail.
  it('keeps the email in deliver mode when told not to deliver for real', async () => {
    const kept = new SeedEmailTransport(real, false)
    kept.mode = 'deliver'
    const email = invitation('new.patient@stride.test')

    await kept.send(email)

    expect(real.send).not.toHaveBeenCalled()
    expect(kept.captured).toEqual([email])
  })

  it('rejects in fail mode, like an unreachable mail server', async () => {
    transport.mode = 'fail'

    await expect(
      transport.send(invitation('stuck.patient@stride.test')),
    ).rejects.toThrow(
      'Seed: delivery to stuck.patient@stride.test fails on purpose (email-failed state)',
    )
    expect(real.send).not.toHaveBeenCalled()
  })

  it("reads the token from the address's LAST captured invitation", async () => {
    const newer = 'cd'.repeat(32)
    await transport.send(invitation('pat@stride.test'))
    await transport.send(invitation('jo@stride.test', 'ef'.repeat(32)))
    await transport.send(invitation('pat@stride.test', newer))

    expect(transport.invitationTokenFor('pat@stride.test')).toBe(newer)
  })

  it('says so when nothing was captured for the address', () => {
    expect(() => transport.invitationTokenFor('nobody@stride.test')).toThrow(
      'Seed: no captured email to nobody@stride.test',
    )
  })

  it('says so when the email has no invitation link', async () => {
    await transport.send({ ...invitation('pat@stride.test'), text: 'Hello' })

    expect(() => transport.invitationTokenFor('pat@stride.test')).toThrow(
      'Seed: the email to pat@stride.test has no invitation link',
    )
  })
})