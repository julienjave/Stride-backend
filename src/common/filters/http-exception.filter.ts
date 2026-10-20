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
  BadRequestException,
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
  ASSIGNED_PROGRAM_EXERCISE_RETIRED,
  ASSIGNED_PROGRAM_EXERCISES_PHOTO_LIMIT,
  ASSIGNED_PROGRAMS_TITLE_NOT_BLANK,
  PROGRAM_TEMPLATES_TITLE_NOT_BLANK,
  CONVERSATION_PARTICIPANTS_FIXED,
  MESSAGE_CONTENT_FIXED,
  MESSAGE_DELETE_WINDOW,
  MESSAGE_READ_BY_RECIPIENT,
  MESSAGES_BODY_MAX_LENGTH,
  MESSAGES_BODY_NOT_BLANK,
  SESSION_EXERCISE_SESSION_FINISHED,
  SESSION_ONE_COMPLETED_PER_DAY,
  isCheckViolation,
} from '../../database/pg-errors'
import { blankTitleMessage } from '../validators/title'
import {
  ONE_SESSION_A_DAY_MESSAGE,
  SESSION_FINISHED_MESSAGE,
} from '../../sessions/session-rules'
import { PHOTO_LIMIT_MESSAGE } from '../../assigned-programs/program-photos'
import {
  BLANK_MESSAGE_MESSAGE,
  CONVERSATION_FIXED_MESSAGE,
  MESSAGE_FIXED_MESSAGE,
  MESSAGE_NOT_DELETABLE_MESSAGE,
  MESSAGE_TOO_LONG_MESSAGE,
} from '../../messaging/message-rules'

// The closed-program guard's refusal (migration 0031) — reached only when
// the service's own check (assertProgramOpen) didn't catch it first: a
// request that raced a cancel, say. Translated HERE, once, rather than in
// every service method that writes to a program: whichever route hits the
// database's refusal, the client gets the same 409 the service would have
// given, never a 500.
export const CLOSED_PROGRAM_MESSAGE =
  'This program is closed, so it can no longer change'

// The same idea for a RETIRED program exercise (migration 0033): a request
// that raced its removal — reordering a workout while one of its exercises
// is being removed, say — gets the 409 the service's own check
// (assertNotRetired) gives, in the same words.
export const RETIRED_EXERCISE_MESSAGE =
  'This exercise was removed from the program, so it can no longer change'

// The database refusals a client can cause, each turned into the answer the
// app's own checks would have given:
// - "the request is fine, but the data it targets can't change any more" —
//   a 409;
// - a blank title (migration 0035's CHECKs) — the 400 of the DTOs' IsTitle()
//   rule, in its words (blankTitleMessage). The DTOs refuse a blank title
//   first, so today nothing reaches these CHECKs through the API; if a
//   future write path ever skipped the DTOs, the client would still get a
//   400 that says what's wrong, not a 500.
// Every other database error stays a 500: it means a bug, not a request to
// fix.
//
// Exported (Phase 5): the WebSocket exception filter translates through the
// same function, so a refusal reached through the socket gets the same
// answer as through REST.
export function translateDatabaseRefusal(caught: unknown): unknown {
  if (isCheckViolation(caught, ASSIGNED_PROGRAM_CLOSED)) {
    return new ConflictException(CLOSED_PROGRAM_MESSAGE)
  }
  if (isCheckViolation(caught, ASSIGNED_PROGRAM_EXERCISE_RETIRED)) {
    return new ConflictException(RETIRED_EXERCISE_MESSAGE)
  }
  // A tick of a session's checklist racing its Finish (migration 0038): the
  // service's own check passed before the Finish committed; the trigger
  // waited for it, then refused. The same 409, in the same words, as the
  // service's assertSessionOpen.
  if (isCheckViolation(caught, SESSION_EXERCISE_SESSION_FINISHED)) {
    return new ConflictException(SESSION_FINISHED_MESSAGE)
  }
  // A start racing a Finish the same day (migration 0041, one session a
  // day): the same 409, in the same words, as SessionsService.create's own
  // check.
  if (isCheckViolation(caught, SESSION_ONE_COMPLETED_PER_DAY)) {
    return new ConflictException(ONE_SESSION_A_DAY_MESSAGE)
  }
  // A program exercise's 11th photo (migration 0042's CHECK). The service
  // counts under the row's lock first, so through the API this is only a
  // safety net — but a net that answers like the service: a 409.
  if (isCheckViolation(caught, ASSIGNED_PROGRAM_EXERCISES_PHOTO_LIMIT)) {
    return new ConflictException(PHOTO_LIMIT_MESSAGE)
  }
  if (isCheckViolation(caught, PROGRAM_TEMPLATES_TITLE_NOT_BLANK)) {
    return new BadRequestException(blankTitleMessage('template'))
  }
  if (isCheckViolation(caught, ASSIGNED_PROGRAMS_TITLE_NOT_BLANK)) {
    return new BadRequestException(blankTitleMessage('program'))
  }
  // Messaging (migrations 0047 / 0048). A message's text: IsMessageBody
  // refuses a blank or over-long one first, so these two are safety nets
  // answering in its words. A delete that raced a read: the service's
  // UPDATE re-checks "unread" itself (no row → its own 409), so the trigger
  // answers only for some other query — a 409 that can't say which of the
  // two conditions failed. The last three changes are never asked for by
  // the service; translated so that a future route that tries gets a
  // readable 409, not a 500.
  if (isCheckViolation(caught, MESSAGES_BODY_NOT_BLANK)) {
    return new BadRequestException(BLANK_MESSAGE_MESSAGE)
  }
  if (isCheckViolation(caught, MESSAGES_BODY_MAX_LENGTH)) {
    return new BadRequestException(MESSAGE_TOO_LONG_MESSAGE)
  }
  if (isCheckViolation(caught, MESSAGE_DELETE_WINDOW)) {
    return new ConflictException(MESSAGE_NOT_DELETABLE_MESSAGE)
  }
  if (
    isCheckViolation(caught, MESSAGE_CONTENT_FIXED) ||
    isCheckViolation(caught, MESSAGE_READ_BY_RECIPIENT)
  ) {
    return new ConflictException(MESSAGE_FIXED_MESSAGE)
  }
  if (isCheckViolation(caught, CONVERSATION_PARTICIPANTS_FIXED)) {
    return new ConflictException(CONVERSATION_FIXED_MESSAGE)
  }
  return caught
}

// --- FILTER ------------------------------------------------------------------------------------------------

// @Catch() with no argument catches EVERYTHING — both Nest's own
// HttpExceptions (thrown deliberately, all over this app —
// NotFoundException, ForbiddenException, etc.) and genuinely unexpected
// errors that were never meant to reach a client at all.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter')

  catch(caught: unknown, host: ArgumentsHost) {
    const exception = translateDatabaseRefusal(caught)
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
      // The error OBJECT goes to the logger, under `err` — not its stack as
      // a string. pino's error serializer then writes the message, the stack
      // AND every `cause` behind it. That matters for database errors:
      // Drizzle wraps node-postgres's error in a DrizzleQueryError whose own
      // stack only says "Failed query: update …"; Postgres's reason ("null
      // value in column "status" … violates not-null constraint", its code,
      // the constraint) is in `cause`. Passed as a string, the cause was lost
      // — every unexpected 500 was logged without its reason (found
      // 2026-10-14, reading the log of a real 500). nestjs-pino turns an
      // object first argument into the log line's fields, and the next
      // argument into its message. Something thrown that isn't an Error
      // (a string, an object) has no stack to give: it's logged as text.
      if (exception instanceof Error) {
        this.logger.error(
          { err: exception },
          `Unhandled exception on ${request.method} ${request.url}`,
        )
      } else {
        this.logger.error(
          `Unhandled exception on ${request.method} ${request.url}: ${String(exception)}`,
        )
      }
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
