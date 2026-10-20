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

import { ArgumentsHost, ForbiddenException, Logger } from '@nestjs/common'
import { DrizzleQueryError } from 'drizzle-orm'
import { WsHttpExceptionFilter } from './ws-exception.filter'

// The WebSocket filter's four paths: a refusal or a bug, with or without an
// acknowledgement. A fake host gives the filter Nest's handler arguments —
// (client, data, ack, pattern) — and records what reaches the ack and what
// the client is emitted. The live behaviour (a real socket.io-client) is in
// test/messaging-gateway.e2e-spec.ts.
describe('WsHttpExceptionFilter', () => {
  function run(exception: unknown, withAck: boolean) {
    // Typed mocks: what the filter passes to the ack and to emit().
    const ack = jest.fn<void, [unknown]>()
    const emit = jest.fn<void, [string, unknown]>()
    const client = { emit }
    const args = [
      client,
      { conversationId: 7 },
      withAck ? ack : undefined,
      'sendMessage',
    ]
    const host = {
      getArgByIndex: (index: number) => args[index],
      switchToWs: () => ({
        getClient: () => client,
        getPattern: () => 'sendMessage',
        getData: () => args[1],
      }),
    } as unknown as ArgumentsHost
    new WsHttpExceptionFilter().catch(exception, host)
    return { ack, emit }
  }

  it('answers a refusal through the acknowledgement, and emits nothing', () => {
    const { ack, emit } = run(new ForbiddenException('Not yours'), true)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack.mock.calls[0][0]).toStrictEqual({
      ok: false,
      status: 403,
      message: ['Not yours'],
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps the `exception` event for a client that sent no acknowledgement', () => {
    const { ack, emit } = run(new ForbiddenException('Not yours'), false)
    expect(ack).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('exception', {
      status: 403,
      message: ['Not yours'],
    })
  })

  // A database refusal goes through the REST filter's translation first:
  // the same 409 through either door.
  it('translates a database refusal like the REST filter does', () => {
    const refusal = new DrizzleQueryError(
      'update "messages" ...',
      [],
      Object.assign(new Error('refused'), {
        code: '23514',
        constraint: 'message_delete_window',
      }),
    )
    const { ack } = run(refusal, true)
    expect(ack.mock.calls[0][0]).toStrictEqual({
      ok: false,
      status: 409,
      message: [
        'This message can no longer be deleted: it has been read, or the 15 minutes have passed',
      ],
    })
  })

  // A bug: a generic 500 to the client — never the error's own text, which
  // could name tables or paths — and the real error in the log.
  it('answers a bug with a generic 500 and logs the real error', () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)
    const { ack } = run(
      new Error('relation "secret_table" does not exist'),
      true,
    )
    expect(ack.mock.calls[0][0]).toStrictEqual({
      ok: false,
      status: 500,
      message: ['Internal server error'],
    })
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0][1]).toBe(
      'Unhandled exception on event sendMessage',
    )
    logged.mockRestore()
  })
})
