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

import { errorMessage } from './error-message'

describe('errorMessage', () => {
  it("returns an Error's message", () => {
    expect(errorMessage(new Error('connect ECONNREFUSED 127.0.0.1:1025'))).toBe(
      'connect ECONNREFUSED 127.0.0.1:1025',
    )
  })

  // Subclasses too — nodemailer, pg and the AWS SDK throw their own.
  it('works for Error subclasses', () => {
    expect(errorMessage(new TypeError('not a function'))).toBe('not a function')
  })

  it('turns anything else that was thrown into text', () => {
    expect(errorMessage('greeting never received')).toBe(
      'greeting never received',
    )
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})