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

// The decorators record their rules with the Reflect metadata API, which
// Nest loads at startup (main.ts) — a plain test file must load it itself,
// before the DTOs (their @Type() decorators run on import).
import 'reflect-metadata'
import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import {
  DeleteMessageEventDto,
  SendMessageDto,
  SendMessageEventDto,
} from './send-message.dto'
import { MessagesPageQueryDto } from './messages-page-query.dto'

// The messaging DTOs through the real class-validator engine. The message
// text rule (IsMessageBody) is run on BOTH of its doors — the REST body and
// the WebSocket event — with describe.each, so a door that lost the
// decorator (or got a looser copy of it) fails here.

type Dto = new () => object

async function errorsFor(dto: Dto, plain: object) {
  const errors = await validate(plainToInstance(dto, plain))
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.values(error.constraints ?? {}),
    ]),
  )
}

describe.each([
  ['SendMessageDto (REST)', SendMessageDto, {}],
  ['SendMessageEventDto (socket)', SendMessageEventDto, { conversationId: 7 }],
] as const)('the message text, on %s', (_name, dto, rest) => {
  it('accepts a message, spaces and line breaks around it included', async () => {
    expect(await errorsFor(dto, { ...rest, messageBody: ' ok \n' })).toEqual({})
  })

  // Blank = no character that isn't white space — spaces, tabs, line
  // breaks. The empty string too (the old @MinLength(1) refused only that).
  it.each(['', '   ', '\t\n'])('refuses a blank message (%j)', async (body) => {
    expect(await errorsFor(dto, { ...rest, messageBody: body })).toEqual({
      messageBody: ["A message can't be blank"],
    })
  })

  it('accepts 5000 characters and refuses 5001', async () => {
    expect(
      await errorsFor(dto, { ...rest, messageBody: 'a'.repeat(5000) }),
    ).toEqual({})
    expect(
      await errorsFor(dto, { ...rest, messageBody: 'a'.repeat(5001) }),
    ).toEqual({ messageBody: ['A message can be at most 5000 characters'] })
  })

  it('refuses a message that is not text, or missing', async () => {
    const notText = await errorsFor(dto, { ...rest, messageBody: 42 })
    expect(notText.messageBody).toContain('messageBody must be a string')
    const missing = await errorsFor(dto, { ...rest })
    expect(missing.messageBody).toContain('messageBody must be a string')
  })
})

describe('the WebSocket events’ ids', () => {
  // An event's payload is JSON as the client sent it — no URL, no
  // ParseIntPipe. A string id is refused rather than converted.
  it('refuses a conversation id that is not a positive whole number', async () => {
    for (const conversationId of ['7', 0, -1, 1.5, undefined]) {
      const errors = await errorsFor(SendMessageEventDto, {
        conversationId,
        messageBody: 'Hi',
      })
      expect(Object.keys(errors)).toEqual(['conversationId'])
    }
  })

  it('requires both ids to delete a message', async () => {
    expect(
      await errorsFor(DeleteMessageEventDto, {
        conversationId: 7,
        messageId: 41,
      }),
    ).toEqual({})
    const errors = await errorsFor(DeleteMessageEventDto, { conversationId: 7 })
    expect(Object.keys(errors)).toEqual(['messageId'])
  })
})

describe('MessagesPageQueryDto', () => {
  // Query strings arrive as text; @Type(() => Number) converts them first.
  it('accepts no parameters, and numbers sent as text', async () => {
    expect(await errorsFor(MessagesPageQueryDto, {})).toEqual({})
    expect(
      await errorsFor(MessagesPageQueryDto, { before: '120', limit: '100' }),
    ).toEqual({})
  })

  it('refuses a limit over 100, and ids that are not positive whole numbers', async () => {
    expect(
      Object.keys(await errorsFor(MessagesPageQueryDto, { limit: '101' })),
    ).toEqual(['limit'])
    for (const before of ['abc', '0', '-3', '1.5']) {
      expect(
        Object.keys(await errorsFor(MessagesPageQueryDto, { before })),
      ).toEqual(['before'])
    }
  })
})
