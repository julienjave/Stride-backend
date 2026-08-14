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

import { Catch, ArgumentsHost, HttpException } from '@nestjs/common'
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets'

// --- FILTER ------------------------------------------------------------------------------------------------

// This app's services (MessagingService.assertParticipant, and everything
// else) throw ordinary HttpException subclasses — NotFoundException,
// ForbiddenException — the SAME classes used everywhere in the REST API,
// deliberately, so authorization logic behaves identically regardless of
// whether it's called from a controller or a gateway. But Nest's DEFAULT
// WebSocket exception handling only recognizes WsException specifically —
// anything else, including our real, meaningful HttpExceptions, silently
// collapses into a generic "Internal server error", telling a legitimate
// client nothing about what actually went wrong (e.g. "you're not a
// participant in this conversation" becomes indistinguishable from a real
// server crash). This filter converts a caught HttpException into an
// equivalent WsException before Nest's own base handling sends it to the
// client, so the real status and message actually reach them.
@Catch()
export class WsHttpExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const response = exception.getResponse()
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string }).message ?? exception.message)
      const messages = Array.isArray(message) ? message : [message]
      return super.catch(new WsException({ status, message: messages }), host)
    }
    return super.catch(exception, host)
  }
}
