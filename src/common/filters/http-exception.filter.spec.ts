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

import { ArgumentsHost, NotFoundException } from '@nestjs/common'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  CLOSED_PROGRAM_MESSAGE,
  HttpExceptionFilter,
  RETIRED_EXERCISE_MESSAGE,
} from './http-exception.filter'

// The filter shapes every error response. Here: the database errors it
// translates (the closed-program guard, migration 0031; the retired-exercise
// guard, 0033; the blank-title CHECKs, 0035) and that the rest is unchanged. A fake ArgumentsHost hands it a request and a response whose
// status() and json() calls are recorded.
describe('HttpExceptionFilter', () => {
  function run(exception: unknown) {
    // Typed mocks: what the filter passes to status() and json().
    const json = jest.fn<void, [Record<string, unknown>]>()
    const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }))
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: 'POST', url: '/sessions' }),
      }),
    } as unknown as ArgumentsHost
    new HttpExceptionFilter().catch(exception, host)
    return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] }
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
    })
  })

  // Any other CHECK failure is still an unexpected error: a 500, its details
  // kept out of the response. The second case is a neighbour of the title
  // CHECKs — another CHECK on the same table — so a translation that
  // matched on the TABLE instead of the constraint would fail here.
  it.each([
    'assigned_programs_ends_after_start',
    'assigned_programs_not_based_on_itself',
  ])('leaves other database errors (%s) as a 500', (constraint) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { status, body } = run(databaseError('23514', constraint))
    expect(status).toBe(500)
    expect(body.message).toEqual(['Internal server error'])
  })

  it('passes HTTP exceptions through unchanged', () => {
    const { status, body } = run(new NotFoundException('Nope'))
    expect(status).toBe(404)
    expect(body.message).toEqual(['Nope'])
  })
})