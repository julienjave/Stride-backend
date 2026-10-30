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

import { MessageNoticesService } from './message-notices.service'
import type { ClaimedNoticeRow } from './message-rules'
import type { DrizzleDb } from '../database/drizzle.provider'
import type { EmailService } from '../email/email.service'

// Roadmap Phase 6.5: the sweep around claim_message_notices(). The claim's
// rules are the database's (test/message-notices.e2e-spec.ts); this checks
// what the class adds — grouping, sending, surviving failures, the timer.

const row = (recipient: number, sender: string): ClaimedNoticeRow => ({
  conversation_id: recipient * 10,
  recipient_id: recipient,
  recipient_side: 'patient',
  recipient_email: `user${recipient}@example.com`,
  recipient_first_name: 'First',
  sender_first_name: sender,
  sender_last_name: 'Chen',
})

function build(rows: ClaimedNoticeRow[] = []) {
  const execute = jest.fn().mockResolvedValue({ rows })
  const send = jest.fn().mockResolvedValue(undefined)
  const service = new MessageNoticesService(
    { execute } as unknown as DrizzleDb,
    { sendNewMessagesNotice: send } as unknown as EmailService,
  )
  return { service, execute, send }
}

describe('MessageNoticesService.sweep', () => {
  it('claims with the 15-minute delay and sends one email per recipient', async () => {
    const { service, execute, send } = build([row(6, 'Alex'), row(7, 'Sam')])
    expect(await service.sweep()).toBe(2)
    expect(execute).toHaveBeenCalledTimes(1)
    // The query names the function and passes 15 as a PARAMETER.
    const query = (execute.mock.calls[0] as [{ queryChunks: unknown[] }])[0]
    expect(JSON.stringify(query.queryChunks)).toContain(
      'SELECT * FROM claim_message_notices(',
    )
    expect(query.queryChunks).toContain(15)
    expect(send.mock.calls.map(([notice]) => notice as unknown)).toStrictEqual([
      {
        recipientId: 6,
        side: 'patient',
        to: 'user6@example.com',
        firstName: 'First',
        senders: ['Alex Chen'],
      },
      {
        recipientId: 7,
        side: 'patient',
        to: 'user7@example.com',
        firstName: 'First',
        senders: ['Sam Chen'],
      },
    ])
  })

  it('sends nothing when nothing is due', async () => {
    const { service, send } = build([])
    expect(await service.sweep()).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('goes on to the next email when one fails, and counts only the sent ones', async () => {
    const { service, send } = build([row(6, 'Alex'), row(7, 'Sam')])
    send.mockRejectedValueOnce(new Error('SMTP down'))
    expect(await service.sweep()).toBe(1)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('MessageNoticesService timer', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('sweeps every interval once started, and stops on shutdown', async () => {
    const { service, execute } = build()
    service.start(1000)
    await jest.advanceTimersByTimeAsync(3000)
    expect(execute).toHaveBeenCalledTimes(3)
    service.onApplicationShutdown()
    await jest.advanceTimersByTimeAsync(3000)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('starts one timer only, however often start() is called', async () => {
    const { service, execute } = build()
    service.start(1000)
    service.start(1000)
    await jest.advanceTimersByTimeAsync(1000)
    expect(execute).toHaveBeenCalledTimes(1)
    service.onApplicationShutdown()
  })

  it('skips a tick while the previous sweep still runs', async () => {
    const { service, execute } = build()
    let finish: () => void = () => {}
    execute.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ rows: [] }))),
    )
    service.start(1000)
    await jest.advanceTimersByTimeAsync(3000)
    expect(execute).toHaveBeenCalledTimes(1)
    finish()
    await jest.advanceTimersByTimeAsync(1000)
    expect(execute).toHaveBeenCalledTimes(2)
    service.onApplicationShutdown()
  })

  it('survives a failed sweep: the next tick runs', async () => {
    const { service, execute } = build()
    execute.mockRejectedValueOnce(new Error('database unreachable'))
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)
    service.start(1000)
    await jest.advanceTimersByTimeAsync(2000)
    expect(execute).toHaveBeenCalledTimes(2)
    service.onApplicationShutdown()
  })
})
