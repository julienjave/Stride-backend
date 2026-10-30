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

import { DrizzleQueryError } from 'drizzle-orm'
import { pathOnly, scrubText, serializeError } from './log-scrub'

// What a log line may say (decisions §32). Each rule with the input that made
// it necessary, and its neighbour that must stay untouched.

describe('pathOnly', () => {
  it.each([
    ['/admin/users?search=Jane%20Doe', '/admin/users'],
    ['/users/12/care-team?includeEnded=true', '/users/12/care-team'],
    ['/exercises#photos', '/exercises'],
    ['/exercises?q=a#b', '/exercises'],
    ['/users/12', '/users/12'],
    ['', ''],
    [undefined, ''],
  ])('%s → %s', (url, path) => {
    expect(pathOnly(url)).toBe(path)
  })
})

describe('scrubText', () => {
  it('replaces every email address', () => {
    expect(
      scrubText(
        '550 5.1.1 <jane.doe+physio@example.co.uk>: Recipient rejected; cc pat@x.io',
      ),
    ).toBe('550 5.1.1 <[email]>: Recipient rejected; cc [email]')
  })

  // Not an address: no dot-and-letters after the @, or no @ at all.
  it('leaves text that only looks a little like one', () => {
    const text = 'Sent 3 email(s) @ 14:05 to user 12; key avatars/12/a.png'
    expect(scrubText(text)).toBe(text)
  })

  // Drizzle's own message carries the query's VALUES: they go, the SQL with
  // its placeholders stays. In a stack, only up to the first frame.
  it("removes Drizzle's params, in a message and in a stack", () => {
    expect(
      scrubText(
        'Failed query: insert into "messages" ("body") values ($1)\nparams: My knee,\nstill hurts',
      ),
    ).toBe(
      'Failed query: insert into "messages" ("body") values ($1)\nparams: [redacted]',
    )
    expect(
      scrubText(
        'Error: Failed query: select 1\nparams: Jane,Doe\n    at run (/app/x.js:1:1)\n    at next (/app/y.js:2:2)',
      ),
    ).toBe(
      'Error: Failed query: select 1\nparams: [redacted]\n    at run (/app/x.js:1:1)\n    at next (/app/y.js:2:2)',
    )
  })

  it('removes the value Postgres repeats in an input error, keeping the kind', () => {
    expect(scrubText('invalid input syntax for type integer: "Jane Doe"')).toBe(
      'invalid input syntax for type integer: [redacted]',
    )
    expect(
      scrubText(
        'invalid input value for enum session_status: "done "quickly""',
      ),
    ).toBe('invalid input value for enum session_status: [redacted]')
    // The neighbour: a constraint's name in quotes is the schema, not data.
    const named =
      'duplicate key value violates unique constraint "users_email_unique"'
    expect(scrubText(named)).toBe(named)
  })
})

describe('serializeError', () => {
  // The shape a real database failure reaches the filter in: Drizzle's
  // wrapper (values in its message and its `params`) around node-postgres's
  // error (values in `detail`).
  function databaseFailure() {
    const pg = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "users_email_unique"',
      ),
      {
        code: '23505',
        constraint: 'users_email_unique',
        table: 'users',
        schema: 'public',
        routine: '_bt_check_unique',
        detail: 'Key (email)=(jane@example.com) already exists.',
        severity: 'ERROR',
        where: 'SQL statement',
      },
    )
    return new DrizzleQueryError(
      'insert into "users" ("email", "first_name") values ($1, $2)',
      ['jane@example.com', 'Jane'],
      pg,
    )
  }

  // An ALLOW-LIST: exactly these fields, whatever else the errors carry.
  it('keeps where and why, never what was written', () => {
    const logged = serializeError(databaseFailure())
    expect({ ...logged, stack: 'checked below' }).toStrictEqual({
      type: 'DrizzleQueryError',
      message:
        'Failed query: insert into "users" ("email", "first_name") values ($1, $2)\nparams: [redacted]',
      stack: 'checked below',
      query: 'insert into "users" ("email", "first_name") values ($1, $2)',
      cause: {
        type: 'Error',
        message:
          'duplicate key value violates unique constraint "users_email_unique"',
        stack: expect.any(String) as string,
        code: '23505',
        constraint: 'users_email_unique',
        table: 'users',
        schema: 'public',
        routine: '_bt_check_unique',
      },
    })
    expect(logged.stack).toMatch(/^Error: Failed query: insert into "users"/)
    expect(JSON.stringify(logged)).not.toMatch(/jane|Jane/)
  })

  it('names the class, and scrubs a plain error message too', () => {
    class MailError extends Error {}
    expect(
      serializeError(new MailError('rejected <jane@example.com>')),
    ).toMatchObject({
      type: 'MailError',
      message: 'rejected <[email]>',
    })
  })

  it('writes something thrown that is not an Error as scrubbed text', () => {
    expect(serializeError('no jane@example.com')).toStrictEqual({
      type: 'string',
      message: 'no [email]',
    })
    expect(serializeError({ code: 1 })).toStrictEqual({
      type: 'object',
      message: '[object Object]',
    })
  })

  // The kept fields are names from the schema — but a query built with
  // sql.raw() around a value one day would carry it: scrubbed like a message.
  it('scrubs the kept fields too', () => {
    const error = Object.assign(new Error('x'), {
      query: "select * from users where email = 'jane@example.com'",
    })
    expect(serializeError(error).query).toBe(
      "select * from users where email = '[email]'",
    )
  })

  it('keeps only string values of the kept fields', () => {
    const error = Object.assign(new Error('x'), { code: 42, table: 'users' })
    const logged = serializeError(error)
    expect(logged.code).toBeUndefined()
    expect(logged.table).toBe('users')
  })

  it('follows a non-Error cause', () => {
    const error = new Error('outer', { cause: 'inner jane@example.com' })
    expect(serializeError(error).cause).toStrictEqual({
      type: 'string',
      message: 'inner [email]',
    })
  })

  // An error whose cause leads back to itself would never end.
  it('stops following a cause chain after five levels', () => {
    const error = new Error('loop')
    error.cause = error
    let logged = serializeError(error)
    let depth = 0
    while (logged.cause) {
      logged = logged.cause
      depth++
    }
    expect(depth).toBe(5)
  })
})
