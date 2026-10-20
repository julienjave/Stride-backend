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

import { applyDecorators } from '@nestjs/common'
import { IsString, Matches, MaxLength } from 'class-validator'
import { MESSAGE_MAX_LENGTH } from '../../database/schema/messaging.schema'
import {
  BLANK_MESSAGE_MESSAGE,
  MESSAGE_TOO_LONG_MESSAGE,
} from '../message-rules'

// --- DECORATOR ---------------------------------------------------------------------------------------------

// What a message's text must be — written once for its two doors: the REST
// route (SendMessageDto) and the WebSocket event (SendMessageEventDto). The
// same pattern as IsTitle (src/common/validators/title.ts):
//   - a string;
//   - at most MESSAGE_MAX_LENGTH characters (5000 — the constant the
//     database's CHECK is built from, so the two can't drift);
//   - NOT BLANK: at least one character that isn't white space. The old
//     @MinLength(1) accepted "   " — a message with nothing in it, notifying
//     the other person for nothing. `\S` finds a non-space character
//     anywhere (the regex isn't anchored), so " ok " passes; it's stored as
//     typed — line breaks and indentation are part of what someone wrote.
//     The same `\S` test as the database's messages_body_not_blank, so a
//     message of tabs or new lines is refused by both.
// Whether the field may be absent isn't decided here: on both DTOs it's
// required (no @IsOptional()), so a missing messageBody fails @IsString().
export function IsMessageBody(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MaxLength(MESSAGE_MAX_LENGTH, { message: MESSAGE_TOO_LONG_MESSAGE }),
    Matches(/\S/, { message: BLANK_MESSAGE_MESSAGE }),
  )
}
