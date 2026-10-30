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

import {
  ArgumentsHost,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  CLOSED_PROGRAM_MESSAGE,
  HttpExceptionFilter,
  RETIRED_EXERCISE_MESSAGE,
} from './http-exception.filter'
import { ONE_SESSION_A_DAY_MESSAGE } from '../../sessions/session-rules'

// The filter shapes every error response. Here: the database errors it
// translates (the closed-program guard, migration 0031; the retired-exercise
// guard, 0033; the blank-title CHECKs, 0035; the end-date and care-team
// guards, 0073) and that the rest is unchanged. A fake ArgumentsHost hands it a request and a response whose
// status() and json() calls are recorded.
const REQUEST_ID = '0b9e6c1e-4c3a-4f7e-9d2a-5f1e8c7b6a50'
// A v4 UUID, as randomUUID() makes them.
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('HttpExceptionFilter', () => {
  // `request`: what the fake request holds besides its method — by default
  // a request the logger has already given its id (REQUEST_ID).
  function run(
    exception: unknown,
    request: Record<string, unknown> = { url: '/sessions', id: REQUEST_ID },
  ) {
    // Typed mocks: what the filter passes to status(), json() and
    // setHeader().
    const json = jest.fn<void, [Record<string, unknown>]>()
    const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }))
    const setHeader = jest.fn<void, [string, string]>()
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, setHeader, headersSent: false }),
        getRequest: () => ({ method: 'POST', ...request }),
      }),
    } as unknown as ArgumentsHost
    new HttpExceptionFilter().catch(exception, host)
    return {
      status: status.mock.calls[0][0],
      body: json.mock.calls[0][0],
      setHeader,
    }
  }

  // node-postgres's error, wrapped by Drizzle as it reaches the filter.
  const databaseError = (code: string, constraint: string) =>
    new DrizzleQueryError(
      'insert into "sessions" ...',
      [],
      Object.assign(new Error('refused'), { code, constraint }),
    )

  it('answers 409 for the closed-program guard, with the same shape as any refusal', () => {
    const { status, body } = run(
      databaseError('23514', 'assigned_program_closed'),
    )
    expect(status).toBe(409)
    expect(body).toMatchObject({
      statusCode: 409,
      message: [CLOSED_PROGRAM_MESSAGE],
      error: 'ConflictException',
      path: '/sessions',
      requestId: REQUEST_ID,
    })
  })

  // One session a day (migration 0041): a start that raced a Finish gets
  // the service's own 409, in its words.
  it("answers 409 for the one-session-a-day guard, in the service's own words", () => {
    const { status, body } = run(
      databaseError('23514', 'session_one_completed_per_day'),
    )
    expect(status).toBe(409)
    expect(body).toMatchObject({
      statusCode: 409,
      message: [ONE_SESSION_A_DAY_MESSAGE],
      error: 'ConflictException',
    })
  })

  it("answers 409 for the retired-exercise guard, in the service's own words", () => {
    const { status, body } = run(
      databaseError('23514', 'assigned_program_exercise_retired'),
    )
    expect(status).toBe(409)
    expect(body).toMatchObject({
      statusCode: 409,
      message: [RETIRED_EXERCISE_MESSAGE],
      error: 'ConflictException',
    })
  })

  // A program exercise's photo limit (migration 0042): the service counts
  // first, so this is the safety net — a 409 like the service's, never a 500.
  it('answers 409 for the photo-limit CHECK', () => {
    const { status, body } = run(
      databaseError('23514', 'assigned_program_exercises_photo_limit'),
    )
    expect(status).toBe(409)
    expect(body).toMatchObject({
      statusCode: 409,
      message: ['A program exercise can have at most 10 photos'],
      error: 'ConflictException',
    })
  })

  // The blank-title CHECKs: the same 400, in the same words, as the DTOs'
  // IsTitle() rule — whichever layer refuses, the client reads one answer.
  // The full body is asserted (toStrictEqual, timestamp aside), so an
  // extra or missing key fails too.
  it.each([
    [
      'program_templates_title_not_blank',
      "The template's title can't be blank",
    ],
    ['assigned_programs_title_not_blank', "The program's title can't be blank"],
  ])("answers 400 for %s, in the DTO's words", (constraint, message) => {
    const { status, body } = run(databaseError('23514', constraint))
    expect(status).toBe(400)
    expect({ ...body, timestamp: 'any' }).toStrictEqual({
      statusCode: 400,
      message: [message],
      error: 'BadRequestException',
      timestamp: 'any',
      path: '/sessions',
      requestId: REQUEST_ID,
    })
  })

  // Messaging (migrations 0047 / 0048): each refusal answered as the
  // service or the DTO would — the text CHECKs as IsMessageBody's 400, the
  // guards as 409s. Full bodies, so a wrong status, class or message fails.
  it.each([
    [
      'messages_body_not_blank',
      400,
      'BadRequestException',
      "A message can't be blank",
    ],
    [
      'messages_body_max_length',
      400,
      'BadRequestException',
      'A message can be at most 5000 characters',
    ],
    [
      'message_delete_window',
      409,
      'ConflictException',
      'This message can no longer be deleted: it has been read, or the 15 minutes have passed',
    ],
    [
      'message_content_fixed',
      409,
      'ConflictException',
      'A message can no longer change once sent',
    ],
    [
      'message_read_by_recipient',
      409,
      'ConflictException',
      'A message can no longer change once sent',
    ],
    [
      'conversation_participants_fixed',
      409,
      'ConflictException',
      'Who a conversation is between can no longer change',
    ],
  ])('answers %s with a %i', (constraint, statusCode, error, message) => {
    const { status, body } = run(databaseError('23514', constraint))
    expect(status).toBe(statusCode)
    expect({ ...body, timestamp: 'any' }).toStrictEqual({
      statusCode,
      message: [message],
      error,
      timestamp: 'any',
      path: '/sessions',
      requestId: REQUEST_ID,
    })
  })

  // Migration 0073's two triggers: the end-date rule's own 400, in
  // end-date.ts's words (so the client can't tell which layer refused), and
  // a 409 for a care-team link changed in any way but being ended. Full
  // bodies again.
  it.each([
    [
      'assigned_program_end_date_not_past',
      400,
      'BadRequestException',
      "The end date can't be moved into the past: to end the program now, complete or cancel it",
    ],
    [
      'care_team_member_end_only',
      409,
      'ConflictException',
      'A care-team link can only be ended, and only while it is current',
    ],
  ])('answers %s with a %i', (constraint, statusCode, error, message) => {
    const { status, body } = run(databaseError('23514', constraint))
    expect(status).toBe(statusCode)
    expect({ ...body, timestamp: 'any' }).toStrictEqual({
      statusCode,
      message: [message],
      error,
      timestamp: 'any',
      path: '/sessions',
      requestId: REQUEST_ID,
    })
  })

  // A guard of 0048 that the filter must NOT translate: refusing a new
  // message that claims to be read already is a bug in the caller, never a
  // request to fix — a 500 like any other unexpected CHECK. (A translation
  // matching every `message_…` name would fail here.)
  it('leaves message_starts_unread as a 500', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { status } = run(databaseError('23514', 'message_starts_unread'))
    expect(status).toBe(500)
  })

  // Any other CHECK failure is still an unexpected error: a 500, its details
  // kept out of the response. The second case is a neighbour of the title
  // CHECKs — another CHECK on the same table — so a translation that
  // matched on the TABLE instead of the constraint would fail here. The
  // third is the same for migration 0073's care-team guard (its table's
  // own CHECK: an end before the start is a bug, not a request to fix).
  it.each([
    'assigned_programs_ends_after_start',
    'assigned_programs_not_based_on_itself',
    'care_team_members_ends_after_start',
  ])('leaves other database errors (%s) as a 500', (constraint) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { status, body } = run(databaseError('23514', constraint))
    expect(status).toBe(500)
    expect(body.message).toEqual(['Internal server error'])
  })

  // What reaches the log for an unexpected error: the error OBJECT, under
  // `err`, so pino's serializer writes its stack and every `cause` — for a
  // database error, Postgres's own reason. (Logged as a stack STRING, the
  // cause was lost: "Failed query: update …", and no why.)
  describe('logging an unexpected error', () => {
    let logged: jest.SpyInstance
    beforeEach(() => {
      logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined)
    })
    afterEach(() => logged.mockRestore())

    it('hands the error itself, cause included, to the logger', () => {
      const error = databaseError('23502', 'sessions_status_not_null')
      run(error)
      expect(logged.mock.calls).toStrictEqual([
        [
          { err: error, requestId: REQUEST_ID },
          'Unhandled exception on POST /sessions',
        ],
      ])
      // The object passed is the one that carries Postgres's reason.
      const passed = (logged.mock.calls[0][0] as { err: Error }).err
      expect(passed.cause).toMatchObject({ code: '23502' })
    })

    // Anything can be thrown: a string has no stack to give, so its text
    // goes into the message.
    it('writes something thrown that is not an Error into the message', () => {
      run('not an error')
      expect(logged.mock.calls).toStrictEqual([
        [
          { requestId: REQUEST_ID },
          'Unhandled exception on POST /sessions: not an error',
        ],
      ])
    })

    // The URL's query string is where search terms are (a patient's name
    // in `?search=`): the line names the PATH only. originalUrl is preferred
    // — Express's `url` is relative inside a mounted router.
    it('names the path, never the query string', () => {
      run(new Error('boom'), {
        url: '/users?search=Jane%20Doe',
        originalUrl: '/admin/users?search=Jane%20Doe#top',
        id: REQUEST_ID,
      })
      expect(logged.mock.calls).toStrictEqual([
        [
          { err: expect.any(Error) as Error, requestId: REQUEST_ID },
          'Unhandled exception on POST /admin/users',
        ],
      ])
    })

    it('logs nothing for an HTTP exception (an expected answer)', () => {
      run(new NotFoundException('Nope'))
      expect(logged).not.toHaveBeenCalled()
    })
  })

  // The reference a person can quote (decisions §32): the request's id in
  // every error body — the one the logger gave the request.
  it("answers the request's id in the body, after the extra fields", () => {
    const { body, setHeader } = run(
      new ConflictException({
        message: 'Taken',
        requestId: 'chosen-by-the-exception',
      }),
    )
    expect(body.requestId).toBe(REQUEST_ID)
    // Already given (and put in the header) by the logger: not set again.
    expect(setHeader).not.toHaveBeenCalled()
  })

  // An error raised before the request logger ran — the body parser
  // refusing a body that isn't JSON — has no id yet: the filter makes one,
  // and puts it in the header too, so every error answer has its reference.
  it('makes the id when the request has none, in the header and the body', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { body, setHeader } = run(new NotFoundException('Nope'), {
      url: '/sessions',
    })
    expect(body.requestId).toMatch(UUID)
    expect(setHeader.mock.calls).toStrictEqual([
      ['X-Request-Id', body.requestId],
    ])
  })

  it('passes HTTP exceptions through unchanged', () => {
    const { status, body } = run(new NotFoundException('Nope'))
    expect(status).toBe(404)
    expect(body.message).toEqual(['Nope'])
  })
})
