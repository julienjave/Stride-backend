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

import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsPositive, Max } from 'class-validator'
import { MESSAGE_PAGE_MAX } from '../message-rules'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /conversations/:id/messages?before=&limit= — one page of a thread.
//
// CURSOR pagination, not page numbers. `?page=3` means "skip 100 rows" —
// but in a live conversation new messages keep arriving at the end, so the
// rows shift between two requests and a page repeats or skips messages.
// `before=<id>` means "the messages older than this one": a fixed point in
// the history, whatever arrived since. Ids grow with every message
// (bigserial), so "older" is "smaller id". Without `before`, the newest
// page.
//
// Query strings are text: @Type(() => Number) (class-transformer, run by
// the global ValidationPipe's `transform: true`) turns "120" into 120
// before the checks, and "abc" into NaN, which @IsInt refuses.
export class MessagesPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  before?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(MESSAGE_PAGE_MAX)
  limit?: number
}
