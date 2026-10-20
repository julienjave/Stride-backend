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

import { IsInt, IsPositive } from 'class-validator'
import { IsMessageBody } from './message-body'

// --- DATA TRANSFER OBJECTS ---------------------------------------------------------------------------------

// POST /conversations/:id/messages — the REST door (the conversation is in
// the URL).
export class SendMessageDto {
  @IsMessageBody()
  messageBody!: string
}

// The `sendMessage` WebSocket event — the socket door. An event has no URL,
// so the conversation travels in the payload. The gateway validates it with
// its own ValidationPipe: the app's global pipe (main.ts) applies to HTTP
// routes only, and before Phase 5 the socket took `data.messageBody` as it
// came — a number, an object, a megabyte of text.
export class SendMessageEventDto {
  @IsInt()
  @IsPositive()
  conversationId!: number

  @IsMessageBody()
  messageBody!: string
}

// The `deleteMessage` WebSocket event.
export class DeleteMessageEventDto {
  @IsInt()
  @IsPositive()
  conversationId!: number

  @IsInt()
  @IsPositive()
  messageId!: number
}
