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

import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { Request, Response } from 'express'
import {
  ASSIGNED_PROGRAM_CLOSED,
  isCheckViolation,
} from '../../database/pg-errors'

// The closed-program guard's refusal (migration 0031) — reached only when
// the service's own check (assertProgramOpen) didn't catch it first: a
// request that raced a cancel, say. Translated HERE, once, rather than in
// every service method that writes to a program: whichever route hits the
// database's refusal, the client gets the same 409 the service would have
// given, never a 500.
export const CLOSED_PROGRAM_MESSAGE =
  'This program is closed, so it can no longer change'

// --- FILTER ------------------------------------------------------------------------------------------------

// @Catch() with no argument catches EVERYTHING — both Nest's own
// HttpExceptions (thrown deliberately, all over this app —
// NotFoundException, ForbiddenException, etc.) and genuinely unexpected
// errors that were never meant to reach a client at all.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter')

  catch(caught: unknown, host: ArgumentsHost) {
    const exception = isCheckViolation(caught, ASSIGNED_PROGRAM_CLOSED)
      ? new ConflictException(CLOSED_PROGRAM_MESSAGE)
      : caught
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    const isHttpException = exception instanceof HttpException
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR

    // A deliberately thrown HttpException (a 404, a 403, a validation 400)
    // was written with a message that's safe and meant to be shown to the
    // caller — reuse it as-is. Anything else is different in kind: it was
    // NEVER meant to reach an API consumer at all, and could contain real
    // internal detail (a stack trace, a file path, raw Postgres error text
    // naming actual columns/tables) — always replace it with a generic
    // message, and log the real one only server-side.
    let message: string | object = 'Internal server error'
    let extra: Record<string, unknown> | undefined
    if (isHttpException) {
      const exceptionResponse = exception.getResponse()
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse
      } else {
        const {
          message: rawMessage,
          statusCode: _statusCode,
          error: _error,
          ...rest
        } = exceptionResponse as Record<string, unknown>
        message = (rawMessage as string | object) ?? exception.message
        if (Object.keys(rest).length > 0) {
          extra = rest
        }
      }
    } else {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      )
    }

    const messages = Array.isArray(message) ? message : [message]

    response.status(status).json({
      statusCode: status,
      message: messages,
      error: isHttpException ? exception.name : 'InternalServerError',
      timestamp: new Date().toISOString(),
      ...extra,
      path: request.url,
    })
  }
}