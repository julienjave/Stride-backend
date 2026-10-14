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

import { Logger } from '@nestjs/common'
import { LogTransport } from './log.transport'

describe('LogTransport', () => {
  // Spying on Logger.prototype.log catches the call from the transport's
  // own Logger instance; mockImplementation keeps the output out of the
  // test run. restoreAllMocks puts the real method back after each test.
  let logSpy: jest.SpyInstance
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  // What a developer relies on: the recipient, the subject and the
  // plain-text body (which carries the link) all appear in one log entry.
  it('logs the recipient, subject and plain-text body, and resolves', async () => {
    await expect(
      new LogTransport().send({
        from: 'Stride <noreply@stride.test>',
        to: 'someone@example.com',
        subject: 'Reset your Stride password',
        html: '<p>ignored</p>',
        text: 'Reset your password: http://localhost:5173/reset-password?token=abc',
      }),
    ).resolves.toBe(undefined)

    expect(logSpy).toHaveBeenCalledTimes(1)
    // A spy's recorded arguments are typed `any`; destructuring the first
    // call as a one-string tuple gives `output` a real type.
    const [output] = logSpy.mock.calls[0] as [string]
    expect(output).toContain('To:      someone@example.com')
    expect(output).toContain('Subject: Reset your Stride password')
    expect(output).toContain(
      'Reset your password: http://localhost:5173/reset-password?token=abc',
    )
  })
})
