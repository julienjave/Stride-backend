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

import { randomUUID } from 'node:crypto'
import { Catch, ArgumentsHost, HttpException, Logger } from '@nestjs/common'
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets'
import { translateDatabaseRefusal } from '../common/filters/http-exception.filter'

// --- TYPES -------------------------------------------------------------------------------------------------

// What every WebSocket event answers through its ACKNOWLEDGEMENT — the
// callback a Socket.IO client passes as the event's last argument
// (`socket.emit('sendMessage', data, (answer) => …)`). One shape for success
// and failure, so the client always learns how ITS event ended:
//   { ok: true, data }                       — data: what REST would answer;
//   { ok: false, status, message: string[] } — the REST status and message;
//                                              a 500 also has `requestId`.
//
// `requestId` (decisions §32): an event on an open socket is not an HTTP
// request — no request logger, no X-Request-Id — so an unexpected failure
// gets its OWN id here, logged with the error and answered to the client:
// the same "Reference" a failed REST request gives, leading to the same line.
export type WsAnswer<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string[]; requestId?: string }

// --- FILTER ------------------------------------------------------------------------------------------------

// The services throw ordinary HTTP exceptions (NotFoundException,
// ForbiddenException…) — the same ones the REST API turns into responses —
// so a rule behaves identically through either door. Nest's DEFAULT
// WebSocket handling only understands WsException: anything else becomes a
// generic "Internal server error". This filter keeps the real status and
// message.
//
// WHERE the answer goes (Phase 5). Nest's own handling emits a separate
// `exception` event — with nothing tying it to the event that failed: a
// screen that sent two messages can't tell which one was refused, so it
// can't mark that bubble "not sent". When the client passed an
// acknowledgement, the answer goes THERE instead, in the WsAnswer shape.
// Nest calls a gateway handler with the arguments (client, data, ack,
// pattern) — read from @nestjs/websockets' WsContextCreator and the
// Socket.IO adapter's bindMessageHandlers — so the ack is argument 2, a
// function only when the client sent one. Without one (an older script),
// the `exception` event as before.
//
// Database refusals are translated first, through the REST filter's own
// function (translateDatabaseRefusal): the same 409 or 400 through both
// doors.
@Catch()
export class WsHttpExceptionFilter extends BaseWsExceptionFilter {
  private readonly log = new Logger('WsExceptionFilter')

  catch(caught: unknown, host: ArgumentsHost) {
    const exception = translateDatabaseRefusal(caught)
    const ack: unknown = host.getArgByIndex(2)

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const response = exception.getResponse()
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ??
            exception.message)
      const messages = Array.isArray(message) ? message : [message]
      if (typeof ack === 'function') {
        const answer: WsAnswer<never> = { ok: false, status, message: messages }
        return (ack as (answer: WsAnswer<never>) => void)(answer)
      }
      return super.catch(new WsException({ status, message: messages }), host)
    }

    // Not a deliberate refusal: a bug. Never its details to the client (a
    // stack, a table name) — a generic 500 — and the real error in the log,
    // as the REST filter does.
    if (typeof ack === 'function') {
      const pattern = String(host.getArgByIndex(3))
      const requestId = randomUUID()
      if (caught instanceof Error) {
        this.log.error(
          { err: caught, requestId },
          `Unhandled exception on event ${pattern}`,
        )
      } else {
        this.log.error(
          { requestId },
          `Unhandled exception on event ${pattern}: ${String(caught)}`,
        )
      }
      const answer: WsAnswer<never> = {
        ok: false,
        status: 500,
        message: ['Internal server error'],
        requestId,
      }
      return (ack as (answer: WsAnswer<never>) => void)(answer)
    }
    return super.catch(caught, host)
  }
}
